# SimpleReminder · 技术方案与决策记录

> 配套文档:[PRODUCT.md](./PRODUCT.md)
> 状态:选型已定,未开工 · 日期:2026-10-04

---

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | **无 · 原生 MV3,零构建** | v0.1 实测修正,见下方「§1.1 偏离记录」 |
| UI | 原生 HTML / CSS | `break.html` 与 popup 都是静态页;content script 本就是无 UI 胶水 |
| 类型 | JSDoc + `// @ts-check` | 不引入编译步骤的前提下保住数据模型的类型约束 |
| 存储 | 自写 `src/lib/storage.js` | sync / local 分家,见 §5 |
| 调度 | `chrome.alarms` | 单一 `next-wake` 闹钟 |
| 遮罩层级 | 原生 `<dialog>.showModal()` → Top Layer | 不用任何 UI 库 |
| 预告层级 | 原生 `popover` + `showPopover()` → Top Layer(非模态) | 同上 |

### 1.1 偏离记录:WXT + React + Tailwind → 原生零构建

封板时选的是 **WXT + React + Tailwind v4**。进入实现后改为原生,理由:

1. **`break.html` 已经用原生 HTML/CSS/JS 调完视觉并通过验收**,重写成 React 是
   拿已确定的东西去换不确定性,零收益。
2. **content script 文档自己定义为「无 UI 胶水」** —— 它的工作是 shadow root、
   `<dialog>`、iframe 生命周期和 Top Layer 抢夺,React 在这里一点忙帮不上。
3. **Tailwind 的价值前提是「要写很多组件」**。v0.1 一共 1 个全屏页 + 1 个 popup,
   CSS 总量两百行,工具链的维护成本高于它省下的。
4. **零构建 = `load unpacked` 直接装**,自用阶段不需要 `npm install`、
   不需要 dev server、仓库里没有 `node_modules`。

**代价与退路:** 失去 HMR、TS 编译期检查、跨浏览器打包。目录结构刻意照 WXT 的
约定摆(`src/background.js` / `src/content.js` / `src/break/` / `src/lib/`),
将来若 UI 复杂度真的上来,迁 WXT 基本是平移加一份 `wxt.config.ts`。

**这个决定在以下情况应当推翻:** 要做 options 页和统计图表(组件数量上去了)、
或要同时发 Firefox(需要跨浏览器 manifest 生成)。

---

## 2. 三大核心难题与最终解法

### 2.1 层级遮挡 → Top Layer,不打 z-index 战争

现代网页的 `transform` / `filter` / `opacity` / `contain` 会创建新的层叠上下文,
导致任何 `z-index` 都可能失效。

**解法:放弃 z-index,用浏览器的 Top Layer。**

| 需求 | API | 进 Top Layer | 背景 inert | 抢焦点 |
|---|---|---|---|---|
| **休息遮罩** | `<dialog>.showModal()` | ✅ | ✅ | ✅ |
| **预告条** | `popover="manual"` + `showPopover()` | ✅ | ❌ | ❌ |

严丝合缝:遮罩需要锁住页面,预告条需要永远在最上层但**绝对不能打断**。

两者交接天然正确 —— Top Layer 是后来者居上的栈,
预告 `hidePopover()` → 遮罩 `showModal()`,顺序不会错。同一套宿主节点管两个阶段。

**原生 `<dialog>` 免费提供:** Top Layer · `::backdrop` · 焦点陷阱 ·
子树外全部 inert(连 hit-test 都拿不到)· Esc 关闭(本项目需拦截)。

#### Top Layer 的四个反制点(必须实现)

| # | 问题 | 对策 |
|---|---|---|
| 1 | **Top Layer 是后来者居上的栈,不是永久王座**。宿主页在我们之后 `showModal()` 或 `requestFullscreen()` 就会盖住我们 | 监听 `fullscreenchange` + `MutationObserver` 观察新出现的 `dialog[open]`;检测到竞争者则 `close()` 后重新 `showModal()` 抢回栈顶 |
| 2 | **宿主页可以删掉我们**。`open` 模式 shadow root 能被 `querySelector(...).shadowRoot` 穿透,有些站点会清理可疑节点 | `closed` 模式 shadow root + 自愈型 `MutationObserver`(宿主节点被移除则重新挂载) |
| 3 | **挂载位置决定生死**。Top Layer 只保证渲染层级,不保证存在;祖先 `display:none` 或被 React 卸载则一起消失 | 宿主直接挂 `document.documentElement` 下,不挂 `document.body` 内部 |
| 4 | `::backdrop` 样式写在外面不生效 | 必须写在 shadow root 内部的样式表里 |

### 2.2 CSS 污染 → iframe,不是 Shadow DOM

**这是本项目最重要的架构决策。**

```
页面 DOM
└─ <div>  ← content script 挂的宿主(closed shadow root)
   ├─ <div popover="manual">              ← 预告条(阶段一)
   └─ <dialog>                            ← 只负责 Top Layer,别无职责
      └─ <iframe src="chrome-extension://<id>/break.html">
                                          ← 「新网页」,标准 React 应用
```

**可行性依据:** Chrome 允许 `chrome-extension://` 的 iframe **无视宿主页面的 CSP**,
只要资源声明在 `web_accessible_resources` 里。即使是 GitHub 这种
`frame-src 'self' render.githubusercontent.com` 的严格策略也拦不住 —— 这是 Chrome 有意为之,
依据是 CSP 规范中「CSP 不应干扰用户自行安装的扩展」。

> 历史上那个著名的「不能注入 iframe」bug(crbug 408932)说的是**外部 https 站点**的 iframe,
> 扩展自己的页面不受影响。

#### 它干掉了什么

| 原难题 | iframe 方案下 |
|---|---|
| 宿主页 CSS 继承污染 Shadow DOM | **彻底消失**。iframe 是独立 document,不是 shadow boundary,连继承都不存在 |
| CSS 变量穿透 Shadow DOM(`all: initial` 挡不住) | **消失** |
| `all: initial` 核弹级重置 | **不需要了** |
| Tailwind v4 的 `:root`→`:host`、shadow root 不支持 `@property` | **不存在**。iframe 里 Tailwind v4 原样可用 |
| Radix Portal 默认挂 `document.body` 会逃出 Shadow DOM | **不存在**。要用就是普通用法 |
| 原子化 CSS 防类名冲突 / Tailwind `prefix` | **问题本身消失**(没有外部类名了) |

#### 两个非显然的红利

1. **开发体验质变。** `break.html` 可直接在浏览器打开 `chrome-extension://<id>/break.html`
   当普通页面开发,HMR 正常。不再需要「改一行 → 重载扩展 → 刷新网页 → 等 20 分钟触发」。
   **这一屏一天看 24 次,需要反复打磨,调试成本的差别是决定性的。**

2. **iframe 本身就是 extension page,拥有完整 `chrome.*` API。**
   它可以自己读 `chrome.storage`、自己订阅 `onChanged`。
   → **content script 退化成约 100 行无 UI 的胶水代码**,不需要 React、不需要 Tailwind。

#### 代价与对策

| 问题 | 对策 |
|---|---|
| 每 tab 一个额外 document,20 tab = 20 份内存 | **懒加载**:平时不创建,预告期才创建,休息结束销毁 |
| iframe 加载 50-150ms,会白闪 | 预告期(8 秒)**预热**:提前创建但 `hidden` |
| 焦点要进 iframe | `iframe.focus()` + 内部 `autofocus` |
| 键盘监听分散两处 | 预告期按键在 content script;长按跳过在 iframe 内。职责清晰 |
| Firefox / Safari | Firefox `moz-extension://` 基本可用,Safari 在 CSP 页面会被拦。**只做 Chrome,无所谓** |

**附带能力:** `::backdrop` 加 `backdrop-filter: blur(20px)` + `break.html` body 背景半透明
= 「原页面被模糊 + 内容浮在上面」。对护眼不是好事(还能看见内容),但可作为主题选项。

### 2.3 后台休眠 → Storage 是真相源,alarm 只是叫醒服务

**绝不能用 `setTimeout`** —— MV3 Service Worker 约 30 秒无活动即被回收。

但也**不要「一个提醒 = 一个 alarm」**:alarm 数量膨胀、持久性 Chrome 不保证、改时间要先 clear 再 create。

#### 单一 `next-wake` 闹钟 + 幂等 reconcile

```
reconcile():
  now = Date.now()
  if (抑制条件命中) → 重置周期,重算下次,return
  if (state.nextFireAt <= now && phase === 'idle')
     → phase = 'prenotice'
     → currentIdeaId = 洗牌袋取一个
     → 写 storage
  重算 nextWake = min(下一个需要醒来的时间点)
  alarms.clear('next-wake'); alarms.create('next-wake', { when: nextWake })
```

在**四个入口**调用:`onAlarm` / `onStartup` / `onInstalled` / `storage.onChanged`。

> **闹钟不再是真相,只是一个叫醒服务。** 丢了、没持久化、没按时响 —— 下次 SW 因任何原因醒来
> (用户点 popup、收到消息),`reconcile()` 都会把漏掉的补上。
> 「电脑休眠唤醒」在这个模型下不是特例,就是普通路径。

**两个必须遵守的实现细节:**

- `chrome.alarms.onAlarm.addListener` **必须写在 SW 顶层同步注册**。
  放在 `async` 函数里会在冷启动时静默丢事件。
- `reconcile()` 对同一次休息跑两次不能触发两次 —— 靠 `phase` 状态机保证幂等。

---

## 3. 数据流:拉模式,不是推模式

**❌ 不用的方案:** `Popup 写 storage + 建 alarm → BG 收 alarm → chrome.tabs.sendMessage 广播 → CS 收消息`

四个独立失败点:
1. 目标 tab 没有 content script(`chrome://` / Web Store / PDF / 安装前就打开的旧 tab)→ **提醒静默丢失**
2. 广播给全部 tab 则切过去每个都弹;只发 active tab 则用户切 tab 后提醒消失
3. 消息是瞬时的,休息中新开的页面完全不知道「现在有个提醒没被确认」
4. 休眠唤醒时 SW 冷启动 + tab 未恢复,`sendMessage` 成功率最低 —— 而这恰是最需要可靠的时刻

**✅ 采用的方案:Storage 是唯一真相源,content script 订阅状态而非接收事件**

```
Popup   → 写 Settings 到 storage
BG      → reconcile():改 RuntimeState.phase,写 storage
CS      → 订阅 storage.onChanged → 创建/销毁 popover 与 dialog
iframe  → 自己订阅 storage,渲染 currentIdea 与倒计时
用户操作 → 写回 storage → BG 的 onChanged 重算
```

`chrome.storage.onChanged` 天然广播到**所有** context,不需要遍历 tab。因为状态是**持久**而非瞬时的:

- 用户切 tab / 开新页 → 新 content script 挂载时读 storage,发现在休息中 → **自动补上**
- 目标 tab 无法注入 → 切到任何可注入页面都会看到
- 休眠唤醒 → 只需把状态改对,不需保证任何消息投递成功。**从「必须送达」降级为「最终一致」**

`sendMessage` 可保留作为「让某个 tab 更快响应」的加速器,**不作为主链路**,挂了不影响正确性。

---

## 4. ⭐ 架构原则:每次休息只决定一次的事,必须在 background 决定

content script 在**每个标签页各跑一份**。若让 `break.html` 自己抽内容:

```
左屏 Notion  → 抽到 👁 看看远处
右屏 GitHub  → 抽到 💧 喝杯水        ← 同一次休息,两块屏让你做两件事
```

更糟的变体:休息中切标签页 → 又抽一次;休息中新开页面 → 又抽一次;两个 Chrome 窗口 → 各抽各的。

> **凡是「每次休息只应该发生一次」的决定,都在 background 做并写进 storage;
> iframe 只是一块显示器,不做任何判断。**

受这条原则管辖的字段:

| 字段 | 不遵守会怎样 |
|---|---|
| `currentIdeaId` | 多窗口显示不同内容 |
| `breakEndsAt`(**绝对时间戳**,不是剩余秒数) | 休息到第 8 秒时新开的标签页会从 20 秒重新倒数 |
| `postponeCount` | 两块屏显示的延迟次数不一样 |

**这条原则一旦遵守,多窗口、多显示器、休息中切标签页全都自动正确,一行特殊处理都不用写。**

---

## 5. 数据模型

### Settings — `chrome.storage.sync`(跨设备)

```ts
{
  intervalMinutes: 20,
  durationSeconds: 20,
  preNoticeSeconds: 8,            // 0/5/8/12/15
  postponeMinutes: 5,
  skipHoldMs: 1000,
  preNoticePosition: 'top',       // v0.1 固定 top
  interruptFullscreenVideo: false,
  idleResetSeconds: 60,           // 实际取 max(durationSeconds, 60)
  ideas: [                        // 用户勾选状态
    { id: 'stand', enabled: true  },
    { id: 'eyes',  enabled: false },
    { id: 'water', enabled: false },
  ],
  theme: 'dark', brightness: 0.85,  // v0.2
}
```

### RuntimeState — `chrome.storage.local`(本机)

```ts
{
  phase: 'idle' | 'prenotice' | 'breaking',
  nextFireAt: 1759564800000,
  breakStartedAt: null,           // ⭐ 绝对时间戳 —— 进度条的分母
  breakEndsAt: null,              // ⭐ 绝对时间戳
  currentIdeaId: null,            // ⭐ background 抽,全窗口共享
  postponeCount: 0,               // ⭐
  pausedUntil: null,
  ideaBag: ['eyes', 'water'],     // 洗牌袋剩余队列
}
```

### Stats — `chrome.storage.local`(保留 30 天,自动清理)

```ts
{
  "2026-10-04": {
    stand: { completed: 12, skipped: 1, postponed: 3 },
    eyes:  { completed: 6,  skipped: 0, postponed: 1 },
  }
}
```

### ⚠️ sync / local 分家的理由

`chrome.storage.sync` 限制:**单项 8KB · 总共 100KB · 每小时 1800 次写入**。

- 运行时状态若放 sync:**A 电脑的闹钟会同步过去打乱 B 电脑的计时**,且这种 bug 极难排查
- 统计/自定义内容若放 sync:很可能撑爆,**而且撑爆时是静默失败**

补救:v1.0 加「导出 / 导入配置 JSON」按钮(约 10 行),解决「换电脑配置全丢」。

### 内容条目(打包在扩展内)

```ts
BreakIdea {
  id: 'stand',
  emoji: '🧍',
  action: { zh: '站起来,走两步', en: '' },   // i18n 结构 v0.1 就留好
  hint:   { zh: '让腰背松一松',   en: '' },   // 允许为空
  bg:     '32 38% 8%',                        // 遮罩底色,HSL 三元组
  accent: '#e8a33d',                          // 进度环等强调色
  animation?: 'stand-up',                     // v0.2
}
```

原本是单个 `color` 字段。实现时发现遮罩需要**两个**色值:大面积的深色背景
和小面积的高亮强调色,二者不是同一个色阶上的点,派生不出来,故拆成
`bg` / `accent`。`bg` 写成 HSL 三元组是为了能直接塞进 `hsl(var(--bg))`。

**无 `category` 字段** —— 3 条谈不上批量操作,主题色/动画直接挂条目上。
**无 `minSeconds` 字段** —— 遮罩是触发器不是容器,改为撰稿规范约束。

---

## 6. 目录结构

```
manifest.json
src/
  background.js        reconcile() · 单 alarm · idle 监听 · badge · 通知兜底
  content.js           无 UI 胶水:订阅 storage → 管 popover / dialog / iframe 生命周期
  break/
    break.html         ⭐ 遮罩本体(iframe 内的扩展页面)
    break.css
    break.js
  popup/               倒计时 · 勾选 · 间隔时长 · 立即休息 · 暂停(第 6 步)
  lib/
    storage.js         Settings / RuntimeState / Stats 的读写封装 + 默认值
    ideas.js           内置 3 条内容
    scheduler.js       reconcile · 洗牌袋 · 抑制条件判定(第 3 步拆出)
demo/
  break-stand.html     调视觉用的单文件原型,不属于扩展
docs/
  PRODUCT.md  ARCHITECTURE.md
```

**`web_accessible_resources` 必须同时包含 `src/break/*` 和 `src/lib/*`** ——
`break.html` 是 ES module,它 `import` 的 `lib/` 文件是独立的子资源请求,
漏掉 `lib/*` 会在某些加载路径下被拦住。

⚠️ content script 是**传统脚本,不支持 `import`**(MV3 不允许
`"type": "module"` 的 content script)。所以 `src/content.js` 必须自包含,
它用到的 storage key 是手写常量,与 `lib/storage.js` 重复定义 —— 改 key
时两边都要改。

---

## 7. 权限

```jsonc
{
  "permissions": ["alarms", "storage", "idle", "notifications", "scripting"],
  "host_permissions": ["<all_urls>"],
  "web_accessible_resources": [
    { "resources": ["break.html", "assets/*"], "matches": ["<all_urls>"] }
  ]
}
```

- `scripting` 用途单一:**给安装 / 更新时已经开着的标签页补注入 content script**。
  Chrome 只在页面加载时注入声明式 content script,不补注入已有标签页
- `<all_urls>` 是审核重点,理由写清:**「注入休息覆盖层,不读取任何页面内容」**
- **初版就按上架标准申请**,别先 optional 再改(改权限模型要重新过审)

---

## 8. 决策记录:被否决的技术方案

| 方案 | 否决理由 |
|---|---|
| **Plasmo** | 2025-09 起未发版,open issue 300+,团队转向商业产品;卡在旧版 Parcel,**不支持 Tailwind v4**。其唯一不可替代的 CSUI 在 iframe 方案下价值归零 → 改用 WXT |
| **Radix UI Dialog 做遮罩** | **事实错误**:Radix Dialog 是 Portal + `<div role="dialog">`,**不用原生 `<dialog>`,不进 Top Layer**(radix-ui/primitives#2857 至今 open)。且其 Portal 默认挂 `document.body`,在 content script 里会**逃出 Shadow DOM**,正好打破隔离目标。两个目标一个都不自动给。改为自己写 hook —— 原生 dialog 免费提供焦点陷阱/inert/Esc |
| **Shadow DOM + Tailwind + `all: initial` 做隔离** | `all: initial` **不重置 CSS 自定义属性**,变量照样继承进来;Tailwind v4 的 `@theme` 变量挂 `:root` 在 shadow root 内不匹配,且 shadow root **不支持 `@property`**。改为 iframe,问题整体消失 |
| **Tailwind `prefix` 防冲突** | Shadow DOM / iframe 内本来就没有外部类名,是在解决一个不存在的问题 |
| **一个提醒 = 一个 alarm** | 数量膨胀、持久性 Chrome 不保证、改时间要 clear+create。改为单一 `next-wake` |
| **`chrome.tabs.sendMessage` 推模式广播** | 四个独立失败点(见 §3)。改为 storage 订阅的拉模式 |
| **`chrome.offscreen` 精确计时 / 可靠播放提醒音** | 声音已砍 + 20 分钟周期不需要秒级精度。整个 entry point 删除 |
| **`setTimeout` / `setInterval` 做调度** | MV3 SW 约 30 秒即回收 |
| **`activeTab` 权限** | 只在用户点击时授予,后台触发注入必须 `<all_urls>` |

---

## 9. 已知限制(需在商店描述中诚实说明)

| 限制 | 说明 |
|---|---|
| **只能盖住浏览器** | 用户在 VSCode / Figma / PS 里时遮罩弹不出来(`chrome.idle` 仍正确判定 active)。v0.2 的系统通知可部分弥补 |
| **浏览器完全关闭时 alarm 不触发** | 只会在下次启动时补偿。无任何技术手段可绕过 |
| **电脑休眠同理** | 唤醒后由 `reconcile()` 补偿,且会被 idle 检测正确判定为「已休息过」 |
| **精度 ±30 秒** | `chrome.alarms` 最小粒度 30 秒(Chrome 120+)。20 分钟周期下无感 |
| **`chrome://` / Web Store / PDF 页面无法注入** | 由系统通知兜底(v0.2) |
| **Firefox / Safari** | 未适配。Safari 对 CSP 页面的扩展 iframe 有额外限制 |

---

## 10. 实现顺序

1. ✅ **`break.html` 单独成页** —— 不接任何扩展逻辑,浏览器直接打开调视觉
   (暗度 / 排版 / 进度条 / 渐暗曲线 / 长按进度环)。原型见 `demo/break-stand.html`
2. ✅ **content script**:`<dialog>` + iframe 挂载、`showModal`、Top Layer 抢回、自愈 observer
3. ✅ **`background.js`**:`reconcile()` + 单 alarm + 状态机
   调度核心抽成纯函数 `lib/scheduler.js`,回归测试见 `test/`(`node test/run.mjs`)
4. ⬜ 预告条 `popover` + 空格延迟 + 输入中自动延迟
   *(状态机里的 `prenotice` 相位与 `POSTPONE` 消息已就绪,第 4 步只剩 UI)*
5. ⬜ idle 检测 + 暂停 + badge
6. ⬜ popup
7. ⬜ 埋点展示(记录已在第 2 步随手做掉)

### 第 3 步落地时确认的事实

| 事实 | 影响 |
|---|---|
| ⭐ **alarm 最小 30 秒,而预告 8 秒、休息 20 秒都在这之下** | 闹钟根本管不了短过渡。改为三层:①页面侧倒计时读同一批绝对时间戳,**精确**;②单一 `next-wake` 闹钟保证**最终一定会醒来**;③SW 里 `setTimeout` 作尽力而为的 fast path。只有①②是正确性依赖 |
| ⭐ **时长必须从 `now` 起算,不能从"计划时刻"起算** | 闹钟迟到 40 秒时,若用 `nextFireAt + 8s` 算预告结束,用户只会看到预告条闪 1 秒就黑屏。休息同理 |
| ⭐ **过渡迟到太久要重置周期,不能补放** | 否则「开完 1 小时会坐下,还没碰键盘屏幕啪一下黑了」—— PRODUCT 点名的最经典差评场景。阈值 `STALE_MS = 2min`,第 5 步接 `chrome.idle` 后会有更准的判断 |
| ⭐ **休息结束后 `nextFireAt` 要用 `now` 而非 `breakEndsAt`** | 否则休息期间电脑睡了三小时,醒来会立刻再响一次 |
| ⭐ **所有状态变更必须串行化** | 闹钟、消息、settings 变更可能同时到达,每条都是「读→算→写」。不串行化会丢更新:两边都读到 `phase='breaking'`,各自算完各自写,后写的覆盖先写的 |
| ⭐ **`storage.onChanged` 只能听 `sync`** | 听 `local` 会和自己写 runtime 形成回声循环 |
| **`postponeCount` 在休息结束时归零,不是预告开始时** | 否则延迟后重新预告,角标永远显示不出 `×2` |
| **`currentIdeaId` 跨延迟保留** | 预告已经剧透过「这次要干嘛」,延迟 5 分钟后换成另一件事会显得随机 |

### 第 2 步落地时确认的事实

| 事实 | 影响 |
|---|---|
| **宿主节点不能 `display:none`** | 祖先 `display:none` 会把子树移出盒树,**Top Layer 也救不回来**,dialog 根本不渲染。改用 `position:fixed` + 0 尺寸 |
| **dialog 不要用 `100vw/100vh`** | `100vw` 含滚动条宽度,在有滚动条的页面会撑出横向滚动。用 `position:fixed; inset:0` 精确等于视口 |
| **Esc 要在两个文档里都拦** | 焦点通常在 iframe 内(由 `break.js` 处理),但也可能留在宿主文档,`content.js` 需兜底 |
| **抢回 Top Layer 必须掐掉动画** | `close()`+`showModal()` 会重放入场动画,需临时加 `.sr-noanim` |
| **iframe 要等 `load` 再 `showModal`** | 否则先闪一下空白框。给 400ms 兜底,并让 dialog 底色与 `break.html` 一致 |
| ⭐ **已打开的标签页拿不到 content script** | Chrome 只在页面**加载时**注入声明式 content script;安装/更新不是导航。症状:装完后新开的页面正常,之前开着的页面毫无反应。必须在 `onInstalled` 用 `scripting.executeScript` 自己补注入 |
| ⭐ **「重新启用扩展」不触发 `onInstalled`** | 只能在 worker 启动时用 `chrome.storage.session` 的版本标记兜底(session 随浏览器会话清空) |
| ⭐ **扩展重载后旧 content script 仍活着** | 同一扩展的 content script 共享一个 isolated world,旧实例的全局变量还在,但 `chrome.*` 已失效("Extension context invalidated")。用版本号判重挡不住,必须让新实例调用旧实例暴露的 `__SR_TEARDOWN__` 把监听器摘干净 |
| **page CSP 管不到我们的 iframe** | 已确认:宿主页的 `frame-src` 只约束指向**外部站点**的 iframe,指向 `chrome-extension://` 的 web-accessible resource 不受约束。Google 这类 CSP 很严的站点同样正常 |
