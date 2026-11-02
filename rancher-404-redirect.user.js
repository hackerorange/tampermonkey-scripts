// ==UserScript==
// @name         广联达 Rancher · 404 页面自动跳转集群列表
// @namespace    zhongct.glodon.rancher.redirect
// @version      1.2.0
// @description  登录 Rancher 后偶发「This page could not be found」错误页时自动跳转到 /g/clusters；顶部/侧边 Logo（a.nav-logo、.side-menu-logo）点击也跳到集群列表；支持 rancher / rancher-sg / rancher-pri 三个环境。带延迟判定、防抖与防死循环保护。
// @author       zhongct
// @match        *://rancher.glodon.com/*
// @match        *://rancher-sg.glodon.com/*
// @match        *://rancher-pri.glodon.com/*
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

  // ============ 监听（SPA 会随时重绘，不重载页面也可能突然变成错误页）============
  let throttleTimer = null;
  function scheduleCheck() {
    if (throttleTimer || handled) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      check();
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
  const pollTimer = setInterval(check, 1000);
  setTimeout(() => clearInterval(pollTimer), 60000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check, { once: true });
  } else {
    check();
  }
  observe();
  bindLogoClick();

  console.log(LOG, '已启动：404 错误页自动跳转 + 顶部 Logo 点击跳转 ' + REDIRECT_PATH);
})();
