// @ts-check
/* ============================================================================
   SimpleReminder · 休息遮罩逻辑(iframe 内)
   ----------------------------------------------------------------------------
   ⭐ 这个页面是**显示器,不是决策者**。
   它不抽内容、不决定下一次什么时候响、不记统计 —— 那些由 background 决定
   并写进 storage,这里只读。凡「每次休息只应发生一次」的事,多个标签页
   同时打开时必须得到同一个答案,所以不能在这里算。

   它只做两件事:
     1. 把 runtime 里的 currentIdeaId / breakEndsAt 渲染出来
     2. 把用户的「跳过」意图上报给 background
   ========================================================================== */

import { IDEA_BY_ID, DEFAULT_IDEA } from '../lib/ideas.js';
import { getSettings, getRuntime, DEFAULT_SETTINGS } from '../lib/storage.js';
import { remainText } from '../lib/format.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const root  = document.documentElement;
const skip  = $('skip');
const ring  = $('ring');
const fill  = $('fill');
const left  = $('left');

const RING = 100;

let holdMs    = DEFAULT_SETTINGS.skipHoldMs;
let startedAt = 0;        // ⭐ 绝对时间戳
let endsAt    = 0;        // ⭐ 绝对时间戳 —— 绝不存"剩余秒数"
let ideaId    = DEFAULT_IDEA.id;

let countRaf  = /** @type {number|null} */ (null);
let holdRaf   = /** @type {number|null} */ (null);
let holdStart = 0;
let finishing = false;

/* ───────────────────── 启动:从 storage 读,不自己决定 ──────────────────── */

(async function boot() {
  const [settings, rt] = await Promise.all([getSettings(), getRuntime()]);

  holdMs = settings.skipHoldMs;

  const idea = IDEA_BY_ID[rt.currentIdeaId || ''] || DEFAULT_IDEA;
  ideaId = idea.id;

  root.style.setProperty('--bg', idea.bg);
  root.style.setProperty('--accent', idea.accent);

  $('title').textContent = idea.action.zh;
  const hint = idea.hint.zh;
  $('sub').textContent = hint;
  $('sub').classList.toggle('off', !hint);

  const now = Date.now();
  endsAt    = rt.breakEndsAt    ?? now + settings.durationSeconds * 1000;
  startedAt = rt.breakStartedAt ?? endsAt - settings.durationSeconds * 1000;

  left.textContent = remainText((endsAt - now) / 1000);
  countRaf = requestAnimationFrame(countTick);
})();

/* ──────────────────── 倒计时:进度条递减 + 剩余时间文字 ─────────────────── */

function countTick() {
  const total  = Math.max(1, endsAt - startedAt);
  const leftMs = endsAt - Date.now();
  fill.style.transform = `scaleX(${Math.max(0, leftMs / total).toFixed(4)})`;
  left.textContent = remainText(leftMs / 1000);
  if (leftMs <= 0) { countRaf = null; finish('completed'); return; }
  countRaf = requestAnimationFrame(countTick);
}

function stopCount() {
  if (countRaf !== null) cancelAnimationFrame(countRaf);
  countRaf = null;
}

/* ─────────────────────────────── 长按跳过 ──────────────────────────────── */

function beginHold() {
  if (holdRaf !== null || finishing) return;
  holdStart = performance.now();
  skip.classList.add('holding');
  holdRaf = requestAnimationFrame(holdTick);
}

/** 用 rAF + performance.now() 每帧直写,**不用 CSS transition**。
    transition 方案在同帧「移除→重加」类名时浏览器不插 reflow,
    会从残留的中途值接着跑 —— 表现为第二次按明显变快。 */
function holdTick(now) {
  const p = Math.min(1, (now - holdStart) / holdMs);
  ring.style.strokeDashoffset = String((RING * (1 - p)).toFixed(2));
  if (p >= 1) { holdRaf = null; finish('skipped'); return; }
  holdRaf = requestAnimationFrame(holdTick);
}

/** 松手即取消,不累积 —— 摩擦必须是真的 */
function releaseHold() {
  if (holdRaf !== null) cancelAnimationFrame(holdRaf);
  holdRaf = null;
  skip.classList.remove('holding');
  ring.style.strokeDashoffset = String(RING);
}

skip.addEventListener('pointerdown', (e) => { if (e.button === 0) beginHold(); });
skip.addEventListener('pointerup',     releaseHold);
skip.addEventListener('pointerleave',  releaseHold);
skip.addEventListener('pointercancel', releaseHold);

/* ──────────────────────── 键盘通路:按住 Esc 一秒 ───────────────────────
   在捕获阶段就 preventDefault,而不是只在 dialog 的 cancel 事件里拦。
   长按 Esc 会产生连续 keydown,每一次都是一个独立的 close request;
   Chrome 的 CloseWatcher 在无用户激活时会强制关闭 dialog 防止用户被困,
   cancel 里 preventDefault 只挡得住第一次。

   heldKey + 60ms 宽限窗代替 e.repeat:部分平台(X11)的键盘自动重复是
   keydown/keyup 成对发送的,e.repeat 识别不出来,会让进度反复归零。  */

let heldKey = /** @type {string|null} */ (null);
let releaseTimer = 0;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') document.body.classList.add('kbd');   // 焦点环闸门
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  if (finishing) return;
  clearTimeout(releaseTimer);
  if (heldKey === 'Escape') return;            // 自动重复 → 保持进度
  heldKey = 'Escape';
  beginHold();
}, true);

document.addEventListener('keyup', (e) => {
  if (e.key !== 'Escape' || heldKey !== 'Escape') return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => { heldKey = null; releaseHold(); }, 60);
}, true);

document.addEventListener('pointerdown', () => {
  document.body.classList.remove('kbd');
}, true);

/* ─────────────────────────────── 收尾上报 ──────────────────────────────── */

/**
 * @param {'completed'|'skipped'} reason
 *
 * 两条路并行,但只有一条决定状态:
 *   · sendMessage → background 写 storage(**权威**:记统计、排下一次)
 *   · postMessage → content.js 立刻开始淡出(**纯视觉**,丢了也不影响正确性)
 * 不并行的话,长按走满之后要干等 service worker 冷启动,会觉得卡住。
 */
function finish(reason) {
  if (finishing) return;                 // 重入保护:长按完成与倒计时归零可能同帧
  finishing = true;
  stopCount();
  releaseHold();
  heldKey = null;
  clearTimeout(releaseTimer);

  parent.postMessage({ __sr: 1, type: 'FINISH', reason }, '*');
  chrome.runtime.sendMessage({ type: 'BREAK_FINISHED', reason, ideaId })
    .catch(() => { /* SW 正在回收时可能失败,storage 侧会由 reconcile 兜底 */ });
}
