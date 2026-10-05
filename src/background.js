// @ts-check
/* ============================================================================
   SimpleReminder · service worker
   ----------------------------------------------------------------------------
   ⚠️ 当前是**第 2 步的最小可测版本**,不是最终形态。

   已实现:
     · 抽内容(洗牌袋)、写 breakStartedAt / breakEndsAt、按条目埋点
     · 点击工具栏图标 = 立即休息(v0.1 的临时触发入口,popup 在第 6 步)

   第 3 步要补上的:
     · reconcile():单一 next-wake alarm + 幂等补偿
     · onAlarm / onStartup / onInstalled / storage.onChanged 四入口
     · 预告阶段 prenotice、延迟、暂停、idle 检测、badge

   ⭐ 架构原则(ARCHITECTURE §4):凡「每次休息只应发生一次」的决定
   —— currentIdeaId、breakEndsAt、postponeCount —— 一律在这里决定并写
   storage。iframe 只是显示器。否则同时开着 5 个标签页时会抽出 5 条不同的
   内容,各自倒各自的计时。
   ========================================================================== */

import { IDEAS } from './lib/ideas.js';
import { getSettings, getRuntime, patchRuntime, bumpStat, DEFAULT_RUNTIME } from './lib/storage.js';

/* ───────────────────────────── 安装 / 启动 ─────────────────────────────── */

chrome.runtime.onInstalled.addListener(async () => {
  // 启动即落一份干净的运行时状态,避免上一次安装的残留把遮罩钉死
  await chrome.storage.local.set({ runtime: { ...DEFAULT_RUNTIME } });
  await injectIntoOpenTabs();

  // PRODUCT:首次安装必须立刻演示一次 overlay。
  // 真实差评佐证 ——「点图标什么都没有…他们不会等 20 分钟」。
  // 第 6 步接上 onboarding 后再决定放在哪,这里先留标记。
});

chrome.runtime.onStartup.addListener(async () => {
  const rt = await getRuntime();
  // 浏览器重启时如果残留 breaking,清掉 —— 否则新开的标签页会被一个
  // 永远不会结束的遮罩盖住
  if (rt.phase === 'breaking') await endBreak(null, 'stale');
});

/* ═══════════════ 补注入已打开的标签页 ═══════════════════════════════════
   ⭐ Chrome **只在页面加载时**注入 manifest 声明的 content script。
   安装 / 更新时已经开着的标签页不会被注入,直到它们发生导航 ——
   症状就是「刚装完,新开的标签页正常,之前开着的标签页毫无反应」。
   Chrome 不自动补注入是刻意的(往任意已有页面里塞脚本可能把页面搞坏),
   它把这个决定留给扩展自己。

   注意「重新启用扩展」不会触发 onInstalled,所以还要在 worker 启动时
   用一个 session 级标记兜底(session storage 随浏览器会话清空)。
   ===================================================================== */

const INJECT_MARK = 'injectedVersion';

async function injectIntoOpenTabs() {
  const version = chrome.runtime.getManifest().version;

  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch { return; }

  // 活动标签页优先 —— 用户正盯着的那个先恢复
  tabs.sort((a, b) => Number(b.active) - Number(a.active));

  for (const tab of tabs) {
    // 跳过已丢弃的标签页:注入会失败,或者把它唤醒,白白耗内存
    if (!tab.id || tab.discarded) continue;
    // chrome:// / 应用商店 / PDF 阅读器注不进去,这是 Chrome 的限制
    if (!/^https?:/i.test(tab.url || '')) continue;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['src/content.js'],
      });
    } catch {
      // 单个标签页失败不能影响其它标签页(可能是受限页面或刚好在导航)
    }
  }

  try { await chrome.storage.session.set({ [INJECT_MARK]: version }); } catch { /* noop */ }
}

// worker 每次启动都检查一次。storage.session 在同一浏览器会话内跨 worker
// 重启保留,所以正常情况下只会真正注入一次。
(async () => {
  try {
    const got = await chrome.storage.session.get(INJECT_MARK);
    if (got[INJECT_MARK] !== chrome.runtime.getManifest().version) {
      await injectIntoOpenTabs();
    }
  } catch { /* noop */ }
})();

/* ──────────────────── 临时触发入口:点工具栏图标 = 立即休息 ───────────────
   第 6 步 popup 做好后会被「立即休息」按钮取代。 */

chrome.action.onClicked.addListener(() => { startBreak(); });

/* ─────────────────────────── 来自遮罩的上报 ───────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'BREAK_FINISHED') {
    endBreak(msg.ideaId, msg.reason).then(() => sendResponse({ ok: true }));
    return true;                         // 保持消息通道,等待异步回复
  }
  return false;
});

/* ─────────────────────────────── 状态迁移 ─────────────────────────────── */

async function startBreak() {
  const settings = await getSettings();
  const rt = await getRuntime();

  if (rt.phase === 'breaking' && (rt.breakEndsAt ?? 0) > Date.now()) return;  // 幂等

  const { ideaId, bag } = drawIdea(settings, rt.ideaBag);
  const now = Date.now();

  await patchRuntime({
    phase: 'breaking',
    breakStartedAt: now,
    breakEndsAt: now + settings.durationSeconds * 1000,
    currentIdeaId: ideaId,
    postponeCount: 0,
    ideaBag: bag,
  });

  // 兜底:遮罩自己会在倒计时归零时上报,但如果用户中途关了所有标签页就没人报了。
  // SW 可能先被回收,所以这只是尽力而为;第 3 步的 reconcile 才是正解。
  setTimeout(() => {
    getRuntime().then((r) => {
      if (r.phase === 'breaking' && (r.breakEndsAt ?? 0) <= Date.now()) {
        endBreak(r.currentIdeaId, 'completed');
      }
    });
  }, settings.durationSeconds * 1000 + 1500);
}

/**
 * @param {string|null} ideaId
 * @param {'completed'|'skipped'|'stale'} reason
 */
async function endBreak(ideaId, reason) {
  const rt = await getRuntime();
  if (rt.phase !== 'breaking') return;            // 幂等:重复上报只生效一次

  if (reason === 'completed' || reason === 'skipped') {
    await bumpStat(ideaId || rt.currentIdeaId || '', reason);
  }

  const settings = await getSettings();
  await patchRuntime({
    phase: 'idle',
    breakStartedAt: null,
    breakEndsAt: null,
    currentIdeaId: null,
    // 跳过也按**正常间隔**重新计时,不减半 —— 惩罚机制会让人学会躲
    nextFireAt: Date.now() + settings.intervalMinutes * 60_000,
  });

  // TODO(第 3 步):在这里 reconcile(),排下一个 next-wake alarm
}

/* ───────────────────────────── 洗牌袋随机 ─────────────────────────────── */

/**
 * 洗牌袋而不是纯随机:纯随机会连着抽到同一条,主观上像坏了。
 * 勾选项只剩 1 条时自然退化为固定内容。
 *
 * @param {import('./lib/storage.js').Settings} settings
 * @param {string[]} bag
 */
function drawIdea(settings, bag) {
  const valid = new Set(IDEAS.map((i) => i.id));
  const enabled = settings.ideas
    .filter((i) => i.enabled && valid.has(i.id))
    .map((i) => i.id);

  // UI 保证至少勾一条,但存储可能被改坏 —— 兜回全集
  const pool = enabled.length ? enabled : IDEAS.map((i) => i.id);

  // 袋里剩下的要过滤掉已被取消勾选的
  let rest = (bag || []).filter((id) => pool.includes(id));
  if (!rest.length) rest = shuffle(pool);

  const ideaId = rest[0];
  return { ideaId, bag: rest.slice(1) };
}

/** @param {string[]} arr */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
