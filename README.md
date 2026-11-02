# tampermonkey-scripts

个人自用的 Tampermonkey（篡改猴）用户脚本合集，主要解决广联达内网系统与一些在线工具里的重复操作问题。

## 脚本列表

| 脚本 | 版本 | 适用站点 | 作用 |
| --- | --- | --- | --- |
| [rancher-404-redirect.user.js](./rancher-404-redirect.user.js) | 1.3.1 | `rancher.glodon.com` / `rancher-sg.glodon.com` / `rancher-pri.glodon.com` | 登录后偶发的「This page could not be found」错误页自动跳到 `/g/clusters`；顶部与侧边 Logo 点击也跳集群列表；日志弹窗固定为视口大小，长日志只在弹窗内部滚动 |
| [glodon-console-fav-menus.user.js](./glodon-console-fav-menus.user.js) | 1.4.1 | `console.developer.glodon.com` | 左侧菜单末级项右侧加星星，标记常用菜单并以橙红色高亮；收藏按菜单名记录（与层级/顺序无关），记录持久化在本机 |
| [glodon-console-version-switch.user.js](./glodon-console-version-switch.user.js) | 1.0.2 | `console.developer.glodon.com` | 应用详情页「版本选择」下方加 release / release-pre 快捷按钮（紧贴下拉框、左沿对齐），一键切换版本；页面弹出的「是否继续」确认框自动点掉，点了就跳转 |
| [pep-book-downloader.user.js](./pep-book-downloader.user.js) | 1.0.2 | `book.pep.com.cn` | 人教教材阅读器底部加「下载」按钮，抓取全部页面、去水印后打包 ZIP（仅供个人学习使用） |

各脚本的详细行为、配置项与边界条件见 [SPEC.md](./SPEC.md)。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 点击下面对应链接，Tampermonkey 会弹出安装页，点「安装」即可：

   - [安装 Rancher 跳转脚本](https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/rancher-404-redirect.user.js)
   - [安装控制台常用菜单标记](https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-fav-menus.user.js)
   - [安装控制台版本快速切换](https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-version-switch.user.js)
   - [安装人教教材下载助手](https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/pep-book-downloader.user.js)

3. 打开目标站点，脚本自动生效（无需额外配置）。

## 更新

每个脚本头部的 `@updateURL` / `@downloadURL` 都指向 `main` 分支的 raw 地址，篡改猴默认会定期检查更新，也可以在脚本列表里手动「检查更新」。脚本改动后同步递增 `@version`，否则不会触发更新提示。

也可以直接打开上面的安装链接重装一次覆盖旧版本。

## 仓库约定

- 一个功能一个 `.user.js` 文件，放在仓库根目录；文件名全小写连字符，与 `@name` 对应。
- 脚本头部保留 `@namespace` / `@version` / `@description` / `@updateURL` / `@downloadURL` / `@license`。
- 提交信息沿用 GitHub 网页端风格：新增 `Create xxx.user.js`，修改 `Update xxx.user.js`。
- 行为有变（选择器、跳转目标、阈值）时同步更新 `SPEC.md`。
- `.workbuddy/` 为本地工作记忆目录，不入库。

## 许可证

MIT
