# SPEC · 用户脚本行为规格

本文件描述各脚本的**应有行为**（需求 + 判定规则 + 边界），是与代码同步的契约。行为变更时同步更新本文件与脚本头部的 `@version`。

- 适用范围：仓库根目录下所有 `*.user.js`
- 运行环境：Tampermonkey（Chrome / Edge），不使用任何外部依赖
- 数据边界：脚本不向第三方发送任何数据，不上报日志，不请求目标站以外的域名

---

## 1. `rancher-404-redirect.user.js`（v1.5.0）

### 1.1 背景与目标

广联达 Rancher 三套环境的 Web 前端是 Nuxt 单页应用。登录后跳转偶发失败，页面渲染出 Nuxt 默认错误页：

```html
<div class="__nuxt-error-page">
  <div class="error">
    <svg .../>
    <div class="title">This page could not be found</div>
    <p class="description"><a href="/dashboard/" class="error-link">Back to Home</a></p>
  </div>
</div>
```

此时页面停留在错误页，无论点「Back to Home」（会去同样有问题的 `/dashboard`）还是刷新都不会自愈。目标：

1. **自动救回**：出现该错误页时，自动跳到集群列表 `/g/clusters`；
2. **统一入口**：顶部 Logo（`a.nav-logo`）与侧边 Logo（`.side-menu-logo`）原本指向 `/dashboard`，点击后同样改为去 `/g/clusters`；
3. **日志弹窗固定**：「日志查看」弹窗内容一多，整个弹窗高度超过视口并随页面滚动，标题栏与按钮被顶出屏幕；改为固定视口大小，只让日志区内部滚动。

### 1.2 适用范围

| 项 | 值 |
| --- | --- |
| `@match` | `*://rancher.glodon.com/*`、`*://rancher-sg.glodon.com/*`、`*://rancher-pri.glodon.com/*`（`*://` 同时覆盖 http / https） |
| `@run-at` | `document-start`（尽早挂监听，避免错过首帧渲染的错误页） |
| `@grant` | `none`（只用标准 DOM / Web Storage API） |
| `@noframes` | 是，避免在 iframe 里重复执行 |
| 登录态 | 不判断登录态。未登录访问 `/g/clusters` 时由 Rancher 自行跳登录页 |

### 1.3 功能需求

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| FR-1 | 识别 Nuxt 错误页 | 出现在 `#__layout .error` / `main .error` / `.error-page .error` / 全局 `.error` 中，且满足 1.4.1 的判据 |
| FR-2 | 自动跳转 `/g/clusters` | 确认错误页后整页跳转，URL 变为 `origin + /g/clusters` |
| FR-3 | 跳转前提示 | 页面顶部出现一条提示条，4 秒后自动消失 |
| FR-4 | 防死循环 | 同一域名 60 秒内最多跳 3 次；已在目标路径时不再跳 |
| FR-5 | Logo 点击跳转 | 点顶部 / 侧边 Logo 一律去 `/g/clusters`，原本的 `/dashboard` 行为被覆盖 |
| FR-6 | 不干扰正常操作 | 组合键点击、登录页、正常页面（无错误页）不受影响 |
| FR-7 | 日志弹窗固定 | 打开「日志查看」弹窗后，弹窗始终完整落在视口内：标题栏在顶部、按钮条在底部、只有日志区可滚；关闭后背景恢复可滚 |
| FR-8 | 暂停滚动 | 日志弹窗内提供「暂停滚动」开关：勾选后日志内容**停止追加**、视图完全冻结（可自由上翻）；取消勾选恢复追加并立即回到底部跟随；暂停期间 Rancher 自带「回到底部」按钮仍有效 |

### 1.4 行为细则

#### 1.4.1 错误页判据（满足任一即认定为错误页）

| 类型 | 判据 | 附加条件 |
| --- | --- | --- |
| 主判据（文案） | 容器内 `.title` 文本（无 `.title` 时取容器文本）匹配 `/could not be found\|page not found\|not found\|页面不存在\|找不到/i` | 元素渲染高度 > 40px |
| 兜底判据（结构） | 同时存在 `.title`、`svg`、`a.error-link` | 元素渲染高度 > 80px |

**高度阈值的作用**：Rancher 的表单校验、接口报错也会用 `.error` 类，但高度很小且没有 `.title` / `.error-link`。阈值 + 结构双重要求，避免把行内报错误判成整页错误页。

**作用域顺序**：先按 Nuxt 常见位置精确查找，未命中再全局 `.error` 兜底；命中第一个即返回。

#### 1.4.2 时序

```
DOM 变化 (MutationObserver, 120ms 节流)  ┐
1s 轮询（启动后前 60s）                 ├→ check()
DOMContentLoaded（readyState=loading 时）┘
                                        ↓
                        未发现错误页 → 清空 settle 定时器，结束
                        发现错误页   → 等 SETTLE_MS(500ms) 后复核
                                        ↓ 仍在 → redirect()
                                    → 提示条 + 350ms 后 location.replace()
```

- **500ms 复核**：Nuxt 在客户端路由切换瞬间可能先渲染错误页再被替换，等一拍确认仍在，避免误跳。
- **350ms 延迟**：让提示条至少可见一瞬（否则用户只看到页面闪一下）。
- **`location.replace`**：错误页无法通过前端路由自救，必须整页导航；用 `replace` 不污染浏览器历史，返回键不会回到错误页。

#### 1.4.3 Logo 点击规则

- 采用 **document 上捕获阶段的事件委托**：Logo 会被 SPA 重绘，直接绑元素会失效；捕获阶段才能抢在 Rancher 自身 `@click` 处理（去 `/dashboard`）之前拦下。
- 命中后 `preventDefault()` + `stopPropagation()`，再 `location.assign(origin + /g/clusters)`。
- **放行**（不拦截，走原生行为）：
  - 非左键，或按住 `Ctrl` / `Cmd` / `Shift` / `Alt`（保留新标签页打开等习惯）；
  - 路径匹配 `/^\/(login|auth|verify|setup)\b/i`：登录 / 引导页不拦，否则会「跳集群列表 → 被踢回登录页」白刷一次。
- **已在目标页**：不刷新，只平滑滚回页面顶部。
- 悬停时补 `title="前往集群列表"`（同样走委托，元素重绘后仍生效）。

#### 1.4.4 日志弹窗固定

**结构**（Ember）：

```
.modal-overlay.modal-open
  .modal-container.large-modal.fullscreen-modal.alert
    .container-log
      h2                      ← 标题「日志查看」+ 服务下拉 + 已连接状态
      .protip                 ← 「高级技巧…」提示
      pre.log-body            ← 日志正文（可能是几千行）
      .footer-actions         ← 自动换行/以前的容器 + 回到顶部/回到底部/下载日志/清除屏幕/关闭
```

**问题成因**：`modal-container` 高度随日志增长（实测 1554px，视口仅 713px），且居中定位 / 随页面滚动，导致标题栏落到视口上方（实测 `top = -1120px`），用户只能看到日志和按钮。

**处理**：

1. 识别：`document.querySelectorAll('.modal-overlay')` 中找到含 `.container-log` 且已渲染（宽高 > 0）的那个，打标 `r404-log-overlay`；从 `.container-log` 逐级向上到 overlay 的每个节点打标 `r404-log-box`（不依赖固定层级，Ember 版本差异也能覆盖）。
2. 布局：overlay 强制 `position: fixed` + `inset: 0` + flex 居中 + 12px 内边距；容器铺满 overlay 内容区（`width/max-width: 100%`，即 `100vw - 24px`）× `(100vh - 24px)`，四边留白都是 12px；`r404-log-box` 逐层 `display:flex; flex-direction:column; min-height:0`，让高度能传到日志区。
3. 滚动：`pre.log-body` 改为 `flex:1; overflow:auto`（覆盖 Rancher 可能写入的内联高度），日志只在框内滚。
4. 背景锁：弹窗存在期间给 `body` 加 `r404-log-lock`（`overflow:hidden`），关闭后自动移除。
5. 幂等：每轮扫描重复调用无副作用（有 `contains` 判断），不新增 DOM 节点，只加类名与一个 `<style>`。

`footer-actions` 保留 Rancher 原样式（底部绝对定位），因为容器已被限高，它自然贴在盒子底部；改成常规流会让 `position:absolute` 的勾选组错位到标题栏上。

#### 1.4.5 日志弹窗实测（模拟环境）

用与真实结构一致的本地 mock（1200×800 视口、200 行日志、`pre` 内容高 6616px、页面已滚动 700px）对比：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| `.modal-container` 距视口顶部 | **-1120px**（标题栏看不见） | **12px** |
| 容器高度 | 1554px（超出视口） | 689px（= 视口高 - 24） |
| 标题栏位置 | 视口外 | 12px，高 50px |
| 日志区 | 1416px，溢出屏幕 | 548px，`overflow:auto` 内部滚动 |
| 按钮条 | 跟随内容漂移 | 固定 649px，高 52px |
| 背景滚动 | 跟随页面滚动 | `body` 锁定 |
| 四边留白（1920×913 视口实测） | 容器 1554px 高、左右随宽度变化 | 左/右/上/下均 **12px**，容器 1896×889 |

#### 1.4.6 暂停滚动（v1.4.0，v1.5.0 加强为「内容也停止追加」）

Rancher 日志流式输出时会持续往 `pre.log-body` 写内容并程序化滚到底部，翻到中间看历史就被拽走。v1.4.0 只冻结滚动位置，v1.5.0 起暂停期间连日志内容也停止追加，视图完全静止。处理：

1. **开关 UI**：悬浮胶囊（`label.r404-pause-chip` + 原生 checkbox + 文字「暂停滚动」）挂在 overlay 右下角（`right:20px; bottom:56px`，绝对定位），独立于 footer 的绝对定位布局互不干扰；勾选态蓝底高亮。每次打开弹窗默认不勾选，不做持久化。
2. **滚动拦截**：对 `pre.log-body` **实例** `Object.defineProperty` 影子化 `scrollTop`（遮住 `Element.prototype` 上的同名访问器）：
   - getter 始终返回 `realTop`（由 `scroll` 事件与原生值保持同步）——Ember 自己读 `scrollTop` 判断是否跟随，拿到的也是正确值；
   - setter 在暂停期间**吞掉一切程序化赋值**；用户的滚轮/拖动条/键盘滚动走浏览器原生路径，不经过 setter，完全不受影响；native set 后回读对齐（原生 setter 会钳制到合法区间）；
   - `pre.scrollTo` 同样包装（Ember 换一种写法也能拦住）。
3. **内容拦截（v1.5.0）**：同样在 pre 实例上影子化内容写入通道，暂停期间全部吞掉：
   - 访问器：`textContent`（`Node.prototype`）、`innerHTML`（`Element.prototype`）、`innerText`（`HTMLElement.prototype`）——setter 直接 return，getter 透传原型；
   - 方法：`appendChild` / `insertBefore`（吞掉但**返回传入节点**，避免调用方拿到 undefined 崩溃）、`append` / `prepend` / `insertAdjacentText` / `insertAdjacentHTML`（吞掉无返回值）；
   - **兜底网**：`MutationObserver`（childList + subtree + characterData + oldValue）监听 pre，暂停期回滚漏网写入——新增节点直接移除；`characterData` 变更以「认可值」回滚（勾选瞬间快照 pre 已有文本节点的 `data` 存 WeakMap；回滚后的记录与认可值一致时跳过，防震荡）。未影子化路径（Range 插入、低层 API 等）由兜底网兜住。
4. **放行窗口**：捕获阶段委托监听「回到底部」按钮（文本匹配 `/回到底部|bottom/i` 且在已标记弹窗内）的点击，给对应日志体开 **600ms 放行窗口**（`allowUntil`），窗口期内滚动**和内容写入**都放行；放行是一次性的，用掉即失效——之后重新冻结。
5. **语义**：暂停 = 内容 + 滚动双冻结——勾选时即使正停在底部，新日志也不再出现（暂停期间错过的输出**不回放**，取消勾选后从 Ember 的下一个写入点继续）；取消勾选立即 `scrollTop = scrollHeight` 回到底部，恢复追加与跟随。
6. **兜底**：`defineProperty` 不可用（极端环境）时开关仍显示，状态照挂但拦截退化（尽力而为）。
7. **幂等**：`pre._r404PauseArmed` 防重复武装；pre 被 Ember 重绘换新时下一轮扫描重新武装；chip 按 overlay 内 `.r404-pause-chip` 存在性检查防重复注入；chip 挂在 overlay 上，随弹窗一起销毁。

### 1.5 配置项（脚本顶部常量）

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `REDIRECT_PATH` | `/g/clusters` | 跳转目标路径，404 修复与 Logo 点击共用 |
| `LOGO_SELECTOR` | `a.nav-logo, .side-menu-logo` | Logo 选择器（逗号分隔多选择器），类名变更时只改这里 |
| `SETTLE_MS` | `500` | 错误页复核延迟（ms），防瞬时误判 |
| `GUARD_KEY` | `rancher404Redirect` | sessionStorage 键名 |
| `GUARD_WINDOW` | `60000` | 防死循环统计窗口（ms） |
| `GUARD_MAX` | `3` | 窗口内最大跳转次数 |
| `PIN_LOG_MODAL` | `true` | 是否固定日志弹窗；置 `false` 可关掉该功能 |
| `LOG_MODAL_BOX` | `.container-log` | 判定「日志查看」弹窗的内容容器选择器 |
| `PAUSE_CHIP_CLASS` | `r404-pause-chip` | 「暂停滚动」开关的类名 |
| `BOTTOM_ALLOW_MS` | `600` | 点「回到底部」后放行程序滚动的窗口（ms） |
| `LOG` | `[Rancher 404 跳转]` | 控制台日志前缀 |

### 1.6 运行时状态

| 名称 | 位置 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| `handled` | 内存 | 单页 | 已处理（已跳转或已放弃）则为 true，后续扫描直接短路 |
| `settleTimer` | 内存 | 单页 | 复核定时器句柄，避免重复排程 |
| 防死循环记录 | `sessionStorage` | 单标签页 | `{ host, ts, count }`；`host` 不同或 `now - ts > GUARD_WINDOW` 时重置计数 |
| `r404-log-overlay` / `r404-log-box` / `r404-log-lock` | DOM 类名 | 弹窗存续期间 | 分别标记弹窗遮罩、布局盒子链、`body` 滚动锁；弹窗关闭后无需清理（节点随弹窗一起销毁） |
| `pre._r404PauseArmed` / `pre._r404PauseState` | pre 元素实例属性 | 弹窗打开期间 | 暂停滚动的武装标记与状态（`paused` / `allowUntil` / `setPaused` / `_approved` 认可值表）；pre 随 Ember 重绘换新后由下一轮扫描重新武装 |

`sessionStorage` 按标签页隔离，多个标签页各自计数、互不影响；隐私模式写入失败时静默降级（仅失去计数能力，不影响跳转）。

### 1.7 非功能要求

- 零依赖、零构建，单文件可直接安装。
- DOM 写入仅限：临时提示条（4s 后移除）、Logo 的 `title` 属性、一个 `<style>` 标签、弹窗相关节点上的类名（不改结构、不移动节点）。
- 不拦截网络请求，不读写 Cookie / localStorage，不采集页面内容。
- 空闲时无定时器：1s 轮询仅在前 60 秒运行，之后只靠 MutationObserver。
- 日志流式刷新（每秒几十次 DOM 变更）下，扫描按 120ms 节流合并，避免逐行触发。

### 1.8 边界与已知限制

| 场景 | 行为 / 限制 |
| --- | --- |
| 跳 3 次仍是错误页 | 停止自动跳转，提示「请手动刷新或重新登录」，交给人处理 |
| 已在 `/g/clusters` 却报错 | 不再自动跳（防自指循环），仅 `handled=true` 后静默 |
| Rancher 升级改了错误页文案 | 主判据失效，兜底判据（`svg` + `.title` + `a.error-link`）仍可命中；两者都变则需更新 1.4.1 |
| Rancher 升级改了 Logo 类名 | Logo 跳转失效，改 `LOGO_SELECTOR` 即可 |
| 站内 SPA 跳转 | `location.assign` / `replace` 会整页重载（数百毫秒到数秒），换取 100% 可靠 |
| 未登录 | 不特殊处理，由 Rancher 自行跳登录页 |
| 日志弹窗关闭 | 扫描到 overlay 已不可见即移除 `body` 锁；Ember 直接销毁节点也成立 |
| 非日志类弹窗 | 不含 `.container-log` 的弹窗不受影响，仍用 Rancher 原生布局 |
| Rancher 给 `.footer-actions` 改结构 | 固定效果仍在（高度由容器限制），但若按钮条改为常规流后与日志重叠，需要补 `padding-bottom` |
| 弹窗内点「下载日志」等按钮 | 不受影响，脚本只改布局不改事件 |
| Ember 改用 scrollIntoView 或操作内层元素滚动 | `scrollTop`/`scrollTo` 的影子拦截覆盖不到，滚动冻结失效（内容拦截不受影响）（目前未见该用法） |
| 「回到底部」按钮文案变更 | 文本匹配 `/回到底部|bottom/i` 失效，暂停期间该按钮被冻结（滚轮滚到底仍可用） |
| 极端环境 `defineProperty` 失败 | 开关仍显示但不拦截，行为退化为 Rancher 原生 |
| Ember 走完全未知的低层路径写入 | 影子化 API + 兜底网之外仍有漏网可能（概率极低） |
| 暂停期间错过的日志 | 不缓存不回放，取消勾选后从 Ember 下一个写入点继续；完整历史建议用「下载日志」 |
| 弹窗关闭后重开 | chip 挂在 overlay 上随弹窗销毁；重开是新实例，开关默认不勾选 |

### 1.9 验收清单（手动）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 访问一个不存在的路径，触发错误页 | 500ms 后跳 `/g/clusters`，顶部有提示条，控制台打印「检测到错误页（error-page）」 |
| 2 | 已在 `/g/clusters` 手动触发错误页 | 不跳转（控制台打印「当前已在目标路径，跳过跳转」） |
| 3 | 连续触发错误页 4 次 | 第 4 次不再跳，提示「自动跳转多次仍未成功」 |
| 4 | 点击顶部 Logo | 跳 `/g/clusters`；鼠标悬停显示「前往集群列表」 |
| 5 | 点击侧边 Logo（含点图片） | 同上，控制台标注「点击侧边 Logo」 |
| 6 | 在 `/g/clusters` 点 Logo | 不刷新，仅滚回顶部 |
| 7 | 登录页点 Logo | 不拦截，走 Rancher 原生行为 |
| 8 | `Ctrl` / `Cmd` + 点 Logo | 不拦截（能新标签页打开则照常） |
| 9 | 三个域名各测一次，http 与 https 均访问 | 行为一致 |
| 10 | 正常集群列表页停留 1 分钟 | 无误跳，控制台无报错 |
| 11 | 打开某 pod 的「日志查看」，日志很长 | 弹窗完整在视口内：标题栏在顶部、按钮在底部，只有日志区可滚 |
| 12 | 在弹窗内滚轮 / 拖动 | 日志内部滚动，背景页面不动 |
| 13 | 关闭弹窗后滚动页面 | 背景恢复可滚 |
| 14 | 打开普通确认弹窗（无 `.container-log`） | 布局与原生一致，未被改动 |
| 15 | 打开「日志查看」，勾选「暂停滚动」，日志持续输出 | 日志内容**停止追加**（行数不再增长）、视图完全静止；滚轮/拖动条可自由上翻 |
| 16 | 暂停状态下点「回到底部」 | 仍能滚到底（放行窗口）；此后恢复冻结，新内容依旧不追加 |
| 17 | 取消勾选「暂停滚动」 | 恢复追加（从 Ember 下一个写入点继续，暂停期间内容不回放），立即回到底部跟随；开关蓝底高亮消失 |

### 1.10 版本历史

| 版本 | 变更 |
| --- | --- |
| 1.0.0 | 错误页识别 + 自动跳 `/g/clusters`；500ms 复核；防死循环；提示条 |
| 1.1.0 | 顶部 Logo（`a.nav-logo`）点击改为跳集群列表，捕获阶段委托，放行组合键与登录页 |
| 1.2.0 | 选择器扩展为 `a.nav-logo, .side-menu-logo`，侧边 Logo 同样生效；日志区分入口 |
| 1.3.0 | 新增日志弹窗固定：overlay 固定视口、容器限高、日志区内部滚动、背景滚动锁；`PIN_LOG_MODAL` 可开关 |
| 1.3.1 | 弹窗宽度铺满：去掉 1280px 上限，四边留白统一 12px（原左右空白偏大） |
| 1.4.0 | 日志弹窗新增「暂停滚动」开关：实例级影子 `scrollTop`/`scrollTo` 冻结 Ember 自动跟随（滚轮等原生滚动不受影响）；「回到底部」按钮点击开 600ms 放行窗口；取消勾选立即回到底部恢复跟随 |
| 1.5.0 | 暂停升级为「内容也停止追加」：影子化 pre 实例的内容写入通道（`textContent`/`innerHTML`/`innerText`/`appendChild`/`append`/`prepend`/`insertBefore`/`insertAdjacent*`），暂停期全部吞掉；MutationObserver 兜底网回滚漏网写入（characterData 按认可值回滚防震荡）；暂停期间错过的输出不回放 |

---

## 2. `glodon-console-fav-menus.user.js`（v1.4.0）

**作用**：在开发者控制台左侧菜单（`div.left-menu`）的末级菜单项右侧加星星，点星星标记为常用；未收藏时悬停才显示空心星，收藏后星标与菜单文字变为橙红色（`ACTIVE_COLOR = #ff5722`，可改常量换色）。

- **站点**：`https://console.developer.glodon.com/*`
- **存储**：`GM_setValue('gld_console_fav_menus', [...])`，存的是**菜单名数组**（如 `["日志查询", "数据库运维"]`）。主键是末级菜单自己的文字，与该菜单在树里的层级、顺序、父级标题都无关——菜单换位置、上级改名都不影响已收藏项
- **取名字**：优先取 `li.el-menu-item > span` 的文本，并排除脚本自己插入的星标 `span`；取不到时（`<a>` 包裹、文本散落等结构）拷贝一份去掉星标后取全文；两者都为空（纯图标项）才退回「父级 > (未命名)」
- **旧数据迁移**：读到形如 `一级 > 二级 > 末级` 的旧记录，自动取末级名称、去重后写回，用户已有的收藏不丢
- **判定**：`li.el-menu-item` 视为末级项
- **星标水平位置**：不写死像素，改为**量测对齐**——向上找最近的 `li.el-submenu`，取其标题里的折叠箭头（优先 `.el-submenu__icon-arrow`，否则取标题内最靠右的 `i`/`svg`），把星标中心对到箭头中心。星标改为 `position:absolute` + 按算出的 `right` 定位，因此菜单项 `padding-right`、主题内边距变化都不会影响对齐
- **兜底**：找不到箭头（顶层项等）时退回 flex 布局，`margin-right = STAR_RIGHT_PX(20) - li.paddingRight`
- **重算时机**：注入时、每次扫描（DOM 变化，此时会按当前菜单名重算收藏键）、窗口 resize
- **防重复注入**：处理过的 `li` 打 `data-gld-fav-star` 标记，重复扫描只同步状态不重复插星
- **调试**：控制台执行 `__gldStarDebug()` 打印每个菜单项的「菜单名 / 收藏键 / 是否已收藏 / 星标中心 / 箭头中心 / 差值 / 定位方式」，便于核对
- **已知限制**：只看菜单名，所以**不同父级下的同名菜单会被视为同一项**（一起点亮）；菜单改名等于新菜单（旧名字的记录保留但不再匹配）；不做跨浏览器/跨设备同步；若某级菜单标题里没有箭头类图标，会退回固定留白

## 3. `glodon-console-version-switch.user.js`（v1.3.2）

**作用**：把开发者控制台应用详情页右侧「总览」改造成一个**快捷链接页**——页面上只剩两组带图标的大方块：`版本`（release / release-pre）与 `常用功能`（构建管理、版本发布）。点版本方块会自动在左侧版本下拉里切换、自动确认页面弹窗并直接跳转；点常用功能方块等于点左侧对应菜单。

- **站点**：`https://console.developer.glodon.com/*`
- **v1.2.0 变更**：总览页原有内容（标题、5 阶段步骤条、学习卡片、帮助中心链接）整块隐藏，改为快捷链接面板；版本从「顶部一条栏」改成「大方块」；修复「点了 release 成功后，再点提示版本不存在」
- **方块配置**：版本取顶部 `TARGETS = ['release', 'release-pre']`；常用功能取 `SHORTCUTS = [{ label: '构建管理', icon: 'tool', url: '/portal/740894248948736/' }, { label: '版本发布', icon: 'rocket', url: '/portal/645701652762624/' }]`，`label` 与左侧菜单文字精确匹配，`url` 只在菜单点不到时兜底
- **注入位置**：总览内容是 qiankun 微应用渲染在**主文档**里（不是 iframe），锚点 `#subapp-viewport > div[id^="__qiankun_microapp_wrapper_for_open_open_component_overview"]`；面板 `#gld-quick-links` 追加为包装节点最后一个子元素，其余子元素（除 `<qiankun-head>`，它承载微应用样式）一律 `display:none`
- **防闪现（v1.3.1）**：样式表里常驻一条规则 `#subapp-viewport > div[id^=__qiankun_microapp_wrapper_for_open_open_component_overview] > *:not(qiankun-head):not(#gld-quick-links) { display:none !important }`，微应用每次重挂的瞬间原始内容即被命中，切页签回来不会先闪旧页面；MutationObserver 回调里发现面板缺失时**立即** scan（不等 200ms 节流）补回面板。注意 CSS 是模板字符串，里面不能写 `//` 注释（v1.3.1 踩过：会把整条规则解析坏）
- **切换原理**：仍走左侧下拉——条目为 `li.el-dropdown-menu__item`，匹配 `.item-middle .name span` 的 `title`/文本，规则为「精确相等」或「以 `name(` / `name（` 开头」（兼容 `release(0.2)` 这种带构建号的形式，且不会把 `release-pre` 误判成 `release`）；命中后对 `li` 派发 `MouseEvent('click')`，由页面自身 Vue 处理器完成切换
- **「版本不存在」修复**（v1.2.0）：
  - 版本列表有可能会等下拉打开后才渲染/异步拉取，`waitVersionItem()` 改成最多 8 轮、每轮 250ms 重试，每轮补发 `mouseenter/mouseover/mousemove`，第 3、6 轮再补一次点击，最后全文档兜底查找
  - 切换成功后**当前版本会从下拉列表里消失**，再点同一版本必然找不到；因此入口处先比对 `.version-select .version-num`，已经是该版本就直接返回（只刷新方块状态，不弹任何提示）
- **Vue 层拦截（v1.3.0，首选路径）**：反查站点打包代码（`/portal/js/app.cbe1471f.js`）摸清真实流程——`version-change` 组件 `handleCommand` → `$emit("changeVersion", version, versionName)` → 根组件 `handelVersionChange` 设 `curVersionObj`、`versionFlag="change"`、`versionDialogVisible=true`（弹窗只是个响应式标志）→ 用户点确定后 `handelClickEnterVersion()` 执行 `pushMicroApp` 跳转 + `fetchAppVersionAndProduct`。脚本从 `panel.__vue__` 沿 `$parent` 链找到带 `handelClickEnterVersion` 的根组件实例，对其 `$watch('versionDialogVisible', cb, { sync: true })`：弹窗标志刚置 true 的 setter 里**同步**直接调 `handelClickEnterVersion()`，弹窗来不及渲染。
  - v1.3.0 的坑：默认异步 `$watch` 的回调在 flush 队列里按 watcher id 排序，组件渲染 watcher 创建更早（id 更小）**先执行**——弹窗先画出来再被回调关掉，肉眼可见闪现；`{ sync: true }` 在 setter 内立即执行，绝对先于任何渲染。只认 `versionFlag === "change"`（新建版本流程复用同一弹窗，不能替用户确认）。`scan()` 每轮重挂钩（实例重绘换新时补上，`__gldHooked` 幂等）
- **自动确认**（v1.2.1 重写，DOM 兜底）：点条目之前 `armAutoConfirm()` 开 10s 时间窗，窗内每 120ms 找可见的 `.el-message-box`（兼容 `.el-dialog`），文案含「切换」或「目标版本名 + 是否继续/确认」才动手；按钮优先 `.el-button--primary`，兜底按「确定/确认/继续/是」文字找；点击用完整的 `mousedown → mouseup → click` 序列（只发 `click` 时会被主题的 mousedown 逻辑或已失效的旧节点吞掉）
  - **一次点不中要继续点**：每次点击间隔 ≥450ms、最多 6 次，直到弹窗真的消失。v1.2.0 的「点一次不成即永久放弃」正是真实页面上弹窗仍在的根因（首次点击落到被重渲染替换掉的旧按钮上）
  - 切换结果改为**轮询等待**（每 200ms、最多 4s），弹窗晚几百毫秒出现、确认后版本才变的情况也能正确判定，不再 800ms 就判死
- **版本名比对**：顶部显示的是 `release(0.2)` 这种带构建号的形式，判断「当前已是该版本」和「切换是否成功」都用 `matchVersion()`（精确或 `name(` 前缀），不能用 `===`——这是 v1.2.0「再点报不存在/提示未响应」的另一半原因
- **留白**：面板 `padding: 32px 40px 24px`，标题与卡片距内容区左沿 40px（v1.2.0 是 0，紧贴侧栏）
- **常用功能跳转**：`openMenu()` 按文字找 `li[role="menuitem"] / .el-menu-item / a` 并派发点击（走站点自身的页签导航）；只有找不到该菜单时才把当前 URL 的 pathname 换成配置里的兜底地址（保留 query），避免在正常点击后再强行刷新
- **状态刷新**：每次扫描把当前版本对应的方块加 `is-current` + 右上角「当前」角标；方块组被微应用重绘掉时，下一次扫描（MutationObserver 200ms 节流）自动补回，不会重复注入
- **已知限制**：版本名匹配规则较严（不做模糊匹配）；若页面在开发模式下禁用了切换（Vue 层忽略点击），脚本无法绕过；站点升级改了 qiankun 包装 id / 菜单结构 / `el-message-box` 结构时需同步改选择器；总览页原有内容被隐藏属于**结构性改动**，站点改版后需要复核
- **v1.3.2 变更（切换不再看见下拉）**：自动交互期间给 `body` 加 `gld-dd-suppress` 类，CSS 把版本下拉压成 `visibility:hidden`——hover 派发照旧让站点渲染列表，但用户看不见；结束后派发 `mouseleave` 让下拉自动收起，并延迟 500ms 再解除隐藏（避开 element-ui 约 300ms 的收起延时）。另外 `switchTo` 每次现取侧栏 panel（不再信任方块闭包里的旧引用）：站点重绘后旧元素上的版本号还是切换前的名字，会让「已是当前版本」短路失效，点当前版本方块也误切一遍

## 4. `pep-book-downloader.user.js`（v1.3.1）

**作用**：人教教材在线阅读器底部工具栏加「下载」按钮，逐页抓图、去水印并合成 PDF 下载（一册一个 `.pdf`，直接可读/可打印）。仅在个人学习场景使用。

- **站点**：`https://book.pep.com.cn/*`
- **依赖**：无（v1.3.0 起移除 JSZip；PDF 由脚本内约 60 行代码手写生成）
- **流程**：读 `config.js` 取总页数 / 书名 / 时间戳 → 逐页抓 `files/mobile/{n}.jpg` → 失败重试与补抓 → 去水印 → 合成 PDF 下载
- **PDF 合成（v1.3.0）**：页面本身就是 JPEG，PDF 的 Image XObject 原生支持 `DCTDecode`——把 JPEG 字节流原样放进 PDF 流里即可，**不重编码、零画质损失**，也不需要 jsPDF 之类的库。手写部分只有：解析 SOF 段拿宽高与通道数（1/3/4 → `DeviceGray`/`DeviceRGB`/`DeviceCMYK`，CMYK 补 `/Decode [1 0 1 0 1 0 1 0]`）→ 每页写 `Page` + 内容流（`q W 0 0 H 0 0 cm /Im0 Do Q`）+ `Image` XObject → 输出带 `xref`/`trailer`/`startxref` 的合法 PDF。页面尺寸按 **300dpi** 换算（`pt = px ÷ 300 × 72`，即 `PX2PT = 0.24`；1273×1800 px → 305.52×432 pt = 10.78×15.24 cm），各页 `MediaBox` 独立、混入不同尺寸的封面也不会变形，图片仍按原始像素绘制（不重采样），Blob 分片拼接、每 8 页让出一次主线程避免 UI 卡顿
- **实测（PDF 合成）**：10 页 / 1273×1800 → 3.79 MB、`MediaBox` 305.52×432（= 1273×1800 @300dpi，有效分辨率实测 300dpi，版面比例与原图完全一致），Node 侧 20 ms、浏览器内 3~4 ms；macOS PDF 引擎（CoreGraphics）可正常解析并渲染，xref 32 个对象偏移全部命中，图像内容与源页逐页一致
- **去水印**：顶部按列重建背景色（只修比背景「深」的像素，保护白色正文）、底部按主色占比 ≥95% 整带填充（深色正文 2px 膨胀保护）
- **底部绿色署名（v1.1.0）**：页面底部居中的「人民教育出版社」绿色书法字固定存在，白页与照片页都要清。流程：在 `x∈[0.30,0.70]W、y≥0.955H` 内找强绿像素（`g-max(r,b)>10 且 g>35`）→ 数量 <80 或过小/过宽（>0.45W）则跳过 → 取外接框 ±6px 为处理区 → 掩膜膨胀 3px 后按「同行左右最近非掩膜像素」线性插值补全 → 再对边框附近偏绿/明显偏暗的残点补一次（近白页脚用 10px/12 阈值，照片页脚用 6px/16 阈值，避免把渐变背景当残迹补出发亮色块）
- **底部灰色水印（v1.2.0）**：`仅供个人学习使用，未经授权不得另做他用` 只出现在「插画铺满页脚」的页面上（白页只有绿色署名），没有干净页可当模板。做法是把「定位」和「定量」拆开：
  - **定位（跨页）**：逐页算相对变暗比例 `dev = (盒式背景 − 亮度) / 盒式背景`（盒式背景用积分图，半径 `WM_BG_R`，把掩膜当空洞只统计干净像素）。水印是半透明灰，它打掉的正是覆盖率本身；插画每页都不同、水印每页都在。跨页取低分位（`WM_QUANTILE`）+ 双阈值滞后（`WM_SEED_T` / `WM_GROW_T`）得到「这行字落在哪几行、哪一段 x」的位置先验。**不追求字形完整**：这行字在每页里的上下位置会浮动几像素，跨页交集只能剩下共同覆盖的一段，硬凑会连插画一起吃掉。
  - **定量（本页）**：修补时以先验为窗口，用**这一页自己**的 `dev` 判定笔画：`dev ∈ [WM_DEV_LO, WM_DEV_HI]` 且横向连续 `≤ WM_RUN_MAX` 才算。反解 `obs / (1 − dev)` 回到水印之前的亮度——纯除法，一个像素都不插值，插画纹理不会被拉花；比灰字更黑的线条（`dev` 更大）、更长的结构（横向段更长）都不碰。
  - **门控**：可清像素数 < 120 判定这页没有这层灰字，直接跳过（白页实测不会被改）。绿署名区（`WM_LOGO_GUARD`）仍交给绿色署名流程。
  - **实测**（上册 8 个插画页脚页 + 2 个白页对照）：学习 8 页 201 ms、建掩膜 16 ms、修补 8 页 464 ms；8 页全部命中，白页 2 页均未改动；清掉的像素平均覆盖率 0.17~0.21，与该水印的实测浓度一致。
- **版本号纪律**：`@version` 必须随任何行为变更递增（v1.3.0 期间改过三次页面尺寸却没升版本号，篡改猴认为已是最新，用户一直跑旧代码，误判为「还是 72dpi」）。运行时日志首行打印 `脚本 vX.Y.Z（PDF 页面 Ndpi）`，结束行打印 `页面 W×H pt（px @Ndpi）`，用于一眼核对实际生效的版本与尺寸
- **断点续传**：已抓页面缓存在内存数组中，不刷新页面可继续
- **已知限制**：遇 WAF 滑块验证时暂停并提示，需人工过验证后重新点击；接口或目录结构变更可能失效；翻页图片尺寸过小/过大时去水印判定阈值需微调（`TOP_BOX` / `BOTTOM_H` / `STRONG_FRAC`）；整幅彩色插画（如幕布/照片铺满页脚）页面上，绿色像素可全部清除，但笔画处可能留下淡淡的暗色纹理痕迹；底部灰字是「尽力而为」——大部分页面淡到看不清，个别页（如牛皮纸底）仍会留淡淡残影，且插画里与灰字浓度相当、又是短横段的细节可能被一起提亮（已用 `dev` 区间和短段长度约束把误伤压到很低）

## 5. `gstack-deploy-log-enhance.user.js`（v1.8.0）

**作用**：GStack 部署详情页（`#/workspace/**/deploy/details`）日志区增强——日志工具条「刷新」左侧注入三个按钮 + 一个「自动到底」复选框，顺序 `[最大化][到底][清理][☐自动到底][刷新]`，按钮复用站点 Fusion Next 类名（`next-btn next-medium next-btn-normal`）融入原生 UI。

- **站点**：`https://gstack.glodon.com/*`
- **识别锚点**：日志块 `.workload-details-log`（内含 Pod 工具条 `.header` 与 `react-codemirror2` 的 CodeMirror）；「刷新」按钮按块内可见 button 文本精确匹配；CodeMirror 实例挂在其 wrapper 元素的 `.CodeMirror` 属性上
- **最大化**：块加 `gstack-log-maxed` 类 → `position:fixed` 铺满视口（z-index 99999）、盖住部署详情；内部 flex 链撑开 `next-loading → .next-loading-wrap → react-codemirror2`，`.CodeMirror{height:100%!important}` 覆盖内联 100vh；容器尺寸变化后 `cm.refresh()`。再点一次或按 **Esc** 还原
- **清理**：点击走 CodeMirror API `setValue('')`——change 事件让 react-codemirror2 把空串同步回 React state，站点重渲染不会带回旧日志（直接改 DOM 会被恢复）；拿不到实例时清空 `.CodeMirror-code` 兜底；清后 `cm.refresh()`
- **到底（v1.7.0 起）**：滚动到日志末尾——优先 `cm.scrollTo(null, cm.getScrollInfo().height)`（y 会被 CM 的 `calculateScrollPos` 钳到最大滚动位，传大值即可到底），拿不到实例时直接滚 `.CodeMirror-scroll`（`scrollTop = scrollHeight`）兜底；最大化状态下同样可用
- **自动到底（v1.8.0 起）**：紧挨「刷新」左侧的复选框，**默认勾选**，状态存站点域 `localStorage['gstack_log_auto_end']`（`'1'` 勾选 / `'0'` 取消；`@grant none` 下拿不到 `GM_setValue`）。**只在「一轮日志数据刷新完成」时滚一次到末尾**，不做逐帧跟随
  - **刷新完成的判定**：CodeMirror 的 `change` 事件 = 一次数据写入；连续写入（流式追加、先清空再写入、多次 setState、一次轮询里多批）用 `REFRESH_SETTLE_MS = 300` 的 debounce 合并成一轮，静默 300ms 后才调 `scrollToEnd()`。日志渲染过程中不会反复拉滚动条
  - **覆盖的刷新来源**：点「刷新」、站点自动轮询、切 Pod/Container、首屏加载、React 重建 CodeMirror 实例（新实例已带全量日志、不会再为这批内容派发 change，`bindFollow()` 首次挂钩时主动补一轮）、整块重绘但拿不到 CM 实例（`scan()` 里 `!cmOf(block)` 的兜底）
  - **复选框交互**：勾选时立即滚一次到末尾（即时生效）；取消勾选时 `cancelFollow()` 清掉排队中未执行的滚动，已渲染内容不变；勾选态文字高亮蓝色（`.is-checked`），React 重绘换掉 checkbox 节点时由 `syncAutoCb()` 对齐回内存状态，标签与原生 `<input type=checkbox>` 用 CSS 撑到与 medium 按钮等高（28px）
  - **挂钩幂等**：`WeakSet` 记录已挂 `change` 的 CM 实例；`scan()` 快路径每轮只做一次 `querySelector('.CodeMirror')` + WeakSet 判断，不写 DOM、不读布局，日志高频渲染下零额外开销
- **换行（v1.6.0 起）**：只在**最大化期间**取消自动换行。做法是把块内带 `CodeMirror-wrap` 类的节点（即 `.CodeMirror` wrapper，等价 CSS 选择器 `.workload-details-log .CodeMirror-wrap`）的该类摘掉——CodeMirror 5 的折行完全由这个类上的 CSS 决定（基样式 `pre.CodeMirror-line{white-space:pre;word-wrap:normal}`，`.CodeMirror-wrap` 里才改成 `pre-wrap`），摘类即长行横向滚动，且**不动 CM 的 `lineWrapping` option**，不与站点渲染节奏抢配置。摘/加类都会改行宽与滚动区尺寸 → 必须 `cm.refresh()` 重测量（用 60ms 定时器把连续操作合并成一次 `refresh`）。还原时只给「被脚本摘过类」的节点补回（`WeakSet` 记录）——站点本就没开换行时不会被强行加上
- **v1.3.0 变更**：**移除 v1.2.0 的「自动刷新」功能**（开关按钮 + 间隔下拉，实测有 bug），扫描时会顺带清掉旧版残留的 `#gstack-log-auto-wrap` / `#gstack-log-auto-btn` / `#gstack-log-auto-interval` 控件
- **v1.3.1 变更（卡顿修复）**：日志高频流式渲染时，原先每次扫描都走 `visibleLogBlock()`（对所有块 `getBoundingClientRect` → 强制同步布局）+ `decorate`（多次 `querySelectorAll`），120～150ms 一次插在 CodeMirror 渲染管线里造成卡顿。现在 `scan()` 先走**快路径**：上次记录的块 `isConnected`、`decorated`（WeakSet）已标记、两个按钮都在、最大化状态一致时直接 return——全程只查 `isConnected` / `querySelector`，**零 DOM 写入、零布局读取**；只有块被 React 替换（`isConnected=false`）或控件缺失时才走完整装饰
- **v1.3.2 变更（不换行丢失修复）**：站点点「刷新」/切页签会把 CodeMirror 重新初始化，`lineWrapping` 回到 `true`、`CodeMirror-wrap` 类被加回来；v1.3.1 的快路径跳过了整轮装饰，导致不换行失效。现在快路径里调 `maintainNoWrap()`——只读 `classList.contains('CodeMirror-wrap')` 与 `cm.getOption('lineWrapping')`（都不触发布局），任一为真才重新关掉换行并摘类；另有按日志容器限定的永久 CSS 兜底
- **v1.3.3 变更（补刀反成卡顿）**：v1.3.2 每 150ms 检查一次、发现 `lineWrapping` 被打开就 `setOption(false)`，而站点每次渲染都可能把它设回 `true` → 双方来回抢，`setOption` 触发 CM 全量重测量，日志一多就卡。改为 **setOption 打补丁（一次挂钩）**：站点想开换行直接被改成关，之后快路径只读 `__gstackNoWrapHooked` 布尔标记（O(1)）；`maintainNoWrap` 仅在类被异常加回来时补刀且 1 秒内最多一次
- **v1.4.0 变更（取消设置，纯 CSS）**：v1.3.3 的 setOption 补丁 + `maintainNoWrap` 整体移除——动态维护思路（纠正 / 拦截）总会和站点的渲染节奏产生交互，干脆全部去掉，改由一条**无条件 CSS 规则**永久保证不换行；快路径里连布尔标记都不用读
- **v1.4.1 变更（最大化下浮层被盖）**：Fusion Select 下拉浮层渲染在 body 末尾、z-index 约 1001，被最大化块（z-index 99999）盖住 → 点击后「不展示」。修复：`applyMax`/`restoreMax` 时给 body 加/去 `gstack-log-maxed-body` 标记类，CSS 把 `.next-overlay-wrapper` / `.next-portal` / `.next-overlay-inner` / `.next-overlay-backdrop` 抬到 z-index 100000；日志块消失（切页）时同样清标记
- **v1.5.0 变更（恢复自动换行）**：移除 v1.4.0 的纯 CSS 不换行规则（`white-space: pre !important` / `overflow-x`）与一次性 `setOption(false)`、摘 `CodeMirror-wrap` 类的逻辑——用户确认需要站点默认的自动折行。测试新增「换行零干预」场景：2 秒观察期内脚本零 `setOption` 调用、零 wrap 类改动
- **v1.6.0 变更（最大化时不换行）**：常规视图回到站点默认折行，只有点「最大化」时摘 `CodeMirror-wrap`、长行改横向滚动，还原/Esc 时补回类。快路径里在 `maxed` 状态下只读一次 `querySelector('.CodeMirror-wrap')`（不读布局），站点点「刷新」/重渲染把类加回来时补摘一次并合并 `refresh`——避免 v1.3.x「150ms 轮询 + `setOption`」与站点互抢导致的卡顿
- **v1.7.0 变更（到底按钮）**：工具条新增「到底」按钮，点击滚动到日志末尾；注入顺序改为 `[最大化][到底][清理][刷新]`，快路径补查 `#gstack-log-end-btn`
- **v1.8.0 变更（自动到底复选框）**：工具条新增复选框，注入顺序改为 `[最大化][到底][清理][☐自动到底][刷新]`，快路径补查 `#gstack-log-auto-end-wrap`（否则从旧版热升级、页面未整刷时不会注入新控件）；勾选后以 CM `change` + 300ms debounce 判定「刷新完数据」，每轮只滚一次到末尾；状态记忆在 `localStorage`。未采用「日志每帧变化就跟随」或「用户上滚自动暂停」——需求明确是「选中后，刷新完数据滚动到底部」，行为保持可预测
- **稳定性（核心约束）**：`scan()` 由 MutationObserver（150ms 节流）+ 1s 兜底轮询驱动，**只在控件缺失/错位时才写 DOM**——同值重设 `textContent` 也会触发 childList 突变，会被 Observer 捕获形成无限扫描循环导致页面假死（v1.1.0 踩过）；按钮监听 `_gstackBound` 只绑一次，点击时现取可见块避免闭包过期；React 重绘整块替换 DOM 后扫描自动补回控件、恢复最大化状态；`scheduleFollow()` 的滚动回调里也现取可见块，不持有过期节点
- **已知限制**：站点升级改了 `.workload-details-log` 结构、按钮文案或 react-codemirror2 引入方式时需同步选择器；清理只清视图层，站点重新拉取日志后会重新渲染；勾选期间每轮数据刷新都会回到底部（**向上翻看历史请先取消勾选**）；「刷新完成」依赖 CodeMirror 的 `change` 事件，若站点改为完全绕过 CM API 直接写 DOM，只剩 `scan()` 的整块重绘兜底；`localStorage` 按站点域持久化，隐私模式 / 禁用存储时退化为每次默认勾选
