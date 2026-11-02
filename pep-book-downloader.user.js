// ==UserScript==
// @name         人教教材阅读器 · 下载助手
// @namespace    pep-book-downloader
// @version      1.0.2
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

  // ===== 全局状态（页面不刷新则缓存一直有效，可断点续传）=====
  let cache = null;          // Array<Blob|null>，下标 = 页码
  let running = false;       // 防止重复点击并发运行
  let cancelFlag = false;    // 弹窗「取消」按钮
  let ui = null;             // 弹窗元素引用

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
    const cleaned = [];
    for (let i = 0; i < blobs.length; i++) {
      if (cancelFlag) { log('⏹ 已取消'); setStage('已取消'); return; }
      cleaned.push(await cleanOnePage(blobs[i]));
      if ((i + 1) % 5 === 0 || i + 1 === blobs.length) {
        setProgress(60 + ((i + 1) / blobs.length) * 30);
        setStage(`去水印 ${i + 1}/${blobs.length}`);
      }
    }
    log(`透传原文件 ${passthrough} 页，去水印重编码 ${reencoded} 页`);

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

  async function cleanOnePage(blob) {
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
    if (!cleanWatermark(c)) { passthrough++; return blob; }
    reencoded++;
    const out = await new Promise((resolve, reject) =>
      c.toBlob(b => b ? resolve(b) : reject(new Error('JPEG 编码失败')), 'image/jpeg', 0.98));
    return patchJpegDensity(out, dens);
  }

  function cleanWatermark(canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    let changed = false;

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
      if (near / total >= BOTTOM_SAME_RATIO && near < total) {
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
    }
    return changed;
  }
})();
