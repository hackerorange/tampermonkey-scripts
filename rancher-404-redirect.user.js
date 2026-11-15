// ==UserScript==
// @name         广联达 Rancher · 404 页面自动跳转集群列表
// @namespace    zhongct.glodon.rancher.redirect
// @version      1.13.6
// @description  登录 Rancher 后偶发「This page could not be found」错误页时自动跳转到 /g/clusters；顶部/侧边 Logo（a.nav-logo、.side-menu-logo）点击也跳到集群列表；日志弹窗固定为视口大小（标题与按钮不再被滚出屏幕），弹窗内加「暂停滚动」开关——勾选后日志内容停止追加、视图完全冻结，可自由上翻，取消勾选恢复追加并立即回到底部跟随；关键字搜索条挂在日志区上方（弹窗头部行正下方，占一整行）——输入关键字点「高亮」，命中所在的整行画 40% 黑色压暗背景（CSS Custom Highlight 绘制，只覆盖文字宽度、不顶到最右，彩色高亮不再刺眼），当前定位行的背景压暗到 60% 更醒目，可用「上一个/下一个」在命中行间定位、「复制」一键复制全部命中行内容，并可勾选「仅显示高亮」隐去其余日志文字、只看命中行。内容重建采用「节流+尾随」——高速流式输出或滚动懒加载出来的新命中行也能自动补上背景（纯防抖会被持续变更饿死，导致只有点高亮那一刻屏幕内已有的行有背景色），另有 2 秒周期兜底重建。支持 rancher / rancher-sg / rancher-pri / rancher-dev 四个环境。
// @author       zhongct
// @match        *://rancher.glodon.com/*
// @match        *://rancher-sg.glodon.com/*
// @match        *://rancher-pri.glodon.com/*
// @match        *://rancher-dev.glodon.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/hackerorange/tampermonkey-scripts
// @supportURL   https://github.com/hackerorange/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/rancher-404-redirect.user.js
// @downloadURL  https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/rancher-404-redirect.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============ 配置 ============
  const REDIRECT_PATH = '/g/clusters';   // 出错后跳转的目标路径
  const LOGO_SELECTOR = 'a.nav-logo, .side-menu-logo'; // 顶部 / 侧边 Rancher Logo，点它原本去 /dashboard，这里改成去集群列表
  const SETTLE_MS = 500;                 // 检测到错误页后再等这么久，避免瞬时渲染误判
  const GUARD_KEY = 'rancher404Redirect';
  const GUARD_WINDOW = 60000;            // 防死循环窗口：60 秒内
  const GUARD_MAX = 3;                   // 最多跳转 3 次，仍失败则停手，交给人处理
  const PIN_LOG_MODAL = true;            // 日志弹窗固定为视口大小（标题栏/按钮不再被长日志顶出屏幕）
  const LOG_MODAL_BOX = '.container-log'; // 日志弹窗的内容容器，命中即认为是「日志查看」弹窗
  const LOG_BOX_CLASS = 'r404-log-box';
  const LOG_OVERLAY_CLASS = 'r404-log-overlay';
  const LOG_LOCK_CLASS = 'r404-log-lock';
  // 「暂停滚动」悬浮开关（v1.4.0）：勾选后冻结 Ember 对日志体的程序化滚动
  const PAUSE_CHIP_CLASS = 'r404-pause-chip';
  const BOTTOM_ALLOW_MS = 600;           // 点「回到底部」后放行程序滚动的窗口
  // 关键字高亮（v1.7.0）：日志体上方注入 [输入框][高亮]，命中处加亮色背景
  const HL_BAR_CLASS = 'r404-hl-bar';
  const HL_BTN_CLASS = 'r404-hl-btn';
  const HL_COUNT_CLASS = 'r404-hl-count';
  const HL_NAME = 'r404-log-hl';         // CSS Custom Highlight 注册名（::highlight() 引用）
  const HL_CURRENT_NAME = 'r404-log-hl-cur'; // 当前定位行的高亮名（60% 黑，比普通命中行更暗）
  const HL_ONLY_CLASS = 'r404-hl-only';  // 「仅显示高亮」生效时挂在 pre 上的类
  const HL_ONLY_TOGGLE_CLASS = 'r404-hl-only-toggle'; // 「仅显示高亮」复选框的类名
  const HL_REFRESH_MS = 250;             // 内容变化后重建高亮的节流间隔（ms）
  const HL_MAX_RANGES = 5000;            // 单次最多标记的命中数，防超大日志卡顿
  const HL_NAV_BTN_CLASS = 'r404-hl-nav';   // 「上一个 / 下一个」定位按钮
  const HL_POS_CLASS = 'r404-hl-pos';       // 「3/12」当前位置指示
  const LOG = '[Rancher 404 跳转]';

  let handled = false;   // 本次页面生命周期内是否已处理（跳转或已放弃）
  let settleTimer = null;

  // ============ 错误页识别 ============
  // Rancher 前端是 Nuxt，错误页结构大致为：
  //   <div class="__nuxt-error-page"><div class="error">
  //     <svg .../><div class="title">This page could not be found</div>
  //     <p class="description"><a href="/dashboard/" class="error-link">Back to Home</a></p>
  //   </div></div>
  function isNuxtErrorBox(el) {
    if (!el || el.nodeType !== 1) return false;
    const title = el.querySelector('.title');
    const text = (title ? title.textContent : el.textContent) || '';
    // 主判据：标题文案
    if (/could not be found|page not found|not found|页面不存在|找不到/i.test(text)) {
      return (el.getBoundingClientRect ? el.getBoundingClientRect().height : 0) > 40;
    }
    // 兜底判据：结构特征（svg 图标 + .title + a.error-link）
    if (title && el.querySelector('svg') && el.querySelector('a.error-link')) {
      const h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
      return h > 80;
    }
    return false;
  }

  function findErrorPage() {
    // 优先按报错页的常见位置精确查找，再做全局兜底
    const scopes = [
      '#__layout .error',
      'main .error',
      '.error-page .error',
      '.error',
    ];
    for (const sel of scopes) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const el of nodes) {
        if (isNuxtErrorBox(el)) return el;
      }
    }
    return null;
  }

  // ============ 防死循环 ============
  function readGuard() {
    try {
      return JSON.parse(sessionStorage.getItem(GUARD_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function bumpGuard() {
    const now = Date.now();
    let rec = readGuard();
    if (!rec || typeof rec.count !== 'number' || rec.host !== location.hostname || now - rec.ts > GUARD_WINDOW) {
      rec = { host: location.hostname, ts: now, count: 0 };
    }
    rec.count += 1;
    rec.ts = now;
    try {
      sessionStorage.setItem(GUARD_KEY, JSON.stringify(rec));
    } catch (e) {
      /* 隐私模式等场景写入失败，忽略即可 */
    }
    return rec.count;
  }

  function isAlreadyTarget() {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    return p === REDIRECT_PATH;
  }

  // ============ 提示条 ============
  function toast(msg) {
    const el = document.createElement('div');
    el.id = 'rancher404Toast';
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:9px 18px', 'border-radius:8px',
      'background:rgba(38,44,54,.94)', 'color:#fff', 'font-size:13px',
      'font-family:"PingFang SC","Microsoft YaHei",sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'pointer-events:none',
      'line-height:1.5', 'max-width:80vw',
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ============ 主流程 ============
  function redirect(reason) {
    if (handled) return;
    handled = true;

    if (isAlreadyTarget()) {
      console.log(LOG, '当前已在目标路径，跳过跳转');
      return;
    }

    const count = bumpGuard();
    if (count > GUARD_MAX) {
      console.warn(LOG, `短时间已跳转 ${GUARD_MAX} 次仍失败，停止自动跳转`);
      toast('Rancher 页面异常，自动跳转多次仍未成功，请手动刷新或重新登录');
      return;
    }

    const target = location.origin + REDIRECT_PATH;
    console.log(LOG, `检测到错误页（${reason}），跳转到 ${target}（第 ${count} 次）`);
    toast('检测到 Rancher 错误页，正在跳转到集群列表…');

    // 留一点时间让提示可见，再整页替换（Nuxt 的客户端路由无法从错误页自救）
    setTimeout(() => {
      try {
        location.replace(target);
      } catch (e) {
        location.href = target;
      }
    }, 350);
  }

  function check() {
    if (handled) return;
    const el = findErrorPage();
    if (!el) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      return;
    }
    // 错误页可能只是瞬时渲染：等一小会儿再复核一次
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (handled) return;
      if (findErrorPage()) redirect('error-page');
    }, SETTLE_MS);
  }

  // ============ Logo 点击 → 集群列表 ============
  // 顶部：<a class="nav-logo logo-oss btn bg-transparent"><span class="sr-only">Rancher</span></a>
  // 侧边：<div class="side-menu-logo"><img class="side-menu-logo-img" src="/dashboard/img/rancher-logo.xxx.svg"></div>
  // 默认点击会去 /dashboard（有时就是那个会 404 的页面），这里统一改成去 /g/clusters。
  function goToClusters(from) {
    if (isAlreadyTarget()) {
      console.log(LOG, `${from}：已在集群列表页，无需跳转`);
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (e) {
        window.scrollTo(0, 0);
      }
      return;
    }
    const target = location.origin + REDIRECT_PATH;
    console.log(LOG, `${from}：跳转到 ${target}`);
    location.assign(target);
  }

  function bindLogoClick() {
    // 用事件委托 + 捕获阶段：Logo 会被 SPA 重绘，且要在 Rancher 自己的点击处理之前拦下
    document.addEventListener('click', (e) => {
      // 让 Ctrl/Cmd/Shift/中键点击等仍走浏览器原生行为
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // 登录/引导页的 Logo 不动它，否则会「跳集群列表 → 弹回登录页」白刷一遍
      if (/^\/(login|auth|verify|setup)\b/i.test(location.pathname)) return;
      const a = e.target && e.target.closest ? e.target.closest(LOGO_SELECTOR) : null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const label = a.classList.contains('side-menu-logo') ? '点击侧边 Logo' : '点击顶部 Logo';
      goToClusters(label);
    }, true);

    // 顺手加个悬停提示（元素可能重绘，同样走委托）
    document.addEventListener('mouseover', (e) => {
      const a = e.target && e.target.closest ? e.target.closest(LOGO_SELECTOR) : null;
      if (a && a.title !== '前往集群列表') a.title = '前往集群列表';
    }, true);
  }

  // ============ 日志弹窗固定 ============
  // Rancher「日志查看」弹窗结构（Ember）：
  //   .modal-overlay.modal-open > .modal-container.large-modal.fullscreen-modal
  //     > .container-log > h2(标题+服务选择+状态) / .protip / pre.log-body / .footer-actions(按钮)
  // 问题：日志内容很长时弹窗整体高度超过视口，弹窗跟着页面一起滚，标题栏和按钮被顶出屏幕。
  // 处理：弹窗钉成视口内的定尺盒子，只让 pre.log-body 内部滚动；并锁住背景滚动。
  function injectLogModalStyle() {
    if (document.getElementById('r404-log-modal-style')) return;
    const css = `
      body.${LOG_LOCK_CLASS} { overflow: hidden !important; }

      .modal-overlay.${LOG_OVERLAY_CLASS} {
        position: fixed !important;
        top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
        width: 100% !important; height: 100% !important;
        margin: 0 !important;
        padding: 12px !important;
        box-sizing: border-box !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        overflow: hidden !important;
      }

      /* overlay → .container-log 之间的每一层都改成纵向 flex，高度才能逐层传下去 */
      .modal-overlay.${LOG_OVERLAY_CLASS} .${LOG_BOX_CLASS} {
        display: flex !important;
        flex-direction: column !important;
        min-height: 0 !important;
        overflow: hidden !important;
        margin: 0 !important;
        box-sizing: border-box !important;
      }

      .modal-overlay.${LOG_OVERLAY_CLASS} .modal-container {
        position: relative !important;
        top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;
        transform: none !important;
        margin: 0 !important;
        /* 铺满 overlay 的内容区：左右不留额外空白，四边等距 12px */
        width: 100% !important;
        max-width: 100% !important;
        height: calc(100vh - 24px) !important;
        max-height: calc(100vh - 24px) !important;
      }

      /* 容器自身可能被 Rancher 写成固定高度，这里让 flex 接管 */
      .modal-overlay.${LOG_OVERLAY_CLASS} .container-log {
        flex: 1 1 auto !important;
        height: auto !important;
        max-height: 100% !important;
        position: relative !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .container-log > h2 { flex: 0 0 auto !important; }
      .modal-overlay.${LOG_OVERLAY_CLASS} .protip { flex: 0 0 auto !important; }

      /* 只有日志体自己滚 */
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body {
        flex: 1 1 auto !important;
        height: auto !important;
        max-height: none !important;
        min-height: 0 !important;
        margin: 0 !important;
        overflow: auto !important;
      }

      /* 按钮条保持 Rancher 原样式（底部绝对定位 + 内部绝对定位的勾选组），
         容器已被限高，它自然贴在盒子底部，不会跟着长日志跑掉 */
      .modal-overlay.${LOG_OVERLAY_CLASS} .footer-actions { flex: 0 0 auto !important; }

      /* 「暂停滚动」悬浮开关：挂在 overlay 右下、按钮条上方，独立于
         Rancher 的 footer 布局（footer 内部是绝对定位，硬塞会互相叠） */
      .modal-overlay.${LOG_OVERLAY_CLASS} > .${PAUSE_CHIP_CLASS} {
        position: absolute !important;
        right: 20px !important;
        bottom: 56px !important;
        z-index: 60 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        padding: 3px 12px !important;
        font-size: 12px !important;
        line-height: 1.4 !important;
        color: #4b5163 !important;
        background: rgba(255, 255, 255, .96) !important;
        border: 1px solid #cfd6e0 !important;
        border-radius: 14px !important;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .14) !important;
        cursor: pointer !important;
        user-select: none !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} > .${PAUSE_CHIP_CLASS} input {
        margin: 0 !important;
        width: 13px !important;
        height: 13px !important;
        cursor: pointer !important;
        accent-color: #3d7ff0 !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} > .${PAUSE_CHIP_CLASS}.is-checked {
        color: #2b6cb0 !important;
        border-color: #8db4ec !important;
        background: #eaf2ff !important;
      }

      /* 关键字搜索条（v1.7.0）：挂在日志区上方、弹窗头部行正下方，占一整行 */
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        box-sizing: border-box !important;
        flex-wrap: nowrap !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .container-log > .${HL_BAR_CLASS} {
        flex: 0 0 auto !important;
        padding: 8px 12px 6px !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > input {
        flex: 0 1 260px !important;
        height: 28px !important;
        padding: 0 9px !important;
        margin: 0 !important;
        font-size: 12px !important;
        color: #2b3140 !important;
        background: #fff !important;
        border: 1px solid #cfd6e0 !important;
        border-radius: 4px !important;
        outline: none !important;
        box-shadow: none !important;
        box-sizing: border-box !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > input:focus {
        border-color: #8db4ec !important;
        box-shadow: 0 0 0 2px rgba(61, 127, 240, .16) !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_BTN_CLASS} {
        flex: 0 0 auto !important;
        height: 28px !important;
        padding: 0 15px !important;
        margin: 0 !important;
        font-size: 12px !important;
        line-height: 1 !important;
        color: #fff !important;
        background: #3d7ff0 !important;
        border: none !important;
        border-radius: 4px !important;
        cursor: pointer !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_BTN_CLASS}:hover {
        background: #2f6cd8 !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_BTN_CLASS}:disabled {
        background: #b9c3d2 !important;
        cursor: not-allowed !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_COUNT_CLASS} {
        flex: 0 0 auto !important;
        font-size: 12px !important;
        color: #6b7280 !important;
        white-space: nowrap !important;
      }

      /* 「仅显示高亮」复选框：跟在命中数后面 */
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_ONLY_TOGGLE_CLASS} {
        flex: 0 0 auto !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 4px !important;
        margin-left: 4px !important;
        font-size: 12px !important;
        line-height: 1.4 !important;
        color: #4b5163 !important;
        cursor: pointer !important;
        user-select: none !important;
        white-space: nowrap !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_ONLY_TOGGLE_CLASS} input {
        margin: 0 !important;
        width: 13px !important;
        height: 13px !important;
        cursor: pointer !important;
        accent-color: #3d7ff0 !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_ONLY_TOGGLE_CLASS}.is-checked {
        color: #2b6cb0 !important;
      }

      /* 「仅显示高亮」生效：日志文字整体透明（不可见），只留命中区。
         命中行的文字颜色由上面的 pre.r404-hl-only::highlight() 规则恢复
         （::highlight() 的 color 优先于元素自身的 color）——
         不必再去算「非命中区间」，零额外开销 */
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body.${HL_ONLY_CLASS} {
        color: transparent !important;
      }

      /* 「上一个 / 下一个」定位按钮 + 当前位置指示（v1.10.0） */
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_NAV_BTN_CLASS} {
        flex: 0 0 auto !important;
        height: 26px !important;
        padding: 0 10px !important;
        margin: 0 !important;
        font-size: 12px !important;
        line-height: 1 !important;
        color: #4b5163 !important;
        background: #f2f4f8 !important;
        border: 1px solid #cfd6e0 !important;
        border-radius: 4px !important;
        cursor: pointer !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_NAV_BTN_CLASS}:hover:not(:disabled) {
        background: #e6ebf2 !important;
        border-color: #b7c2d2 !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_NAV_BTN_CLASS}:disabled {
        color: #aeb6c2 !important;
        background: #f2f4f8 !important;
        border-color: #e0e5ec !important;
        cursor: not-allowed !important;
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} .${HL_BAR_CLASS} > .${HL_POS_CLASS} {
        flex: 0 0 auto !important;
        font-size: 12px !important;
        color: #6b7280 !important;
        white-space: nowrap !important;
      }

      /* 命中行黑色压暗背景（v1.13.6 调色）：::highlight 绘制，只覆盖文字宽度、
         不顶到日志区最右（v1.12~v1.13.2 的条带覆盖层方案实测有问题，弃用）。
         彩色高亮（绿/荧光黄/琥珀）叠在深色日志底上都会抬亮度、看久刺眼——
         改为黑色半透明「压暗」：与周围行形成明暗差来标记命中，零眩光。
         普通命中行 40% 黑；当前定位行用第二个注册名画 60% 黑（更暗更深）*/
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body::highlight(${HL_NAME}) {
        background-color: rgba(0, 0, 0, .4);
      }
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body::highlight(${HL_CURRENT_NAME}) {
        background-color: rgba(0, 0, 0, .6);
      }
      /* 「仅显示高亮」时行文字被置透明，命中行的文字需要单独恢复可见 */
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body.${HL_ONLY_CLASS}::highlight(${HL_NAME}),
      .modal-overlay.${LOG_OVERLAY_CLASS} pre.log-body.${HL_ONLY_CLASS}::highlight(${HL_CURRENT_NAME}) {
        color: #c9d3de;
      }
    `;
    const style = document.createElement('style');
    style.id = 'r404-log-modal-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function isRendered(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pinLogModals() {
    if (!PIN_LOG_MODAL || !document.body) return;
    injectLogModalStyle();
    let open = 0;
    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      const log = overlay.querySelector(LOG_MODAL_BOX);
      if (!log || !isRendered(overlay)) return;
      open++;
      if (!overlay.classList.contains(LOG_OVERLAY_CLASS)) {
        overlay.classList.add(LOG_OVERLAY_CLASS);
        console.log(LOG, '已固定日志弹窗（仅日志区内部滚动）');
      }
      // 从 .container-log 一路往上到 overlay 都打上盒子标记，避免依赖固定层级
      let el = log;
      while (el && el !== overlay) {
        if (!el.classList.contains(LOG_BOX_CLASS)) el.classList.add(LOG_BOX_CLASS);
        el = el.parentElement;
      }
      // 「暂停滚动」：给日志体挂程序滚动拦截 + 确保开关存在（pre 被 Ember
      // 重绘换新时，下一轮扫描会重新武装）
      const pre = overlay.querySelector('pre.log-body');
      if (pre) {
        armPauseScroll(pre);
        ensurePauseChip(overlay);
        ensureHighlightBar(overlay, pre);   // 关键字高亮条（v1.7.0）
      }
    });
    // 弹窗关掉后恢复背景滚动
    const shouldLock = open > 0;
    if (document.body.classList.contains(LOG_LOCK_CLASS) !== shouldLock) {
      document.body.classList.toggle(LOG_LOCK_CLASS, shouldLock);
    }
    // 弹窗全关：清掉残留的高亮区间（区间指向已销毁的日志节点）
    if (open === 0) clearHighlight();
  }

  // ============ 暂停滚动（v1.4.0 起，v1.5.0 加强为「内容也停止追加」） ============
  // Ember 在日志流式输出时会持续往 pre.log-body 写内容，并把视图程序化滚到底部，
  // 翻历史会被拽走。做法：在 pre 实例上用 defineProperty / 方法包装做「影子化」——
  //   1. 滚动通道：scrollTop / scrollTo 在暂停期吞掉程序化赋值（用户滚轮/拖动条
  //      走浏览器原生路径，不经过 setter，不受影响）；
  //   2. 内容通道（v1.5.0）：textContent / innerHTML / innerText / appendChild /
  //      append / prepend / insertBefore / insertAdjacentText / insertAdjacentHTML
  //      在暂停期全部吞掉，日志内容不再往下追加，视图完全静止；
  //   3. 兜底网：MutationObserver 监听 pre 的 childList / characterData，暂停期
  //      回滚漏网的新增节点与文本变更（characterData 用「认可值」表防回滚震荡）。
  // 取消暂停后一切通道放行，Ember 的后续写入照常进来。
  function armPauseScroll(pre) {
    if (!pre || pre._r404PauseArmed) return;
    pre._r404PauseArmed = true;
    const state = { paused: false, allowUntil: 0, _approved: null };
    // 暂停判断与「回到底部」放行窗口共用一套逻辑：窗口期内滚动和写入都放行
    const blocked = () => state.paused && Date.now() >= state.allowUntil;

    // 暂停开始时快照已有文本节点的当前值，作为 characterData 回滚的「认可值」
    state.setPaused = (v) => {
      state.paused = v;
      if (v) {
        state._approved = new WeakMap();
        try {
          for (const n of pre.childNodes) {
            if (n.nodeType === 3) state._approved.set(n, n.data);
          }
        } catch (e) { /* 快照失败则兜底网不回滚 characterData，不影响其余功能 */ }
      } else {
        state._approved = null;
      }
    };

    try {
      // ---- 1) 影子化内容写入访问器（textContent 在 Node.prototype，innerText 在
      //      HTMLElement.prototype，innerHTML 在 Element.prototype）----
      const shadowAccessor = (proto, name) => {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (d && d.get && d.set) {
          Object.defineProperty(pre, name, {
            configurable: true,
            get() { return d.get.call(this); },
            set(v) { if (blocked()) return; d.set.call(this, v); },
          });
        }
      };
      shadowAccessor(Node.prototype, 'textContent');
      shadowAccessor(Element.prototype, 'innerHTML');
      shadowAccessor(HTMLElement.prototype, 'innerText');

      // ---- 2) 影子化内容写入方法（append/prepend/insertAdjacent* 无返回值；
      //      appendChild/insertBefore 需返回节点，避免调用方拿到 undefined 崩溃）----
      const wrapMethod = (name, keepArg0) => {
        const fn = pre[name];
        if (typeof fn !== 'function') return;
        pre[name] = function (...args) {
          if (blocked()) return keepArg0 ? args[0] : undefined;
          return fn.apply(this, args);
        };
      };
      wrapMethod('appendChild', true);
      wrapMethod('insertBefore', true);
      wrapMethod('append', false);
      wrapMethod('prepend', false);
      wrapMethod('insertAdjacentText', false);
      wrapMethod('insertAdjacentHTML', false);

      // ---- 3) 滚动通道（v1.4.0 原有逻辑）----
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      if (desc && desc.get && desc.set) {
        const nativeGet = () => desc.get.call(pre);
        const nativeSet = (v) => { try { desc.set.call(pre, v); } catch (e) { /* ignore */ } };
        let realTop = nativeGet();
        // 原生滚动（滚轮/拖动条/键盘）只触发 scroll 事件，不经过 setter，在这里同步
        pre.addEventListener('scroll', () => { realTop = nativeGet(); }, { passive: true });
        Object.defineProperty(pre, 'scrollTop', {
          configurable: true,
          get() { return realTop; },
          set(v) {
            v = Number(v) || 0;
            // 暂停期间吞掉程序滚动；「回到底部」点击后的放行窗口内除外
            if (blocked()) return;
            state.allowUntil = 0;            // 放行是一次性的，用掉即失效
            nativeSet(v);
            realTop = nativeGet();           // 原生 setter 会钳制到合法区间，回读对齐
          },
        });
        // Ember 也可能用 scrollTo() 滚动，一并包住
        const nativeScrollTo = pre.scrollTo;
        if (typeof nativeScrollTo === 'function') {
          pre.scrollTo = function (...args) {
            if (blocked()) return undefined;
            state.allowUntil = 0;
            return nativeScrollTo.apply(pre, args);
          };
        }
      }

      // ---- 4) 兜底网：暂停期回滚漏网的写入（走 Range/低层 API 等未影子化的路径）。
      //      characterData 回滚以「认可值」为准，且回滚后的记录与认可值一致时跳过，
      //      避免回滚自身触发的 mutation 造成震荡 ----
      const net = new MutationObserver((muts) => {
        if (!blocked()) return;
        try {
          for (const m of muts) {
            if (m.type === 'childList') {
              for (const n of m.addedNodes) {
                try {
                  if (n.remove) n.remove(); else if (m.target) m.target.removeChild(n);
                } catch (e) { /* 节点已被移除等情况，忽略 */ }
              }
            } else if (m.type === 'characterData' && m.target && m.target.nodeType === 3) {
              const map = state._approved;
              if (!map) continue;
              if (!map.has(m.target)) {
                // 暂停开始后漏网新增的文本节点：认可其当前值，之后的变化照样回滚
                map.set(m.target, m.target.data);
                continue;
              }
              const good = map.get(m.target);
              if (m.target.data !== good) m.target.data = good;
            }
          }
        } catch (e) { /* 兜底网自身出错不影响页面 */ }
      });
      net.observe(pre, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: true,
      });

      pre._r404PauseState = state;
    } catch (e) {
      // defineProperty 失败则退化为不拦截；状态仍挂上，开关与滚动冻结尽力而为
      pre._r404PauseState = state;
    }
  }

  // 「暂停滚动」开关：悬浮在 overlay 右下、按钮条上方（CSS 定位）。
  // 每次打开弹窗默认不勾选；勾选后内容与滚动同时冻结；取消勾选恢复追加并回到底部。
  function ensurePauseChip(overlay) {
    if (overlay.querySelector('.' + PAUSE_CHIP_CLASS)) return;
    const chip = document.createElement('label');
    chip.className = PAUSE_CHIP_CLASS;
    chip.title = '勾选后日志内容停止追加、视图完全冻结，可自由上翻；取消勾选恢复追加并立即回到底部';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const text = document.createElement('span');
    text.textContent = '暂停滚动';
    chip.appendChild(cb);
    chip.appendChild(text);
    cb.addEventListener('change', () => {
      const on = cb.checked;
      chip.classList.toggle('is-checked', on);
      const pre = overlay.querySelector('pre.log-body');
      const st = pre && pre._r404PauseState;
      if (st && typeof st.setPaused === 'function') {
        st.setPaused(on);
      } else if (st) {
        st.paused = on;
      }
      if (!on && pre) {
        try { pre.scrollTop = pre.scrollHeight; } catch (e) { /* ignore */ }
      }
      console.log(LOG, on ? '已暂停：日志停止追加、视图冻结（可自由上翻）' : '已恢复：日志继续追加（已回到底部跟随）');
    });
    overlay.appendChild(chip);
  }

  // 暂停期间点 Rancher 自带的「回到底部」要仍然有效：捕获阶段委托拦截
  // 该按钮的点击，给对应日志体开一个短暂的放行窗口（BOTTOM_ALLOW_MS）
  function bindBottomButton() {
    document.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && t.closest ? t.closest('button') : null;
      if (!btn) return;
      const overlay = btn.closest('.modal-overlay');
      if (!overlay || !overlay.classList.contains(LOG_OVERLAY_CLASS)) return;
      if (!/回到底部|bottom/i.test(btn.textContent || '')) return;
      const pre = overlay.querySelector('pre.log-body');
      const st = pre && pre._r404PauseState;
      if (st && st.paused) {
        st.allowUntil = Date.now() + BOTTOM_ALLOW_MS;
        console.log(LOG, '放行「回到底部」的程序滚动（600ms）');
      }
    }, true);
  }

  // ============ 关键字高亮（v1.7.0，v1.9.0 整行，v1.10.0 定位，v1.11.0 复制，
  //              v1.13.1 搜索条回到日志体上方，v1.13.3 回退条带覆盖层） ============
  // 搜索条挂在弹窗头部行正下方、日志体上方，占一整行（v1.12/v1.13 曾塞进头部
  // 行的 h2 里，h2 是会换行的 flex 行，空间不够会把搜索条和下拉框挤得错乱）。
  // 点「高亮」（或回车）后把「命中所在的整行」画 40% 黑色压暗背景（当前
  // 定位行 60% 更暗）。v1.12~v1.13.2 用过条带覆盖层 div（width:100% 顶到日志区最右），
  // 实测有问题，v1.13.3 回退到 ::highlight 直接绘制——背景只覆盖文字宽度，
  // 不碰日志 DOM、不额外建层，滚动/流式追加天然跟随。
  // 日志底色是深色的，绿太浅会看不出来。
  // 「上一个 / 下一个」在命中行间循环定位滚动，「复制」把全部命中行写入剪贴板。
  // 实现走 CSS Custom Highlight API（CSS.highlights + ::highlight()），只注册
  // Range、不插 <mark>、不改日志 DOM：日志流式追加时区间随文本节点自动跟随，
  // 也不会和 Ember 的写入 / 暂停滚动的拦截打架。关键字按不区分大小写匹配；
  // 内容变化后按「节流 + 尾随」重建：连续输出期间每 250ms 一次、停更后补一次
  // 收尾（纯防抖会被持续变更饿死——v1.13.1 实测往下滚动新加载的命中行没有背景），
  // 另有 2 秒周期兜底（v1.13.2）。
  function highlightSupported() {
    return typeof Highlight === 'function' && !!(window.CSS && CSS.highlights);
  }

  function clearHighlight() {
    if (!highlightSupported()) return;
    if (CSS.highlights.has(HL_NAME)) CSS.highlights.delete(HL_NAME);
    if (CSS.highlights.has(HL_CURRENT_NAME)) CSS.highlights.delete(HL_CURRENT_NAME);
  }

  // 「仅显示高亮」：只改 pre 的一个类，命中区靠 ::highlight 的 color 保持可见。
  // 仅在「勾选了开关 + 有关键字 + 至少 1 处命中」时才生效——否则日志会被整片隐藏。
  function applyOnlyMode(pre, st, count) {
    const on = !!(st && st.only) && count > 0;
    if (pre.classList.contains(HL_ONLY_CLASS) !== on) {
      pre.classList.toggle(HL_ONLY_CLASS, on);
    }
  }

  function applyHighlight(pre, st) {
    if (!st || !highlightSupported()) return -1;
    if (!st.keyword) {
      CSS.highlights.delete(HL_NAME);
      if (st.countEl) st.countEl.textContent = '';
      st.count = 0;
      st.lines = 0;
      st.navRanges = [];
      st.navIdx = -1;
      updateNavUI(st);
      paintCurrent(st);
      applyOnlyMode(pre, st, 0);
      return 0;
    }
    const hl = new Highlight();
    const kw = st.keyword.toLowerCase();
    const len = st.keyword.length;
    let matches = 0;      // 命中次数（文案用）
    let lines = 0;        // 命中的「视觉行」数（跨节点的同一行只算一次）
    let rangeCount = 0;

    // 文本节点 → 该行需要着色的 [start, end) 片段集合（同一行跨多个节点时每段一条）
    const lineMap = new Map();
    // 行首节点 → Map(行首偏移 → 行信息)：按行去重计数 + 整行范围（导航定位用）
    const lineStarts = new Map();

    const addSeg = (n, s, e) => {
      if (e <= s) return;
      let arr = lineMap.get(n);
      if (!arr) { arr = []; lineMap.set(n, arr); }
      arr.push([s, e]);
    };

    // 命中落在 node 的 idx 处 → 把整行（可能横跨相邻文本节点）登记进 lineMap。
    // 日志是分块追加的，一行常被切成多个文本节点，所以行首/行尾要跨兄弟节点补齐。
    const addLineFor = (node, idx) => {
      // ---- 向左：本节点行首为 0 时，往前面的兄弟文本节点找行首 ----
      let cur = node;
      let ls = node.data.lastIndexOf('\n', idx - 1) + 1;
      const leftSegs = [];
      while (ls === 0) {
        const prev = cur.previousSibling;
        if (!prev || prev.nodeType !== 3) break;
        const pi = prev.data.lastIndexOf('\n');
        if (pi === -1) { leftSegs.push([prev, 0, prev.data.length]); cur = prev; }
        else { leftSegs.push([prev, pi + 1, prev.data.length]); break; }
      }
      // ---- 行尾：本节点内先找；找不到说明行还没结束 ----
      let ce = node.data.indexOf('\n', idx);
      if (ce === -1) ce = node.data.length;
      // ---- 行首身份：最靠左那段的起点（同行的多次命中共用，去重 + 导航定位）----
      const leftMost = leftSegs.length ? leftSegs[leftSegs.length - 1] : null;
      const keyNode = leftMost ? leftMost[0] : node;
      const keyOff = leftMost ? leftMost[1] : ls;
      let lineObjs = lineStarts.get(keyNode);
      if (!lineObjs) { lineObjs = new Map(); lineStarts.set(keyNode, lineObjs); }
      let lineObj = lineObjs.get(keyOff);
      if (!lineObj) {
        // v1.10.0：记录整行范围（行可跨多个文本节点，Range 天然跨节点），
        // 供「上一个 / 下一个」定位滚动
        lineObj = { sn: keyNode, so: keyOff, en: node, eo: ce };
        lineObjs.set(keyOff, lineObj);
        lines++;
      }
      // ---- 登记着色片段：向左补的段 + 本节点段 ----
      for (const [n, s, e] of leftSegs) addSeg(n, s, e);
      addSeg(node, ls, ce);
      // ---- 向右：本节点以行尾结束（不含 \n）就继续往后补，并延长整行范围 ----
      if (ce === node.data.length) {
        let nn = node.nextSibling;
        while (nn && nn.nodeType === 3) {
          const ni = nn.data.indexOf('\n');
          if (ni === -1) {
            addSeg(nn, 0, nn.data.length);
            lineObj.en = nn; lineObj.eo = nn.data.length;
            nn = nn.nextSibling;
          } else {
            addSeg(nn, 0, ni);
            lineObj.en = nn; lineObj.eo = ni;
            break;
          }
        }
      }
    };

    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode()) && matches < HL_MAX_RANGES) {
      textNodes.push(node);
      const text = node.data;
      if (!text || text.length < len) continue;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(kw);
      while (idx !== -1 && matches < HL_MAX_RANGES) {
        matches++;
        addLineFor(node, idx);
        idx = lower.indexOf(kw, idx + len);
      }
    }

    // 关键字被 chunk 边界切断（前半在上一文本节点、后半在下一文本节点）时，
    // 按节点逐个 indexOf 找不到 —— 补一遍相邻节点的拼接检查
    if (matches < HL_MAX_RANGES) {
      for (let i = 0; i + 1 < textNodes.length && matches < HL_MAX_RANGES; i++) {
        const a = textNodes[i];
        const b = textNodes[i + 1];
        if (!a || !b || a.nextSibling !== b) continue;
        const tailLen = Math.min(len - 1, a.data.length);
        const headLen = Math.min(len - 1, b.data.length);
        if (tailLen <= 0 || headLen <= 0) continue;
        const joined = a.data.slice(-tailLen) + b.data.slice(0, headLen);
        const lowJoined = joined.toLowerCase();
        let p = lowJoined.indexOf(kw);
        while (p !== -1 && matches < HL_MAX_RANGES) {
          if (p < tailLen && p + len > tailLen) {   // 命中跨在边界上
            matches++;
            addLineFor(a, a.data.length - tailLen + p);
          }
          p = lowJoined.indexOf(kw, p + 1);
        }
      }
    }

    // 每个节点内合并重叠/相接的片段，再统一建 Range
    for (const [n, arr] of lineMap) {
      arr.sort((a, b) => a[0] - b[0]);
      let cur = null;
      const merged = [];
      for (const s of arr) {
        if (cur && s[0] <= cur[1]) {
          if (s[1] > cur[1]) cur[1] = s[1];
        } else {
          cur = [s[0], s[1]];
          merged.push(cur);
        }
      }
      for (const seg of merged) {
        if (rangeCount >= HL_MAX_RANGES) break;
        try {
          const r = document.createRange();
          r.setStart(n, seg[0]);
          r.setEnd(n, seg[1]);
          hl.add(r);
          rangeCount++;
        } catch (e) { /* 文本节点在处理中被替换，跳过即可 */ }
      }
    }

    // 导航用：每条命中行一个 Range（document 顺序），供「上一个 / 下一个」定位
    const navRanges = [];
    for (const lineObjs of lineStarts.values()) {
      for (const lo of lineObjs.values()) {
        try {
          const r = document.createRange();
          r.setStart(lo.sn, lo.so);
          r.setEnd(lo.en, lo.eo);
          navRanges.push(r);
        } catch (e) { /* 节点在处理中被替换，跳过即可 */ }
      }
    }
    // 关键字没变（流式追加自动重建）时尽量保持当前定位行；换了关键字则复位
    const keepNav = !!(st.navRanges && st.keyword === st._navKw && st.navIdx >= 0);
    st._navKw = st.keyword;
    st.navRanges = navRanges;
    st.navIdx = keepNav ? Math.min(st.navIdx, navRanges.length - 1) : -1;

    if (rangeCount > 0) CSS.highlights.set(HL_NAME, hl);
    else CSS.highlights.delete(HL_NAME);
    if (st.countEl) {
      st.countEl.textContent = matches === 0
        ? '无匹配'
        : (matches >= HL_MAX_RANGES ? `${lines} 行 / ${matches}+ 处` : `${lines} 行 / ${matches} 处`);
    }
    st.count = matches;
    st.lines = lines;
    updateNavUI(st);
    paintCurrent(st);
    applyOnlyMode(pre, st, matches);
    return matches;
  }

  // 「上一个 / 下一个」定位（v1.10.0）：滚动让第 navIdx 条命中行在日志视口里居中。
  // 用 Range.getBoundingClientRect 拿行在视口里的位置（无需改 DOM）；
  // 暂停滚动期间开一次性放行窗口，否则 scrollTop 会被影子 setter 吞掉。
  function navigateHighlight(pre, st, dir) {
    const ranges = st.navRanges || [];
    if (!ranges.length) return;
    st.navIdx = ((st.navIdx + dir) % ranges.length + ranges.length) % ranges.length;
    const r = ranges[st.navIdx];
    try {
      const rect = r.getBoundingClientRect();
      const preRect = pre.getBoundingClientRect();
      const delta = rect.top - preRect.top - (preRect.height - rect.height) / 2;
      const ps = pre._r404PauseState;
      if (ps && ps.paused) ps.allowUntil = Date.now() + BOTTOM_ALLOW_MS;
      pre.scrollTop += delta;
    } catch (e) { /* ignore */ }
    updateNavUI(st);
    paintCurrent(st);   // 深色高亮移到新的当前定位行
  }

  function updateNavUI(st) {
    const n = (st.navRanges || []).length;
    if (st.posEl) st.posEl.textContent = n && st.navIdx >= 0 ? `${st.navIdx + 1}/${n}` : '';
    if (st.navBtns) for (const b of st.navBtns) b.disabled = !n;
  }

  // 剪贴板写入：优先 navigator.clipboard（用户手势上下文里一般可用），
  // 失败退回 textarea + execCommand 兜底（http 页面 / 权限被拒时）
  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => copyTextFallback(text));
    }
    return Promise.resolve(copyTextFallback(text));
  }

  function copyTextFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // 当前定位行加深（v1.10.0/v1.13.x）：navIdx 指向的整行 Range 注册为第二个
  // 高亮名（60% 黑，注册在后、比 40% 浅黑更暗）。v1.13.3 起不再画条带 div，
  // 背景全部交给 ::highlight——只覆盖文字宽度，与 v1.11 及之前的观感一致。
  function paintCurrent(st) {
    if (!highlightSupported()) return;
    const cur = (st.navRanges || [])[st.navIdx];
    if (cur) {
      const hlc = new Highlight();
      hlc.add(cur);
      CSS.highlights.set(HL_CURRENT_NAME, hlc);
    } else if (CSS.highlights.has(HL_CURRENT_NAME)) {
      CSS.highlights.delete(HL_CURRENT_NAME);
    }
  }

  function ensureHighlightBar(overlay, pre) {
    // 状态挂在 pre 上：pre 被 Ember 换新时关键字自然重置（等于切了容器/新弹窗）
    if (!pre._r404Hl) pre._r404Hl = { keyword: '', countEl: null, timer: null, only: false, count: 0, lines: 0, navRanges: [], navIdx: -1, posEl: null, navBtns: null };
    const st = pre._r404Hl;

    // 内容变化后重建高亮（追加、清空重写都覆盖）。v1.13.2 起「节流 + 尾随」
    // 而不是纯防抖：日志高速流式输出、滚动触发懒加载时 mutation 每几毫秒就来
    // 一次，纯防抖的定时器会被一直重置、永远等不到安静 250ms，结果只有点
    // 「高亮」那一刻已在 DOM 里的行有背景，往下滚动新出现的命中行全是裸的
    // （实测如此）。节流保证连续输出期间至少每 250ms 重建一次，停更后还会
    // 补一次收尾重建。
    if (!pre._r404HlArmed) {
      pre._r404HlArmed = true;
      let lastRun = 0;
      const obs = new MutationObserver(() => {
        if (!st.keyword) return;
        if (st.timer) return;   // 已有排程在等，这次变更由它一并覆盖
        const wait = Math.max(0, HL_REFRESH_MS - (Date.now() - lastRun));
        st.timer = setTimeout(() => {
          st.timer = null;
          lastRun = Date.now();
          applyHighlight(pre, st);
        }, wait);
      });
      obs.observe(pre, { childList: true, subtree: true, characterData: true });
      // 周期兜底（v1.13.2）：个别写入路径可能绕过观察，新命中的行会漏背景
      // ——关键字生效期间每 2 秒按当前关键字重建一次，保证最终一致
      st.guardTimer = setInterval(() => {
        if (!pre.isConnected) { clearInterval(st.guardTimer); return; }
        if (!st.keyword || document.hidden) return;
        applyHighlight(pre, st);
      }, 2000);
    }

    // 挂载位置（v1.12.0）：优先挂到弹窗头部行——「日志查看:」后面的容器选择框
    // 右边；弹窗里没有 <select> 时兜底放回日志体上方。位置期望变化时移除重建。
    const existing = overlay.querySelector('.' + HL_BAR_CLASS);
    if (existing) {
      // 条已存在：同一个 pre 就直接复用；pre 被 Ember 换新时移除重建
      // （旧条绑的是废弃节点）。v1.13.1 起不再挂进头部行——h2 是会换行的
      // flex 行，空间不够会把搜索条挤成几列、还把下拉框挤换行（实测错乱）
      if (existing._r404Pre === pre) return;
      existing.remove();
      clearHighlight();   // 旧 pre 已废弃，清掉指向它的区间
    }
    const container = pre.parentElement;
    if (!container) return;

    const bar = document.createElement('div');
    bar.className = HL_BAR_CLASS;
    bar._r404Pre = pre;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '输入关键字，点右侧「高亮」';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = HL_BTN_CLASS;
    btn.textContent = '高亮';
    const countEl = document.createElement('span');
    countEl.className = HL_COUNT_CLASS;
    // 「上一个 / 下一个」定位（v1.10.0）：在命中行之间循环跳转
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = HL_NAV_BTN_CLASS;
    prevBtn.textContent = '上一个';
    prevBtn.title = '定位到上一条命中行';
    prevBtn.disabled = true;
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = HL_NAV_BTN_CLASS;
    nextBtn.textContent = '下一个';
    nextBtn.title = '定位到下一条命中行';
    nextBtn.disabled = true;
    const posEl = document.createElement('span');
    posEl.className = HL_POS_CLASS;
    // 「复制」（v1.11.0）：把全部命中行的整行内容复制到剪贴板
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = HL_NAV_BTN_CLASS;
    copyBtn.textContent = '复制';
    copyBtn.title = '复制全部命中行的整行内容（按日志顺序，换行分隔）';
    copyBtn.disabled = true;
    // 「仅显示高亮」：勾选后除命中处外的日志文字全部隐去
    const onlyWrap = document.createElement('label');
    onlyWrap.className = HL_ONLY_TOGGLE_CLASS;
    onlyWrap.title = '勾选后只显示命中高亮的内容，其余日志文字隐去（仍占位，可正常滚动与复制）';
    const onlyCb = document.createElement('input');
    onlyCb.type = 'checkbox';
    const onlyText = document.createElement('span');
    onlyText.textContent = '仅显示高亮';
    onlyWrap.appendChild(onlyCb);
    onlyWrap.appendChild(onlyText);
    bar.appendChild(input);
    bar.appendChild(btn);
    bar.appendChild(countEl);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(posEl);
    bar.appendChild(copyBtn);
    bar.appendChild(onlyWrap);
    st.countEl = countEl;
    st.posEl = posEl;
    st.navBtns = [prevBtn, nextBtn, copyBtn];

    if (!highlightSupported()) {
      btn.disabled = true;
      input.disabled = true;
      onlyCb.disabled = true;
      countEl.textContent = '当前浏览器不支持高亮';
      console.warn(LOG, '浏览器不支持 CSS Custom Highlight API，关键字高亮不可用');
    }

    const run = () => {
      st.keyword = input.value.trim();
      const n = applyHighlight(pre, st);
      if (n > 0 && (st.navRanges || []).length) {
        st.navIdx = -1;
        navigateHighlight(pre, st, 1);   // 高亮后先定位到第一条命中行
      }
      if (n >= 0) {
        console.log(LOG, st.keyword
          ? `高亮「${st.keyword}」：${st.lines || 0} 行 / ${n} 处命中`
          : '已清除关键字高亮');
      }
    };
    btn.addEventListener('click', run);
    prevBtn.addEventListener('click', () => navigateHighlight(pre, st, -1));
    nextBtn.addEventListener('click', () => navigateHighlight(pre, st, 1));
    // 复制全部命中行：Range.toString 跨文本节点拼接，天然还原整行内容
    copyBtn.addEventListener('click', () => {
      const ranges = st.navRanges || [];
      if (!ranges.length) return;
      const text = ranges.map(r => r.toString()).join('\n');
      copyText(text).then((ok) => {
        copyBtn.textContent = ok ? `已复制 ${ranges.length} 行` : '复制失败';
        if (copyBtn._r404Timer) clearTimeout(copyBtn._r404Timer);
        copyBtn._r404Timer = setTimeout(() => {
          copyBtn._r404Timer = null;
          copyBtn.textContent = '复制';
        }, 1200);
        console.log(LOG, ok
          ? `已复制 ${ranges.length} 条命中行（共 ${text.length} 字符）`
          : '复制到剪贴板失败');
      });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
      else if (e.key === 'Escape') { e.stopPropagation(); input.blur(); }
    });
    // 清空输入即撤掉高亮，不必再点按钮
    input.addEventListener('input', () => {
      if (input.value.trim()) return;
      st.keyword = '';
      applyHighlight(pre, st);
      console.log(LOG, '已清除关键字高亮');
    });

    // 「仅显示高亮」开关：立即按当前命中数决定是否隐藏其余文字
    onlyCb.addEventListener('change', () => {
      st.only = onlyCb.checked;
      onlyWrap.classList.toggle('is-checked', onlyCb.checked);
      applyOnlyMode(pre, st, st.count || 0);
      if (onlyCb.checked && !(st.count > 0)) {
        console.log(LOG, '已勾选「仅显示高亮」：当前无命中，先输入关键字点「高亮」后生效');
      } else {
        console.log(LOG, onlyCb.checked ? '已开启「仅显示高亮」' : '已关闭「仅显示高亮」');
      }
    });

    // 挂载：弹窗头部行（h2，含「日志查看:」与服务/容器选择框）正下方、
    // 日志体正上方，占一整行——不塞进 h2 内部（h2 是 flex 行，空间不够会把
    // 搜索条与下拉框挤得换行错乱，v1.12.0/v1.13.0 实测如此）
    const header = container.querySelector('h2');
    if (header && header.parentElement === container && header.nextSibling) {
      container.insertBefore(bar, header.nextSibling);
    } else {
      container.insertBefore(bar, pre);
    }
    console.log(LOG, '已注入关键字搜索条（日志体上方）');
  }

  // ============ 监听（SPA 会随时重绘，不重载页面也可能突然变成错误页）============
  let throttleTimer = null;
  function scan() {
    check();          // 404 错误页
    pinLogModals();   // 日志弹窗固定
  }

  function scheduleCheck() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      scan();
    }, 120);
  }

  function observe() {
    const observer = new MutationObserver(scheduleCheck);
    // document-start 时 body 可能还不存在，直接观察 documentElement
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // 兜底轮询：某些场景（字体/水合完成后才插入）观察器可能错过首次绘制
  const pollTimer = setInterval(scan, 1000);
  setTimeout(() => clearInterval(pollTimer), 60000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  } else {
    scan();
  }
  observe();
  bindLogoClick();
  bindBottomButton();

  console.log(LOG, '已启动：404 自动跳转 + Logo 跳转 + 日志弹窗固定 + 暂停滚动 + 关键字高亮');
})();
