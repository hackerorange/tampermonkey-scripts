// ==UserScript==
// @name         广联达开发者控制台-版本快速切换
// @namespace    zhongct.glodon.console.version.quick
// @version      1.1.0
// @description  在应用详情页右侧「总览」页顶部加一条版本栏（当前版本 + release / release-pre 快捷按钮），点击后自动在左侧版本下拉里切换并自动确认页面弹窗、直接跳转；同时把总览页横向溢出的步骤条/学习卡片改成自适应换行，不再被右边裁掉。
// @author       zhongct
// @match        https://console.developer.glodon.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/hackerorange/tampermonkey-scripts
// @supportURL   https://github.com/hackerorange/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-version-switch.user.js
// @downloadURL  https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-version-switch.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============ 配置 ============
  // 快捷按钮对应的版本名（与版本下拉里条目的名称精确匹配，顺序即按钮顺序）
  const TARGETS = ['release', 'release-pre'];
  // 左侧版本选择器容器（div.version.version-change），切换仍然走它
  const PANEL_SELECTOR = '.application .version';
  // 「总览」微应用（qiankun 渲染在主文档里，不是 iframe）
  const OVERVIEW_SELECTOR =
    '#subapp-viewport > div[id^="__qiankun_microapp_wrapper_for_open_open_component_overview"]';
  const BAR_CLASS = 'gld-version-bar';
  const BTN_CLASS = 'gld-vq-btn';
  const BTN_ACTIVE_CLASS = 'gld-vq-btn-active';
  const TOAST_ID = 'gld-vq-toast';
  const LOG = '[版本快速切换]';

  // 点击后自动确认确认框的时间窗
  const CONFIRM_WINDOW_MS = 10000;

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function toast(text) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.style.cssText = [
        'position: fixed', 'top: 16px', 'left: 50%', 'transform: translateX(-50%)',
        'z-index: 99999', 'padding: 8px 16px', 'border-radius: 4px',
        'background: rgba(0,0,0,.75)', 'color: #fff', 'font-size: 13px',
        'box-shadow: 0 2px 8px rgba(0,0,0,.2)', 'transition: opacity .3s',
        'pointer-events: none',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }

  // ---------- 样式 ----------
  function injectStyle() {
    if (document.getElementById('gld-vq-style')) return;
    const style = document.createElement('style');
    style.id = 'gld-vq-style';
    style.textContent = `
      .${BAR_CLASS} {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 0 12px;
        padding: 8px 16px;
        background: #fff;
        border: 1px solid #e8e8e8;
        border-radius: 4px;
        font-size: 13px;
        color: #595959;
        line-height: 22px;
      }
      .${BAR_CLASS} .gld-vb-label { font-weight: 600; color: #262626; }
      .${BAR_CLASS} .gld-vb-cur { color: #262626; }
      .${BAR_CLASS} .gld-vb-sep { width: 1px; height: 14px; background: #e8e8e8; }
      .${BTN_CLASS} {
        padding: 1px 10px;
        font-size: 12px;
        line-height: 18px;
        border: 1px solid #d9d9d9;
        border-radius: 3px;
        background: #fff;
        color: #595959;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .${BTN_CLASS}:hover {
        color: #268dff;
        border-color: #beddff;
        background: #e9f4ff;
      }
      .${BTN_CLASS}.${BTN_ACTIVE_CLASS} {
        color: #fff;
        background: #268dff;
        border-color: #268dff;
        cursor: default;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- 自动确认切换弹窗 ----------
  // 页面在点到版本条目后会弹 Element UI 的 MessageBox「你将切换到 xxx，是否继续」，
  // 这里在点击后的一小段时间窗内自动点「确定」，做到点了就跳转。
  let confirmDeadline = 0;
  let confirmTarget = '';
  let confirmDone = false;
  let confirmTimer = null;

  function armAutoConfirm(name) {
    confirmTarget = name;
    confirmDone = false;            // 每次点击重置，弹窗节点被复用也能再确认一次
    confirmDeadline = Date.now() + CONFIRM_WINDOW_MS;
    if (confirmTimer) return;
    confirmTimer = setInterval(() => {
      if (!confirmDeadline || Date.now() > confirmDeadline) {
        clearInterval(confirmTimer);
        confirmTimer = null;
        return;
      }
      tryAutoConfirm();
    }, 100);
  }

  function visibleMessageBox() {
    const wraps = document.querySelectorAll(
      '.el-message-box__wrapper, .el-message-box'
    );
    for (const el of wraps) {
      const box = el.classList.contains('el-message-box') ? el : el.querySelector('.el-message-box');
      if (!box) continue;
      const wrap = box.parentElement;
      if (wrap && wrap.style && wrap.style.display === 'none') continue;
      if (box.getBoundingClientRect().height === 0) continue;   // 还在收起态
      return box;
    }
    return null;
  }

  function tryAutoConfirm() {
    if (!confirmDeadline || confirmDone || Date.now() > confirmDeadline) return;
    const box = visibleMessageBox();
    if (!box) return;
    const text = normalize(box.textContent);
    // 只对「切换版本」的确认框动手，避免误点其它确认弹窗
    if (text.indexOf('切换') < 0 && !(confirmTarget && text.indexOf(confirmTarget) >= 0)) return;

    const ok = box.querySelector('.el-message-box__btns .el-button--primary')
      || box.querySelector('.el-message-box__btns button:last-of-type');
    if (!ok) return;
    confirmDone = true;          // 一次点击只确认一次
    confirmDeadline = 0;         // 已确认，关闭时间窗
    console.log(LOG, '自动确认弹窗：' + text.slice(0, 60));
    ok.click();
  }

  // ---------- 版本切换（仍走左侧下拉，由页面自身 Vue 处理） ----------
  function findVersionItem(root, name) {
    const scope = root || document;
    const items = scope.querySelectorAll('li.el-dropdown-menu__item.other-item');
    for (const li of items) {
      const nameEl = li.querySelector('.item-middle .name span');
      const n = normalize(nameEl && (nameEl.getAttribute('title') || nameEl.textContent));
      if (n === name) return li;
    }
    return null;
  }

  function currentVersionName(panel) {
    const el = panel.querySelector('.version-select .version-num');
    return normalize(el && el.textContent);
  }

  async function switchTo(panel, name) {
    const dropdown = panel.querySelector('.el-dropdown');
    // 页面 .el-dropdown 上常驻 disabled="disabled" 属性，实测不代表真的禁用，不据此拦下
    const markedDisabled = !!(dropdown && dropdown.hasAttribute('disabled'));
    if (markedDisabled) console.log(LOG, '下拉带 disabled 属性，仍尝试切换');

    const trigger = panel.querySelector('.version-select');
    if (trigger) {
      ['mouseenter', 'mouseover'].forEach((t) =>
        trigger.dispatchEvent(new MouseEvent(t, { bubbles: true }))
      );
      await sleep(200);
    }

    let item = findVersionItem(panel, name);
    if (!item && trigger) {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);
      item = findVersionItem(panel, name);
    }
    if (!item) {
      toast('未找到版本「' + name + '」');
      console.warn(LOG, '下拉里没有名为「' + name + '」的条目');
      return;
    }

    const before = currentVersionName(panel);
    console.log(LOG, '切换到版本「' + name + '」（当前 ' + before + '）');
    armAutoConfirm(name);   // 弹窗可能立刻就出来，先布好监听
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(800);

    // 成功就静默（页面通常已经跳转/刷新），只有没反应时才提示
    const after = currentVersionName(panel);
    const selected = item.classList.contains('select-item') || !!item.querySelector('.cur-select');
    if (after === name || selected || !document.contains(panel)) {
      console.log(LOG, '切换成功 →', after);
      refreshBars();
      return;
    }
    toast(markedDisabled
      ? '页面未响应切换，可能当前禁用了版本切换（开发模式）'
      : '未检测到版本变化，请展开下拉确认');
    console.warn(LOG, '点击已派发但版本未变化，当前仍为', after);
  }

  // ---------- 总览页版本栏 ----------
  function buildBar(panel) {
    const bar = document.createElement('div');
    bar.className = BAR_CLASS;

    const label = document.createElement('span');
    label.className = 'gld-vb-label';
    label.textContent = '版本';
    const cur = document.createElement('span');
    cur.className = 'gld-vb-cur';
    cur.textContent = currentVersionName(panel) || '—';
    const sep = document.createElement('span');
    sep.className = 'gld-vb-sep';
    bar.append(label, cur, sep);

    TARGETS.forEach((name) => {
      const btn = document.createElement('span');
      btn.className = BTN_CLASS;
      btn.textContent = name;
      btn.title = '切换到版本「' + name + '」';
      if (cur.textContent === name) btn.classList.add(BTN_ACTIVE_CLASS);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchTo(panel, name);
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  function refreshBars() {
    const panel = document.querySelector(PANEL_SELECTOR);
    const cur = panel ? currentVersionName(panel) : '';
    document.querySelectorAll('.' + BAR_CLASS).forEach((bar) => {
      const curEl = bar.querySelector('.gld-vb-cur');
      if (curEl && cur) curEl.textContent = cur;
      bar.querySelectorAll('.' + BTN_CLASS).forEach((btn) => {
        btn.classList.toggle(BTN_ACTIVE_CLASS, btn.textContent === cur);
      });
    });
  }

  // 总览页内容是微应用渲染的，横向内容（5 阶段步骤、学习卡片）在小窗口下会被右边裁掉。
  // 这里把「比可视区宽」的容器放宽：去掉固定最小宽、允许 flex 换行；滚动容器和弹层不动。
  function relaxLayout(root) {
    const scroller = root.closest('.el-scrollbar__wrap, .el-scrollbar');
    const visibleW = (scroller && scroller.clientWidth)
      || (root.parentElement && root.parentElement.clientWidth)
      || window.innerWidth;
    if (!visibleW) return;

    root.querySelectorAll('div,section,ul').forEach((el) => {
      if (el.dataset.gldRelax === '1') return;
      const w = el.getBoundingClientRect().width;
      if (w <= visibleW + 2) return;                       // 没超出可视区
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'absolute') return;  // 弹层等不动
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;   // 本就设计为滚动
      el.dataset.gldRelax = '1';
      el.style.minWidth = '0';
      el.style.maxWidth = '100%';
      if (el.style.width && parseFloat(el.style.width) > visibleW) el.style.width = '100%';
      if (cs.display.indexOf('flex') >= 0) {
        el.style.flexWrap = 'wrap';
        if (!el.style.rowGap) el.style.rowGap = '16px';
      }
    });
  }

  function decorateOverview(wrap, panel) {
    let bar = wrap.querySelector(':scope > .' + BAR_CLASS);
    if (!bar) {
      bar = buildBar(panel);
      wrap.insertBefore(bar, wrap.firstChild);
      console.log(LOG, '已在总览页注入版本栏：', TARGETS.join(' / '));
    }
    relaxLayout(wrap);
    refreshBars();
  }

  function scan() {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (!panel || !panel.closest('.application')) return;   // 找不到侧栏版本选择器就不注入
    document.querySelectorAll(OVERVIEW_SELECTOR).forEach((wrap) => {
      decorateOverview(wrap, panel);
    });
  }

  // ---------- SPA 监听 ----------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 200);
  }

  function realignAll() {
    // 窗口尺寸变化后重新探测溢出
    document.querySelectorAll('[data-gld-relax]').forEach((el) => {
      delete el.dataset.gldRelax;
    });
    scheduleScan();
  }

  function init() {
    injectStyle();
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', realignAll);
    console.log(LOG, '已启动：总览页版本栏 →', TARGETS.join(' / '));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
