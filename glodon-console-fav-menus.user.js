// ==UserScript==
// @name         广联达开发者控制台-常用菜单标记
// @namespace    zhongct.glodon.console.favorites
// @version      1.4.1
// @description  在左侧菜单(.left-menu)最末级菜单项最右侧添加星星，点击标记常用菜单；未收藏时悬停才显示空心星；收藏后菜单文字与星标为橙红色；星标按上级折叠箭头的实际中心自动对齐；收藏按「菜单名」记录（与层级、顺序无关），旧版层级路径记录会自动迁移；记录持久化在本机（Tampermonkey 用户目录存储）。
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
  const ABS_CLASS = 'gld-fav-star-abs';
  const ACTIVE_COLOR = '#ff5722';   // 橙红，鲜艳醒目
  const GRAY = '#c0c4cc';
  const STAR_RIGHT_PX = 20;   // 兜底：找不到折叠箭头时，星标右侧留白

  // ---------- 存储 ----------
  let favCache = null;

  // 旧版本存的是「一级 > 二级 > 末级」层级路径，层级/顺序一变就失联。
  // 现在只按菜单名记录，读到旧格式时自动迁移成末级名称并去重。
  function migrateLegacy(list) {
    let changed = false;
    const out = [];
    const seen = new Set();
    list.forEach((v) => {
      if (typeof v !== 'string' || !v.trim()) { changed = true; return; }
      const name = v.split(/\s*>\s*/).filter(Boolean).pop().trim();
      if (!name) { changed = true; return; }
      if (name !== v) changed = true;
      if (seen.has(name)) { changed = true; return; }
      seen.add(name);
      out.push(name);
    });
    return { list: out, changed };
  }

  function readFavs() {
    try {
      const v = GM_getValue(STORAGE_KEY, []);
      const raw = Array.isArray(v) ? v : [];
      const { list, changed } = migrateLegacy(raw);
      if (changed) {
        favCache = list;
        try {
          GM_setValue(STORAGE_KEY, list);
        } catch (e) {
          console.warn('[常用菜单标记] 迁移旧记录写回失败', e);
        }
        console.log('[常用菜单标记] 已按菜单名迁移旧记录：', list);
      }
      return list;
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
        position: relative;
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
      /* 与上级折叠箭头对齐时改为绝对定位，位置由 JS 按箭头的实际中心算 */
      .${STAR_CLASS}.${ABS_CLASS} {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        margin-left: 0;
        margin-right: 0;
      }
      .left-menu li.el-menu-item:hover .${STAR_CLASS},
      .${STAR_CLASS}.${ACTIVE_CLASS} {
        opacity: 1;
      }
      .left-menu li.el-menu-item.${MARKED_CLASS} > span {
        color: ${ACTIVE_COLOR};
        font-weight: 600;
      }
    `;
    const style = document.createElement('style');
    style.id = 'gld-fav-star-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- 菜单标识：按名字，不按层级/位置 ----------
  const NAME_SEP = ' > ';

  function normalizeText(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  // 末级菜单的名字：取直接子 span 的文本（排除我们自己插的星标 span）
  function getLeafName(li) {
    const spans = li.querySelectorAll(':scope > span');
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].classList.contains(STAR_CLASS)) continue;
      const t = normalizeText(spans[i]);
      if (t) return t;
    }
    // 兜底：兼容 <a> 包裹、文本散落等结构 —— 拷贝一份去掉星标后取全文
    const clone = li.cloneNode(true);
    const stars = clone.querySelectorAll('.' + STAR_CLASS);
    for (let i = 0; i < stars.length; i++) stars[i].remove();
    return normalizeText(clone);
  }

  // 仅当菜单名为空（纯图标项）时，才用上级标题补一个可读的名字
  function getParentPath(li) {
    const parts = [];
    let el = li.parentElement ? li.parentElement.closest('li') : null;
    while (el && el.tagName === 'LI') {
      if (el.classList.contains('el-submenu')) {
        const title = el.querySelector(':scope > .el-submenu__title');
        const label = title ? title.querySelector(':scope > span') : null;
        const t = normalizeText(label) || normalizeText(title);
        if (t) parts.unshift(t);
      }
      el = el.parentElement ? el.parentElement.closest('li') : null;
    }
    return parts.join(NAME_SEP);
  }

  // 收藏主键 = 菜单名（与它在菜单树里的位置、顺序无关）
  function getMenuKey(li) {
    const name = getLeafName(li);
    if (name) return name;
    const parent = getParentPath(li);
    return parent ? parent + NAME_SEP + '(未命名)' : '(未命名菜单)';
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

  // ---------- 星标水平位置 ----------
  // 对齐目标：上级菜单标题右侧的折叠/展开箭头（Element UI:.el-submenu__title > i）
  // 不写死像素值，而是量出箭头中心，把星标中心对上去；换主题/换内边距都不会偏。
  function isRendered(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 6 && r.height >= 6;
  }

  function findRefArrow(li) {
    let sub = li.parentElement ? li.parentElement.closest('li.el-submenu') : null;
    while (sub) {
      const title = sub.querySelector(':scope > .el-submenu__title') || sub;
      // 优先用 Element UI 的箭头类名
      const arrow = title.querySelector('.el-submenu__icon-arrow');
      if (arrow && isRendered(arrow)) return arrow;
      // 兜底：标题里可能还有左侧图标，取最靠右的那个（折叠箭头永远在最右）
      const cands = Array.prototype.filter.call(
        title.querySelectorAll('i, svg'),
        isRendered
      );
      if (cands.length) {
        cands.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return cands[0];
      }
      sub = sub.parentElement ? sub.parentElement.closest('li.el-submenu') : null;
    }
    return null;
  }

  function applyStarOffset(star, li) {
    const liRect = li.getBoundingClientRect();
    if (!liRect.width) return;
    const starW = star.getBoundingClientRect().width || 18;
    const arrow = findRefArrow(li);
    if (arrow) {
      const a = arrow.getBoundingClientRect();
      const center = a.left + a.width / 2;
      star.classList.add(ABS_CLASS);
      star.style.marginRight = '0px';
      // right 相对 li 的 padding 边缘；li 无边框时与 rect 右沿一致
      star.style.right = Math.max(0, Math.round(liRect.right - center - starW / 2)) + 'px';
    } else {
      // 兜底：没有折叠箭头的场景（顶层项）按固定留白，减掉菜单项自身 padding
      star.classList.remove(ABS_CLASS);
      star.style.right = '';
      const pad = parseFloat(getComputedStyle(li).paddingRight) || 0;
      star.style.marginRight = (STAR_RIGHT_PX - pad) + 'px';
    }
  }

  function createStar(li, favSet) {
    const star = document.createElement('span');
    star.className = STAR_CLASS;
    star.title = '标记为常用';

    const { svg, path } = buildStarSvg();
    star.appendChild(svg);

    function render(isActive) {
      if (isActive) {
        path.setAttribute('fill', ACTIVE_COLOR);
        path.setAttribute('stroke', ACTIVE_COLOR);
        star.title = '取消常用标记：' + (star._gldKey || '');
      } else {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', GRAY);
        star.title = '标记为常用：' + (star._gldKey || '');
      }
      li.classList.toggle(MARKED_CLASS, isActive);
    }

    function syncFromStorage(set) {
      // 每次都按当前菜单名重算主键：菜单改名/换位置后依然认得出来
      star._gldKey = getMenuKey(li);
      const active = isFav(star._gldKey, set);
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
      setFav(getMenuKey(li), nowActive);
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
    // 侧边栏折叠/窗口缩放会改变宽度，重新对齐一次
    window.addEventListener('resize', scheduleScan);
    window.__gldStarDebug = debugStars;
    console.log('[常用菜单标记] 已启动：左侧菜单末级可点击星星标记常用');
  }

  // 控制台执行 __gldStarDebug() 可打印每个星标与对齐参照物的实际坐标，便于微调
  function debugStars() {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) };
    };
    const rows = [];
    document.querySelectorAll('div.left-menu li.el-menu-item').forEach((li) => {
      const star = li.querySelector(':scope > .' + STAR_CLASS);
      const arrow = findRefArrow(li);
      rows.push({
        菜单名: getLeafName(li),
        收藏键: getMenuKey(li),
        已收藏: star ? star.classList.contains(ACTIVE_CLASS) : null,
        星标中心: star ? Math.round(star.getBoundingClientRect().left + star.getBoundingClientRect().width / 2) : null,
        箭头中心: arrow ? Math.round(arrow.getBoundingClientRect().left + arrow.getBoundingClientRect().width / 2) : null,
        差值: star && arrow
          ? Math.round((star.getBoundingClientRect().left + star.getBoundingClientRect().width / 2) -
              (arrow.getBoundingClientRect().left + arrow.getBoundingClientRect().width / 2))
          : null,
        绝对定位: star ? star.classList.contains(ABS_CLASS) : null,
        星标right: star ? star.style.right : null,
        星标marginRight: star ? getComputedStyle(star).marginRight : null,
        li右沿: Math.round(li.getBoundingClientRect().right),
        星标: r(star),
        箭头: r(arrow),
      });
    });
    console.table(rows);
    return rows;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();