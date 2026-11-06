// ==UserScript==
// @name         人教教材阅读器 · 下载助手
// @namespace    pep-book-downloader
// @version      1.2.0
// @description  在人教教材在线阅读器底部工具栏加一个「下载」按钮，点击后弹窗显示进度，自动抓取全部页面、去水印并打包 ZIP 下载。仅供个人学习使用。
// @author       hackerorange
// @match        https://book.pep.com.cn/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/hackerorange/tampermonkey-scripts
// @supportURL   https://github.com/hackerorange/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/pep-book-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/hackerorange/tampermonkey-scripts/main/pep-book-downloader.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ===== 去水印配置（与导出脚本同款最终算法）=====
  const TOP_BOX = { y0: 0.0028, y1: 0.0367, x0: 0.33, x1: 0.70 };
  const BOTTOM_H = 0.0344;
  const STRONG_FRAC = 0.25;   // 顶部区域深色像素占比超过此值 → 视为深色图片，整页跳过
  const DARK_PROTECT = 160;   // 底部亮度低于此值视为深色正文（页码等），填充时保护
  const BOTTOM_SAME_RATIO = 0.95;
  const BOTTOM_TOL = 64;
  // 页面底部「人民教育出版社」绿色书法署名：固定居中，占比很小
  const LOGO_ZONE = { x0: 0.30, x1: 0.70, y0: 0.955 };
  // 页面底部灰色水印「仅供个人学习使用，未经授权不得另做他用」：
  // 它只出现在「插画铺满页脚」的页面上（白页只有绿色书法署名），所以没有干净参考页可学。
  // 办法：水印是半透明灰，它在每个像素上打掉的比例 a 就是「相对变暗比例」；
  // 这个比例每页都相同，而插画内容每页都不同 —— 逐页求 dev=(背景−亮度)/背景，跨页取低分位，
  // 水印的字形和浓度就一起浮出来了（见 4.5 节）。
  const WM_SEED_T = 0.10;     // 双阈值：alpha 明显的位置作种子（一定属于字形）
  const WM_GROW_T = 0.04;     // 双阈值：alpha 略高的位置作可生长区（种子连通过来才算）
  const WM_ALPHA_MAX = 0.55;  // 反解时 alpha 的上限：再高就不是「半透明灰字」了
  const WM_QUANTILE = 0.25;   // 跨页取低分位：水印每页都在，插画各不相同
  const WM_DEV_LO = 0.07;     // 页内：灰字覆盖率的下限（再低就是噪点）
  const WM_DEV_HI = 0.35;     // 页内：上限（更黑的是插画线条，不是半透明灰字）
  const WM_RUN_MAX = 24;      // 页内：横向连续不超过这么多像素才算笔画
  const WM_BAND_PAD = 4;      // 页内：字行区间上下各放宽几行
  const WM_BG_R = 16;         // 估「局部背景」的盒式窗口半径：要明显大于笔画，且能把笔画的上下空白卷进来
  const WM_MIN_PAGES = 4;     // 至少累积这么多页才敢定位置先验
  const WM_STACK_MAX = 32;    // 最多保留这么多页的响应（再多内存吃不消）
  const WM_LOGO_GUARD = { x0: 0.36, x1: 0.64 };  // 绿色署名区交给 cleanLogoSignature

  // ===== 全局状态（页面不刷新则缓存一直有效，可断点续传）=====
  let cache = null;          // Array<Blob|null>，下标 = 页码
  let running = false;       // 防止重复点击并发运行
  let cancelFlag = false;    // 弹窗「取消」按钮
  let ui = null;             // 弹窗元素引用

  // ===== 底部灰色水印（跨页学位置 + 逐页反解）=====
  let wmStack = [];          // Float32Array(W*bh) 列表：逐页的相对变暗比例 dev（= 覆盖率）
  let wmN = 0;               // 参与学习的页数
  let wmW = 0, wmBH = 0;     // 学习时的页面宽度与底带高度（尺寸不一致的页不参与）
  let wmMask = null;         // Uint8Array(W*bh)：字行位置先验（跨页交集，不追求字形完整）
  let wmMed = null;          // Float32Array(W*bh)：跨页学到的覆盖率（alpha），也当字形模板用
  let wmLastA = 0;           // 上一页清掉的像素平均覆盖率（0.10~0.30 属正常），供日志/调试

  function resetFooterLearning() {
    wmStack = []; wmN = 0; wmW = 0; wmBH = 0; wmMask = null; wmMed = null; wmLastA = 0;
  }

  // ============================================================
  // 一、底部工具栏注入「下载」按钮
  // ============================================================
  function injectButton() {
    if (document.getElementById('pepDlBtn')) return;
    const bar = document.querySelector('#fbToolBar .buttonBar');
    if (!bar) return false;
    const first = bar.querySelector('.button');
    if (!first) return false;

    // 最左边按钮的 left 值再往左挪 34px，保持同样式
    const leftPx = parseFloat(first.style.left) || 0;
    const btn = document.createElement('div');
    btn.className = 'button';
    btn.id = 'pepDlBtn';
    btn.title = '下载本书（去水印 · ZIP）';
    btn.style.cssText = `cursor: pointer; left: ${Math.max(0, leftPx - 34)}px; top: ${first.style.top || '7px'}; opacity: 1;`;
    // 与其他按钮完全同构：18x18 img 图标 + span 文字（icon-only 工具栏会自动隐藏 span）
    // 图标用橙色 #FF9F45，和灰色原生按钮区分开
    const ICON = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAWUlEQVR4nGNgGHLg/3zX/yBMSB0TtSxkGjVoCIYRIzKHmPSCDBgTdzNidRGyBCHAiKYWw2vEGMaIRQ1OTdi8yYjHEpyBja6JkQRvE+0yrBaTowmuGVesUQIAduobdBwRf14AAAAASUVORK5CYII=';
    btn.innerHTML =
      '<img style="pointer-events:none;" src="data:image/png;base64,' + ICON + '">' +
      '<span style="pointer-events: none; color: rgb(255,159,69);">下载</span>';
    btn.addEventListener('click', () => startDownload());
    // 插到最左边按钮前面
    bar.insertBefore(btn, first);
    return true;
  }

  // 工具栏可能是异步渲染的，轮询等待出现
  const waitBar = setInterval(() => {
    if (injectButton()) clearInterval(waitBar);
  }, 800);
  setTimeout(() => clearInterval(waitBar), 60000);

  // ============================================================
  // 二、弹窗 UI
  // ============================================================
  function buildModal() {
    if (ui) return;
    const wrap = document.createElement('div');
    wrap.id = 'pepDlModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;' +
      'display:none;align-items:center;justify-content:center;font-family:"PingFang SC","Microsoft YaHei",sans-serif;';
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:12px;width:420px;max-width:90vw;padding:22px 26px;box-shadow:0 8px 30px rgba(0,0,0,.3);">' +
      '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '    <div id="pepDlTitle" style="font-size:16px;font-weight:700;color:#333;">教材下载</div>' +
      '    <div id="pepDlClose" style="cursor:pointer;color:#999;font-size:20px;line-height:1;" title="关闭">×</div>' +
      '  </div>' +
      '  <div id="pepDlBook" style="font-size:13px;color:#777;margin-bottom:14px;word-break:break-all;"></div>' +
      '  <div style="background:#eee;border-radius:8px;height:14px;overflow:hidden;">' +
      '    <div id="pepDlBar" style="height:100%;width:0%;background:linear-gradient(90deg,#b3452f,#c9703f);transition:width .25s;"></div>' +
      '  </div>' +
      '  <div style="display:flex;justify-content:space-between;margin-top:8px;">' +
      '    <div id="pepDlStage" style="font-size:13px;color:#555;">准备中 …</div>' +
      '    <div id="pepDlPct" style="font-size:13px;color:#555;font-weight:600;">0%</div>' +
      '  </div>' +
      '  <div id="pepDlMsg" style="margin-top:10px;font-size:12px;color:#888;max-height:110px;overflow-y:auto;line-height:1.6;white-space:pre-wrap;"></div>' +
      '  <div style="margin-top:14px;text-align:right;">' +
      '    <button id="pepDlCancel" style="padding:6px 18px;border:1px solid #ddd;border-radius:6px;background:#f7f7f7;color:#666;cursor:pointer;font-size:13px;">取消</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    ui = {
      wrap,
      title: wrap.querySelector('#pepDlTitle'),
      book: wrap.querySelector('#pepDlBook'),
      bar: wrap.querySelector('#pepDlBar'),
      pct: wrap.querySelector('#pepDlPct'),
      stage: wrap.querySelector('#pepDlStage'),
      msg: wrap.querySelector('#pepDlMsg'),
      close: wrap.querySelector('#pepDlClose'),
      cancel: wrap.querySelector('#pepDlCancel'),
    };
    ui.close.addEventListener('click', hideModal);          // 只收起弹窗，不中断任务
    ui.cancel.addEventListener('click', () => { cancelFlag = true; });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) hideModal(); });
  }
  const showModal = () => { buildModal(); cancelFlag = false; ui.wrap.style.display = 'flex'; };
  const hideModal = () => { if (ui) ui.wrap.style.display = 'none'; };

  function setProgress(pct) {            // 0~100
    if (!ui) return;
    ui.bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    ui.pct.textContent = Math.round(pct) + '%';
  }
  function setStage(text) { if (ui) ui.stage.textContent = text; }
  function log(text) {
    if (!ui) return;
    ui.msg.textContent += text + '\n';
    ui.msg.scrollTop = ui.msg.scrollHeight;
    console.log('[下载助手]', text);
  }

  // ============================================================
  // 三、下载主流程
  // ============================================================
  async function startDownload() {
    if (running) { showModal(); log('任务正在进行中 …'); return; }
    running = true;
    showModal();
    try {
      await run();
    } catch (err) {
      log('❌ 出错：' + err.message);
      setStage('出错，详见日志');
    }
    running = false;
  }

  async function run() {
    ui.title.textContent = '教材下载';
    ui.book.textContent = '';
    ui.msg.textContent = '';
    setProgress(0);
    setStage('读取书籍信息 …');

    // 1. 书 ID 与 config
    const m = location.pathname.match(/^\/(\d+)/);
    if (!m) throw new Error('请在教材阅读器页面（book.pep.com.cn/书ID/...）使用本脚本');
    const bookId = m[1];
    const base = `/${bookId}/files/mobile/`;

    let totalPages = 0, bookTitle = '', createdTime = '';
    for (const cfgUrl of [`/${bookId}/javascript/config.js`, `/${bookId}/mobile/javascript/config.js`]) {
      try {
        const res = await fetch(cfgUrl);
        if (!res.ok) continue;
        const text = await res.text();
        const tp = text.match(/totalPageCount\s*=\s*(\d+)/);
        const ct = text.match(/CreatedTime\s*=\s*"(\d+)"/);
        const bt = text.match(/bookTitle\s*=\s*"([^"]+)"/);
        if (tp) totalPages = parseInt(tp[1], 10);
        if (ct) createdTime = ct[1];
        if (bt && !bookTitle) bookTitle = bt[1];
        if (totalPages) break;   // 拿到 WAF 验证页（HTML）时解析不到，继续试下一个地址
      } catch (e) { /* 尝试下一个位置 */ }
    }
    if (!totalPages) throw new Error('未能读取总页数，请先完成滑块验证并进入阅读器后再点下载');
    if (!bookTitle) bookTitle = bookId;
    ui.book.textContent = `《${bookTitle}》 · ${totalPages} 页`;

    // 时间戳参数：优先用 config.js 的 CreatedTime（每本书固定值）
    let TS = createdTime;
    if (!TS) {
      try {
        const entries = performance.getEntriesByType('resource');
        for (let k = entries.length - 1; k >= 0; k--) {
          const mm = entries[k].name.match(/files\/(?:mobile|large)\/\d+\.jpg\?(\d+)/);
          if (mm) { TS = mm[1]; break; }
        }
      } catch (e) { /* ignore */ }
    }
    if (!TS) {
      const d = new Date();
      TS = '' + d.getFullYear() % 100 + String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') + String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
    }
    log(`书ID ${bookId} ｜ 总页数 ${totalPages} ｜ 时间戳 ?${TS}`);

    // 2. 断点缓存（页面不刷新就一直有效）
    if (!cache || cache.length !== totalPages + 1) cache = new Array(totalPages + 1).fill(null);

    const fetchWithTimeout = async (url, ms) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try { return await fetch(url, { signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
    };
    let needVerify = false;
    const tryFetchPage = async (i) => {
      try {
        const res = await fetchWithTimeout(`${base}${i}.jpg?${TS}`, 12000);
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('text/html')) { needVerify = true; return null; }
        if (res.ok) {
          const b = await res.blob();
          if (b.type.startsWith('image') && b.size > 2000) return b;
        }
      } catch (e) { /* 超时或网络错误 */ }
      return null;
    };

    // 3. 逐页下载（阶段权重 0~60%）
    setStage('下载页面 …');
    const failed = [];
    let consecutiveFail = 0;
    let done = 0;
    for (let i = 1; i <= totalPages; i++) {
      if (cancelFlag) { log('⏹ 已取消'); setStage('已取消'); return; }
      if (cache[i]) { done++; setProgress((done / totalPages) * 60); continue; }
      let blob = await tryFetchPage(i);
      if (!blob && !needVerify) { await sleep(3000); blob = await tryFetchPage(i); }
      if (!blob && !needVerify) { await sleep(8000); blob = await tryFetchPage(i); }
      if (needVerify) {
        setStage('需要人机验证');
        log('⚠️ 检测到滑块验证：请完成验证进入阅读器后，重新点击「下载」按钮继续（已完成页的缓存会保留在本页面，不刷新即可续传）');
        return;
      }
      cache[i] = blob;
      done++;
      setProgress((done / totalPages) * 60);
      setStage(`下载页面 ${i}/${totalPages}`);
      if (blob) { consecutiveFail = 0; }
      else {
        consecutiveFail++; failed.push(i);
        log(`第 ${i} 页暂缺，稍后补抓`);
        if (consecutiveFail >= 5) { log('连续 5 页失败，疑似限流，等待 30 秒 …'); await sleep(30000); }
      }
      await sleep(500);
    }

    // 4. 补抓缺失页
    if (failed.length) {
      log(`补抓 ${failed.length} 个缺失页 …`);
      for (const i of failed) {
        if (cancelFlag) { log('⏹ 已取消'); setStage('已取消'); return; }
        const blob = await tryFetchPage(i);
        if (blob) cache[i] = blob;
        await sleep(2000);
      }
    }

    const pageNos = [];
    const blobs = [];
    const missing = [];
    for (let i = 1; i <= totalPages; i++) {
      if (cache[i]) { blobs.push(cache[i]); pageNos.push(i); } else missing.push(i);
    }
    if (missing.length) log(`最终缺失页：${missing.join(', ')}`);
    if (!blobs.length) throw new Error('未获取到任何页面，请确认已通过滑块验证');

    // 5. 去水印处理（阶段权重 60~90%）
    setStage('去水印处理 …');
    passthrough = 0; reencoded = 0;
    resetFooterLearning();
    const cleaned = [];
    const busy = [];        // 主色填充没擦到底带的页（插画页脚 / 水印太浅），等模板学完再补
    for (let i = 0; i < blobs.length; i++) {
      if (cancelFlag) { log('⏹ 已取消'); setStage('已取消'); return; }
      const r = await cleanOnePage(blobs[i], { learn: true });
      cleaned.push(r.blob);
      if (!r.stripOk || !r.fillRan) busy.push(i);
      if ((i + 1) % 5 === 0 || i + 1 === blobs.length) {
        setProgress(60 + ((i + 1) / blobs.length) * 28);
        setStage(`去水印 ${i + 1}/${blobs.length}`);
      }
    }
    log(`透传原文件 ${passthrough} 页，去水印重编码 ${reencoded} 页`);

    // 5.1 主色填充没擦到的页（插画铺满页脚）：用跨页学到的「字行位置」+ 本页的「半透明浓度」补掉底部灰字
    if (busy.length) {
      wmMask = buildFooterMask();
      if (!wmMask) {
        log(`插画页脚 ${busy.length} 页：可比对的页数不足（需 ≥${WM_MIN_PAGES} 页），灰字保持原样`);
      } else {
        let fixed = 0;
        for (const i of busy) {
          if (cancelFlag) { log('⏹ 已取消'); setStage('已取消'); return; }
          const r = await cleanOnePage(blobs[i], { applyMask: true });
          cleaned[i] = r.blob;
          if (r.masked) fixed++;
          setProgress(88 + (fixed / busy.length) * 2);
          setStage(`插画页脚修补 ${fixed}/${busy.length}`);
        }
        log(`插画页脚 ${busy.length} 页：补掉底部灰字 ${fixed} 页（尽力而为，个别位置可能留淡淡残影）`);
      }
    }

    // 6. 打包 ZIP（阶段权重 90~99%）
    setStage('打包 ZIP …');
    const zip = new JSZip();
    const pad = String(totalPages).length;
    for (let i = 0; i < cleaned.length; i++) {
      zip.file(String(pageNos[i]).padStart(pad, '0') + '.jpg', cleaned[i], { compression: 'STORE' });
    }
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      (meta) => { setProgress(90 + meta.percent * 0.09); }
    );

    // 7. 保存
    const title = bookTitle.replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = title + '.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);

    setProgress(100);
    setStage('✅ 完成');
    log(`ZIP 已开始下载：${blobs.length} 张图片，${(zipBlob.size / 1048576).toFixed(1)} MB`);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 计数器：主流程与 cleanOnePage 共用（cleanOnePage 定义在外层，需能访问）
  let passthrough = 0, reencoded = 0;

  // ============================================================
  // 四、去水印（与导出脚本同款：顶部按列重建 + 底部主色填充）
  // ============================================================
  const readJpegDensity = (ab) => {
    const u8 = new Uint8Array(ab);
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    let i = 2;
    while (i + 16 < u8.length) {
      if (u8[i] !== 0xFF) break;
      const marker = u8[i + 1];
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (marker === 0xE0 && u8[i + 4] === 0x4A && u8[i + 5] === 0x46 &&
          u8[i + 6] === 0x49 && u8[i + 7] === 0x46) {
        return { units: u8[i + 11], xd: (u8[i + 12] << 8) | u8[i + 13], yd: (u8[i + 14] << 8) | u8[i + 15] };
      }
      if (marker === 0xDA) break;
      i += 2 + len;
    }
    return null;
  };

  const patchJpegDensity = async (blob, dens) => {
    if (!dens || !dens.xd || !dens.yd || dens.units === 0) return blob;
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let i = 2;
    while (i + 16 < u8.length) {
      if (u8[i] !== 0xFF) break;
      const marker = u8[i + 1];
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (marker === 0xE0 && u8[i + 4] === 0x4A && u8[i + 5] === 0x46) {
        u8[i + 11] = dens.units;
        u8[i + 12] = dens.xd >> 8; u8[i + 13] = dens.xd & 0xFF;
        u8[i + 14] = dens.yd >> 8; u8[i + 15] = dens.yd & 0xFF;
        return new Blob([u8], { type: 'image/jpeg' });
      }
      if (marker === 0xDA) break;
      i += 2 + len;
    }
    const seg = new Uint8Array(18);
    seg[0] = 0xFF; seg[1] = 0xE0; seg[2] = 0x00; seg[3] = 0x10;
    seg[4] = 0x4A; seg[5] = 0x46; seg[6] = 0x49; seg[7] = 0x46; seg[8] = 0x00;
    seg[9] = 0x01; seg[10] = 0x01;
    seg[11] = dens.units || 1;
    seg[12] = dens.xd >> 8; seg[13] = dens.xd & 0xFF;
    seg[14] = dens.yd >> 8; seg[15] = dens.yd & 0xFF;
    const out = new Uint8Array(2 + seg.length + (u8.length - 2));
    out.set(u8.subarray(0, 2), 0);
    out.set(seg, 2);
    out.set(u8.subarray(2), 2 + seg.length);
    return new Blob([out], { type: 'image/jpeg' });
  };

  async function cleanOnePage(blob, opts) {
    opts = opts || {};
    const dens = readJpegDensity(await blob.arrayBuffer());
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      const u = URL.createObjectURL(blob);
      im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(u); reject(new Error('图片解码失败')); };
      im.src = u;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;    // 原始像素尺寸，不缩放
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const info = cleanWatermark(c, opts);
    if (!info.changed) { passthrough++; return { blob, stripOk: info.stripOk, fillRan: info.fillRan, masked: info.masked }; }
    reencoded++;
    const out = await new Promise((resolve, reject) =>
      c.toBlob(b => b ? resolve(b) : reject(new Error('JPEG 编码失败')), 'image/jpeg', 0.98));
    return { blob: await patchJpegDensity(out, dens), stripOk: info.stripOk, fillRan: info.fillRan, masked: info.masked };
  }

  // ---------- 底部绿色署名清除 ----------
  // 掩膜膨胀（方形核）：把笔画外扩 r 像素，连带抗锯齿边一起处理
  function dilateMask(mask, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let yy = y0; yy <= y1; yy++) out.fill(1, yy * w + x0, yy * w + x1 + 1);
      }
    }
    return out;
  }

  // 被掩膜的像素用「同一行左右最近的非掩膜像素」线性插值补上。
  // 选横向是因为署名笔画多为竖向笔划：一行内笔画宽度很小，左右邻居就在旁边，
  // 取过来的背景色最接近；纵向插值会拉出竖条。
  function fillByNeighbors(data, mask, w, h) {
    const left = new Int32Array(w), right = new Int32Array(w);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let last = -1;
      for (let x = 0; x < w; x++) { left[x] = last; if (!mask[base + x]) last = x; }
      last = -1;
      for (let x = w - 1; x >= 0; x--) { right[x] = last; if (!mask[base + x]) last = x; }
      for (let x = 0; x < w; x++) {
        if (!mask[base + x]) continue;
        const p = (base + x) * 4;
        const l = left[x], r = right[x];
        if (l >= 0 && r >= 0) {
          const t = (x - l) / (r - l);
          const pl = (base + l) * 4, pr = (base + r) * 4;
          data[p] = data[pl] * (1 - t) + data[pr] * t;
          data[p + 1] = data[pl + 1] * (1 - t) + data[pr + 1] * t;
          data[p + 2] = data[pl + 2] * (1 - t) + data[pr + 2] * t;
        } else {
          const q = l >= 0 ? (base + l) * 4 : (base + r) * 4;
          data[p] = data[q]; data[p + 1] = data[q + 1]; data[p + 2] = data[q + 2];
        }
      }
    }
  }

  // 底部居中的「人民教育出版社」绿色书法署名：定位 → 掩膜 → 插值抹掉。
  // 白页上等价于填白；照片页上取左右邻像素，接缝不可见。
  function cleanLogoSignature(ctx, W, H) {
    const sx = Math.round(W * LOGO_ZONE.x0);
    const sw = Math.round(W * (LOGO_ZONE.x1 - LOGO_ZONE.x0));
    const sy = Math.round(H * LOGO_ZONE.y0);
    const sh = H - sy;
    if (sw <= 8 || sh <= 8) return false;

    const band = ctx.getImageData(sx, sy, sw, sh).data;
    // 找强绿色笔画（墨绿，远高于红蓝通道）
    let minX = sw, maxX = -1, minY = sh, maxY = -1, cnt = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const p = (y * sw + x) * 4;
        if (band[p + 1] - Math.max(band[p], band[p + 2]) > 10 && band[p + 1] > 35) {
          cnt++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (cnt < 80) return false;                                   // 这页没有署名
    if (maxX - minX < W * 0.12 || maxY - minY < 10) return false;  // 太小，是零散绿点
    if (maxX - minX > W * 0.45) return false;                      // 太宽，像照片里的绿色区域

    const PAD = 6;
    const bx0 = Math.max(0, sx + minX - PAD);
    const by0 = Math.max(0, sy + minY - PAD);
    const bx1 = Math.min(W, sx + maxX + PAD + 1);
    const by1 = Math.min(H, sy + maxY + PAD + 1);
    const bw = bx1 - bx0, bh = by1 - by0;
    const img = ctx.getImageData(bx0, by0, bw, bh);
    const d = img.data;
    const src = new Uint8ClampedArray(d);   // 掩膜判定始终基于原图，避免被已填的像素带偏

    const isGreen = (i, thr) => {
      const p = i * 4;
      return src[p + 1] - Math.max(src[p], src[p + 2]) > thr && src[p + 1] > 30;
    };

    const seed = new Uint8Array(bw * bh);
    for (let i = 0; i < seed.length; i++) if (isGreen(i, 10)) seed[i] = 1;

    // 第一遍：笔画 + 3px 膨胀（吃掉抗锯齿边）
    fillByNeighbors(d, dilateMask(seed, bw, bh, 3), bw, bh);

    // 背景是否「近白页脚」：白页可以放开手脚多清一圈；照片页要保守，否则会把
    // 明暗渐变的背景当成残迹，补出一块发亮的色块
    let bright = 0, sampled = 0;
    for (let i = 0; i < seed.length; i++) {
      if (seed[i]) continue;
      const p = i * 4;
      sampled++;
      if ((src[p] + src[p + 1] + src[p + 2]) / 3 >= 235) bright++;
    }
    const whiteFooter = sampled > 0 && bright / sampled >= 0.85;
    const nearR = whiteFooter ? 10 : 6;
    const darkTol = whiteFooter ? 12 : 16;

    // 第二遍：笔画外 nearR 内仍偏绿 / 明显比本行背景暗的残点，再补一次
    const near = dilateMask(seed, bw, bh, nearR);
    const lum = new Float32Array(bw * bh);
    for (let i = 0; i < lum.length; i++) {
      const p = i * 4;
      lum[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
    }
    const rowMed = new Float32Array(bh);
    const rowBuf = new Float32Array(bw);
    for (let y = 0; y < bh; y++) {
      rowBuf.set(lum.subarray(y * bw, y * bw + bw));
      const sorted = Array.from(rowBuf).sort((a, b) => a - b);
      rowMed[y] = sorted[sorted.length >> 1];
    }
    const resid = new Uint8Array(bw * bh);
    let residCnt = 0;
    for (let i = 0; i < resid.length; i++) {
      if (!near[i]) continue;
      const y = (i / bw) | 0;
      if (isGreen(i, 3) || lum[i] < rowMed[y] - darkTol) { resid[i] = 1; residCnt++; }
    }
    if (residCnt) fillByNeighbors(d, dilateMask(resid, bw, bh, 1), bw, bh);

    ctx.putImageData(img, bx0, by0);
    return true;
  }

  // ============================================================
  // 四.5 底部灰色水印（跨页中值 → 搜索区 → 页内精修 → 同行插值）
  // ============================================================
  // 问题：底部「仅供个人学习使用，未经授权不得另做他用」是半透明灰字。白页面上它根本不存在
  // （白页只有绿色书法署名），只在「插画铺满页脚」的页面上出现 —— 所以没有干净参考页可以学模板。
  //
  // 办法（分成「学位置」和「量浓度」两件事）：
  //   1) 逐页算相对变暗比例 dev = (盒式背景 − 亮度) / 盒式背景。水印是半透明灰，
  //      它在每个像素上打掉的比例恰好就是覆盖率 a；插画内容每页不同，dev 也就每页不同。
  //   2) 跨页取低分位 + 双阈值滞后 → 得到「这行字大概落在哪几行、哪一段 x」的位置先验。
  //      （不追求字形完整：这行字在每页里的上下位置会浮动几像素，跨页交集只能剩下一段。）
  //   3) 修补时以该先验为窗口，用**这一页自己的 dev** 决定清哪些像素：dev ∈ [0.07, 0.35]
  //      且横向连续 ≤ 24px 的才当笔画。反解 obs/(1−dev) 即回到水印之前的亮度，
  //      纹理一个像素都不插值，所以插画不会拉花；比灰字更黑的线条、更长的结构都不碰。
  // 注意：绿色署名区不参与，交给 cleanLogoSignature。

  // 盒式均值（积分图实现，O(n)）：把掩膜当空洞、只统计干净像素，用来估「背景本该多亮」
  function boxMeanLum(lum, mask, W, H, r) {
    const pw = W + 1;
    const p1 = new Float64Array(pw * (H + 1));
    const p2 = new Float64Array(pw * (H + 1));
    for (let y = 0; y < H; y++) {
      let r1 = 0, r2 = 0;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, w = mask && mask[i] ? 0 : 1;
        r1 += lum[i] * w; r2 += w;
        p1[(y + 1) * pw + x + 1] = p1[y * pw + x + 1] + r1;
        p2[(y + 1) * pw + x + 1] = p2[y * pw + x + 1] + r2;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const s1 = p1[y1 * pw + x1] - p1[y0 * pw + x1] - p1[y1 * pw + x0] + p1[y0 * pw + x0];
        const s2 = p2[y1 * pw + x1] - p2[y0 * pw + x1] - p2[y1 * pw + x0] + p2[y0 * pw + x0];
        out[y * W + x] = s2 >= 8 ? s1 / s2 : lum[y * W + x];
      }
    }
    return out;
  }

  function learnFooterFootprint(d, W, bh) {
    if (!wmW) { wmW = W; wmBH = bh; }
    if (W !== wmW || bh !== wmBH) return;      // 尺寸不同的页（封面等）不参与
    wmN++;
    if (wmStack.length >= WM_STACK_MAX) return;
    const n = W * bh;
    const lum = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
    // 相对变暗比例 dev = (bg − 亮度) / bg：水印是「半透明灰」，它在每个像素上打掉的正是这个比例，
    // 也就是覆盖率 alpha 本身。插画内容每页不同，dev 也会变；水印每页都在，dev 保持同一个值。
    const bg = boxMeanLum(lum, null, W, bh, WM_BG_R);
    const dev = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = bg[i];
      if (b < 24) continue;                    // 太暗的地方量不出比例
      const v = (b - lum[i]) / b;
      dev[i] = v > 0 ? (v > 1 ? 1 : v) : 0;
    }
    wmStack.push(dev);
  }

  // 3x3 形态学：grow=true 为膨胀，false 为腐蚀

  function maskMorph(m, w, h, grow) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let dy = -1; dy <= 1 && (grow ? !v : v); dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (grow) { if (m[yy * w + xx]) { v = 1; break; } }
            else if (!m[yy * w + xx]) { v = 0; break; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function buildFooterMask() {
    const n = wmStack.length;
    if (n < WM_MIN_PAGES) return null;
    const w = wmW, h = wmBH, area = w * h;
    // 逐像素跨页取「低分位」：水印每页都在这个位置打掉同一比例 → 低分位仍是那个比例；
    // 插画内容每页不同（有的页这里深、有的浅）→ 低分位被拉到 0。低分位比中值更不容易被
    // 「多数页都恰好有深色内容」骗到，代价是偶尔把水印估得略轻 —— 后面反解是除法，可承受。
    const wmDev = new Float32Array(area);
    const buf = new Float32Array(n);
    const qi = Math.floor((n - 1) * WM_QUANTILE);
    for (let i = 0; i < area; i++) {
      for (let k = 0; k < n; k++) buf[k] = wmStack[k][i];
      buf.sort();
      wmDev[i] = buf[qi];
    }
    const gx0 = Math.round(w * WM_LOGO_GUARD.x0), gx1 = Math.round(w * WM_LOGO_GUARD.x1);
    // 双阈值滞后：强响应作种子（一定是笔画），弱响应作可生长区；从种子在弱区内连通生长，
    // 既能补全笔画（中值响应在笔画边缘会衰减），又不会把纹理的零散弱响应吃进来（那里没有种子）
    let m = new Uint8Array(area);
    let cand = new Uint8Array(area);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (x >= gx0 && x < gx1) continue;    // 绿色署名区交给 cleanLogoSignature
        const v = wmDev[row + x];
        if (v > WM_SEED_T) { m[row + x] = 1; cand[row + x] = 1; }
        else if (v > WM_GROW_T) cand[row + x] = 1;
      }
    }
    for (let it = 0; it < 8; it++) {
      let grown = 0;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (m[row + x] || !cand[row + x]) continue;
          const up = y > 0 && m[row - w + x];
          const dn = y < h - 1 && m[row + w + x];
          const lf = x > 0 && m[row + x - 1];
          const rt = x < w - 1 && m[row + x + 1];
          if (up || dn || lf || rt) { m[row + x] = 1; grown++; }
        }
      }
      if (!grown) break;
    }
    cand = null;

    let cnt = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        cnt++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    // 结构检查：必须是一整行、够宽，但也不能糊成大块
    if (cnt < area * 0.005 || cnt > area * 0.35) return null;
    if (maxX - minX < w * 0.30 || maxY - minY < 6) return null;
    wmMed = wmDev;
    return maskMorph(m, w, h, true);   // 外扩 1px，带上抗锯齿边
  }

  function applyFooterMask(ctx, W, H) {
    if (!wmMask || !wmMed || W !== wmW || H < wmBH) return false;
    const bh = wmBH, area = W * bh;
    const strip = ctx.getImageData(0, H - bh, W, bh);
    const d = strip.data;

    // 关键事实：这行灰字在每页里的「上下位置」会浮动几像素，跨页取交集只能剩下共同覆盖的那一段。
    // 所以分成两步：
    //   ① 全局掩膜只用来定「字行可能出现在哪几行、哪一段 x」（位置先验）；
    //   ② 真正要清哪些像素由这页自己的 dev = (背景−亮度)/背景 决定 —— 水印是半透明灰，
    //      dev 就是它的覆盖率 a，反解 obs/(1−a) 即可还原，纹理不动。
    // 只吃「浓度落在灰字区间 + 横向短段」的像素：更黑的是插画线条，更长的是插画结构，都不碰。
    const lum0 = new Float32Array(area);
    for (let i = 0, p = 0; i < area; i++, p += 4) lum0[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
    const bg0 = boxMeanLum(lum0, null, W, bh, WM_BG_R);

    let yLo = bh, yHi = -1, xLo = W, xHi = -1;
    for (let y = 0; y < bh; y++) {
      let c = 0;
      for (let x = 0; x < W; x++) if (wmMask[y * W + x]) {
        c++;
        if (x < xLo) xLo = x; if (x > xHi) xHi = x;
      }
      if (c >= 2) { if (y < yLo) yLo = y; if (y > yHi) yHi = y; }
    }
    if (yHi < yLo) return false;
    yLo = Math.max(0, yLo - WM_BAND_PAD); yHi = Math.min(bh - 1, yHi + WM_BAND_PAD);

    const dev = new Float32Array(area);
    for (let y = yLo; y <= yHi; y++) {
      const row = y * W;
      for (let x = xLo; x <= xHi; x++) {
        const i = row + x, b = bg0[i];
        if (b < 40) continue;                        // 太暗的地方量不出比例
        const v = (b - lum0[i]) / b;
        if (v >= WM_DEV_LO && v <= WM_DEV_HI) dev[i] = v;
      }
    }

    let cnt = 0, devSum = 0;
    for (let y = yLo; y <= yHi; y++) {
      const row = y * W;
      let x = xLo;
      while (x <= xHi) {
        if (!dev[row + x]) { x++; continue; }
        let x1 = x;
        while (x1 <= xHi && dev[row + x1]) x1++;
        if (x1 - x <= WM_RUN_MAX) {                  // 短段才可能是笔画
          for (let xx = x; xx < x1; xx++) {
            const i = row + xx, p = i * 4;
            const k = 1 / (1 - dev[i]);
            d[p]     = Math.min(255, d[p]     * k);
            d[p + 1] = Math.min(255, d[p + 1] * k);
            d[p + 2] = Math.min(255, d[p + 2] * k);
            cnt++; devSum += dev[i];
          }
        }
        x = x1;
      }
    }
    if (cnt < 120) return false;
    wmLastA = devSum / cnt;                       // 平均覆盖率，正常 0.10~0.30

    ctx.putImageData(strip, 0, H - bh);
    return true;
  }

  function cleanWatermark(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    let changed = false;
    let stripOk = false;      // 底带是否「背景单一」，即主色填充这条路走通了
    let fillRan = false;      // 底带是否真的被整带/选择性填成了主色（水印浅时不会走）
    let masked = false;       // 是否用模板修补了插画页脚

    // ---- 顶部「人民教育出版社」书法字 ----
    // 水印笔迹永远比背景「深」：灰字压白底、墨绿字压彩带都是如此；
    // 而正文内容（如彩色横幅上的白色标题）比背景「亮」。
    // 所以只修比列背景更深的像素，亮像素一律不碰 → 不会擦掉白色标题等正文。
    {
      const y0 = Math.round(TOP_BOX.y0 * H), y1 = Math.round(TOP_BOX.y1 * H);
      const x0 = Math.round(TOP_BOX.x0 * W), x1 = Math.round(TOP_BOX.x1 * W);
      const bw = x1 - x0, bh = y1 - y0;
      const topRows = ctx.getImageData(x0, Math.max(0, y0 - 5), bw, Math.min(5, y0));
      const botRows = ctx.getImageData(x0, y1, bw, Math.min(25, H - y1));
      const tCnt = topRows.height, bCnt = botRows.height;
      const colTop = new Float64Array(bw * 3), colBot = new Float64Array(bw * 3);
      for (let p = 0; p < topRows.data.length; p += 4) {
        const c = (p / 4 % bw) * 3;
        colTop[c] += topRows.data[p]; colTop[c + 1] += topRows.data[p + 1]; colTop[c + 2] += topRows.data[p + 2];
      }
      for (let p = 0; p < botRows.data.length; p += 4) {
        const c = (p / 4 % bw) * 3;
        colBot[c] += botRows.data[p]; colBot[c + 1] += botRows.data[p + 1]; colBot[c + 2] += botRows.data[p + 2];
      }
      // 每列背景：上下参考色接近就取平均；差异大（水印框跨横幅/白页交界）时优先用上方参考行——
      // 水印贴着页顶，它上方一定与其背后的背景一致；下方可能已经是另一块背景（如白色页面）
      const colBg = new Float64Array(bw * 3);
      for (let c = 0; c < bw; c++) {
        const k = c * 3;
        if (tCnt > 0 && bCnt > 0) {
          const tr = colTop[k] / tCnt, tg = colTop[k + 1] / tCnt, tb = colTop[k + 2] / tCnt;
          const br = colBot[k] / bCnt, bg2 = colBot[k + 1] / bCnt, bb2 = colBot[k + 2] / bCnt;
          if (Math.abs(tr - br) < 40 && Math.abs(tg - bg2) < 40 && Math.abs(tb - bb2) < 40) {
            colBg[k] = (tr + br) / 2; colBg[k + 1] = (tg + bg2) / 2; colBg[k + 2] = (tb + bb2) / 2;
          } else {
            colBg[k] = tr; colBg[k + 1] = tg; colBg[k + 2] = tb;
          }
        } else if (tCnt > 0) {
          colBg[k] = colTop[k] / tCnt; colBg[k + 1] = colTop[k + 1] / tCnt; colBg[k + 2] = colTop[k + 2] / tCnt;
        } else {
          colBg[k] = colBot[k] / bCnt; colBg[k + 1] = colBot[k + 1] / bCnt; colBg[k + 2] = colBot[k + 2] / bCnt;
        }
      }
      const region = ctx.getImageData(x0, y0, bw, bh);
      const d = region.data;
      const n = d.length / 4;

      // 逐像素亮度与背景偏差（正 dlum=比背景暗，负=比背景亮）
      const lumArr = new Float64Array(n), dfArr = new Float64Array(n), dlArr = new Float64Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const k = (i % bw) * 3;
        const br = colBg[k], bg = colBg[k + 1], bb = colBg[k + 2];
        dfArr[i] = Math.abs(d[p] - br) + Math.abs(d[p + 1] - bg) + Math.abs(d[p + 2] - bb);
        lumArr[i] = (d[p] + d[p + 1] + d[p + 2]) / 3;
        dlArr[i] = (br + bg + bb) / 3 - lumArr[i];
      }
      // 白色正文保护：仅对「彩色背景的列」启用——白色标题压在横幅上时，以近白像素为核
      // 向外膨胀 2px 形成保护圈（水印的半透明亮偏差与标题反锯齿同属亮偏差，只能靠空间区分）。
      // 白色背景的列不启用（背景本身近白，保护圈会覆盖全部像素导致水印擦不掉），
      // 这些列维持「只修深色」：亮偏差都是内容，天然安全。
      const colColored = new Uint8Array(bw);
      for (let c = 0; c < bw; c++) {
        const k = c * 3;
        if ((colBg[k] + colBg[k + 1] + colBg[k + 2]) / 3 <= 235) colColored[c] = 1;
      }
      const prot = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const cx = i % bw;
        if (!colColored[cx] || lumArr[i] <= 235) continue;
        const cy = (i / bw) | 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= bh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= bw) continue;
            prot[yy * bw + xx] = 1;
          }
        }
      }
      // 分类：1=暗水印主体（整替换） 2=半透明水印（仅彩色列，明暗双向，强混 85%）
      //       3=暗反锯齿边（混 75%）
      const kind = new Uint8Array(n);
      let darkStrong = 0;
      for (let i = 0; i < n; i++) {
        if (prot[i]) continue;
        if (dfArr[i] > 60 && dlArr[i] > 10) { kind[i] = 1; darkStrong++; }
        else if (colColored[i % bw] && dfArr[i] > 40 && Math.abs(dlArr[i]) > 3) kind[i] = 2;
        else if (dfArr[i] > 20 && dlArr[i] > 3) kind[i] = 3;
      }
      // 保护：暗水印主体占比过高 → 整个区域是深色图片而非水印 → 整页跳过；
      // 没有任何主体 → 本来就没水印 → 不动（保证原始文件可透传）
      if (darkStrong > 0 && darkStrong / n <= STRONG_FRAC) {
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          if (!kind[i]) continue;
          const k = (i % bw) * 3;
          const br = colBg[k], bg = colBg[k + 1], bb = colBg[k + 2];
          if (kind[i] === 1) { d[p] = br; d[p + 1] = bg; d[p + 2] = bb; }
          else if (kind[i] === 2) { d[p] = d[p] * 0.15 + br * 0.85; d[p + 1] = d[p + 1] * 0.15 + bg * 0.85; d[p + 2] = d[p + 2] * 0.15 + bb * 0.85; }
          else { d[p] = d[p] * 0.25 + br * 0.75; d[p + 1] = d[p + 1] * 0.25 + bg * 0.75; d[p + 2] = d[p + 2] * 0.25 + bb * 0.75; }
        }
        ctx.putImageData(region, x0, y0);
        changed = true;
      }
    }

    // ---- 底部「仅供个人学习使用」灰字：主色占比 ≥95% 时整带填主色 ----
    {
      const bh = Math.round(BOTTOM_H * H);
      const strip = ctx.getImageData(0, H - bh, W, bh);
      const d = strip.data;
      const total = d.length / 4;
      const hist = new Map();
      for (let p = 0; p < d.length; p += 4) {
        const key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
        hist.set(key, (hist.get(key) || 0) + 1);
      }
      let bestKey = 0, bestCnt = -1;
      for (const [k, c] of hist) { if (c > bestCnt) { bestCnt = c; bestKey = k; } }
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let p = 0; p < d.length; p += 4) {
        const key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
        if (key === bestKey) { sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++; }
      }
      const cr = Math.round(sr / cnt), cg = Math.round(sg / cnt), cb = Math.round(sb / cnt);
      let near = 0;
      for (let p = 0; p < d.length; p += 4) {
        if (Math.abs(d[p] - cr) <= BOTTOM_TOL &&
            Math.abs(d[p + 1] - cg) <= BOTTOM_TOL &&
            Math.abs(d[p + 2] - cb) <= BOTTOM_TOL) near++;
      }
      const uniform = near / total >= BOTTOM_SAME_RATIO;
      if (uniform && near < total) {
        fillRan = true;
        // 底带里可能有深色正文（页码、页脚小字）与水印同行 → 带深色内容保护的选择性填充
        const dark = new Uint8Array(total);
        let darkCnt = 0;
        for (let i = 0, p = 0; i < total; i++, p += 4) {
          if ((d[p] + d[p + 1] + d[p + 2]) / 3 < DARK_PROTECT) { dark[i] = 1; darkCnt++; }
        }
        if (darkCnt === 0) {
          for (let p = 0; p < d.length; p += 4) { d[p] = cr; d[p + 1] = cg; d[p + 2] = cb; }
        } else {
          // 深色像素膨胀 2px 形成保护圈，圈内不动；圈外的亮像素填主色（水印灰字被清除）
          const prot = new Uint8Array(total);
          for (let i = 0; i < total; i++) {
            if (!dark[i]) continue;
            const cx = i % W, cy = (i / W) | 0;
            for (let dy = -2; dy <= 2; dy++) {
              const yy = cy + dy;
              if (yy < 0 || yy >= bh) continue;
              for (let dx = -2; dx <= 2; dx++) {
                const xx = cx + dx;
                if (xx < 0 || xx >= W) continue;
                prot[yy * W + xx] = 1;
              }
            }
          }
          for (let i = 0, p = 0; i < total; i++, p += 4) {
            if (prot[i]) continue;
            if ((d[p] + d[p + 1] + d[p + 2]) / 3 >= DARK_PROTECT) { d[p] = cr; d[p + 1] = cg; d[p + 2] = cb; }
          }
        }
        ctx.putImageData(strip, 0, H - bh);
        changed = true;
      }
      // 底带「背景单一」= 主色占比达标。注意 near===total 的纯色页也算单一（只是没水印可擦），
      // 所以判定不能带 near < total。
      stripOk = uniform;
      // 学习：只有「主色填充没擦到」的页才可能是带灰字的插画页脚页，用它们自己的响应做跨页中值。
      // 必须在填充之前取数据 —— 填完整带都是主色就再也看不出「哪里曾是水印」了（本分支恰好没填）。
      if (opts.learn && !fillRan) learnFooterFootprint(d, W, bh);
    }
    // ---- 模板修补：底带背景不单一（插画铺满页脚），或主色填充根本没走（水印很浅）→ 局部补掉灰字 ----
    if ((!stripOk || !fillRan) && opts.applyMask && applyFooterMask(ctx, W, H)) { changed = true; masked = true; }

    // ---- 底部「人民教育出版社」绿色书法署名（白页/照片页都要清） ----
    if (cleanLogoSignature(ctx, W, H)) changed = true;
    return { changed, stripOk, fillRan, masked };
  }
})();
