# SimpleReminder

> 一个节拍器,每隔一段时间从你勾选的休息方式里随机抽一个,**全屏**推到你面前,按住一秒可以跳过。

一个 Chrome 扩展形态的健康休息提醒工具。无账号、无服务端、无数据上传。

---

## 当前状态

**产品与技术方案已封板,尚未开工。**

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

**技术栈:** WXT · React · Tailwind v4 · `chrome.alarms` + `chrome.idle` · 原生 `<dialog>` / `popover`

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

先只做一件事:**把 `break.html` 这一屏单独做出来**(普通网页,不接扩展逻辑),
浏览器直接打开,把暗度、排版、倒计时、渐暗曲线调到满意。

这一屏定了,剩下的都是管道工程。
