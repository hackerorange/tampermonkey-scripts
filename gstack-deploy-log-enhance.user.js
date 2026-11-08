// ==UserScript==
// @name         GStack 部署日志增强
// @namespace    zhongct.gstack.deploy.log.maximize
// @version      1.7.0
// @description  gstack.glodon.com 部署详情页：日志工具条「刷新」左侧加「最大化」「到底」「清理」——最大化把日志（含 Pod 工具条）铺满视口、盖住部署详情，并去掉 CodeMirror-wrap 取消自动换行（长行横向滚动），Esc 或再点一次还原（恢复站点默认自动换行）；「到底」滚动到日志末尾；清理一键清空当前日志内容。
// @author       zhongct
// @match        https://gstack.glodon.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/hackerorange/tampermonkey-scripts
// @supportURL   https://github.com/hackerorange/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/gstack-deploy-log-enhance.user.js
// @downloadURL  https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/gstack-deploy-log-enhance.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[GStack日志增强]';
  const MAX_CLASS = 'gstack-log-maxed';
  // 最大化期间加在 body 上：用于把站点浮层（下拉/弹窗，挂在 body 末尾、
  // z-index 约 1001）抬到最大化块（z-index 99999）之上，否则下拉打不开
  const MAX_BODY_CLASS = 'gstack-log-maxed-body';
  const BTN_ID = 'gstack-log-max-btn';
  const CLEAR_BTN_ID = 'gstack-log-clear-btn';
  const SCROLL_BTN_ID = 'gstack-log-end-btn';
  // v1.2.0 的「自动刷新」控件 id：升级后页面上可能残留，扫描时清掉
  const STALE_IDS = ['gstack-log-auto-wrap', 'gstack-log-auto-btn', 'gstack-log-auto-interval'];

  // ---------- 样式 ----------
  function injectStyle() {
    if (document.getElementById('gstack-log-max-style')) return;
    const style = document.createElement('style');
    style.id = 'gstack-log-max-style';
    style.textContent = `
      /* 最大化：整个日志块（工具条 + CodeMirror）fixed 铺满视口，盖住部署详情 */
      .workload-details-log.${MAX_CLASS} {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 99999; background: #fff; padding: 12px 16px;
        box-sizing: border-box; display: flex; flex-direction: column;
        overflow: hidden;
      }
      /* 撑开 loading 内部的高度链，CodeMirror 占满工具条以外的剩余空间 */
      .${MAX_CLASS} > .next-loading { flex: 1 1 0; min-height: 0; height: auto !important; }
      .${MAX_CLASS} .next-loading-wrap { height: 100% !important; display: flex !important; flex-direction: column !important; }
      .${MAX_CLASS} .header { flex: 0 0 auto; }
      .${MAX_CLASS} .react-codemirror2 { flex: 1 1 0; min-height: 0; }
      .${MAX_CLASS} .CodeMirror { height: 100% !important; }
      /* 最大化时站点浮层容器（Select 下拉/弹窗等，渲染在 body 末尾、
         z-index 约 1001）会被本块（z-index 99999）盖住 → 抬到块之上 */
      body.${MAX_BODY_CLASS} .next-overlay-wrapper,
      body.${MAX_BODY_CLASS} .next-portal,
      body.${MAX_BODY_CLASS} .next-overlay-inner,
      body.${MAX_BODY_CLASS} .next-overlay-backdrop { z-index: 100000 !important; }
    `;
    document.head.appendChild(style);
  }

  // ---------- 工具 ----------
  function normalize(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 只在内容变化时写入：同值重设 textContent 也会触发 childList 突变，
  // 会被下面的 MutationObserver 捕获形成 无限扫描循环（页面假死）
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function visibleLogBlock() {
    for (const block of document.querySelectorAll('.workload-details-log')) {
      if (block.isConnected && isVisible(block)) return block;
    }
    return null;
  }

  function findRefreshBtn(block) {
    for (const b of block.querySelectorAll('button')) {
      if (normalize(b.textContent) === '刷新' && isVisible(b)) return b;
    }
    return null;
  }

  // ---------- CodeMirror ----------
  function cmOf(block) {
    const wrapper = block.querySelector('.CodeMirror');
    return wrapper && wrapper.CodeMirror ? wrapper.CodeMirror : null;
  }

  function refreshCM(block) {
    const cm = cmOf(block);
    if (cm) { try { cm.refresh(); } catch (e) { /* ignore */ } }
  }

  // ---------- 换行：只在最大化期间取消 ----------
  // CodeMirror 5 的换行完全由 wrapper 上的 .CodeMirror-wrap 这个类控制：
  // 基样式 pre.CodeMirror-line{white-space:pre;word-wrap:normal} 不折行，
  // .CodeMirror-wrap 里才改成 pre-wrap。所以摘掉类 = 长行横向滚动。
  // 摘/加类都改变了行宽与滚动区尺寸，必须 refresh 让 CM 重新测量，
  // 否则滚动条/选区坐标会错位；refresh 较贵，用定时器合并成一次
  const CM_WRAP_CLASS = 'CodeMirror-wrap';
  // 记录「被本脚本摘掉类的节点」，还原时只给这些补回（站点若本就没开
  // 换行，不会被我强行加回来）；WeakSet 不拦 GC，节点被 React 换新即失效
  const strippedWrap = new WeakSet();
  let refreshTimer = null;

  function scheduleRefresh(block) {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshCM(block);
    }, 60);
  }

  function stripWrap(block) {
    let hit = false;
    block.querySelectorAll('.' + CM_WRAP_CLASS).forEach((n) => {
      n.classList.remove(CM_WRAP_CLASS);
      strippedWrap.add(n);
      hit = true;
    });
    if (hit) scheduleRefresh(block);
    return hit;
  }

  function restoreWrap(block) {
    let hit = false;
    block.querySelectorAll('.CodeMirror').forEach((n) => {
      if (strippedWrap.has(n)) {
        n.classList.add(CM_WRAP_CLASS);
        hit = true;
      }
    });
    if (hit) scheduleRefresh(block);
  }

  // ---------- 清理日志 ----------
  // 走 CodeMirror API：setValue 会派发 change 事件，react-codemirror2 会把
  // 空串同步回 React state，之后重渲染也不会把旧日志带回来
  function clearLog(block) {
    const cm = cmOf(block);
    if (cm) {
      try { cm.setValue(''); } catch (e) { /* 落到 DOM 兜底 */ }
    } else {
      // 兜底：直接清掉渲染出来的行（React 下次渲染可能恢复，但拿不到实例时只能这样）
      block.querySelectorAll('.CodeMirror-code').forEach((n) => { n.textContent = ''; });
    }
    refreshCM(block);
    console.log(LOG, '已清空当前日志');
  }

  // ---------- 滚动到日志末尾 ----------
  // 优先走 CM API：scrollTo 的 y 会被 calculateScrollPos 钳制到最大滚动位，
  // 传一个足够大的值即可到底；拿不到实例时滚 .CodeMirror-scroll 兜底
  function scrollToEnd(block) {
    const cm = cmOf(block);
    if (cm) {
      try {
        cm.scrollTo(null, cm.getScrollInfo().height);
        return;
      } catch (e) { /* 落到 DOM 兜底 */ }
    }
    const scroller = block.querySelector('.CodeMirror-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------- 最大化 / 还原 ----------
  let maxed = false;

  function applyMax(block) {
    block.classList.add(MAX_CLASS);
    document.body.classList.add(MAX_BODY_CLASS);
    maxed = true;
    // 最大化同时取消自动换行（长行横向滚动）
    stripWrap(block);
    // CodeMirror 容器尺寸 + 换行状态都变了，必须 refresh，
    // 否则内容区高度/滚动宽度还是旧值
    scheduleRefresh(block);
  }

  function restoreMax(block) {
    block.classList.remove(MAX_CLASS);
    document.body.classList.remove(MAX_BODY_CLASS);
    maxed = false;
    // 还原 = 回到站点默认的自动换行
    restoreWrap(block);
    scheduleRefresh(block);
  }

  function toggleMax(block) {
    if (block.classList.contains(MAX_CLASS)) {
      restoreMax(block);
    } else {
      applyMax(block);
    }
    updateBtnText(block);
  }

  function updateBtnText(block) {
    const btn = block.querySelector('#' + BTN_ID);
    if (!btn) return;
    setText(btn.querySelector('.next-btn-helper') || btn,
      block.classList.contains(MAX_CLASS) ? '还原' : '最大化');
  }

  // ---------- 注入按钮：插在「刷新」左边，顺序 [最大化][到底][清理][刷新] ----------
  function makeButton() {
    // 复用站点 Fusion Next 按钮的类名，外观与「下载」一致
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = 'next-btn next-medium next-btn-normal';
    btn.style.marginRight = '8px';
    btn.innerHTML = '<span class="next-btn-helper">最大化</span>';
    return btn;
  }

  function makeEndButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = SCROLL_BTN_ID;
    btn.className = 'next-btn next-medium next-btn-normal';
    btn.title = '滚动到日志末尾';
    btn.style.marginRight = '8px';
    btn.innerHTML = '<span class="next-btn-helper">到底</span>';
    return btn;
  }

  function makeClearButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = CLEAR_BTN_ID;
    btn.className = 'next-btn next-medium next-btn-normal';
    btn.title = '清空当前日志内容';
    btn.style.marginRight = '8px';
    btn.innerHTML = '<span class="next-btn-helper">清理</span>';
    return btn;
  }

  function decorate(block) {
    const refreshBtn = findRefreshBtn(block);
    if (!refreshBtn) return;

    // 目标顺序 [最大化][到底][清理][刷新]。
    // 注意：只在缺失/错位时才动 DOM——每轮扫描哪怕无意义地重排一次，
    // 都会被 MutationObserver 捕获形成 无限扫描循环（页面假死）
    const parent = refreshBtn.parentNode;
    // 清掉 v1.2.0 自动刷新的残留控件（升级自旧版且页面未整刷时可能还在）
    for (const id of STALE_IDS) {
      const stale = block.querySelector('#' + id);
      if (stale) stale.remove();
    }
    let maxBtn = block.querySelector('#' + BTN_ID);
    let endBtn = block.querySelector('#' + SCROLL_BTN_ID);
    let clearBtn = block.querySelector('#' + CLEAR_BTN_ID);
    if (!endBtn) {
      endBtn = makeEndButton();
      parent.insertBefore(endBtn, refreshBtn);
    }
    if (!clearBtn) {
      clearBtn = makeClearButton();
      parent.insertBefore(clearBtn, refreshBtn);
    }
    if (!maxBtn) {
      maxBtn = makeButton();
      parent.insertBefore(maxBtn, endBtn);
    }
    if (maxBtn.nextElementSibling !== endBtn ||
        endBtn.nextElementSibling !== clearBtn ||
        clearBtn.nextElementSibling !== refreshBtn) {
      parent.insertBefore(maxBtn, endBtn);
      parent.insertBefore(endBtn, clearBtn);
      parent.insertBefore(clearBtn, refreshBtn);
    }
    // 只绑定一次（scan 会被 MutationObserver 频繁调用，重复绑定会叠加）；
    // 点击时现取可见块，避免闭包里的 block 过期
    if (!maxBtn._gstackBound) {
      maxBtn._gstackBound = true;
      maxBtn.addEventListener('click', () => {
        const b = visibleLogBlock();
        if (b) toggleMax(b);
      });
    }
    if (!clearBtn._gstackBound) {
      clearBtn._gstackBound = true;
      clearBtn.addEventListener('click', () => {
        const b = visibleLogBlock();
        if (b) clearLog(b);
      });
    }
    if (!endBtn._gstackBound) {
      endBtn._gstackBound = true;
      endBtn.addEventListener('click', () => {
        const b = visibleLogBlock();
        if (b) scrollToEnd(b);
      });
    }
    updateBtnText(block);

    // 最大化状态下块被 React 重绘换新：重新套上最大化样式
    if (maxed && !block.classList.contains(MAX_CLASS)) {
      applyMax(block);
    }
  }

  // ---------- SPA 监听 ----------
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 150);
  }

  // 已完整装饰过的块：快路径直接跳过，避免日志高频流式渲染期间
  // 每次 scan 都做 getBoundingClientRect（强制同步布局）造成卡顿
  const decorated = new WeakSet();
  let currentBlock = null;

  function scan() {
    // 快路径：上次记录的块还活着、控件齐全、最大化状态一致 → 直接返回，
    // 全程只查 isConnected（不触发布局），日志高频渲染时零额外开销
    const b = currentBlock;
    if (b && b.isConnected && decorated.has(b) &&
        b.querySelector('#' + BTN_ID) &&
        b.querySelector('#' + SCROLL_BTN_ID) &&
        b.querySelector('#' + CLEAR_BTN_ID) &&
        (!maxed || b.classList.contains(MAX_CLASS))) {
      // 最大化期间站点重渲染（刷新/切页签会重新 setOption）可能把
      // CodeMirror-wrap 加回来 → 补摘一次。只读 querySelector + 可能的
      // 一次类写入，不读布局，高频日志下开销可忽略
      if (maxed) {
        const wrapNode = b.querySelector('.' + CM_WRAP_CLASS);
        if (wrapNode) stripWrap(b);
      }
      return;
    }
    const block = visibleLogBlock();
    if (!block) {
      currentBlock = null;
      if (maxed) {
        maxed = false;                       // 日志块整个没了（切页）：复位
        document.body.classList.remove(MAX_BODY_CLASS);
      }
      return;
    }
    currentBlock = block;
    decorate(block);
    decorated.add(block);
    // 隐藏的旧块残留：清掉最大化标记
    document.querySelectorAll('.workload-details-log.' + MAX_CLASS).forEach((el) => {
      if (el !== block) el.classList.remove(MAX_CLASS);
    });
  }

  function init() {
    injectStyle();
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 1000);   // React 重渲染可能整块替换 DOM，兜底补按钮
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !maxed) return;
      const block = document.querySelector('.workload-details-log.' + MAX_CLASS);
      if (block) {
        restoreMax(block);
        updateBtnText(block);
      }
      e.preventDefault();
    });
    console.log(LOG, '已启动');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
