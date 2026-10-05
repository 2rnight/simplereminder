import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const src = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + m); };

/* ════════════ 极简 DOM 桩 ════════════
   够用就好:只要能跟踪 class / textContent / 调用了哪些 Top Layer API。 */
function makeEl(tag = 'div') {
  const kids = new Map();                       // '.cls' → 子元素桩
  const el = {
    tagName: tag.toUpperCase(),
    style: { cssText: '', setProperty() {} },
    attrs: {},
    textContent: '',
    hidden: false,
    tabIndex: 0,
    open: false,
    calls: [],                                  // showModal / showPopover / …
    classes: new Set(),
    handlers: {},
    classList: {
      add: (...c) => c.forEach((x) => el.classes.add(x)),
      remove: (...c) => c.forEach((x) => el.classes.delete(x)),
      contains: (c) => el.classes.has(c),
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    appendChild() {}, append() {}, remove() {},
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    removeEventListener() {},
    attachShadow: () => ({ append() {} }),
    focus() {}, blur() {},
    showModal() { el.open = true; el.calls.push('showModal'); },
    close() { el.open = false; el.calls.push('close'); },
    showPopover() { el.calls.push('showPopover'); },
    hidePopover() { el.calls.push('hidePopover'); },
    get isConnected() { return true; },
    querySelector(sel) { return kids.get(sel) || null; },
    set innerHTML(html) {
      for (const m of html.matchAll(/class="([^"]+)"/g)) kids.set('.' + m[1], makeEl('span'));
    },
    get innerHTML() { return ''; },
    fire(type, ev = {}) { (el.handlers[type] || []).forEach((f) => f(ev)); },
  };
  return el;
}

let frameBudget = 0;
const pending = [];                       // 被 setTimeout 挂起的回调
/** 立刻执行所有挂起的定时器 —— 用来快进「自动延迟提示停留 2 秒」这类等待 */
function flushTimers() {
  const todo = pending.filter(Boolean);
  pending.length = 0;
  todo.forEach((t) => t.f());
}
const created = [];
const log = { storageAdd: 0, storageRemove: 0, winAdd: 0, winRemove: 0, msgs: [] };

const ctx = {
  console,
  setTimeout: (f, ms) => { pending.push({ f, ms }); return pending.length; },
  clearTimeout: (id) => { if (id) pending[id - 1] = null; },
  // rAF 必须异步,否则 content.js 的进度循环会变成无限递归。
  // 再加一个帧预算,防止测试里的倒计时跑满 8 秒。
  requestAnimationFrame: (f) => {
    if (frameBudget-- <= 0) return 0;
    setImmediate(() => f(Date.now()));
    return frameBudget;
  },
  cancelAnimationFrame() {},
  MutationObserver: class { observe() {} disconnect() {} },
  DOMParser: class {},
  document: {
    activeElement: null,
    createElement(tag) { const e = makeEl(tag); created.push(e); return e; },
    documentElement: { appendChild() {} },
    addEventListener(t, f) { (ctx.document.__h ||= {})[t] = f; },
    removeEventListener() {},
  },
  chrome: {
    runtime: {
      id: 'fakeid',
      // 指向真实文件,让 content.js 的动态 import 真的能拿到那三条内容
      getURL: (p) => pathToFileURL(path.join(SRC, '..', p)).href,
      sendMessage: async (m) => { log.msgs.push(m); },
    },
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener(f) { log.storageAdd++; ctx.__onChanged = f; },
        removeListener() { log.storageRemove++; },
      },
    },
  },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
/** vm 沙箱默认禁止动态 import()。给它主上下文的 loader,
    这样才能真的验证 content.js 从 lib/ideas.js 拿内容,而不是测到降级分支。 */
const RUN = { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER };
const run = () => vm.runInContext(src, ctx, RUN);
ctx.window.addEventListener = () => { log.winAdd++; };
ctx.window.removeEventListener = () => { log.winRemove++; };

const findByTag = (t) => created.filter((e) => e.tagName === t).pop();
const bar = () => created.find((e) => e.attrs.popover === 'manual');
/** 推进若干轮微/宏任务,让异步 rAF 与动态 import 都落地 */
const tick = async (n = 10) => {
  frameBudget = 12;                       // 每个场景给 12 帧,足够跑完过渡
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/* ════════════ 1. 幂等注入 ════════════ */
console.log('── 重复注入 ───────────────────────────────');
run();
ok(log.storageAdd === 1 && log.winAdd === 1, '第 1 次注入:各注册 1 个监听器');
ok(typeof ctx.window.__SR_TEARDOWN__ === 'function', '暴露了 __SR_TEARDOWN__');

run();
ok(log.storageRemove === 1 && log.winRemove === 1, '第 2 次注入先把旧实例的监听器摘掉');
run();
ok(log.storageAdd - log.storageRemove === 1, '注入 3 次后 storage 活监听器仍只有 1 个');
ok(log.winAdd - log.winRemove === 1, '注入 3 次后 message 活监听器仍只有 1 个');

/* ════════════ 2. 预告条 ════════════ */
console.log('\n── 预告条 ─────────────────────────────────');
const now = Date.now();
const fire = (rt) => ctx.__onChanged({ runtime: { newValue: rt } }, 'local');

fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();

const b = bar();
ok(!!b, '创建了 popover="manual" 的预告条(非模态,页面不会被 inert)');
ok(b.calls.includes('showPopover'), '调用了 showPopover 进 Top Layer');
ok(b.style.pointerEvents === 'auto',
   '⭐ 显式收回 pointer-events —— 宿主节点是 none,不收回整条点不动');
ok(b.classes.has('sr-bar-in'), '加了滑入 class');
ok(b.querySelector('.sr-text').textContent === '马上休息:站起来,走两步',
   '⭐ 动态 import 真的拿到了 lib/ideas.js 的内容(不是副本)');
ok(b.querySelector('.sr-emoji').textContent === '🧍', 'emoji 正确');
ok(b.querySelector('.sr-count').hidden === true, '延迟 0 次 → 不显示角标');

fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 1 });
await tick();
ok(b.querySelector('.sr-count').hidden === true, '⭐ 延迟 1 次仍不显示 ——「×1」没有信息量');

fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 2 });
await tick();
ok(b.querySelector('.sr-count').hidden === false, '延迟 2 次 → 显示角标');
ok(b.querySelector('.sr-count').textContent === '已延迟 ×2', '角标文案');

/* ════════════ 3. 延迟 ════════════ */
console.log('\n── 延迟 ───────────────────────────────────');
log.msgs.length = 0;
const keydown = ctx.document.__h.keydown;

// 焦点在普通元素:Esc = 延迟
let prevented = false;
ctx.document.activeElement = { tagName: 'DIV', isContentEditable: false };
keydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
ok(log.msgs.some((m) => m.type === 'POSTPONE'), 'Esc → 发 POSTPONE');
ok(prevented, 'preventDefault,免得同一下按键在页面里再干一件事');

// ⭐ 空格不再是延迟键 —— 它是页面的翻页键,得还给页面
fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();
log.msgs.length = 0;
let spacePrevented = false;
keydown({ key: ' ', code: 'Space', preventDefault: () => { spacePrevented = true; } });
ok(log.msgs.length === 0 && !spacePrevented,
   '⭐ 空格原样放给页面 —— 预告那几秒照样能翻页');

// 在输入框里**明确**按 Esc,算主动延迟,不该被说成"正在输入"
fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();
log.msgs.length = 0;
ctx.document.activeElement = { tagName: 'INPUT', isContentEditable: false };
keydown({ key: 'Escape', preventDefault() {} });
ok(log.msgs.some((m) => m.type === 'POSTPONE'), '输入框里按 Esc 也延迟');
ok(b.querySelector('.sr-text').textContent !== '正在输入,已自动延后',
   '⭐ 但不能说成"自动延后" —— 那是他自己按的');

// 焦点在输入框:任意键都自动延迟
fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();
log.msgs.length = 0;
ctx.document.activeElement = { tagName: 'TEXTAREA', isContentEditable: false };
keydown({ key: 'a', preventDefault() {} });
ok(log.msgs.some((m) => m.type === 'POSTPONE'), '⭐ 正在输入 → 任意键自动延迟');
ok(b.querySelector('.sr-text').textContent === '正在输入,已自动延后',
   '⭐ 自动延迟必须说出来(P4:静默的智能行为会摧毁信任)');

// 纯修饰键不该触发
fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();
log.msgs.length = 0;
keydown({ key: 'Shift', preventDefault() {} });
ok(log.msgs.length === 0, '单独按 Shift 不算在输入');

// 宽限期内再按键不该重复发 —— 这是对的,先验证它
log.msgs.length = 0;
keydown({ key: 'y', preventDefault() {} });
ok(log.msgs.length === 0, '⭐ 自动延迟的 2 秒提示期内,再按键不会重复延迟');

// 快进掉宽限期,再验 contenteditable
flushTimers();
fire({ phase: 'prenotice', prenoticeStartedAt: now, prenoticeEndsAt: now + 8000,
       currentIdeaId: 'stand', postponeCount: 0 });
await tick();
log.msgs.length = 0;
ctx.document.activeElement = { tagName: 'DIV', isContentEditable: true };
keydown({ key: 'x', preventDefault() {} });
ok(log.msgs.some((m) => m.type === 'POSTPONE'), 'contenteditable 也识别为正在输入');

/* ════════════ 4. 遮罩 / Esc ════════════ */
console.log('\n── 遮罩 ───────────────────────────────────');
fire({ phase: 'breaking', breakStartedAt: now, breakEndsAt: now + 20000, currentIdeaId: 'stand' });
await tick();
const dlg = findByTag('DIALOG');
ok(dlg.attrs['aria-label'] === '休息提醒', '创建了 dialog');
ok(dlg.tabIndex === -1, 'dialog 自己持有焦点,按钮不会被自动聚焦画出焦点环');

let escPrevented = false;
ctx.document.activeElement = { tagName: 'BODY' };
keydown({ key: 'Escape', preventDefault: () => { escPrevented = true; } });
ok(escPrevented, '⭐ 遮罩期间宿主文档的 Esc 也要拦(焦点可能不在 iframe 里)');

log.msgs.length = 0;
keydown({ key: ' ', code: 'Space', preventDefault() {} });
ok(log.msgs.length === 0, '遮罩已盖上时空格不再延迟 —— 那时只能长按跳过');

/* ════════════ 5. 拆卸 ════════════ */
console.log('\n── 拆卸 ───────────────────────────────────');
ctx.chrome.runtime.id = undefined;
let threw = false;
try { ctx.window.__SR_TEARDOWN__(); } catch (e) { threw = true; console.log('  ' + e.message); }
ok(!threw, '上下文失效后调用 teardown 不抛异常');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
