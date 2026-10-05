# SimpleReminder

> 一个节拍器,每隔一段时间从你勾选的休息方式里随机抽一个,**全屏**推到你面前,按住一秒可以跳过。

一个 Chrome 扩展形态的健康休息提醒工具。无账号、无服务端、无数据上传。

---

## 当前状态

**可以装进 Chrome 跑了** —— 遮罩链路已打通(实现顺序 7 步中的第 1、2 步完成)。
调度器还没做,所以目前只能手动触发:**点工具栏图标 = 立即休息一次。**

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
4. 随便打开一个网页,**点一下工具栏里的 SimpleReminder 图标**

应该立刻全屏盖上一层休息屏,20 秒后自动消失。
**按住「按住跳过」一秒**,或者**按住 `Esc` 一秒**,可以提前结束。

> 遮罩盖不住 `chrome://` 开头的页面、Chrome 应用商店和 PDF 阅读器 ——
> 这是 Chrome 的限制,不是 bug。见 [ARCHITECTURE §9](docs/ARCHITECTURE.md)。

### 想单独调这一屏的视觉

`demo/break-stand.html` 是不接任何扩展逻辑的单文件原型,浏览器直接打开即可,
按 `D` 调出参数面板。

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

**第 3 步:`background.js` 的 `reconcile()` + 单一 `next-wake` alarm。**

现在的 background 是个最小可测版本 —— 会抽内容、会埋点、会按正常间隔重排,
但**没有闹钟**,所以不会自己响。接上调度器之后,它才真的成为一个节拍器。
