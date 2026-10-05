# SimpleReminder

> 一个节拍器,每隔一段时间从你勾选的休息方式里随机抽一个,**全屏**推到你面前,按住一秒可以跳过。

一个 Chrome 扩展形态的健康休息提醒工具。无账号、无服务端、无数据上传。

---

## 当前状态

**完整的一轮已经跑通了:** 预告条滑下来 → 你可以按空格延迟 → 不延迟就全屏
→ 按住一秒可以跳过 → 按正常间隔排下一轮。

实现顺序中的第 1、2、3、4、6 步完成。剩下 idle 检测 + badge(第 5 步)和埋点展示。

| 文档 | 内容 |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品方案(封板)· 设计原则 · 功能规格 · 版本范围 · 被否决方案记录 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术选型 · 三大难题解法 · 数据模型 · 决策记录 |

---

## 核心设计速览

**全屏遮挡是功能本身,不是通知的载体。**
角落弹窗说「该看远处了」,用户瞥一眼点掉继续盯屏幕 —— 功能完全没有发生。

| 难题 | 解法 |
|---|---|
| 现代网页 `transform` / `filter` 导致 z-index 失效 | 放弃 z-index,用原生 `<dialog>.showModal()` 的 **Top Layer**;预告条用 `popover`(非模态) |
| 网页 CSS 变量穿透 Shadow DOM | 不用 Shadow DOM 承载 UI,改用 **扩展页 iframe** —— 独立 document,连继承都不存在 |
| MV3 Service Worker 被回收 | **Storage 是真相源**,`chrome.alarms` 只是叫醒服务;幂等 `reconcile()` 自愈补偿 |
| 多标签页各自随机导致双屏显示不同内容 | **每次休息只决定一次的事,一律在 background 决定并写 storage**;iframe 只是显示器 |

**技术栈:** 原生 MV3,零构建 · JSDoc + `@ts-check` · `chrome.alarms` + `chrome.idle` · 原生 `<dialog>` / `popover`
(封板时选的是 WXT + React + Tailwind,实现阶段改为原生 —— 理由见
[ARCHITECTURE §1.1](docs/ARCHITECTURE.md#11-偏离记录wxt--react--tailwind--原生零构建))

---

## 安装(开发版)

不需要 `npm install`,没有构建步骤。

1. 打开 `chrome://extensions`
2. 右上角打开「**开发者模式**」
3. 点「**加载已解压的扩展程序**」,选这个仓库的根目录
4. 点工具栏里的 SimpleReminder 图标 → 弹出 popup

popup 里能看到**下次休息的时刻和实时倒计时**。点「立即休息」会马上
全屏盖上,20 秒后自动消失 —— **按住「按住跳过」一秒**,或者
**按住 `Esc` 一秒**,可以提前结束。

到点前 8 秒会先有一条**预告条**压在网页顶上。这几秒里:
**按空格**(或点那条)= 延迟 5 分钟;**如果你正在输入框里打字,它会自动延后**
并把这件事写在条上 —— 静默的智能行为会摧毁信任,所以它必须说出来。

> 遮罩盖不住 `chrome://` 开头的页面、Chrome 应用商店和 PDF 阅读器 ——
> 这是 Chrome 的限制,不是 bug。见 [ARCHITECTURE §9](docs/ARCHITECTURE.md)。

### 只在部分网站生效?

如果某些标签页毫无反应,**先在 `chrome://extensions` 点一下扩展卡片上的刷新按钮**。

Chrome 只在页面**加载时**注入 content script,安装和更新都不算导航 ——
所以装扩展时已经开着的标签页会漏掉。扩展现在会在安装 / 更新 / 启用时
自动给已打开的标签页补注入,但如果你是直接覆盖文件后手动重载扩展,
偶尔还是需要刷一下页面。

### 怎么确认「它真的会自己响」

⚠️ **点图标 ≠ 验证调度器。** 点图标 / 点「立即休息」是手动触发,
它从第一版起就能用。调度器要验的是**你不操作它也会响**:

1. 在 popup 里把**间隔改成 1**(分钟),焦点离开输入框即生效
2. **关掉 popup,什么都别点**
3. 看着工具栏图标等一分钟 —— 遮罩应该自己盖上来

改完间隔后重新打开 popup,「下次休息」的时刻应该已经重算成一分钟后,
而不是沿用旧的 20 分钟。那一行就是调度器在工作的证据。

### 测试

```bash
node test/run.mjs
```

零依赖,不需要 `npm install`。112 条断言,覆盖状态机、补齐逻辑、
睡眠唤醒三场景、延迟计数、并发去重、重复注入、展示函数。

> 这是**跑在 Node 里的单元测试**,和你浏览器里装的那个扩展实例没有关系 ——
> 它验的是代码逻辑对不对,不是「这次安装有没有生效」。

### 更深的调试

`chrome://extensions` → SimpleReminder 卡片上的「**Service Worker**」链接
→ Console。下面这些是 **JS,粘在那个控制台里**,不是终端命令:

```js
chrome.storage.local.get('runtime', console.log);   // 当前状态机
chrome.alarms.getAll(console.log);                  // 唯一的那个闹钟
chrome.storage.local.get('stats', console.log);     // 按条目的埋点
```

### 不装扩展也能看

```bash
python3 -m http.server 8080      # 在仓库根目录
```

打开 `localhost:8080/demo/` —— popup、预告条、休息屏都能真跑
(假的 chrome API + **真实的** `popup.js` / `content.js`),
调视觉不用反复重载扩展。预告条那页还带一个输入框,专门用来试自动延迟。



---

## v0.1 范围(自用两周验证)

```
✓ 单 timer:间隔 + 时长,popup 里直接改
✓ 全屏遮罩(dialog + iframe),三条内容勾选 + 洗牌袋随机
✓ 预告条:通栏贴顶,空格延迟,输入中自动延迟(可见)
✓ 长按 1 秒跳过(拦截 Esc)
✓ idle 自然休息检测 · 暂停 · 立即休息 · Badge 倒计时
✓ 按条目埋点(不展示)
```

目的不是发布,是**自用两周**暴露纸上谈兵的部分。

---

## 下一步

**`chrome.idle` 自然休息检测 + badge。**

离开电脑超过一段时间就等于已经休息过了,回来不该立刻被糊一脸 ——
目前只有一条「迟到超过 2 分钟就重置周期」的粗兜底,接上 `chrome.idle`
才算真的解决。badge 则是「这扩展还活着」在浏览器里唯一的常驻信号。
