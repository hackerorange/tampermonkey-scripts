// ==UserScript==
// @name         广联达开发者控制台-版本快速切换
// @namespace    zhongct.glodon.console.version.quick
// @version      1.0.2
// @description  在应用详情页左上角「版本选择」下方加 release / release-pre 快捷按钮（紧贴下拉框、左沿对齐），点击后自动在版本下拉里找到对应版本并切换，页面弹出的「是否继续」确认框自动点掉，直接跳转。
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
  // 版本选择器容器（div.version.version-change），找不到时退回 .application .version
  const PANEL_SELECTOR = '.application .version';
  const BAR_CLASS = 'gld-version-quick';
  const BTN_CLASS = 'gld-vq-btn';
  const BTN_ACTIVE_CLASS = 'gld-vq-btn-active';
  const TOAST_ID = 'gld-vq-toast';
  const PROCESSED_ATTR = 'data-gld-vq';
  const ALIGNED_ATTR = 'data-gld-vq-aligned';
  const LOG = '[版本快速切换]';

  // 布局常量
  const BAR_GAP_PX = 8;        // 版本下拉底边 → 按钮顶边
  const BAR_BOTTOM_PX = 12;    // 按钮底边 → 下方菜单的留白
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
        gap: 6px;
        margin: 0;
        padding: 0 12px;
        box-sizing: border-box;
        /* 上下间距由 alignBar() 一次性算出（margin-top 贴下拉、padding-bottom 给下方留白） */
      }
      .${BTN_CLASS} {
        padding: 2px 10px;
        font-size: 12px;
        line-height: 18px;
        border: 1px solid #dcdfe6;
        border-radius: 3px;
        background: #fff;
        color: #606266;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      .${BTN_CLASS}:hover {
        color: #409eff;
        border-color: #c6e2ff;
        background: #ecf5ff;
      }
      .${BTN_CLASS}.${BTN_ACTIVE_CLASS} {
        color: #fff;
        background: #409eff;
        border-color: #409eff;
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

  // ---------- 版本切换 ----------
  // 在版本下拉菜单里按名称找条目；菜单是 v-show 常驻 DOM，无需真的展开
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

  // 当前选中的版本名（顶部触发器上的文字，如 " master"）
  function currentVersionName(panel) {
    const el = panel.querySelector('.version-select .version-num');
    return normalize(el && el.textContent);
  }

  async function switchTo(panel, name) {
    const dropdown = panel.querySelector('.el-dropdown');
    // 注意：页面上 .el-dropdown 常带 disabled="disabled" 属性，但实测仍能切换，所以不据此拦下
    const markedDisabled = !!(dropdown && dropdown.hasAttribute('disabled'));
    if (markedDisabled) console.log(LOG, '下拉带 disabled 属性，仍尝试切换');

    const trigger = panel.querySelector('.version-select');
    // 先模拟 hover 打开下拉（Element UI 默认 hover 触发），让页面按真实交互走一遍
    if (trigger) {
      ['mouseenter', 'mouseover'].forEach((t) =>
        trigger.dispatchEvent(new MouseEvent(t, { bubbles: true }))
      );
      await sleep(200);
    }

    let item = findVersionItem(panel, name);
    if (!item && trigger) {
      // 兜底：菜单懒渲染或 hover 未生效时，补偿一次点击
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
      return;
    }
    toast(markedDisabled
      ? '页面未响应切换，可能当前禁用了版本切换（开发模式）'
      : '未检测到版本变化，请展开下拉确认');
    console.warn(LOG, '点击已派发但版本未变化，当前仍为', after);
  }

  // ---------- 注入按钮 ----------
  function buildBar(panel) {
    const bar = document.createElement('div');
    bar.className = BAR_CLASS;
    const cur = currentVersionName(panel);

    TARGETS.forEach((name) => {
      const btn = document.createElement('span');
      btn.className = BTN_CLASS;
      btn.textContent = name;
      btn.title = '切换到版本「' + name + '」';
      if (cur === name) btn.classList.add(BTN_ACTIVE_CLASS);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchTo(panel, name);
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  // 找到面板对应的按钮条（SPA 重绘后可能插进了别的兄弟节点）
  function findBar(panel) {
    const next = panel.nextElementSibling;
    if (next && next.classList.contains(BAR_CLASS)) return next;
    const parent = panel.parentElement;
    if (!parent) return null;
    const cand = parent.querySelector(':scope > .' + BAR_CLASS);
    return cand || null;
  }

  // 让按钮条紧贴版本下拉下方、左沿对齐。
  // 关键：量之前先把 margin-top 归零，用「自然间距」算一次补偿；算完打标记，之后不再重算。
  // 旧版用「已生效 margin 后的位置」反推，补偿会被当成自然间距，每扫一次就把间距推回去，于是来回抖。
  function alignBar(panel, bar, force) {
    if (!bar || !bar.isConnected) return;
    const sel = panel.querySelector('.version-select');
    if (!sel) return;
    if (!force && bar.getAttribute(ALIGNED_ATTR) === '1') return;

    bar.style.marginTop = '0px';
    const s = sel.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    if (!s.height || !b.height) return;   // 未渲染（例如面板折叠）时跳过

    bar.style.marginTop = Math.round(BAR_GAP_PX - (b.top - s.bottom)) + 'px';
    bar.style.paddingLeft = Math.max(0, Math.round(s.left - b.left)) + 'px';
    bar.style.paddingBottom = BAR_BOTTOM_PX + 'px';
    bar.setAttribute(ALIGNED_ATTR, '1');
  }

  function decorate(panel) {
    let bar = findBar(panel);

    if (!bar) {
      panel.setAttribute(PROCESSED_ATTR, '1');
      bar = buildBar(panel);
      panel.insertAdjacentElement('afterend', bar);
      alignBar(panel, bar, true);
      console.log(LOG, '已注入快捷按钮：', TARGETS.join(' / '));
      return;
    }

    // 已注入：只刷新激活态，间距已对齐就不再动
    const cur = currentVersionName(panel);
    bar.querySelectorAll('.' + BTN_CLASS).forEach((btn) => {
      btn.classList.toggle(BTN_ACTIVE_CLASS, btn.textContent === cur);
    });
    alignBar(panel, bar, false);
  }

  function scan() {
    document.querySelectorAll(PANEL_SELECTOR).forEach((panel) => {
      // 只处理应用详情面板里的版本选择器（其父容器是 .application）
      if (!panel.closest('.application')) return;
      decorate(panel);
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
    document.querySelectorAll('.' + BAR_CLASS).forEach((bar) => {
      bar.removeAttribute(ALIGNED_ATTR);
    });
    scheduleScan();
  }

  function init() {
    injectStyle();
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', realignAll);
    console.log(LOG, '已启动：版本选择下方快捷按钮 →', TARGETS.join(' / '));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
