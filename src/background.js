// @ts-check
/* ============================================================================
   SimpleReminder · service worker
   ----------------------------------------------------------------------------
   这里只有 I/O:读写 storage、排闹钟、埋点、补注入。
   所有调度判断都在 lib/scheduler.js 的纯函数里,这样它能被穷举测试。

   ⭐ 架构原则(ARCHITECTURE §4):凡「每次休息只应发生一次」的决定
   —— currentIdeaId、breakEndsAt、postponeCount —— 一律在这里决定并写
   storage。页面只是显示器。否则同时开着 5 个标签页会抽出 5 条不同内容。

   ⚠️ 两条 MV3 的硬规矩:
     1. 所有 addListener **必须在顶层同步注册**。放进 async 函数里会在
        service worker 冷启动时静默丢事件 —— 这种 bug 极难复现。
     2. **绝不能用 setTimeout 做调度**,SW 约 30 秒无活动即被回收。
        下面那个 fast path 是尽力而为的加速,不是正确性的依赖。
   ========================================================================== */

import {
  getSettings, getRuntime, bumpStat, DEFAULT_RUNTIME, KEY_RUNTIME, KEY_SETTINGS,
} from './lib/storage.js';
import {
  reconcileState, postponeState, startBreakState, endBreakState, setPauseState,
  setIdleState, badgeFor, assertAlive,
  ALARM_NAME, PAUSE_FOREVER,
} from './lib/scheduler.js';

/** badge 的分钟级心跳。和 next-wake 分开两个闹钟:
    一个管正确性(必须准),一个管好看(可以丢)。 */
const BADGE_ALARM = 'badge-tick';

/* ═══════════════════ 顶层同步注册的监听器(四个入口)═══════════════════ */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) queue(() => applyTransition(reconcileState, 'alarm'));
  // badge 心跳不参与任何状态决定,只是重画那两个字符
  if (alarm.name === BADGE_ALARM) queue(() => refreshBadge());
});

/* ⭐ 自然休息检测。离开电脑超过 idleResetSeconds 就等于已经休息过了,
   回来不该立刻被糊一脸 —— 这是 PRODUCT 里点名的最经典差评场景。 */
chrome.idle.onStateChanged.addListener((state) => {
  queue(() => applyTransition(
    (now, s, rt) => setIdleState(now, s, rt, state),
    `idle:${state}`,
  ));
});

chrome.runtime.onStartup.addListener(() => {
  queue(async () => {
    await syncIdleDetection();
    await applyTransition(reconcileState, 'startup');
  });
});

chrome.runtime.onInstalled.addListener(() => {
  queue(async () => {
    // 落一份干净的运行时状态,避免上一次安装的残留把遮罩钉死
    await chrome.storage.local.set({ [KEY_RUNTIME]: { ...DEFAULT_RUNTIME } });
    await syncIdleDetection();
    await applyTransition(reconcileState, 'installed');
    await injectIntoOpenTabs();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  // 只听 settings(sync)。听 local 会和自己的写入形成回声循环。
  if (area !== 'sync' || !changes[KEY_SETTINGS]) return;
  queue(() => onSettingsChanged(changes[KEY_SETTINGS]));
});

/* ── 用户动作入口 ──────────────────────────────────────────────────────── */
/* 注意:manifest 里挂了 default_popup,所以 chrome.action.onClicked
   **永远不会触发**。所有用户动作都从 popup 走消息进来。 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'BREAK_FINISHED':
      queue(() => applyTransition(
        (now, s, rt) => endBreakState(now, s, rt, msg.reason === 'skipped' ? 'skipped' : 'completed'),
        'break-finished',
      )).then(() => sendResponse({ ok: true }));
      return true;                                   // 保持通道等异步回复

    // ⭐ 页面侧到点推一把。预告 8 秒 / 休息 20 秒都短于 alarm 的 30 秒下限,
    // 闹钟管不了这两个过渡,由看得见倒计时的那一方来触发。
    // applyTransition 是幂等的,多个标签页同时推也只生效一次。
    case 'RECONCILE':
      queue(() => applyTransition(reconcileState, 'page-tick')).then(() => sendResponse({ ok: true }));
      return true;

    case 'POSTPONE':
      queue(() => applyTransition(postponeState, 'postpone')).then(() => sendResponse({ ok: true }));
      return true;

    case 'START_BREAK':
      queue(() => applyTransition(startBreakState, 'start-break')).then(() => sendResponse({ ok: true }));
      return true;

    case 'SET_PAUSE':
      queue(() => applyTransition(
        (now, s, rt) => setPauseState(now, s, rt, msg.until ?? null),
        'set-pause',
      )).then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});

/* ═══════════════════════════ 串行化 ═══════════════════════════════════════
   闹钟、消息、settings 变更可能几乎同时到达。每条路径都是
   「读 storage → 算 → 写 storage」,不串行化就会丢更新
   (两边都读到 phase='breaking',各自算完各自写,后写的覆盖先写的)。
   ===================================================================== */

let chain = Promise.resolve();

/** @param {() => Promise<any>} fn */
function queue(fn) {
  chain = chain.then(fn).catch((err) => console.error('[SimpleReminder]', err));
  return chain;
}

/* ═══════════════════════ 状态迁移的唯一出口 ═════════════════════════════
   所有状态变更都走这里:每次都重新读 storage(而不是用缓存),
   算完写回,再排闹钟。幂等由 scheduler 里的 phase 守卫保证 ——
   「自动结束」和「用户跳过」撞在一起时,第二个看到 phase 已经不是
   breaking,自然变成 no-op,不会重复埋点。
   ===================================================================== */

/**
 * @param {(now:number, s:any, rt:any) => import('./lib/scheduler.js').SchedResult} fn
 * @param {string} reason
 */
async function applyTransition(fn, reason) {
  const now = Date.now();
  const settings = await getSettings();
  const prev = await getRuntime();

  const res = fn(now, settings, prev);
  const { rt, events, nextWake } = res;

  /* ⭐ 不变式自检:没在暂停就必须有下一次唤醒。
     违反它意味着扩展会静悄悄死掉,而 UI 上只表现为「下次休息 --:--」。
     真发生了就当场兜住 + 喊出来,而不是等用户两天后发现它再也不响。 */
  const dead = assertAlive(res);

  for (const ev of events) {
    if (ev.type === 'break-end' || ev.type === 'break-end:completed') {
      await bumpStat(ev.ideaId || '', 'completed');
    } else if (ev.type === 'break-end:skipped') {
      await bumpStat(ev.ideaId || '', 'skipped');
    } else if (ev.type === 'postponed') {
      await bumpStat(ev.ideaId || '', 'postponed');
    }
  }

  let wake = nextWake;
  if (dead) {
    console.error('[SimpleReminder] 调度不变式被破坏:', dead, '(', reason, ')');
    rt.nextFireAt = now + Math.max(1, settings.intervalMinutes) * 60_000;
    wake = rt.nextFireAt;
  }

  if (JSON.stringify(rt) !== JSON.stringify(prev)) {
    await chrome.storage.local.set({ [KEY_RUNTIME]: rt });
  }
  await scheduleWake(wake);
  await syncBadge(now, rt);

  if (events.length) {
    console.debug('[SimpleReminder]', reason, '→', rt.phase, events.map((e) => e.type).join(','));
  }
  return rt;
}

/** @param {chrome.storage.StorageChange} change */
async function onSettingsChanged(change) {
  const before = change.oldValue || {};
  const after = change.newValue || {};
  // 改了间隔就从现在重新起算,而不是沿用旧的 nextFireAt ——
  // 把 20 分钟改成 5 分钟却还要再等 18 分钟,会让人觉得设置没生效
  if (before.intervalMinutes !== after.intervalMinutes) {
    const rt = await getRuntime();
    if (rt.phase === 'idle' && rt.pausedUntil === null) {
      await chrome.storage.local.set({ [KEY_RUNTIME]: { ...rt, nextFireAt: null } });
    }
  }
  if (before.idleResetSeconds !== after.idleResetSeconds) await syncIdleDetection();
  await applyTransition(reconcileState, 'settings-changed');
}

/* ═══════════════════════════ 闹钟 ═══════════════════════════════════════ */

let fastTimer = /** @type {any} */ (null);

/**
 * @param {number|null} when
 *
 * Chrome 120+ 会把 30 秒以内的闹钟钳到 30 秒,而预告 8 秒、休息 20 秒都在
 * 这之下。所以闹钟只保证「最终一定会醒来」,精确的短过渡由页面侧倒计时
 * 驱动(页面读的是同一批绝对时间戳,到点 sendMessage 上报)。
 *
 * 下面的 fastTimer 是尽力而为的第三条路:SW 刚干完活通常还能活约 30 秒,
 * 这个 setTimeout 多半能跑到。它**不是正确性依赖** —— 即使 SW 被回收、
 * 页面也全关了,下次任何事件唤醒时 reconcileState 都会把状态补齐。
 */
async function scheduleWake(when) {
  clearTimeout(fastTimer);
  fastTimer = null;

  await chrome.alarms.clear(ALARM_NAME);
  if (when === null) return;

  const now = Date.now();
  await chrome.alarms.create(ALARM_NAME, { when: Math.max(when, now + 1000) });

  const delay = when - now;
  if (delay > 0 && delay < 35_000) {
    fastTimer = setTimeout(
      () => queue(() => applyTransition(reconcileState, 'fast-path')),
      delay + 50,
    );
  }
}

/* ═══════════════════════════ badge ═════════════════════════════════════
   badge 是这个扩展在浏览器里**唯一的常驻信号**。chrome-stats 上那条真实
   差评「点图标什么都没有…他们不会等 20 分钟」说的就是没有它的后果。

   分钟级心跳用一个**独立的** periodic alarm,和 next-wake 分开:
   一个管正确性(必须准),一个管好看(丢了无所谓)。

   ⭐ 心跳只在「idle 相位 + 未暂停 + 人在电脑前」时才跑。
   离开电脑时没人看 badge,再每分钟唤醒 service worker 就纯属耗电。
   ===================================================================== */

/** @param {number} now @param {any} rt */
async function syncBadge(now, rt) {
  const { text, color } = badgeFor(now, rt);
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* 窗口全关时 action API 可能不可用 */ }

  const wantTick = rt.phase === 'idle'
    && rt.idleSince === null
    && !(rt.pausedUntil !== null && rt.pausedUntil > now)
    && rt.nextFireAt !== null;

  const existing = await chrome.alarms.get(BADGE_ALARM);
  if (wantTick && !existing) {
    await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  } else if (!wantTick && existing) {
    await chrome.alarms.clear(BADGE_ALARM);
  }
}

/** 心跳回调:只重画,不碰状态 */
async function refreshBadge() {
  await syncBadge(Date.now(), await getRuntime());
}

/* ═══════════════════════ 自然休息检测 ══════════════════════════════════
   ⭐ detectionInterval 直接设成 idleResetSeconds,于是「收到 idle 事件」
   本身就等价于「已经离开满那么久」—— 不用再拿时间戳去减,也就没有
   「idle 事件比实际离开晚 N 秒」的偏差。判断逻辑见 scheduler.setIdleState。
   ===================================================================== */

async function syncIdleDetection() {
  const settings = await getSettings();
  // Chrome 下限 15 秒
  const seconds = Math.max(15, Math.round(settings.idleResetSeconds));
  try {
    chrome.idle.setDetectionInterval(seconds);
    // 冷启动时对齐一次:SW 被回收期间发生的 idle 变化收不到事件
    const state = await chrome.idle.queryState(seconds);
    await applyTransition((now, s, rt) => setIdleState(now, s, rt, state), `idle-query:${state}`);
  } catch (err) {
    console.error('[SimpleReminder] idle 检测初始化失败', err);
  }
}

/* ═══════════════ 补注入已打开的标签页 ═══════════════════════════════════
   ⭐ Chrome **只在页面加载时**注入 manifest 声明的 content script。
   安装 / 更新时已经开着的标签页不会被注入,直到它们发生导航 ——
   症状就是「刚装完,新开的标签页正常,之前开着的标签页毫无反应」。

   注意「重新启用扩展」不会触发 onInstalled,所以还要在 worker 启动时
   用一个 session 级标记兜底(session storage 随浏览器会话清空)。
   ===================================================================== */

const INJECT_MARK = 'injectedVersion';

async function injectIntoOpenTabs() {
  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch { return; }

  // 活动标签页优先 —— 用户正盯着的那个先恢复
  tabs.sort((a, b) => Number(b.active) - Number(a.active));

  for (const tab of tabs) {
    if (!tab.id || tab.discarded) continue;                  // 丢弃的标签页别唤醒
    if (!/^https?:/i.test(tab.url || '')) continue;          // chrome:// 等注不进去
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['src/content.js'],
      });
    } catch { /* 单个标签页失败不影响其它 */ }
  }

  try {
    await chrome.storage.session.set({ [INJECT_MARK]: chrome.runtime.getManifest().version });
  } catch { /* noop */ }
}

/* ═══════════════════════ worker 每次启动 ════════════════════════════════
   SW 被回收后任何事件都会重新拉起它,此时重跑一次 reconcile 几乎零成本,
   却能把「闹钟丢了 / 电脑休眠过」这类情况一并补上。
   ===================================================================== */

queue(async () => {
  // ⭐ detectionInterval 要在**每次** worker 冷启动时重设。
  // SW 被回收后这个值不保证还在,而 onStartup 只在浏览器启动时触发一次 ——
  // 靠事件唤醒的那些冷启动根本走不到那里。
  await syncIdleDetection();
  await applyTransition(reconcileState, 'worker-start');
  try {
    const got = await chrome.storage.session.get(INJECT_MARK);
    if (got[INJECT_MARK] !== chrome.runtime.getManifest().version) {
      await injectIntoOpenTabs();
    }
  } catch { /* noop */ }
});

export { PAUSE_FOREVER };
