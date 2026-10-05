// @ts-check
/**
 * SimpleReminder · 存储封装
 *
 * sync / local 分家的理由(ARCHITECTURE §5):
 * - 运行时状态若放 sync,A 电脑的闹钟会同步过去打乱 B 电脑的计时,且极难排查
 * - 统计若放 sync,很可能撑爆配额,**而且撑爆时是静默失败**
 */

export const KEY_SETTINGS = 'settings';   // chrome.storage.sync
export const KEY_RUNTIME  = 'runtime';    // chrome.storage.local
export const KEY_STATS    = 'stats';      // chrome.storage.local

/**
 * @typedef {Object} Settings
 * @property {number} intervalMinutes
 * @property {number} durationSeconds
 * @property {number} preNoticeSeconds       0/5/8/12/15
 * @property {number} postponeMinutes
 * @property {number} skipHoldMs
 * @property {'top'} preNoticePosition
 * @property {boolean} interruptFullscreenVideo
 * @property {number} idleResetSeconds       实际取 max(durationSeconds, 60)
 * @property {{id:string, enabled:boolean}[]} ideas
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  intervalMinutes: 20,
  durationSeconds: 20,
  preNoticeSeconds: 8,
  postponeMinutes: 5,
  skipHoldMs: 1000,
  preNoticePosition: 'top',
  interruptFullscreenVideo: false,
  idleResetSeconds: 60,
  ideas: [
    { id: 'stand', enabled: true  },
    { id: 'eyes',  enabled: true  },
    { id: 'water', enabled: false },
  ],
};

/**
 * ⭐ 凡「每次休息只应发生一次」的决定,一律在 background 决定并写进这里。
 * iframe 只是显示器,不自己抽内容、不自己记时长。
 *
 * @typedef {Object} RuntimeState
 * @property {'idle'|'prenotice'|'breaking'} phase
 * @property {number|null} nextFireAt       ⭐ 绝对时间戳 —— 预告该开始的时刻
 * @property {number|null} prenoticeStartedAt ⭐ 绝对时间戳(预告进度线的分母)
 * @property {number|null} prenoticeEndsAt  ⭐ 绝对时间戳 —— 预告结束 = 休息开始
 * @property {number|null} breakStartedAt   ⭐ 绝对时间戳(进度条算分母用)
 * @property {number|null} breakEndsAt      ⭐ 绝对时间戳 —— 绝不存"剩余秒数"
 * @property {string|null} currentIdeaId    ⭐ background 抽,全窗口共享
 * @property {number} postponeCount
 * @property {number|null} pausedUntil      null = 未暂停;PAUSE_FOREVER = 直到手动恢复
 * @property {string[]} ideaBag             洗牌袋剩余队列
 */

/** @type {RuntimeState} */
export const DEFAULT_RUNTIME = {
  phase: 'idle',
  nextFireAt: null,
  prenoticeStartedAt: null,
  prenoticeEndsAt: null,
  breakStartedAt: null,
  breakEndsAt: null,
  currentIdeaId: null,
  postponeCount: 0,
  pausedUntil: null,
  ideaBag: [],
};

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const got = await chrome.storage.sync.get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(got[KEY_SETTINGS] || {}) };
}

/** @param {Partial<Settings>} patch */
export async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ [KEY_SETTINGS]: next });
  return next;
}

/** @returns {Promise<RuntimeState>} */
export async function getRuntime() {
  const got = await chrome.storage.local.get(KEY_RUNTIME);
  return { ...DEFAULT_RUNTIME, ...(got[KEY_RUNTIME] || {}) };
}

/** @param {Partial<RuntimeState>} patch */
export async function patchRuntime(patch) {
  const next = { ...(await getRuntime()), ...patch };
  await chrome.storage.local.set({ [KEY_RUNTIME]: next });
  return next;
}

/**
 * 按条目埋点。v0.1 只记不展示 —— 统计的定位是**调参助手**,不是成就系统。
 * @param {string} ideaId
 * @param {'completed'|'skipped'|'postponed'} field
 */
export async function bumpStat(ideaId, field) {
  if (!ideaId) return;
  const got = await chrome.storage.local.get(KEY_STATS);
  /** @type {Record<string, Record<string, Record<string, number>>>} */
  const stats = got[KEY_STATS] || {};
  const day = new Date().toISOString().slice(0, 10);

  const perDay = (stats[day] ||= {});
  const perIdea = (perDay[ideaId] ||= { completed: 0, skipped: 0, postponed: 0 });
  perIdea[field] = (perIdea[field] || 0) + 1;

  // 只留 30 天,自动清理 —— 避免 local 无限增长
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const d of Object.keys(stats)) if (d < cutoff) delete stats[d];

  await chrome.storage.local.set({ [KEY_STATS]: stats });
}
