// @ts-check
/* ============================================================================
   SimpleReminder · 调度核心
   ----------------------------------------------------------------------------
   ⭐ 本文件是**纯函数**:不碰 chrome.*、不碰 Date.now()、不产生副作用。
   时间从参数进来,新状态从返回值出去。
   理由:调度是整个扩展唯一真正复杂的部分,它必须能被穷举测试。
   所有 I/O(读写 storage、排闹钟、埋点)都在 background.js 里。

   —— 模型 ——
   闹钟不是真相,只是一个叫醒服务。真相是 storage 里的几个**绝对时间戳**。
   `reconcileState()` 是一个幂等函数:给定 (now, settings, 旧状态),
   算出"此刻**应该**是什么状态"。它能一次补齐多级过渡,所以:
     · 闹钟丢了 / 没按时响   → 下次任何事件唤醒时补上
     · 电脑休眠三小时后唤醒  → 不是特例,就是普通路径
     · 同一时刻被调用两次    → 第二次是 no-op(靠 phase 状态机保证)

   —— 为什么短过渡不能靠闹钟 ——
   Chrome 120+ 的 alarm 最小粒度是 30 秒,而预告 8 秒、休息 20 秒都在这之下。
   所以:精确的短过渡由**页面侧的倒计时**驱动(它读同一批绝对时间戳,
   到点上报),闹钟只保证"最终一定会醒来"。两者冲突时以本函数为准。
   ========================================================================== */

import { IDEAS } from './ideas.js';

export const ALARM_NAME = 'next-wake';

/** `pausedUntil` 取这个值表示「暂停到手动恢复为止」。
    用一个大到不可能到达的时间戳,就不必给比较逻辑开特例。 */
export const PAUSE_FOREVER = 8640000000000000;   // ECMAScript 允许的最大时间值

/**
 * 过渡迟到超过这个时长,就认为"中间睡过去了",**重置周期而不是补放**。
 *
 * ⚠️ 这条规则防的是 PRODUCT 里点名的最经典差评场景:
 *    「开完 1 小时会坐下,还没碰键盘,屏幕啪一下黑了」。
 * 第 5 步接上 chrome.idle 之后会有更准的判断,在那之前这是兜底。
 */
export const STALE_MS = 2 * 60_000;

/** 补齐多级过渡的循环上限,纯防御 —— 状态机本身不可能转这么多次 */
const MAX_STEPS = 8;

/**
 * @typedef {import('./storage.js').Settings} Settings
 * @typedef {import('./storage.js').RuntimeState} RuntimeState
 *
 * @typedef {{ type: string, ideaId?: string|null }} SchedEvent
 * @typedef {{ rt: RuntimeState, events: SchedEvent[], nextWake: number|null }} SchedResult
 */

/**
 * 算出此刻**应该**是什么状态。幂等。
 *
 * @param {number} now
 * @param {Settings} settings
 * @param {RuntimeState} prev
 * @param {{ random?: () => number }} [opts]
 * @returns {SchedResult}
 */
export function reconcileState(now, settings, prev, opts = {}) {
  /** @type {RuntimeState} */
  const rt = { ...prev };
  /** @type {SchedEvent[]} */
  const events = [];

  const interval = Math.max(1, settings.intervalMinutes) * 60_000;
  const duration = Math.max(1, settings.durationSeconds) * 1000;
  const pre      = Math.max(0, settings.preNoticeSeconds) * 1000;

  /* ── ① 暂停优先于一切 ───────────────────────────────────────────────── */
  if (rt.pausedUntil !== null && rt.pausedUntil > now) {
    if (rt.phase !== 'idle') events.push({ type: 'cancelled-by-pause' });
    rt.phase = 'idle';
    rt.prenoticeStartedAt = null;
    rt.prenoticeEndsAt = null;
    rt.breakStartedAt = null;
    rt.breakEndsAt = null;
    rt.currentIdeaId = null;
    rt.nextFireAt = null;                       // 恢复时再重新起算
    return result(now, settings, rt, events);
  }
  if (rt.pausedUntil !== null) {                // 暂停已到期
    rt.pausedUntil = null;
    rt.nextFireAt = now + interval;             // 恢复后从头开始,不补放
    events.push({ type: 'resumed' });
  }

  /* ── ② 状态机:一次补齐所有已经过期的过渡 ───────────────────────────── */
  let steps = 0;
  while (steps++ < MAX_STEPS) {
    if (rt.phase === 'idle') {
      if (rt.nextFireAt === null) { rt.nextFireAt = now + interval; break; }
      if (rt.nextFireAt > now) break;                      // 还没到点

      if (now - rt.nextFireAt > STALE_MS) {                // 睡过去了
        rt.nextFireAt = now + interval;
        events.push({ type: 'cycle-reset' });
        break;
      }

      // 抽内容。**延迟过来的保留原内容** —— 用户已经被剧透过"这次要干嘛",
      // 延迟 5 分钟后换成另一件事会显得随机。currentIdeaId 在休息结束时才清。
      if (!rt.currentIdeaId) {
        const drawn = drawIdea(settings, rt.ideaBag, opts.random);
        rt.currentIdeaId = drawn.ideaId;
        rt.ideaBag = drawn.bag;
      }

      if (pre > 0) {
        rt.phase = 'prenotice';
        // 用 now 而不是 nextFireAt + pre:调度可以迟到,但预告该有的 8 秒
        // 不能被迟到时间吃掉,否则用户可能只看到 1 秒预告条就黑屏了
        rt.prenoticeStartedAt = now;
        rt.prenoticeEndsAt = now + pre;
        events.push({ type: 'prenotice-start', ideaId: rt.currentIdeaId });
      } else {
        rt.phase = 'breaking';
        rt.breakStartedAt = now;
        rt.breakEndsAt = now + duration;
        events.push({ type: 'break-start', ideaId: rt.currentIdeaId });
      }
      continue;
    }

    if (rt.phase === 'prenotice') {
      if (rt.prenoticeEndsAt === null) { rt.phase = 'idle'; continue; }   // 数据损坏兜底
      if (rt.prenoticeEndsAt > now) break;

      if (now - rt.prenoticeEndsAt > STALE_MS) {
        // 预告期间睡过去了 —— 绝不能一醒来就黑屏
        rt.phase = 'idle';
        rt.prenoticeStartedAt = null;
        rt.prenoticeEndsAt = null;
        rt.currentIdeaId = null;
        rt.nextFireAt = now + interval;
        events.push({ type: 'cycle-reset' });
        break;
      }

      rt.phase = 'breaking';
      rt.prenoticeStartedAt = null;
      rt.prenoticeEndsAt = null;
      rt.breakStartedAt = now;                 // 同理,休息时长不被调度延迟吃掉
      rt.breakEndsAt = now + duration;
      events.push({ type: 'break-start', ideaId: rt.currentIdeaId });
      continue;
    }

    // phase === 'breaking'
    if (rt.breakEndsAt === null) { rt.phase = 'idle'; continue; }        // 数据损坏兜底
    if (rt.breakEndsAt > now) break;

    events.push({ type: 'break-end', ideaId: rt.currentIdeaId });
    rt.phase = 'idle';
    rt.breakStartedAt = null;
    rt.breakEndsAt = null;
    rt.currentIdeaId = null;
    rt.postponeCount = 0;                      // 一次休息真的发生了,延迟计数归零
    rt.nextFireAt = now + interval;            // 用 now 而非 breakEndsAt,
                                               // 否则休息结束后睡很久会立刻又响
    continue;
  }

  return result(now, settings, rt, events);
}

/**
 * ⭐ **所有**迁移函数的统一出口。
 *
 * 存在的理由只有一条:`idle` 相位 + `nextFireAt === null` 意味着没有下一次
 * 唤醒,也就意味着再没有任何东西会唤醒 service worker —— 扩展静悄悄死掉,
 * 而 UI 上只表现为「下次休息 --:--」,看起来像个显示问题。
 *
 * 这个状态最容易从**守卫分支**里漏出来:那些"条件不满足,什么都不做"的
 * return,会原样把一个坏状态传出去。统一在这里补上,比指望每个分支都记得
 * 检查可靠。test/scheduler.test.mjs 末尾那段 240 组合的扫描是它的看门狗。
 *
 * @param {number} now @param {Settings} settings
 * @param {RuntimeState} rt @param {SchedEvent[]} events
 * @returns {SchedResult}
 */
function result(now, settings, rt, events) {
  const paused = rt.pausedUntil !== null && rt.pausedUntil > now;
  if (rt.phase === 'idle' && rt.nextFireAt === null && !paused) {
    rt.nextFireAt = now + Math.max(1, settings.intervalMinutes) * 60_000;
  }
  return { rt, events, nextWake: computeNextWake(rt) };
}

/** 下一个需要醒来的时间点。`null` = 不需要闹钟(无限期暂停)。 */
export function computeNextWake(rt) {
  if (rt.pausedUntil !== null) {
    return rt.pausedUntil === PAUSE_FOREVER ? null : rt.pausedUntil;
  }
  if (rt.phase === 'prenotice') return rt.prenoticeEndsAt;
  if (rt.phase === 'breaking')  return rt.breakEndsAt;
  return rt.nextFireAt;
}

/* ──────────────────────────────── 用户动作 ─────────────────────────────── */

/**
 * 延迟。只在预告期有效 —— 遮罩已经盖上就只能长按跳过了。
 *
 * 不做次数上限、不做时长递减:递减有「被催促」的负面体感,可能适得其反。
 * 只把次数显示出来(「已延迟 ×N」),纯信息,零强制。
 *
 * @param {number} now @param {Settings} settings @param {RuntimeState} prev
 * @returns {SchedResult}
 */
export function postponeState(now, settings, prev) {
  if (prev.phase !== 'prenotice') {
    return result(now, settings, { ...prev }, []);
  }
  const rt = {
    ...prev,
    phase: /** @type {'idle'} */ ('idle'),
    prenoticeStartedAt: null,
    prenoticeEndsAt: null,
    nextFireAt: now + Math.max(1, settings.postponeMinutes) * 60_000,
    postponeCount: prev.postponeCount + 1,
    // currentIdeaId 故意保留 —— 延迟的是"这一次休息",内容不该换
  };
  return result(now, settings, rt, [{ type: 'postponed', ideaId: rt.currentIdeaId }]);
}

/**
 * 立即休息:跳过预告直接进遮罩。
 * @param {number} now @param {Settings} settings @param {RuntimeState} prev
 * @param {{ random?: () => number }} [opts]
 * @returns {SchedResult}
 */
export function startBreakState(now, settings, prev, opts = {}) {
  if (prev.phase === 'breaking' && (prev.breakEndsAt ?? 0) > now) {
    return result(now, settings, { ...prev }, []);                   // 幂等
  }
  const drawn = prev.currentIdeaId
    ? { ideaId: prev.currentIdeaId, bag: prev.ideaBag }
    : drawIdea(settings, prev.ideaBag, opts.random);

  const rt = {
    ...prev,
    phase: /** @type {'breaking'} */ ('breaking'),
    prenoticeStartedAt: null,
    prenoticeEndsAt: null,
    breakStartedAt: now,
    breakEndsAt: now + Math.max(1, settings.durationSeconds) * 1000,
    currentIdeaId: drawn.ideaId,
    ideaBag: drawn.bag,
    pausedUntil: null,                 // 手动要求休息 = 解除暂停
  };
  return result(now, settings, rt, [{ type: 'break-start', ideaId: rt.currentIdeaId }]);
}

/**
 * 结束当前休息(用户长按跳过,或页面上报倒计时归零)。
 *
 * **跳过后按正常间隔重排,不减半。** 惩罚机制会让人学会躲着它。
 *
 * @param {number} now @param {Settings} settings @param {RuntimeState} prev
 * @param {'completed'|'skipped'} reason
 * @returns {SchedResult}
 */
export function endBreakState(now, settings, prev, reason) {
  if (prev.phase !== 'breaking') {                      // 幂等:重复上报只生效一次
    return result(now, settings, { ...prev }, []);
  }
  const rt = {
    ...prev,
    phase: /** @type {'idle'} */ ('idle'),
    breakStartedAt: null,
    breakEndsAt: null,
    currentIdeaId: null,
    postponeCount: 0,
    nextFireAt: now + Math.max(1, settings.intervalMinutes) * 60_000,
  };
  return result(now, settings, rt, [{ type: `break-end:${reason}`, ideaId: prev.currentIdeaId }]);
}

/**
 * 暂停。`until === PAUSE_FOREVER` 表示直到手动恢复。
 * @param {number} _now @param {RuntimeState} prev @param {number|null} until
 * @returns {SchedResult}
 */
export function setPauseState(now, settings, prev, until) {
  const rt = { ...prev, pausedUntil: until };

  if (until !== null) {
    rt.phase = 'idle';
    rt.prenoticeStartedAt = null;
    rt.prenoticeEndsAt = null;
    rt.breakStartedAt = null;
    rt.breakEndsAt = null;
    rt.currentIdeaId = null;
    rt.nextFireAt = null;                       // 恢复时重新起算
  } else {
    /* ⭐ 恢复时**必须**重新起算 nextFireAt。
       暂停那一刻把它置成了 null,如果这里不补上:
       computeNextWake → null → 不排闹钟 → 再没有任何东西会唤醒
       service worker → **扩展永久性死掉**,而且 popup 上只是显示
       「下次休息 --:--」,看起来像个显示问题。
       下面 assertAlive() 那条不变式就是为了让这类 bug 当场炸出来。 */
    rt.nextFireAt = now + Math.max(1, settings.intervalMinutes) * 60_000;
    rt.idleSince = null;
  }

  return result(now, settings, rt, [{ type: until === null ? 'resumed' : 'paused' }]);
}

/* ──────────────────────────── 自然休息检测 ─────────────────────────────── */

/**
 * `chrome.idle` 状态变化。
 *
 * ⭐ 关键简化:我们把 **detectionInterval 设成 idleResetSeconds**。
 * 这样「收到 idle 事件」本身就等价于「已经离开满那么久」—— 不需要再
 * 拿 idleSince 去减,也就没有「idle 事件比实际离开晚 N 秒」的偏差。
 *
 * ⚠️ 离开期间**不动 nextFireAt**。人不在的时候,该响就响、该结束就结束
 * (反正没人看见),回来那一下的 'active' 会把整个周期重排。
 * 这比在这里猜「要不要暂停周期」稳得多,也避免了「读长文 5 分钟没动鼠标
 * 就被判定成离开、从此不再提醒」这种反向故障。
 *
 * @param {number} now
 * @param {Settings} settings
 * @param {RuntimeState} prev
 * @param {'active'|'idle'|'locked'} state
 * @returns {SchedResult}
 */
export function setIdleState(now, settings, prev, state) {
  const rt = { ...prev };
  /** @type {SchedEvent[]} */
  const events = [];

  // 暂停盖过一切
  if (rt.pausedUntil !== null && rt.pausedUntil > now) {
    return result(now, settings, rt, events);
  }

  if (state !== 'active') {
    if (rt.idleSince === null) {
      rt.idleSince = now;
      events.push({ type: 'went-idle' });
    }
    return result(now, settings, rt, events);
  }

  if (rt.idleSince === null) {                  // 本来就没离开过
    return result(now, settings, rt, events);
  }

  /* 回来了,而且确实离开够久 = 已经休息过了,周期从头算。
     如果回来时正好有遮罩盖着,一并撤掉 —— 他刚休息完,
     再糊一脸正是 PRODUCT 里点名的那条最经典差评。 */
  rt.idleSince = null;
  rt.phase = 'idle';
  rt.prenoticeStartedAt = null;
  rt.prenoticeEndsAt = null;
  rt.breakStartedAt = null;
  rt.breakEndsAt = null;
  rt.currentIdeaId = null;
  rt.postponeCount = 0;
  rt.nextFireAt = now + Math.max(1, settings.intervalMinutes) * 60_000;
  events.push({ type: 'idle-reset' });

  return result(now, settings, rt, events);
}

/* ──────────────────────────────── badge ────────────────────────────────── */

/** 两次休息之间不该有东西在闪 —— idle 态用静音琥珀,不是警示色 */
export const BADGE_COLOR = {
  idle:   '#4a4034',
  soon:   '#e8a33d',
  paused: '#4a4a4a',
};

/**
 * badge 该显示什么。纯函数,分钟级。
 *
 * badge 是这个扩展在浏览器里**唯一的常驻信号** —— chrome-stats 上那条
 * 真实差评「点图标什么都没有…他们不会等 20 分钟」说的就是没有它的后果。
 *
 * @param {number} now
 * @param {RuntimeState} rt
 * @returns {{ text: string, color: string }}
 */
export function badgeFor(now, rt) {
  if (rt.pausedUntil !== null && rt.pausedUntil > now) {
    return { text: '||', color: BADGE_COLOR.paused };
  }
  if (rt.phase === 'prenotice') return { text: '!', color: BADGE_COLOR.soon };
  // 休息中屏幕已经被盖住了,badge 没人看 —— 留空比显示 0 干净
  if (rt.phase === 'breaking') return { text: '', color: BADGE_COLOR.soon };
  if (rt.nextFireAt === null) return { text: '', color: BADGE_COLOR.idle };

  const min = Math.ceil((rt.nextFireAt - now) / 60_000);
  return { text: min > 0 ? String(min) : '', color: BADGE_COLOR.idle };
}

/**
 * ⭐ 不变式:**只要没在暂停,就一定有下一次唤醒。**
 *
 * 违反它 = 没有闹钟 = 再没有任何东西会唤醒 service worker = 扩展静悄悄
 * 死掉,而且 UI 上只表现为「下次休息 --:--」。这是这个产品最坏的失败方式,
 * 所以把它写成一条可断言的不变式,而不是指望每次改调度时都记得。
 *
 * @param {SchedResult} res
 * @returns {string|null} 违反时返回原因,正常返回 null
 */
export function assertAlive(res) {
  const paused = res.rt.pausedUntil !== null;
  if (res.nextWake === null && !paused) return 'nextWake 为 null 但并未暂停';
  return null;
}

/* ──────────────────────────────── 洗牌袋 ───────────────────────────────── */

/**
 * 洗牌袋而不是纯随机:纯随机会连着抽到同一条,主观上像坏了。
 * 勾选项只剩 1 条时自然退化为固定内容。
 *
 * @param {Settings} settings
 * @param {string[]} bag
 * @param {() => number} [random]
 */
export function drawIdea(settings, bag, random = Math.random) {
  const valid = new Set(IDEAS.map((i) => i.id));
  const enabled = settings.ideas
    .filter((i) => i.enabled && valid.has(i.id))
    .map((i) => i.id);

  // UI 保证至少勾一条,但存储可能被改坏 —— 兜回全集
  const pool = enabled.length ? enabled : IDEAS.map((i) => i.id);

  // 袋里剩下的要过滤掉已被取消勾选的
  let rest = (bag || []).filter((id) => pool.includes(id));
  if (!rest.length) rest = shuffle(pool, random);

  return { ideaId: rest[0], bag: rest.slice(1) };
}

/** @param {string[]} arr @param {() => number} random */
function shuffle(arr, random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
