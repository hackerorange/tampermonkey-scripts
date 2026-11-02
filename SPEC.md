# SPEC · 用户脚本行为规格

本文件描述各脚本的**应有行为**（需求 + 判定规则 + 边界），是与代码同步的契约。行为变更时同步更新本文件与脚本头部的 `@version`。

- 适用范围：仓库根目录下所有 `*.user.js`
- 运行环境：Tampermonkey（Chrome / Edge），不使用任何外部依赖
- 数据边界：脚本不向第三方发送任何数据，不上报日志，不请求目标站以外的域名

---

## 1. `rancher-404-redirect.user.js`（v1.2.0）

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
2. **统一入口**：顶部 Logo（`a.nav-logo`）与侧边 Logo（`.side-menu-logo`）原本指向 `/dashboard`，点击后同样改为去 `/g/clusters`。

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

### 1.5 配置项（脚本顶部常量）

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `REDIRECT_PATH` | `/g/clusters` | 跳转目标路径，404 修复与 Logo 点击共用 |
| `LOGO_SELECTOR` | `a.nav-logo, .side-menu-logo` | Logo 选择器（逗号分隔多选择器），类名变更时只改这里 |
| `SETTLE_MS` | `500` | 错误页复核延迟（ms），防瞬时误判 |
| `GUARD_KEY` | `rancher404Redirect` | sessionStorage 键名 |
| `GUARD_WINDOW` | `60000` | 防死循环统计窗口（ms） |
| `GUARD_MAX` | `3` | 窗口内最大跳转次数 |
| `LOG` | `[Rancher 404 跳转]` | 控制台日志前缀 |

### 1.6 运行时状态

| 名称 | 位置 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| `handled` | 内存 | 单页 | 已处理（已跳转或已放弃）则为 true，后续扫描直接短路 |
| `settleTimer` | 内存 | 单页 | 复核定时器句柄，避免重复排程 |
| 防死循环记录 | `sessionStorage` | 单标签页 | `{ host, ts, count }`；`host` 不同或 `now - ts > GUARD_WINDOW` 时重置计数 |

`sessionStorage` 按标签页隔离，多个标签页各自计数、互不影响；隐私模式写入失败时静默降级（仅失去计数能力，不影响跳转）。

### 1.7 非功能要求

- 零依赖、零构建，单文件可直接安装。
- 不修改页面结构：唯一 DOM 写入是临时提示条（4s 后移除）与 Logo 的 `title` 属性。
- 不拦截网络请求，不读写 Cookie / localStorage，不采集页面内容。
- 空闲时无定时器：1s 轮询仅在前 60 秒运行，之后只靠 MutationObserver。

### 1.8 边界与已知限制

| 场景 | 行为 / 限制 |
| --- | --- |
| 跳 3 次仍是错误页 | 停止自动跳转，提示「请手动刷新或重新登录」，交给人处理 |
| 已在 `/g/clusters` 却报错 | 不再自动跳（防自指循环），仅 `handled=true` 后静默 |
| Rancher 升级改了错误页文案 | 主判据失效，兜底判据（`svg` + `.title` + `a.error-link`）仍可命中；两者都变则需更新 1.4.1 |
| Rancher 升级改了 Logo 类名 | Logo 跳转失效，改 `LOGO_SELECTOR` 即可 |
| 站内 SPA 跳转 | `location.assign` / `replace` 会整页重载（数百毫秒到数秒），换取 100% 可靠 |
| 未登录 | 不特殊处理，由 Rancher 自行跳登录页 |

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

### 1.10 版本历史

| 版本 | 变更 |
| --- | --- |
| 1.0.0 | 错误页识别 + 自动跳 `/g/clusters`；500ms 复核；防死循环；提示条 |
| 1.1.0 | 顶部 Logo（`a.nav-logo`）点击改为跳集群列表，捕获阶段委托，放行组合键与登录页 |
| 1.2.0 | 选择器扩展为 `a.nav-logo, .side-menu-logo`，侧边 Logo 同样生效；日志区分入口 |

---

## 2. `glodon-console-fav-menus.user.js`（v1.3.0）

**作用**：在开发者控制台左侧菜单（`div.left-menu`）的末级菜单项右侧加星星，点星星标记为常用；未收藏时悬停才显示空心星，收藏后菜单文字变黄。

- **站点**：`https://console.developer.glodon.com/*`
- **存储**：`GM_setValue('gld_console_fav_menus', [...])`，存的是菜单路径字符串数组（`一级 > 二级 > 三级`，按 DOM 层级拼出）
- **判定**：`li.el-menu-item` 视为末级项，`li.el-submenu` 的标题参与路径拼接
- **防重复注入**：处理过的 `li` 打 `data-gld-fav-star` 标记，重复扫描只同步状态不重复插星
- **已知限制**：菜单文案（`span` 文本）或层级调整会导致路径变化，已收藏项按新路径视为未收藏；不做跨浏览器/跨设备同步

## 3. `pep-book-downloader.user.js`（v1.0.2）

**作用**：人教教材在线阅读器底部工具栏加「下载」按钮，逐页抓图、去水印并打包 ZIP。仅在个人学习场景使用。

- **站点**：`https://book.pep.com.cn/*`
- **依赖**：`@require` JSZip 3.10.1
- **流程**：读 `config.js` 取总页数 / 书名 / 时间戳 → 逐页抓 `files/mobile/{n}.jpg` → 失败重试与补抓 → 去水印 → ZIP（STORE）下载
- **去水印**：顶部按列重建背景色（只修比背景「深」的像素，保护白色正文）、底部按主色占比 ≥95% 整带填充（深色正文 2px 膨胀保护）
- **断点续传**：已抓页面缓存在内存数组中，不刷新页面可继续
- **已知限制**：遇 WAF 滑块验证时暂停并提示，需人工过验证后重新点击；接口或目录结构变更可能失效；翻页图片尺寸过小/过大时去水印判定阈值需微调（`TOP_BOX` / `BOTTOM_H` / `STRONG_FRAC`）
