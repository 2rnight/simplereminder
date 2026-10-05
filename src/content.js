// @ts-check
/* ============================================================================
   SimpleReminder · content script
   ----------------------------------------------------------------------------
   职责边界:**只管两个浮层的生命周期,不含任何业务判断。**
   不抽内容、不算下一次时间、不记统计 —— 那些全在 background。
   这里唯一的输入是 chrome.storage.local 里的 runtime.phase。

   架构三件套(ARCHITECTURE §2):

     页面 DOM └─ <sr-overlay-host>(closed shadow root,挂 documentElement)
                  ├─ <div popover="manual">   ← 预告条(非模态,页面仍可操作)
                  └─ <dialog>                 ← 休息遮罩,只负责 Top Layer
                     └─ <iframe break.html>   ← UI 本体,扩展页面

   为什么预告条是 div 而遮罩是 iframe:
   预告条只有一行文字和一条进度线,写死所有样式就够了;遮罩是整屏排版,
   值得用 iframe 换一个"宿主页 CSS 一行都进不来"的硬保证。

   Top Layer 的四个反制点,全部在本文件:
     ① fullscreenchange → 重新 showModal 抢回 Top Layer 顶部
     ② MutationObserver 自愈 → 宿主页删掉我们的宿主节点就挂回去
     ③ 挂 documentElement 而非 body → SPA 整体替换 body 时不受影响
     ④ ::backdrop 样式写在 shadow root 内 → 宿主页改不到
   ========================================================================== */

(() => {
  'use strict';

  /* 幂等注入。
     本脚本有两条进入路径:manifest 声明式注入(页面加载时),以及
     background 的 scripting.executeScript 补注入(装完扩展时已经开着的
     标签页拿不到声明式注入)。两条路可能都命中同一个文档。

     同一扩展的 content script 共享一个 isolated world,所以扩展重载后
     旧实例的全局变量还在,但它的 chrome.* 已经失效("Extension context
     invalidated")。用版本号判重挡不住这种情况 —— 让新实例主动把旧实例
     拆干净才是对的。 */
  try { window.__SR_TEARDOWN__?.(); } catch { /* 旧实例已失效,忽略 */ }

  /** 扩展上下文是否还活着。重载 / 卸载后 chrome.runtime.id 会变成 undefined
      或直接抛异常,此时任何 chrome.* 调用都会报错。 */
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  const RT_KEY    = 'runtime';
  const BREAK_URL = chrome.runtime.getURL('src/break/break.html');

  /** 入场渐暗 / 出场淡出。与 break.css 的 --fade-in 保持一致。 */
  const FADE_IN  = 300;
  const FADE_OUT = 260;

  /** 预告条滑入 / 滑出 */
  const BAR_IN  = 200;
  const BAR_OUT = 180;

  /** 自动延迟后,提示要停留多久再滑走。
      P4:静默的智能行为会摧毁信任 —— 用户必须看到「它懂我」,而不是「它坏了」。 */
  const AUTO_HOLD = 2000;

  /** iframe 没按时 load 时的兜底:不能让用户等一个空白遮罩 */
  const IFRAME_LOAD_TIMEOUT = 400;

  /** 遮罩底色 —— 与 break.html 同色,遮住 iframe 加载那一两帧的空隙 */
  const FALLBACK_BG = 'hsl(32 38% 8%)';

  let /** @type {HTMLElement|null}       */ host   = null;
  let /** @type {ShadowRoot|null}        */ shadow = null;
  let /** @type {HTMLDialogElement|null} */ dialog = null;
  let /** @type {HTMLIFrameElement|null} */ iframe = null;
  let /** @type {HTMLElement|null}       */ bar    = null;
  let /** @type {MutationObserver|null}  */ healer = null;

  let overlayOpen = false;
  let barOpen     = false;
  let barRaf      = 0;
  let barHoldUntil = 0;        // 自动延迟提示期间,忽略来自 storage 的隐藏指令
  let closeTimer = 0, barTimer = 0, loadTimer = 0;
  let lastRuntime = null;

  /* ========================================================================
     Shadow 样式
     ------------------------------------------------------------------------
     dialog 用 position:fixed + inset:0,**不用 100vw/100vh**。
     100vw 含滚动条宽度,会比可视区宽出十几像素,在有滚动条的页面上
     可能给文档撑出横向滚动。inset:0 精确等于视口。

     预告条里每一条样式都写死,不依赖任何继承值 —— 宿主节点上的
     `all: initial` 已经掐断了继承链,但显式写出来才不会在将来踩回去。
     ====================================================================== */
  const SHADOW_CSS = `
    :host { all: initial !important; }

    /* ───────── 休息遮罩 ───────── */
    dialog {
      position: fixed;
      inset: 0;
      width: auto;  height: auto;
      max-width: none; max-height: none;
      margin: 0; padding: 0; border: 0;
      overflow: hidden;
      overscroll-behavior: none;
      background: ${FALLBACK_BG};
      color-scheme: dark;
    }
    dialog:focus { outline: none; }
    dialog::backdrop { background: #000; }

    @keyframes sr-in  { from { opacity: 0 } to   { opacity: 1 } }
    @keyframes sr-out { from { opacity: 1 } to   { opacity: 0 } }

    dialog[open],
    dialog[open]::backdrop {
      animation: sr-in ${FADE_IN}ms cubic-bezier(.22,.61,.36,1) both;
    }
    /* 淡出必须**同时**作用于 dialog 和 ::backdrop。
       只给 dialog 的话,黑色 backdrop 会在 dialog 淡出时反而露出来,
       close() 再硬切 —— 观感等于完全没有淡出。 */
    dialog.sr-closing,
    dialog.sr-closing::backdrop {
      animation: sr-out ${FADE_OUT}ms ease both;
    }
    /* 抢回 Top Layer 要 close()+showModal(),会重放入场动画,临时掐掉 */
    dialog.sr-noanim,
    dialog.sr-noanim::backdrop { animation: none !important; }

    iframe {
      display: block;
      width: 100%; height: 100%;
      border: 0;
      background: transparent;
      color-scheme: dark;
    }

    /* ───────── 预告条 ───────── */
    /* popover 的 UA 默认样式是居中的 fit-content 方框,全部要覆盖掉 */
    #bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      width: 100%;
      max-width: none; max-height: none;
      height: 48px;
      margin: 0;
      padding: 0 18px;
      border: 0;
      border-bottom: 1px solid rgba(255,255,255,.09);
      overflow: visible;
      box-sizing: border-box;

      display: flex;
      align-items: center;
      gap: 12px;

      background: hsl(32 26% 11%);
      color: rgba(255,255,255,.9);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
                   "Noto Sans SC", sans-serif;
      font-size: 14px;
      font-weight: 400;
      font-style: normal;
      line-height: 1;
      letter-spacing: .01em;
      text-align: left;
      text-transform: none;
      direction: ltr;
      cursor: pointer;
      user-select: none;
      -webkit-font-smoothing: antialiased;
      box-shadow: 0 6px 22px rgba(0,0,0,.34);

      transform: translateY(-100%);
      transition: transform ${BAR_IN}ms cubic-bezier(.22,.61,.36,1);
    }
    #bar::backdrop { background: transparent; }      /* 非模态,不能压暗页面 */
    #bar.sr-bar-in  { transform: translateY(0); }
    #bar.sr-bar-out { transform: translateY(-100%); transition-duration: ${BAR_OUT}ms; }
    #bar:hover { background: hsl(32 26% 13%); }

    #bar .sr-emoji { font-size: 16px; line-height: 1; flex: none; }
    #bar .sr-text  { flex: 1; min-width: 0; overflow: hidden;
                     text-overflow: ellipsis; white-space: nowrap; }
    #bar .sr-count {
      flex: none;
      font-size: 11.5px;
      font-variant-numeric: tabular-nums;
      color: #e8a33d;
      border: 1px solid rgba(232,163,61,.42);
      border-radius: 9px;
      padding: 2px 7px;
    }
    #bar .sr-hint  { flex: none; font-size: 12.5px; color: rgba(255,255,255,.5); }
    #bar .sr-key {
      display: inline-block;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: rgba(255,255,255,.72);
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 4px;
      padding: 2px 6px;
      margin-right: 6px;
    }

    /* 底边细线进度 —— 和遮罩里的进度条同一套语言:递减表示剩余 */
    #bar .sr-line {
      position: absolute;
      left: 0; right: 0; bottom: -1px;
      height: 2px;
      background: #e8a33d;
      transform-origin: left center;
      transform: scaleX(1);
    }

    @media (prefers-reduced-motion: reduce) {
      dialog, dialog::backdrop { animation: none !important; }
      #bar { transition: none !important; }
    }
  `;

  /* ========================================================================
     内容数据
     ------------------------------------------------------------------------
     content script 是传统脚本,不支持顶层 import。动态 import() 一个
     web-accessible 的模块是 Chrome 官方给出的办法,这样这三条内容
     只有 lib/ideas.js 一份,不会和这里的副本漂移。
     ====================================================================== */
  let ideasPromise = null;
  function loadIdeas() {
    if (!ideasPromise) {
      ideasPromise = import(chrome.runtime.getURL('src/lib/ideas.js'))
        .then((m) => m.IDEA_BY_ID)
        .catch(() => null);                 // 失败就退化成通用文案,不至于白条
    }
    return ideasPromise;
  }

  /* ========================================================================
     挂载 / 卸载
     ------------------------------------------------------------------------
     只在预告或休息时才存在。其余时间本脚本在页面上零 DOM footprint ——
     它要在用户的每一个标签页里常驻,不能白占。
     ====================================================================== */

  function mount() {
    if (host && host.isConnected) return;

    // 自定义标签名,宿主页的选择器几乎不可能命中
    host = document.createElement('sr-overlay-host');
    // position:fixed + 0 尺寸:完全脱离文档流,不可能影响宿主页布局。
    // 注意**不能用 display:none** —— 祖先 display:none 会把整棵子树移出
    // 盒树,Top Layer 也救不回来,里面的东西根本不会渲染。
    host.style.cssText =
      'all: initial !important; position: fixed !important;' +
      'width: 0 !important; height: 0 !important;' +
      'top: 0 !important; left: 0 !important;' +
      'pointer-events: none !important; z-index: 0 !important;';

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    /* ── 预告条 ── */
    bar = document.createElement('div');
    bar.id = 'bar';
    bar.setAttribute('popover', 'manual');     // 非模态:页面不会被 inert
    bar.setAttribute('role', 'status');
    // host 是 pointer-events:none,这里收回来,否则整条点不动
    bar.style.pointerEvents = 'auto';
    bar.innerHTML =
      '<span class="sr-emoji"></span>' +
      '<span class="sr-text"></span>' +
      '<span class="sr-count" hidden></span>' +
      '<span class="sr-hint"></span>' +
      '<i class="sr-line"></i>';
    bar.addEventListener('click', () => requestPostpone('click'));

    /* ── 休息遮罩 ── */
    dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '休息提醒');
    dialog.tabIndex = -1;
    dialog.style.pointerEvents = 'auto';

    iframe = document.createElement('iframe');
    iframe.setAttribute('aria-label', '休息提醒');
    iframe.setAttribute('scrolling', 'no');
    iframe.src = BREAK_URL;

    dialog.appendChild(iframe);
    shadow.append(style, bar, dialog);
    document.documentElement.appendChild(host);

    // 反制点②:自愈。宿主页(或某些洁癖脚本)把我们的节点删了就挂回去。
    healer = new MutationObserver(() => {
      if (!host || host.isConnected) return;
      if (!overlayOpen && !barOpen) return;
      document.documentElement.appendChild(host);
      // 重新挂载后已不在 Top Layer,必须再 show 一次
      if (overlayOpen) reassertTopLayer();
      if (barOpen) { try { bar?.showPopover(); } catch { /* noop */ } }
    });
    healer.observe(document.documentElement, { childList: true });

    // 反制点①:页面元素进入全屏会被放进 Top Layer 且排在我们之后 → 盖住我们
    document.addEventListener('fullscreenchange', onFullscreenChange, true);
    document.addEventListener('keydown', onHostKeyDown, true);
    dialog.addEventListener('cancel', (e) => e.preventDefault());
  }

  function unmount() {
    clearTimeout(closeTimer);
    clearTimeout(barTimer);
    clearTimeout(loadTimer);
    cancelAnimationFrame(barRaf);
    barRaf = 0;
    healer?.disconnect();
    healer = null;
    document.removeEventListener('fullscreenchange', onFullscreenChange, true);
    document.removeEventListener('keydown', onHostKeyDown, true);
    try { dialog?.close(); } catch { /* 未 open 时 close 会抛 */ }
    try { bar?.hidePopover(); } catch { /* 未 show 时同理 */ }
    host?.remove();
    host = shadow = dialog = iframe = bar = null;
  }

  /** 两个浮层都关掉之后才真的拆掉宿主节点 */
  function unmountIfIdle() {
    if (!overlayOpen && !barOpen) unmount();
  }

  /* ========================================================================
     Top Layer 抢回
     ====================================================================== */

  function reassertTopLayer() {
    if (!dialog || !host?.isConnected) return;
    dialog.classList.add('sr-noanim');
    try { dialog.close(); } catch { /* noop */ }
    try { dialog.showModal(); } catch { /* noop */ }
    dialog.focus();
    requestAnimationFrame(() => dialog?.classList.remove('sr-noanim'));
  }

  function onFullscreenChange() {
    if (overlayOpen) reassertTopLayer();
    // popover 不受全屏影响到同等程度,但重新 show 一次代价极小
    if (barOpen) { try { bar?.showPopover(); } catch { /* 已经在顶层 */ } }
  }

  /* ========================================================================
     键盘
     ====================================================================== */

  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
  }

  function onHostKeyDown(e) {
    /* ── 休息中:拦住 Esc ──
       焦点通常在 iframe 内(由 break.js 处理),但也可能留在宿主文档。
       不 stopPropagation —— 宿主页自己的 Esc 逻辑与我们无关,
       我们只要阻止它变成一个 close request 即可。 */
    if (overlayOpen && e.key === 'Escape') { e.preventDefault(); return; }

    if (!barOpen || barHoldUntil) return;

    /* ── 预告中:正在输入 → 自动延迟 ──
       P4:静默的智能行为必须可见。延迟了就要说出来,否则用户以为它坏了。 */
    if (isEditable(document.activeElement)) {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      requestPostpone('typing');
      return;
    }

    /* ── 预告中:空格 → 延迟 ──
       这里必须 preventDefault,否则页面会同时滚动一屏 ——
       「延迟了」和「页面跳走了」一起发生会很懵。
       代价是预告那几秒内空格不能滚页面;条上明写着这个绑定,可接受。 */
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      requestPostpone('space');
    }
  }

  /* ========================================================================
     延迟
     ====================================================================== */

  let postponing = false;

  function requestPostpone(source) {
    if (!barOpen || postponing) return;
    postponing = true;

    if (source === 'typing') {
      // 停留 2 秒把话说清楚再走
      barHoldUntil = Date.now() + AUTO_HOLD;
      setBarMessage('⌨️', '正在输入,已自动延后');
      clearTimeout(barTimer);
      barTimer = setTimeout(() => { barHoldUntil = 0; hideBar(); }, AUTO_HOLD);
    } else {
      hideBar();                               // 用户主动按的,立刻走,要跟手
    }

    if (alive()) {
      chrome.runtime.sendMessage({ type: 'POSTPONE' }).catch(() => { /* SW 正在回收 */ });
    }
  }

  function setBarMessage(emoji, text) {
    if (!bar) return;
    bar.querySelector('.sr-emoji').textContent = emoji;
    bar.querySelector('.sr-text').textContent = text;
    bar.querySelector('.sr-count').hidden = true;
    bar.querySelector('.sr-hint').textContent = '';
    cancelAnimationFrame(barRaf);
    barRaf = 0;
    /** @type {HTMLElement} */ (bar.querySelector('.sr-line')).style.transform = 'scaleX(0)';
  }

  /* ========================================================================
     预告条:显示 / 隐藏
     ====================================================================== */

  async function showBar(rt) {
    mount();
    if (!bar) return;

    const map = await loadIdeas();
    if (!bar) return;                          // 等 import 的工夫可能已经拆了
    const idea = map?.[rt.currentIdeaId];

    bar.querySelector('.sr-emoji').textContent = idea?.emoji ?? '⏱';
    bar.querySelector('.sr-text').textContent =
      idea ? `马上休息:${idea.action.zh}` : '马上休息一下';

    // 「已延迟 ×1」没有信息量,第 2 次起才显示
    const badge = /** @type {HTMLElement} */ (bar.querySelector('.sr-count'));
    badge.hidden = !(rt.postponeCount >= 2);
    badge.textContent = `已延迟 ×${rt.postponeCount}`;

    bar.querySelector('.sr-hint').innerHTML =
      '<span class="sr-key">空格</span>延迟';

    if (!barOpen) {
      barOpen = true;
      postponing = false;
      try { bar.showPopover(); } catch { /* 已经显示 */ }
      bar.classList.remove('sr-bar-out');
      // 让 translateY(-100%) 先落地一帧,再切到 0,否则不会有滑入动画
      requestAnimationFrame(() => requestAnimationFrame(() => bar?.classList.add('sr-bar-in')));
    }

    startBarProgress(rt);
  }

  /** 底边细线:读绝对时间戳每帧直写,和遮罩里的进度条同一套做法 */
  function startBarProgress(rt) {
    cancelAnimationFrame(barRaf);
    const line = /** @type {HTMLElement|null} */ (bar?.querySelector('.sr-line'));
    const endsAt = rt.prenoticeEndsAt;
    if (!line || !endsAt) return;

    // 分母用 background 写的 prenoticeStartedAt,绝不用"第一次看到它的时刻"——
    // 中途打开的标签页那样算会从满格重新走一遍
    const total = Math.max(1, endsAt - (rt.prenoticeStartedAt ?? (endsAt - 8000)));

    const tick = () => {
      if (!barOpen || barHoldUntil) { barRaf = 0; return; }
      const left = endsAt - Date.now();
      line.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total)).toFixed(4)})`;
      if (left <= 0) {
        barRaf = 0;
        // ⭐ 预告只有 8 秒,而 chrome.alarms 最小 30 秒 —— 闹钟管不了这个过渡。
        // 页面侧到点主动推一把,background 那边是幂等的,多个标签页同时推也没事。
        if (alive()) chrome.runtime.sendMessage({ type: 'RECONCILE' }).catch(() => {});
        return;
      }
      barRaf = requestAnimationFrame(tick);
    };
    barRaf = requestAnimationFrame(tick);
  }

  function hideBar() {
    if (!barOpen) return;
    barOpen = false;
    cancelAnimationFrame(barRaf);
    barRaf = 0;
    const el = bar;
    if (!el) { unmountIfIdle(); return; }
    el.classList.remove('sr-bar-in');
    el.classList.add('sr-bar-out');
    clearTimeout(barTimer);
    barTimer = setTimeout(() => {
      try { el.hidePopover(); } catch { /* noop */ }
      unmountIfIdle();
    }, BAR_OUT);
  }

  /* ========================================================================
     休息遮罩:显示 / 隐藏
     ====================================================================== */

  function showOverlay() {
    if (overlayOpen) return;
    overlayOpen = true;
    clearTimeout(closeTimer);
    mount();
    if (!dialog || !iframe) return;

    dialog.classList.remove('sr-closing');

    // 等 iframe 真的加载完再掀开,否则会先闪一下空白框。
    // 扩展页面走本地磁盘,通常 <50ms;给 400ms 兜底防止 load 不触发。
    let opened = false;
    const reveal = () => {
      if (opened || !overlayOpen || !dialog) return;
      opened = true;
      clearTimeout(loadTimer);
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* 已在 Top Layer */ }
      }
      // 焦点给 dialog 自己,不让任何按钮被自动聚焦而画出焦点环
      dialog.focus();
    };
    iframe.addEventListener('load', reveal, { once: true });
    loadTimer = setTimeout(reveal, IFRAME_LOAD_TIMEOUT);
  }

  function hideOverlay() {
    if (!overlayOpen) return;
    overlayOpen = false;
    clearTimeout(loadTimer);
    if (!dialog || !dialog.open) { unmountIfIdle(); return; }

    dialog.classList.add('sr-closing');
    closeTimer = setTimeout(() => {
      try { dialog?.close(); } catch { /* noop */ }
      unmountIfIdle();
    }, FADE_OUT);
  }

  /* ========================================================================
     拉模式:storage 是真相源
     ------------------------------------------------------------------------
     不用 chrome.tabs.sendMessage 推 —— 推模式有四个独立失败点
     (SW 已回收 / 标签页未注入 / 页面 bfcache / 新开标签页错过广播)。
     storage.onChanged 对所有已注入的文档同时到达,天然幂等。
     ====================================================================== */

  /** @param {any} rt */
  function apply(rt) {
    lastRuntime = rt;
    const now = Date.now();

    // 过期保护:background 若意外死掉,不能留一个永远不消失的浮层
    const breaking = !!rt && rt.phase === 'breaking'
      && typeof rt.breakEndsAt === 'number' && rt.breakEndsAt > now;
    const prenotice = !!rt && rt.phase === 'prenotice'
      && typeof rt.prenoticeEndsAt === 'number' && rt.prenoticeEndsAt > now;

    if (breaking) { hideBar(); showOverlay(); return; }
    hideOverlay();

    if (prenotice) { showBar(rt); return; }
    if (!barHoldUntil) hideBar();     // 自动延迟提示还在显示时,别抢着收走
  }

  function onStorageChanged(changes, area) {
    if (!alive()) { teardown(); return; }
    if (area !== 'local' || !changes[RT_KEY]) return;
    apply(changes[RT_KEY].newValue);
  }
  chrome.storage.onChanged.addListener(onStorageChanged);

  // 首次注入时对齐一次 —— 休息中途打开的新标签页、以及被补注入的旧标签页,
  // 都要立刻和真相源对齐,而不是干等下一次 onChanged
  chrome.storage.local.get(RT_KEY)
    .then((got) => apply(got[RT_KEY]))
    .catch(() => { /* 上下文已失效 */ });

  /* ========================================================================
     iframe → content script 的即时信号
     ------------------------------------------------------------------------
     权威路径仍然是 storage(background 写 → onChanged → apply),
     这条 postMessage 只是让淡出**立刻**开始,不用等 service worker 被唤醒
     (冷启动可能 100~200ms,长按走满后干等那么久会觉得卡住)。
     它不参与任何状态决定,丢了也不影响正确性。
     ====================================================================== */
  function onIframeMessage(e) {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (!d || d.__sr !== 1) return;
    if (d.type === 'FINISH') hideOverlay();
  }
  window.addEventListener('message', onIframeMessage);

  /* ========================================================================
     拆卸
     ------------------------------------------------------------------------
     暴露给**下一个**注入实例调用。没有它的话,扩展重载后页面上会同时存在
     两份监听器,而旧那份的 chrome.* 全是坏的。
     ====================================================================== */
  function teardown() {
    overlayOpen = false;
    barOpen = false;
    barHoldUntil = 0;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* noop */ }
    window.removeEventListener('message', onIframeMessage);
    unmount();
    try { delete window.__SR_TEARDOWN__; } catch { /* noop */ }
  }
  window.__SR_TEARDOWN__ = teardown;
})();
