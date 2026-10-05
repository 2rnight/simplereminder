// @ts-check
/* ============================================================================
   SimpleReminder · content script
   ----------------------------------------------------------------------------
   职责边界:**只管遮罩的生命周期,不含任何业务判断。**
   不抽内容、不算下一次时间、不记统计 —— 那些全在 background。
   这里唯一的输入是 chrome.storage.local 里的 runtime.phase。

   架构三件套(ARCHITECTURE §2):

     页面 DOM └─ <sr-overlay-host>(closed shadow root,挂 documentElement)
                  └─ <dialog>                ← 只负责 Top Layer
                     └─ <iframe break.html>  ← UI 本体,扩展页面

   iframe 而不是 Shadow DOM 承载 UI:宿主页 CSS 一行都进不来,
   `all: initial` 不重置自定义属性那套坑整体消失。

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

  /** iframe 没按时 load 时的兜底:不能让用户等一个空白遮罩 */
  const IFRAME_LOAD_TIMEOUT = 400;

  /** 遮罩底色 —— 与 break.html 同色,遮住 iframe 加载那一两帧的空隙 */
  const FALLBACK_BG = 'hsl(32 38% 8%)';

  let /** @type {HTMLElement|null}   */ host     = null;
  let /** @type {ShadowRoot|null}    */ shadow   = null;
  let /** @type {HTMLDialogElement|null} */ dialog = null;
  let /** @type {HTMLIFrameElement|null} */ iframe = null;
  let /** @type {MutationObserver|null}  */ healer = null;

  let wantOpen   = false;   // 真相源的意图
  let closeTimer = 0;
  let loadTimer  = 0;

  /* ========================================================================
     Shadow 样式
     ------------------------------------------------------------------------
     dialog 用 position:fixed + inset:0,**不用 100vw/100vh**。
     100vw 含滚动条宽度,会比可视区宽出十几像素,在有滚动条的页面上
     可能给文档撑出横向滚动。inset:0 精确等于视口。
     ====================================================================== */
  const SHADOW_CSS = `
    :host { all: initial !important; }

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
    /* 焦点落在 dialog 上,但不要画 UA 焦点环 */
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

    @media (prefers-reduced-motion: reduce) {
      dialog, dialog::backdrop { animation: none !important; }
    }
  `;

  /* ========================================================================
     挂载 / 卸载
     ------------------------------------------------------------------------
     只在真正休息时才存在。其余时间本脚本在页面上零 DOM footprint ——
     它要在用户的每一个标签页里常驻,不能白占。
     ====================================================================== */

  function mount() {
    if (host && host.isConnected) return;

    // 自定义标签名,宿主页的选择器几乎不可能命中
    host = document.createElement('sr-overlay-host');
    // position:fixed + 0 尺寸:完全脱离文档流,不可能影响宿主页布局。
    // 注意**不能用 display:none** —— 祖先 display:none 会把整棵子树移出
    // 盒树,Top Layer 也救不回来,dialog 根本不会渲染。
    host.style.cssText =
      'all: initial !important; position: fixed !important;' +
      'width: 0 !important; height: 0 !important;' +
      'top: 0 !important; left: 0 !important;' +
      'pointer-events: none !important; z-index: 0 !important;';

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '休息提醒');
    dialog.tabIndex = -1;                       // 让 dialog 自己持有初始焦点
    dialog.style.pointerEvents = 'auto';        // host 是 none,这里收回来

    iframe = document.createElement('iframe');
    iframe.setAttribute('aria-label', '休息提醒');
    iframe.setAttribute('scrolling', 'no');
    iframe.src = BREAK_URL;

    dialog.appendChild(iframe);
    shadow.append(style, dialog);
    document.documentElement.appendChild(host);

    // 反制点②:自愈。宿主页(或某些洁癖脚本)把我们的节点删了就挂回去。
    healer = new MutationObserver(() => {
      if (!wantOpen || !host) return;
      if (!host.isConnected) {
        document.documentElement.appendChild(host);
        // 重新挂载后 dialog 已不在 Top Layer,必须再 showModal 一次
        reassertTopLayer();
      }
    });
    healer.observe(document.documentElement, { childList: true });

    // 反制点①:页面元素进入全屏会被放进 Top Layer 且排在我们之后 → 盖住我们
    document.addEventListener('fullscreenchange', onFullscreenChange, true);

    // Esc 兜底:正常情况下焦点在 iframe 内,由 break.js 处理;
    // 万一焦点留在宿主文档,这里也要挡住 Chrome 的 CloseWatcher。
    document.addEventListener('keydown', onHostKeyDown, true);
    dialog.addEventListener('cancel', (e) => e.preventDefault());
  }

  function unmount() {
    clearTimeout(closeTimer);
    clearTimeout(loadTimer);
    healer?.disconnect();
    healer = null;
    document.removeEventListener('fullscreenchange', onFullscreenChange, true);
    document.removeEventListener('keydown', onHostKeyDown, true);
    try { dialog?.close(); } catch { /* 未 open 时 close 会抛,忽略 */ }
    host?.remove();
    host = shadow = dialog = iframe = null;
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
    if (!wantOpen || !dialog) return;
    // 进全屏和退全屏都重新抢一次,顺序问题一次解决
    reassertTopLayer();
  }

  function onHostKeyDown(e) {
    if (e.key !== 'Escape' || !wantOpen) return;
    // 不 stopPropagation —— 宿主页自己的 Esc 逻辑与我们无关,
    // 我们只要阻止它变成一个 close request 即可。
    e.preventDefault();
  }

  /* ========================================================================
     显示 / 隐藏
     ====================================================================== */

  function showOverlay() {
    if (wantOpen) return;
    wantOpen = true;
    clearTimeout(closeTimer);
    mount();
    if (!dialog || !iframe) return;

    dialog.classList.remove('sr-closing');

    // 等 iframe 真的加载完再掀开,否则会先闪一下空白框。
    // 扩展页面走本地磁盘,通常 <50ms;给 400ms 兜底防止 load 不触发。
    let opened = false;
    const reveal = () => {
      if (opened || !wantOpen || !dialog) return;
      opened = true;
      clearTimeout(loadTimer);
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* 已在 Top Layer */ }
      }
      // 焦点给 dialog,再由它交给 iframe —— 不让任何按钮被自动聚焦而画出焦点环
      dialog.focus();
    };
    iframe.addEventListener('load', reveal, { once: true });
    loadTimer = setTimeout(reveal, IFRAME_LOAD_TIMEOUT);
  }

  function hideOverlay() {
    if (!wantOpen) return;
    wantOpen = false;
    clearTimeout(loadTimer);
    if (!dialog || !dialog.open) { unmount(); return; }

    dialog.classList.add('sr-closing');
    closeTimer = setTimeout(unmount, FADE_OUT);
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
    // breakEndsAt 过期保护:background 若意外死掉,不能留一个永远不消失的遮罩
    const breaking =
      !!rt && rt.phase === 'breaking' &&
      typeof rt.breakEndsAt === 'number' && rt.breakEndsAt > Date.now();

    if (breaking) showOverlay();
    else hideOverlay();
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
    wantOpen = false;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* noop */ }
    window.removeEventListener('message', onIframeMessage);
    unmount();
    try { delete window.__SR_TEARDOWN__; } catch { /* noop */ }
  }
  window.__SR_TEARDOWN__ = teardown;
})();
