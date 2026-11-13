// ==UserScript==
// @name         广联达 Rancher · 404 页面自动跳转集群列表
// @namespace    zhongct.glodon.rancher.redirect
// @version      1.6.0
// @description  登录 Rancher 后偶发「This page could not be found」错误页时自动跳转到 /g/clusters；顶部/侧边 Logo（a.nav-logo、.side-menu-logo）点击也跳到集群列表；日志弹窗固定为视口大小（标题与按钮不再被滚出屏幕），弹窗内加「暂停滚动」开关——勾选后日志内容停止追加、视图完全冻结，可自由上翻，取消勾选恢复追加并立即回到底部跟随。支持 rancher / rancher-sg / rancher-pri / rancher-dev 四个环境。
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
      }
    });
    // 弹窗关掉后恢复背景滚动
    const shouldLock = open > 0;
    if (document.body.classList.contains(LOG_LOCK_CLASS) !== shouldLock) {
      document.body.classList.toggle(LOG_LOCK_CLASS, shouldLock);
    }
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

  console.log(LOG, '已启动：404 自动跳转 + Logo 跳转 + 日志弹窗固定 + 暂停滚动');
})();
