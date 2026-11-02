# SPEC · 用户脚本行为规格

本文件描述各脚本的**应有行为**（需求 + 判定规则 + 边界），是与代码同步的契约。行为变更时同步更新本文件与脚本头部的 `@version`。

- 适用范围：仓库根目录下所有 `*.user.js`
- 运行环境：Tampermonkey（Chrome / Edge），不使用任何外部依赖
- 数据边界：脚本不向第三方发送任何数据，不上报日志，不请求目标站以外的域名

---

## 1. `rancher-404-redirect.user.js`（v1.3.1）

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
| `LOG` | `[Rancher 404 跳转]` | 控制台日志前缀 |

### 1.6 运行时状态

| 名称 | 位置 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| `handled` | 内存 | 单页 | 已处理（已跳转或已放弃）则为 true，后续扫描直接短路 |
| `settleTimer` | 内存 | 单页 | 复核定时器句柄，避免重复排程 |
| 防死循环记录 | `sessionStorage` | 单标签页 | `{ host, ts, count }`；`host` 不同或 `now - ts > GUARD_WINDOW` 时重置计数 |
| `r404-log-overlay` / `r404-log-box` / `r404-log-lock` | DOM 类名 | 弹窗存续期间 | 分别标记弹窗遮罩、布局盒子链、`body` 滚动锁；弹窗关闭后无需清理（节点随弹窗一起销毁） |

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

### 1.10 版本历史

| 版本 | 变更 |
| --- | --- |
| 1.0.0 | 错误页识别 + 自动跳 `/g/clusters`；500ms 复核；防死循环；提示条 |
| 1.1.0 | 顶部 Logo（`a.nav-logo`）点击改为跳集群列表，捕获阶段委托，放行组合键与登录页 |
| 1.2.0 | 选择器扩展为 `a.nav-logo, .side-menu-logo`，侧边 Logo 同样生效；日志区分入口 |
| 1.3.0 | 新增日志弹窗固定：overlay 固定视口、容器限高、日志区内部滚动、背景滚动锁；`PIN_LOG_MODAL` 可开关 |
| 1.3.1 | 弹窗宽度铺满：去掉 1280px 上限，四边留白统一 12px（原左右空白偏大） |

---

## 2. `glodon-console-fav-menus.user.js`（v1.4.0）

**作用**：在开发者控制台左侧菜单（`div.left-menu`）的末级菜单项右侧加星星，点星星标记为常用；未收藏时悬停才显示空心星，收藏后菜单文字变黄。

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

## 3. `pep-book-downloader.user.js`（v1.0.2）

**作用**：人教教材在线阅读器底部工具栏加「下载」按钮，逐页抓图、去水印并打包 ZIP。仅在个人学习场景使用。

- **站点**：`https://book.pep.com.cn/*`
- **依赖**：`@require` JSZip 3.10.1
- **流程**：读 `config.js` 取总页数 / 书名 / 时间戳 → 逐页抓 `files/mobile/{n}.jpg` → 失败重试与补抓 → 去水印 → ZIP（STORE）下载
- **去水印**：顶部按列重建背景色（只修比背景「深」的像素，保护白色正文）、底部按主色占比 ≥95% 整带填充（深色正文 2px 膨胀保护）
- **断点续传**：已抓页面缓存在内存数组中，不刷新页面可继续
- **已知限制**：遇 WAF 滑块验证时暂停并提示，需人工过验证后重新点击；接口或目录结构变更可能失效；翻页图片尺寸过小/过大时去水印判定阈值需微调（`TOP_BOX` / `BOTTOM_H` / `STRONG_FRAC`）
