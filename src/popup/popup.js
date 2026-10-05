// @ts-check
/* ============================================================================
   SimpleReminder · popup
   ----------------------------------------------------------------------------
   和休息遮罩一样,popup 也**只是显示器**:它读 storage、发消息,
   从不自己决定「下次什么时候」。所有状态迁移都由 background 做。

   唯一例外是 settings 的写入 —— 那是用户意图本身,不是调度决定。
   写完 sync 后 background 的 storage.onChanged 会自动 reconcile。
   ========================================================================== */

import { IDEAS } from '../lib/ideas.js';
import { getSettings, patchSettings, getRuntime } from '../lib/storage.js';
import { remainText, clockText, toggleIdea, dailyCount } from '../lib/format.js';
import { PAUSE_FOREVER } from '../lib/scheduler.js';

const $ = (id) => /** @type {any} */ (document.getElementById(id));

let settings = null;
let runtime = null;
let ticker = 0;

/* ─────────────────────────────── 启动 ─────────────────────────────────── */

(async function boot() {
  [settings, runtime] = await Promise.all([getSettings(), getRuntime()]);
  renderIdeas();
  renderFields();
  render();

  // 每秒重画状态行。popup 关掉就销毁了,不存在泄漏问题。
  ticker = setInterval(render, 1000);
})();

// background 改了状态(比如休息开始/结束)要立刻反映出来
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.runtime) runtime = await getRuntime();
  if (area === 'sync' && changes.settings) { settings = await getSettings(); renderFields(); renderIdeas(); }
  render();
});

window.addEventListener('unload', () => clearInterval(ticker));

/* ─────────────────────────────── 状态行 ───────────────────────────────── */

function render() {
  if (!runtime || !settings) return;
  const now = Date.now();
  const st = $('status');
  st.classList.remove('is-paused', 'is-active');
  $('resume').hidden = true;

  // 暂停优先 —— 它盖过一切
  if (runtime.pausedUntil !== null && runtime.pausedUntil > now) {
    st.classList.add('is-paused');
    $('statusMain').textContent = '已暂停';
    $('statusSub').textContent =
      runtime.pausedUntil === PAUSE_FOREVER
        ? '直到手动恢复'
        : `${clockText(runtime.pausedUntil)} 恢复`;
    $('resume').hidden = false;
    return;
  }

  if (runtime.phase === 'breaking' && runtime.breakEndsAt) {
    st.classList.add('is-active');
    $('statusMain').textContent = '休息中';
    $('statusSub').textContent = remainText((runtime.breakEndsAt - now) / 1000);
    return;
  }

  if (runtime.phase === 'prenotice' && runtime.prenoticeEndsAt) {
    st.classList.add('is-active');
    $('statusMain').textContent = '马上休息';
    $('statusSub').textContent = remainText((runtime.prenoticeEndsAt - now) / 1000);
    return;
  }

  if (runtime.nextFireAt) {
    // 绝对时刻 + 相对剩余一起给:前者帮你判断「这件事来得及做完吗」,
    // 后者是「它还活着」的心跳
    $('statusMain').textContent = `下次休息 ${clockText(runtime.nextFireAt)}`;
    $('statusSub').textContent = remainText((runtime.nextFireAt - now) / 1000);
  } else {
    $('statusMain').textContent = '下次休息 --:--';
    $('statusSub').textContent = '正在安排…';
  }
}

/* ────────────────────────────── 内容勾选 ──────────────────────────────── */

function renderIdeas() {
  const ul = $('ideas');
  ul.textContent = '';
  for (const idea of IDEAS) {
    const on = settings.ideas.find((i) => i.id === idea.id)?.enabled ?? false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML =
      `<span class="emoji">${idea.emoji}</span>` +
      `<span class="label"></span><span class="dot"></span>`;
    btn.querySelector('.label').textContent = idea.action.zh;
    btn.addEventListener('click', () => onToggleIdea(idea.id));

    const li = document.createElement('li');
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function onToggleIdea(id) {
  const { ideas, refused } = toggleIdea(settings.ideas, id);
  if (refused) {
    // 不弹窗、不禁用按钮 —— 只是解释一下为什么没反应
    $('ideaHint').hidden = false;
    setTimeout(() => { $('ideaHint').hidden = true; }, 2600);
    return;
  }
  settings = await patchSettings({ ideas });
  renderIdeas();
}

/* ──────────────────────────────── 参数 ────────────────────────────────── */

function renderFields() {
  $('interval').value = String(settings.intervalMinutes);
  $('duration').value = String(settings.durationSeconds);
  renderPreview();
}

/** 后果预览而不是硬限制:不替用户做决定,只让代价可见 */
function renderPreview() {
  const n = Number($('interval').value);
  const show = Number.isFinite(n) && n > 0 && n < 10;
  $('preview').hidden = !show;
  if (show) $('preview').textContent = `间隔 ${n} 分钟 → 一天大约 ${dailyCount(n)} 次提醒`;
}

$('interval').addEventListener('input', renderPreview);

// 用 change 而不是 input 写入:边敲边存会把「2」当成一个完整值存进去,
// 触发一次 reconcile 把周期重排到 2 分钟后
$('interval').addEventListener('change', async (e) => {
  const v = clamp(e.target.value, 1, 240, settings.intervalMinutes);
  e.target.value = String(v);
  settings = await patchSettings({ intervalMinutes: v });
  renderPreview();
});

$('duration').addEventListener('change', async (e) => {
  const v = clamp(e.target.value, 5, 600, settings.durationSeconds);
  e.target.value = String(v);
  settings = await patchSettings({ durationSeconds: v });
});

function clamp(raw, min, max, fallback) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ──────────────────────────────── 动作 ────────────────────────────────── */

$('now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'START_BREAK' });
  window.close();                       // 遮罩马上盖上来,popup 没必要留着
});

$('resume').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SET_PAUSE', until: null });
  runtime = await getRuntime();
  render();
});

const menu = $('pauseMenu');
const pauseBtn = $('pauseBtn');

pauseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  menu.hidden = !open;
  pauseBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', () => {
  menu.hidden = true;
  pauseBtn.setAttribute('aria-expanded', 'false');
});

menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  let until;
  if (b.dataset.forever) {
    until = PAUSE_FOREVER;
  } else if (b.dataset.today) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);      // 「今天」= 到今天结束,不是 24 小时
    until = end.getTime();
  } else {
    until = Date.now() + Number(b.dataset.min) * 60_000;
  }
  await chrome.runtime.sendMessage({ type: 'SET_PAUSE', until });
  runtime = await getRuntime();
  menu.hidden = true;
  render();
});
