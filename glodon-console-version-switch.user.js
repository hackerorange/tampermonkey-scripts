// ==UserScript==
// @name         广联达开发者控制台-版本快速切换
// @namespace    zhongct.glodon.console.version.quick
// @version      1.0.0
// @description  在应用详情页左上角「版本选择」下方加 release / release-pre 快捷按钮，点击后自动在版本下拉里找到对应版本并切换，免去每次展开下拉逐个找。版本列表可在脚本顶部 TARGETS 常量里增删。
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
  const LOG = '[版本快速切换]';

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
        padding: 4px 12px 8px;
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
    if (dropdown && dropdown.hasAttribute('disabled')) {
      toast('版本切换当前不可用（可能处于开发模式）');
      console.warn(LOG, '下拉为 disabled，放弃切换', name);
      return;
    }

    let item = findVersionItem(panel, name);
    if (!item) {
      // 兜底：个别场景菜单懒渲染，模拟 hover 展开一次再找
      const trigger = panel.querySelector('.version-select');
      if (trigger) {
        ['mouseover', 'mouseenter'].forEach((t) =>
          trigger.dispatchEvent(new MouseEvent(t, { bubbles: true }))
        );
        await sleep(300);
        item = findVersionItem(panel, name);
      }
    }
    if (!item) {
      toast('未找到版本「' + name + '」');
      console.warn(LOG, '下拉里没有名为「' + name + '」的条目');
      return;
    }

    console.log(LOG, '切换到版本「' + name + '」');
    // Element UI 在 li 上绑了 click/command 处理，直接派发即可
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    toast('已切换到 ' + name);
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

  function decorate(panel) {
    if (panel.hasAttribute(PROCESSED_ATTR)) {
      // 已注入：仅刷新激活态
      const bar = panel.nextElementSibling;
      if (bar && bar.classList.contains(BAR_CLASS)) {
        const cur = currentVersionName(panel);
        bar.querySelectorAll('.' + BTN_CLASS).forEach((btn) => {
          btn.classList.toggle(BTN_ACTIVE_CLASS, btn.textContent === cur);
        });
      }
      return;
    }
    panel.setAttribute(PROCESSED_ATTR, '1');
    const bar = buildBar(panel);
    panel.insertAdjacentElement('afterend', bar);
    console.log(LOG, '已注入快捷按钮：', TARGETS.join(' / '));
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

  function init() {
    injectStyle();
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleScan);
    console.log(LOG, '已启动：版本选择下方快捷按钮 →', TARGETS.join(' / '));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
