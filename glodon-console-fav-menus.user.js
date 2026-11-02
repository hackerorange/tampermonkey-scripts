// ==UserScript==
// @name         广联达开发者控制台-常用菜单标记
// @namespace    zhongct.glodon.console.favorites
// @version      1.3.1
// @description  在左侧菜单(.left-menu)最末级菜单项最右侧添加星星，点击标记常用菜单；未收藏时悬停才显示空心星；收藏后菜单文字变黄；星标右侧留白 20px，与菜单顶部折叠按钮对齐；收藏记录持久化在本机（Tampermonkey 用户目录存储）。
// @author       zhongct
// @match        https://console.developer.glodon.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @homepageURL  https://github.com/hackerorange/tampermonkey-scripts
// @supportURL   https://github.com/hackerorange/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-fav-menus.user.js
// @downloadURL  https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/glodon-console-fav-menus.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'gld_console_fav_menus';
  const PROCESSED_ATTR = 'data-gld-fav-star';
  const STAR_CLASS = 'gld-fav-star';
  const ACTIVE_CLASS = 'gld-fav-active';
  const MARKED_CLASS = 'gld-fav-marked';
  const GOLD = '#f7ba2a';
  const GRAY = '#c0c4cc';
  const STAR_RIGHT_PX = 20;   // 星标右侧留白，与左菜单顶部的折叠按钮对齐

  // ---------- 存储 ----------
  let favCache = null;

  function readFavs() {
    try {
      const v = GM_getValue(STORAGE_KEY, []);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      console.error('[常用菜单标记] 读取失败', e);
      return [];
    }
  }

  function getFavs() {
    if (favCache === null) favCache = readFavs();
    return favCache;
  }

  function saveFavs(favs) {
    favCache = favs;
    try {
      GM_setValue(STORAGE_KEY, favs);
    } catch (e) {
      console.error('[常用菜单标记] 保存失败', e);
    }
  }

  function isFav(path, favSet) {
    return favSet ? favSet.has(path) : getFavs().includes(path);
  }

  function setFav(path, fav) {
    const favs = getFavs().slice();
    const idx = favs.indexOf(path);
    if (fav && idx === -1) {
      favs.push(path);
      saveFavs(favs);
    } else if (!fav && idx !== -1) {
      favs.splice(idx, 1);
      saveFavs(favs);
    }
  }

  // ---------- 样式 ----------
  function injectStyle() {
    if (document.getElementById('gld-fav-star-style')) return;
    const css = `
      .left-menu li.el-menu-item {
        display: flex;
        align-items: center;
      }
      .${STAR_CLASS} {
        margin-left: auto;
        margin-right: 20px;
        width: 18px;
        height: 18px;
        cursor: pointer;
        user-select: none;
        opacity: 0;
        transition: opacity .15s ease;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .${STAR_CLASS} svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      .left-menu li.el-menu-item:hover .${STAR_CLASS},
      .${STAR_CLASS}.${ACTIVE_CLASS} {
        opacity: 1;
      }
      .left-menu li.el-menu-item.${MARKED_CLASS} > span {
        color: ${GOLD};
        font-weight: 600;
      }
    `;
    const style = document.createElement('style');
    style.id = 'gld-fav-star-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- 菜单路径 ----------
  function normalizeText(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function getMenuPath(li) {
    const parts = [];
    let el = li;
    while (el && el.tagName === 'LI') {
      if (el.classList.contains('el-menu-item')) {
        const span = el.querySelector(':scope > span');
        const t = normalizeText(span) || normalizeText(el);
        if (t) parts.unshift(t);
      } else if (el.classList.contains('el-submenu')) {
        const title = el.querySelector(':scope > .el-submenu__title > span');
        const t = normalizeText(title);
        if (t) parts.unshift(t);
      }
      el = el.parentElement ? el.parentElement.closest('li') : null;
    }
    return parts.join(' > ');
  }

  // ---------- 星星（SVG 对称五角星） ----------
  const STAR_PATH_D = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';

  function buildStarSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', STAR_PATH_D);
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return { svg, path };
  }

  // 星标右侧距菜单项外边缘固定 STAR_RIGHT_PX；菜单项自身有 padding-right，这里减掉它，
  // 避免「padding + margin」叠加导致星标越推越左（或贴着右沿）
  function applyStarOffset(star, li) {
    const pad = parseFloat(getComputedStyle(li).paddingRight) || 0;
    star.style.marginRight = (STAR_RIGHT_PX - pad) + 'px';
  }

  function createStar(li, favSet) {
    const star = document.createElement('span');
    star.className = STAR_CLASS;
    star.title = '标记为常用';

    const { svg, path } = buildStarSvg();
    star.appendChild(svg);

    const menuPath = getMenuPath(li);

    function render(isActive) {
      if (isActive) {
        path.setAttribute('fill', GOLD);
        path.setAttribute('stroke', GOLD);
        star.title = '取消常用标记';
      } else {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', GRAY);
        star.title = '标记为常用';
      }
      li.classList.toggle(MARKED_CLASS, isActive);
    }

    function syncFromStorage(set) {
      const active = isFav(menuPath, set);
      star.classList.toggle(ACTIVE_CLASS, active);
      render(active);
    }
    star._gldSync = syncFromStorage;
    star._gldAlign = () => applyStarOffset(star, li);

    syncFromStorage(favSet);
    applyStarOffset(star, li);

    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    star.addEventListener('pointerdown', stop);
    star.addEventListener('mousedown', stop);
    star.addEventListener('mouseup', stop);
    star.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowActive = !star.classList.contains(ACTIVE_CLASS);
      star.classList.toggle(ACTIVE_CLASS, nowActive);
      setFav(menuPath, nowActive);
      render(nowActive);
    });

    return star;
  }

  function decorate(li, favSet) {
    li.setAttribute(PROCESSED_ATTR, '1');
    li.appendChild(createStar(li, favSet));
  }

  function scan() {
    const menu = document.querySelector('div.left-menu');
    if (!menu) return;
    favCache = null;
    const favSet = new Set(getFavs());
    menu.querySelectorAll('li.el-menu-item').forEach((li) => {
      const star = li.querySelector(':scope > .' + STAR_CLASS);
      if (li.hasAttribute(PROCESSED_ATTR) && star) {
        if (typeof star._gldSync === 'function') star._gldSync(favSet);
        if (typeof star._gldAlign === 'function') star._gldAlign();
      } else {
        if (star) star.remove();
        li.removeAttribute(PROCESSED_ATTR);
        decorate(li, favSet);
      }
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

  function observe() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    injectStyle();
    scan();
    observe();
    console.log('[常用菜单标记] 已启动：左侧菜单末级可点击星星标记常用');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();