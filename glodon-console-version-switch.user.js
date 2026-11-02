// ==UserScript==
// @name         广联达开发者控制台-版本快速切换
// @namespace    zhongct.glodon.console.version.quick
// @version      1.2.0
// @description  把应用详情页右侧「总览」改成快捷链接页：版本（release / release-pre）与常用功能（构建管理、版本发布）做成带图标的大方块；点版本自动切换并自动确认弹窗、直接跳转。
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
  // 版本方块：与左侧版本下拉里条目的名称匹配（精确，或 "release(0.2)" 这种带括号后缀）
  const TARGETS = ['release', 'release-pre'];
  // 常用功能方块：label 与左侧菜单文字精确匹配；url 是点不到菜单时的兜底跳转地址
  const SHORTCUTS = [
    { label: '构建管理', icon: 'tool', url: '/portal/740894248948736/' },
    { label: '版本发布', icon: 'rocket', url: '/portal/645701652762624/' },
  ];

  // 左侧版本选择器容器（div.version.version-change）
  const PANEL_SELECTOR = '.application .version';
  // 「总览」微应用（qiankun 渲染在主文档里，不是 iframe）
  const OVERVIEW_SELECTOR =
    '#subapp-viewport > div[id^="__qiankun_microapp_wrapper_for_open_open_component_overview"]';
  const QUICK_ID = 'gld-quick-links';
  const TILE_CLASS = 'gld-tile';
  const TOAST_ID = 'gld-vq-toast';
  const LOG = '[版本快速切换]';

  // 点击后自动确认确认框的时间窗
  const CONFIRM_WINDOW_MS = 10000;

  // ---------- 图标（24x24 线性图标） ----------
  const ICONS = {
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    branch: '<line x1="6" y1="4" x2="6" y2="15"/><circle cx="18" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M18 8.6a9 9 0 0 1-9 9"/>',
    tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>',
    rocket:
      '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z"/>' +
      '<path d="m12 15-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2Z"/>' +
      '<path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0"/><path d="M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  };

  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"' +
      ' stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

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
      #${QUICK_ID} { padding: 28px 0 8px; font-size: 14px; color: #262626; }
      #${QUICK_ID} .gld-qp-hd {
        font-size: 16px; font-weight: 600; color: #262626;
        margin: 0 0 22px; padding-left: 2px;
      }
      #${QUICK_ID} .gld-qp-sec { margin-bottom: 28px; }
      #${QUICK_ID} .gld-qp-title {
        font-size: 14px; font-weight: 600; color: #262626;
        margin: 0 0 14px; padding-left: 2px;
      }
      #${QUICK_ID} .gld-qp-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(156px, 156px));
        gap: 16px;
      }
      #${QUICK_ID} .${TILE_CLASS} {
        position: relative;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 12px; height: 136px;
        background: #fff; border: 1px solid #e8e8e8; border-radius: 8px;
        cursor: pointer; user-select: none;
        transition: border-color .18s, box-shadow .18s, transform .18s;
      }
      #${QUICK_ID} .${TILE_CLASS}:hover {
        border-color: #beddff;
        box-shadow: 0 4px 14px rgba(38, 141, 255, .14);
        transform: translateY(-1px);
      }
      #${QUICK_ID} .${TILE_CLASS}.is-current {
        border-color: #268dff;
        background: #f4f9ff;
        cursor: default;
      }
      #${QUICK_ID} .gld-tile-ico {
        width: 44px; height: 44px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        background: #e9f4ff; color: #268dff;
      }
      #${QUICK_ID} .gld-tile-ico svg { width: 22px; height: 22px; }
      #${QUICK_ID} .gld-tile-txt { font-size: 14px; color: #262626; }
      #${QUICK_ID} .gld-tile-badge {
        position: absolute; top: 8px; right: 8px;
        font-size: 11px; line-height: 16px; padding: 0 6px;
        color: #fff; background: #268dff; border-radius: 9px;
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
    const wraps = document.querySelectorAll('.el-message-box__wrapper, .el-message-box');
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

  // ---------- 版本切换（走左侧下拉，由页面自身 Vue 处理） ----------
  function currentVersionName(panel) {
    const el = panel.querySelector('.version-select .version-num');
    return normalize(el && el.textContent);
  }

  // 版本名匹配：精确，或 "release(0.2)" / "release（0.2）" 这种带构建号的形式
  function matchVersion(text, name) {
    const t = normalize(text);
    if (!t) return false;
    if (t === name) return true;
    return t.indexOf(name + '(') === 0 || t.indexOf(name + '（') === 0;
  }

  function findVersionItem(root, name) {
    const scope = root || document;
    const items = scope.querySelectorAll('li.el-dropdown-menu__item');
    for (const li of items) {
      const span = li.querySelector('.item-middle .name span')
        || li.querySelector('.name span') || li.querySelector('span[title]');
      const text = span ? (span.getAttribute('title') || span.textContent) : li.textContent;
      if (matchVersion(text, name)) return li;
    }
    return null;
  }

  // 版本列表有可能是「打开下拉后才渲染」或异步拉取，按轮次重试；
  // v1.1.0 只 hover 一次、等 200ms，列表没出来就误报「版本不存在」。
  async function waitVersionItem(panel, name) {
    const trigger = panel.querySelector('.version-select') || panel.querySelector('.el-dropdown');
    const hover = () => {
      if (!trigger) return;
      ['mouseenter', 'mouseover', 'mousemove'].forEach((t) =>
        trigger.dispatchEvent(new MouseEvent(t, { bubbles: true }))
      );
      const root = panel.querySelector('.el-dropdown');
      if (root) root.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    };
    for (let i = 0; i < 8; i++) {
      let item = findVersionItem(panel, name);
      if (item) return item;
      hover();
      // 第 3、6 轮再补一次点击，防止 hover 触发没被页面接住
      if ((i === 2 || i === 5) && trigger) {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      await sleep(250);
    }
    return findVersionItem(document, name);   // 全文档兜底
  }

  async function switchTo(panel, name) {
    const before = currentVersionName(panel);
    // 已经是该版本就什么都不做：切换后当前版本会从下拉列表里消失，
    // 再点会误报「未找到版本」——v1.1.0 的「有时提示不存在」就是这个。
    if (before === name) {
      console.log(LOG, '当前已是', name, '，忽略');
      refreshQuick(document.getElementById(QUICK_ID), panel);
      return;
    }

    const dropdown = panel.querySelector('.el-dropdown');
    // 页面 .el-dropdown 上常驻 disabled="disabled" 属性，实测不代表真的禁用，不据此拦下
    const markedDisabled = !!(dropdown && dropdown.hasAttribute('disabled'));

    const item = await waitVersionItem(panel, name);
    if (!item) {
      toast('未找到版本「' + name + '」');
      console.warn(LOG, '下拉里没有名为「' + name + '」的条目，当前为', before);
      return;
    }

    console.log(LOG, '切换到版本「' + name + '」（当前 ' + before + '）');
    armAutoConfirm(name);   // 弹窗可能立刻就出来，先布好监听
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(800);

    // 成功就静默（页面通常已经跳转/刷新），只有没反应时才提示
    const after = currentVersionName(panel);
    const selected = item.classList.contains('select-item') || !!item.querySelector('.cur-select');
    if (after === name || selected || !document.contains(panel)) {
      console.log(LOG, '切换成功 →', after);
      refreshQuick(document.getElementById(QUICK_ID), panel);
      return;
    }
    toast(markedDisabled
      ? '页面未响应切换，可能当前禁用了版本切换（开发模式）'
      : '未检测到版本变化，请展开下拉确认');
    console.warn(LOG, '点击已派发但版本未变化，当前仍为', after);
  }

  // ---------- 常用功能：点左侧菜单跳转 ----------
  function findMenuItem(label) {
    const nodes = document.querySelectorAll(
      'li[role="menuitem"], li.el-menu-item, .el-submenu li, .el-menu-item, .menu-item, a'
    );
    for (const el of nodes) {
      if (normalize(el.textContent) === label) return el;
    }
    return null;
  }

  function fallbackNavigate(url) {
    if (!url) return;
    try {
      const u = new URL(location.href);
      u.pathname = url;
      u.hash = '';
      location.href = u.toString();
    } catch (e) {
      location.href = url;
    }
  }

  function openMenu(label, url) {
    const el = findMenuItem(label);
    if (!el) {
      // 侧栏没渲染出这条菜单（折叠/未展开）时才用兜底地址，避免误伤正常点击
      console.warn(LOG, '没找到菜单「' + label + '」，改用兜底地址');
      fallbackNavigate(url);
      return;
    }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    console.log(LOG, '打开菜单：' + label);
  }

  // ---------- 快捷链接面板 ----------
  function makeTile(opts) {
    const tile = document.createElement('div');
    tile.className = TILE_CLASS;
    tile.dataset.kind = opts.kind;
    tile.dataset.key = opts.key;

    const ico = document.createElement('div');
    ico.className = 'gld-tile-ico';
    ico.innerHTML = svgIcon(opts.icon);

    const txt = document.createElement('div');
    txt.className = 'gld-tile-txt';
    txt.textContent = opts.label;

    tile.append(ico, txt);

    if (opts.kind === 'version') {
      const badge = document.createElement('span');
      badge.className = 'gld-tile-badge';
      badge.textContent = '当前';
      badge.style.display = 'none';
      tile.appendChild(badge);
    }
    tile.addEventListener('click', () => opts.onClick());
    return tile;
  }

  function buildSection(title, tiles) {
    const sec = document.createElement('div');
    sec.className = 'gld-qp-sec';
    const h = document.createElement('div');
    h.className = 'gld-qp-title';
    h.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'gld-qp-grid';
    grid.append(...tiles);
    sec.append(h, grid);
    return sec;
  }

  function buildQuick(panel) {
    const box = document.createElement('div');
    box.id = QUICK_ID;

    const versionTiles = TARGETS.map((name) => makeTile({
      kind: 'version',
      key: name,
      label: name,
      icon: name === 'release-pre' ? 'branch' : 'tag',
      onClick: () => switchTo(panel, name),
    }));

    const menuTiles = SHORTCUTS.map((s) => makeTile({
      kind: 'menu',
      key: s.label,
      label: s.label,
      icon: s.icon,
      onClick: () => openMenu(s.label, s.url),
    }));

    const hd = document.createElement('div');
    hd.className = 'gld-qp-hd';
    hd.textContent = '快捷链接';

    box.append(
      hd,
      buildSection('版本', versionTiles),
      buildSection('常用功能', menuTiles)
    );
    return box;
  }

  function refreshQuick(box, panel) {
    if (!box || !panel) return;
    const cur = currentVersionName(panel);
    box.querySelectorAll('.' + TILE_CLASS + '[data-kind="version"]').forEach((tile) => {
      const isCur = tile.dataset.key === cur;
      tile.classList.toggle('is-current', isCur);
      const badge = tile.querySelector('.gld-tile-badge');
      if (badge) badge.style.display = isCur ? 'block' : 'none';
    });
  }

  // 总览页原本的内容整块隐藏，只留快捷链接
  function hideOriginal(wrap, box) {
    for (const el of wrap.children) {
      if (el === box) continue;
      if (el.tagName.toLowerCase() === 'qiankun-head') continue;   // 微应用样式，不能藏
      if (el.style.display !== 'none') el.style.display = 'none';
    }
  }

  function decorateOverview(wrap, panel) {
    let box = wrap.querySelector(':scope > #' + QUICK_ID);
    if (!box) {
      box = buildQuick(panel);
      wrap.appendChild(box);
      console.log(LOG, '已把总览页改成快捷链接：版本 ' + TARGETS.join(' / ')
        + '；常用功能 ' + SHORTCUTS.map((s) => s.label).join(' / '));
    }
    hideOriginal(wrap, box);
    refreshQuick(box, panel);
  }

  function scan() {
    const panel = document.querySelector(PANEL_SELECTOR);
    if (!panel || !panel.closest('.application')) return;   // 找不到侧栏版本选择器就不动
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

  function init() {
    injectStyle();
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleScan);
    console.log(LOG, '已启动：总览页快捷链接 →', TARGETS.join(' / '),
      '+', SHORTCUTS.map((s) => s.label).join(' / '));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
