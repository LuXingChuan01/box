/* =============================================================
 * app.js —— 状态 / 交互 / 预览播放器 / 体积逼近与导出
 *
 * 依赖：apng.js（window.APNG）、render.js（window.RENDER）
 * 全部为普通 <script> 引入，不使用 ES module，file:// 下可直接运行。
 * ============================================================= */
(function () {
  'use strict';

  var APNG = window.APNG;
  var R = window.RENDER;

  var MAX_BASE = 1280;        // 画布基准最长边上限（避免首图过大导致编码极慢）
  var FRAME_INTERVAL = 40;    // 扫描线每步间隔（ms），约 25 步/秒
  var DELAY_DEN = 1000;       // APNG 帧延时分母
  // 体积超限时的降分辨率顺序（按最长边像素档位）
  var RES_STEPS = [640, 480, 384, 320];

  var state = {
    items: [],              // { name, img, url }
    mode: 'scan',           // 'scan' | 'frames'
    transitionMs: 700,
    holdMs: 700,
    bg: 'white',            // 'white' | 'black' | 'dominant'
    unlimited: false,
    targetBytes: 1048576,   // 1.0MB
    baseW: 640,
    baseH: 360,
    dominant: '#ffffff',
    forceRaw: false         // canvas PNG 解析异常时退化为自实现 PNG 编码
  };

  var specs = [];
  var totalMs = 0;
  var curT = 0;
  var playing = true;
  var rafId = 0;
  var playStart = 0;
  var busy = false;

  var el = {};
  var preview = null;
  var pctx = null;

  /* ---------------------------------------------------------- 工具 */

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function setStatus(msg, kind) {
    if (!el.status) return;
    el.status.textContent = msg;
    el.status.className = 'status' + (kind ? ' is-' + kind : '');
  }

  /* ---------------------------------------------------------- 图片载入 */

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ name: file.name || ('粘贴图片-' + Date.now() + '.png'), img: img, url: url });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取：' + (file.name || '未知文件')));
      };
      img.src = url;
    });
  }

  function isImageFile(f) {
    if (!f) return false;
    if (f.type && /^image\//.test(f.type)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name || '');
  }

  function addFiles(fileList) {
    var list = Array.prototype.slice.call(fileList || []).filter(isImageFile);
    if (!list.length) { setStatus('没有可识别的图片文件', 'warn'); return; }

    setStatus('正在读取 ' + list.length + ' 张图片…');
    var chain = Promise.resolve();
    var ok = 0;

    list.forEach(function (f) {
      chain = chain.then(function () {
        return loadImage(f).then(function (item) {
          state.items.push(item);
          ok++;
        }).catch(function (e) {
          console.warn(e);
        });
      });
    });

    chain.then(function () {
      renderList();
      onItemsChanged();
      setStatus('已添加 ' + ok + ' 张图片' + (ok < list.length ? '（' + (list.length - ok) + ' 张失败）' : ''), 'ok');
    });
  }

  /* ---------------------------------------------------------- 首图主色 */

  function computeDominant(img) {
    try {
      var c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      var cx = c.getContext('2d');
      cx.drawImage(img, 0, 0, 32, 32);
      var d = cx.getImageData(0, 0, 32, 32).data;
      var buckets = Object.create(null);
      var bestKey = null, bestN = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        var key = (d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5);
        var e = buckets[key];
        if (!e) { e = buckets[key] = { n: 0, r: 0, g: 0, b: 0 }; }
        e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
        if (e.n > bestN) { bestN = e.n; bestKey = key; }
      }
      if (!bestKey) return '#ffffff';
      var b = buckets[bestKey];
      return 'rgb(' + Math.round(b.r / b.n) + ',' + Math.round(b.g / b.n) + ',' + Math.round(b.b / b.n) + ')';
    } catch (e) {
      return '#ffffff';
    }
  }

  function bgColorValue() {
    if (state.bg === 'black') return '#000000';
    if (state.bg === 'dominant') return state.dominant || '#ffffff';
    return '#ffffff';
  }

  /* ---------------------------------------------------------- 列表渲染 */

  function renderList() {
    el.list.innerHTML = '';
    state.items.forEach(function (item, i) {
      var li = document.createElement('li');
      li.className = 'thumb';
      li.draggable = true;
      li.dataset.index = String(i);
      li.innerHTML =
        '<span class="idx">' + (i + 1) + '</span>' +
        '<img src="' + item.url + '" alt="" />' +
        '<span class="name">' + escapeHtml(item.name) + '</span>' +
        '<button class="del" type="button" title="移除">×</button>';
      el.list.appendChild(li);
    });
    el.count.textContent = String(state.items.length);
    el.emptyHint.style.display = state.items.length ? 'none' : '';
    el.list.style.display = state.items.length ? '' : 'none';
    updateMeta();
  }

  function removeItem(i) {
    var it = state.items[i];
    if (it && it.url) URL.revokeObjectURL(it.url);
    state.items.splice(i, 1);
    renderList();
    onItemsChanged();
  }

  /* ---------------------------------------------------------- 画布基准 / 时间线 */

  function recomputeBase() {
    if (!state.items.length) {
      state.baseW = 640; state.baseH = 360;
      state.dominant = '#ffffff';
      return;
    }
    var img = state.items[0].img;
    var w = img.naturalWidth || img.width || 640;
    var h = img.naturalHeight || img.height || 360;
    // 画布比例跟随首图，最长边不超过 MAX_BASE（等比缩放，不改变比例）
    var s = Math.min(1, MAX_BASE / Math.max(w, h));
    state.baseW = Math.max(2, Math.round(w * s));
    state.baseH = Math.max(2, Math.round(h * s));
    state.dominant = computeDominant(img);
  }

  function buildTimeline() {
    var N = state.items.length;
    if (!N) { specs = []; totalMs = 0; return; }
    specs = R.buildSpecs(N, state.mode, state.transitionMs, state.holdMs, FRAME_INTERVAL);
    totalMs = R.totalOf(specs);
  }

  function updateMeta() {
    if (el.canvasMeta) {
      el.canvasMeta.textContent = '画布 ' + state.baseW + '×' + state.baseH +
        ' · 图片 ' + state.items.length + ' 张 · 帧 ' + specs.length;
    }
  }

  function onItemsChanged() {
    recomputeBase();
    buildTimeline();
    if (preview) { preview.width = state.baseW; preview.height = state.baseH; }
    curT = 0;
    drawAt(curT);
    updateMeta();
  }

  /* ---------------------------------------------------------- 预览 */

  function drawAt(t) {
    if (!pctx || !preview) return;
    var W = preview.width, H = preview.height;
    if (!state.items.length) {
      pctx.fillStyle = '#f1f3f6';
      pctx.fillRect(0, 0, W, H);
      pctx.fillStyle = '#9aa3af';
      pctx.font = Math.round(Math.min(W, H) / 18) + 'px sans-serif';
      pctx.textAlign = 'center';
      pctx.textBaseline = 'middle';
      pctx.fillText('添加图片后在这里预览', W / 2, H / 2);
      return;
    }
    var scene = R.sceneAtSpecs(t, specs, totalMs) || { a: 0, b: null, progress: 0 };
    var images = state.items.map(function (it) { return it.img; });
    R.drawScene(pctx, W, H, scene, images, bgColorValue());
  }

  function updateTimeInfo(t) {
    if (!el.timeInfo) return;
    var a = (t % (totalMs || 1)) / 1000;
    var b = totalMs / 1000;
    el.timeInfo.textContent = a.toFixed(2) + 's / ' + b.toFixed(2) + 's';
  }

  function loop(ts) {
    if (!playing) return;
    curT = ts - playStart;
    drawAt(curT);
    updateTimeInfo(curT);
    rafId = requestAnimationFrame(loop);
  }

  function play() {
    if (playing) return;
    playing = true;
    playStart = performance.now() - curT;
    el.btnPlay.textContent = '暂停';
    rafId = requestAnimationFrame(loop);
  }

  function pause() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(rafId);
    el.btnPlay.textContent = '播放';
  }

  function togglePlay() { playing ? pause() : play(); }

  /* ---------------------------------------------------------- 编码 */

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error('canvas.toBlob 返回空'));
      }, 'image/png');
    });
  }

  /**
   * 按给定分辨率编码一次，返回 { bytes, bitDepth, colorType }。
   * 首帧整幅（写 IDAT），后续帧与前一帧做帧差、只编码变化区域（写 fdAT）。
   */
  async function encodeAt(W, H, onProgress) {
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var sub = document.createElement('canvas');
    var subctx = sub.getContext('2d', { willReadFrequently: true });

    var images = state.items.map(function (it) { return it.img; });
    var bg = bgColorValue();

    var frames = [];        // { idat, x, y, w, h, delayMs }
    var prev = null;
    var useRaw = state.forceRaw;
    var refBitDepth = 0, refColorType = -1;
    var pushed = 0;

    for (var i = 0; i < specs.length; i++) {
      var sp = specs[i];
      R.drawScene(ctx, W, H, sp, images, bg);
      var imgData = ctx.getImageData(0, 0, W, H);

      var rect = prev ? R.diffBounds(prev.data, imgData.data, W, H)
                      : { x: 0, y: 0, w: W, h: H };

      if (!rect) {
        // 与上一帧完全相同：把延时并入上一帧，不新增帧
        if (frames.length) frames[frames.length - 1].delayMs += sp.delay;
        continue;
      }

      var info = null;

      if (useRaw) {
        info = await APNG.encodePNGFromImageData(imgData);
        if (!info) throw new Error('浏览器不支持 CompressionStream，请改用 Chrome / Edge');
        rect = { x: 0, y: 0, w: W, h: H };
      } else {
        var src;
        if (rect.x === 0 && rect.y === 0 && rect.w === W && rect.h === H) {
          src = canvas;
        } else {
          sub.width = rect.w; sub.height = rect.h;
          subctx.clearRect(0, 0, rect.w, rect.h);
          subctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
          src = sub;
        }
        try {
          var blob = await toBlob(src);
          info = APNG.parsePNG(await blob.arrayBuffer());
        } catch (err) {
          // canvas PNG 解析失败：整体退化为自实现 PNG 编码
          console.warn('canvas PNG 解析失败，退化为自实现编码：', err);
          state.forceRaw = true;
          useRaw = true;
          info = await APNG.encodePNGFromImageData(imgData);
          if (!info) throw err;
          rect = { x: 0, y: 0, w: W, h: H };
        }
      }

      // 校验所有帧的位深 / 颜色类型一致，否则 APNG 结构非法
      if (frames.length === 0) {
        refBitDepth = info.bitDepth;
        refColorType = info.colorType;
      } else if (info.bitDepth !== refBitDepth || info.colorType !== refColorType) {
        var e = new Error('PNG_COLOR_MISMATCH');
        e.code = 'PNG_COLOR_MISMATCH';
        throw e;
      }

      frames.push({
        idat: APNG.concatBytes(info.idatParts),
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        delayMs: sp.delay
      });
      prev = imgData;
      pushed++;
      if (onProgress) onProgress(i + 1, specs.length, W, H);
    }

    var list = frames.map(function (f) {
      return {
        idat: f.idat,
        x: f.x, y: f.y, w: f.w, h: f.h,
        delayNum: Math.max(1, Math.min(65535, Math.round(f.delayMs))) || 1,
        delayDen: DELAY_DEN,
        disposeOp: 0,   // APNG_DISPOSE_OP_NONE：保留上一帧，供窄带增量叠加
        blendOp: 0      // APNG_BLEND_OP_SOURCE：整块覆盖（帧差区域必须覆盖而非混合）
      };
    });

    var bytes = APNG.assembleAPNG({
      width: W, height: H,
      bitDepth: refBitDepth, colorType: refColorType,
      frames: list, numPlays: 0
    });

    return { bytes: bytes, frameCount: list.length, bitDepth: refBitDepth, colorType: refColorType };
  }

  /** 计算降分辨率档位对应的画布尺寸（保持首图比例，最长边取档位值） */
  function sizeForStep(step) {
    var longest = Math.max(state.baseW, state.baseH);
    var s = Math.min(1, step / longest);
    return {
      W: Math.max(2, Math.round(state.baseW * s)),
      H: Math.max(2, Math.round(state.baseH * s))
    };
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  async function exportAPNG() {
    if (busy) return;
    if (state.items.length < 2) {
      setStatus('至少需要 2 张图片才能生成动图', 'warn');
      return;
    }

    busy = true;
    el.btnExport.disabled = true;

    try {
      buildTimeline();
      updateMeta();

      var target = state.unlimited ? Infinity : state.targetBytes;
      var last = null;

      // 第一轮用基准分辨率；超限则按 RES_STEPS 逐档降分辨率重编
      var first = { W: state.baseW, H: state.baseH, label: '基准' };
      var tries = [first];
      for (var i = 0; i < RES_STEPS.length; i++) {
        var sz = sizeForStep(RES_STEPS[i]);
        if (sz.W * sz.H >= state.baseW * state.baseH) continue; // 不比基准更小就跳过
        var dup = tries.some(function (t) { return t.W === sz.W && t.H === sz.H; });
        if (!dup) tries.push({ W: sz.W, H: sz.H, label: RES_STEPS[i] + 'px' });
      }

      for (var ti = 0; ti < tries.length; ti++) {
        var tr = tries[ti];
        setStatus('正在编码 ' + tr.W + '×' + tr.H + '（第 ' + (ti + 1) + ' 次）…');
        var res;
        try {
          res = await encodeAt(tr.W, tr.H, function (done, all, W, H) {
            if (done % 8 === 0 || done === all) {
              setStatus('正在编码 ' + W + '×' + H + '：' + done + ' / ' + all + ' 帧…');
            }
          });
        } catch (err) {
          if (err && err.code === 'PNG_COLOR_MISMATCH' && !state.forceRaw) {
            // 特殊浏览器下 canvas PNG 颜色类型不一致：整体切换为自实现编码后重试
            state.forceRaw = true;
            ti--;
            continue;
          }
          throw err;
        }
        last = { res: res, W: tr.W, H: tr.H };
        if (!(res.bytes.length > target)) break; // 未超限，停止降级
      }

      var blob = new Blob([last.res.bytes], { type: 'image/apng' });
      var name = 'apng-' + stamp() + '.apng';
      download(blob, name);

      var over = last.res.bytes.length > target;
      var msg = '已导出 ' + last.W + '×' + last.H + '，' + fmtSize(last.res.bytes.length) +
        '，共 ' + last.res.frameCount + ' 帧';
      if (over) {
        msg += '。体积仍超过目标 ' + fmtSize(state.targetBytes) +
          '，已降至最小档 ' + last.W + '×' + last.H;
        setStatus(msg, 'warn');
      } else if (tries[0].W !== last.W || tries[0].H !== last.H) {
        msg += '。为压进目标体积，已从 ' + state.baseW + '×' + state.baseH +
          ' 降分辨率到 ' + last.W + '×' + last.H;
        setStatus(msg, 'ok');
      } else {
        setStatus(msg, 'ok');
      }
    } catch (err) {
      console.error(err);
      setStatus('编码失败：' + (err && err.message ? err.message : err), 'error');
    } finally {
      busy = false;
      el.btnExport.disabled = false;
    }
  }

  /* ---------------------------------------------------------- 控件绑定 */

  function linkNumber(range, num, apply) {
    function sync(v) {
      var lo = Number(num.min || 0), hi = Number(num.max || 100000);
      v = Math.max(lo, Math.min(hi, Math.round(v)));
      if (!isFinite(v)) v = lo;
      num.value = String(v);
      range.value = String(Math.max(Number(range.min), Math.min(Number(range.max), v)));
      apply(v);
    }
    range.addEventListener('input', function () { sync(Number(range.value)); });
    num.addEventListener('change', function () { sync(Number(num.value)); });
  }

  function bindEvents() {
    el.btnAdd.addEventListener('click', function () { el.fileInput.click(); });

    el.fileInput.addEventListener('change', function () {
      addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });

    el.btnClear.addEventListener('click', function () {
      state.items.forEach(function (it) { if (it.url) URL.revokeObjectURL(it.url); });
      state.items = [];
      renderList();
      onItemsChanged();
      setStatus('已清空列表');
    });

    // ---- 列表：移除 / 拖拽排序 ----
    var dragFrom = -1;

    el.list.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.del') : null;
      if (!btn) return;
      var li = btn.closest('.thumb');
      if (!li) return;
      removeItem(Number(li.dataset.index));
    });

    el.list.addEventListener('dragstart', function (e) {
      var li = e.target.closest ? e.target.closest('.thumb') : null;
      if (!li) return;
      dragFrom = Number(li.dataset.index);
      li.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(dragFrom));
      } catch (err) { /* ignore */ }
    });

    el.list.addEventListener('dragend', function () {
      dragFrom = -1;
      Array.prototype.forEach.call(el.list.querySelectorAll('.thumb'), function (n) {
        n.classList.remove('dragging', 'over');
      });
    });

    el.list.addEventListener('dragover', function (e) {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var li = e.target.closest ? e.target.closest('.thumb') : null;
      Array.prototype.forEach.call(el.list.querySelectorAll('.thumb'), function (n) {
        n.classList.remove('over');
      });
      if (li) li.classList.add('over');
    });

    el.list.addEventListener('drop', function (e) {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      var li = e.target.closest ? e.target.closest('.thumb') : null;
      if (!li) return;
      var to = Number(li.dataset.index);
      var from = dragFrom;
      dragFrom = -1;
      if (to === from) return;
      var moved = state.items.splice(from, 1)[0];
      state.items.splice(to, 0, moved);
      renderList();
      onItemsChanged();
    });

    // ---- 从文件管理器拖入图片 ----
    var panel = el.listPanel;
    ['dragenter', 'dragover'].forEach(function (ev) {
      panel.addEventListener(ev, function (e) {
        if (dragFrom >= 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        panel.classList.add('dropping');
      });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      panel.addEventListener(ev, function () { panel.classList.remove('dropping'); });
    });
    panel.addEventListener('drop', function (e) {
      if (dragFrom >= 0) return;
      e.preventDefault();
      panel.classList.remove('dropping');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });

    // 阻止浏览器直接打开被拖入的文件
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    // ---- Ctrl+V 粘贴 ----
    window.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f && isImageFile(f)) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    // ---- 播放 ----
    el.btnPlay.addEventListener('click', togglePlay);

    // ---- 模式 ----
    Array.prototype.forEach.call(document.querySelectorAll('#mode-seg .seg-btn'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('#mode-seg .seg-btn'), function (b) {
          b.classList.toggle('is-on', b === btn);
        });
        state.mode = btn.dataset.mode;
        buildTimeline();
        curT = 0;
        drawAt(curT);
        updateMeta();
      });
    });

    // ---- 数值参数 ----
    linkNumber(el.rangeTransition, el.numTransition, function (v) {
      state.transitionMs = v; buildTimeline(); curT = 0; drawAt(curT); updateMeta();
    });
    linkNumber(el.rangeHold, el.numHold, function (v) {
      state.holdMs = v; buildTimeline(); curT = 0; drawAt(curT); updateMeta();
    });

    // ---- 背景色 ----
    el.selBg.addEventListener('change', function () {
      state.bg = el.selBg.value;
      drawAt(curT);
    });

    // ---- 目标体积 ----
    function applyTarget() {
      state.unlimited = el.chkUnlimited.checked;
      el.numTarget.disabled = state.unlimited;
      var mb = Number(el.numTarget.value);
      if (!isFinite(mb) || mb <= 0) mb = 1.0;
      state.targetBytes = Math.round(mb * 1048576);
    }
    el.numTarget.addEventListener('change', applyTarget);
    el.chkUnlimited.addEventListener('change', applyTarget);

    // ---- 导出 ----
    el.btnExport.addEventListener('click', exportAPNG);

    // 快捷键：空格播放/暂停
    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''))) {
        e.preventDefault();
        togglePlay();
      }
    });
  }

  /* ---------------------------------------------------------- 初始化 */

  function init() {
    el = {
      fileInput: $('file-input'),
      btnAdd: $('btn-add'),
      btnClear: $('btn-clear'),
      list: $('thumb-list'),
      listPanel: $('list-panel'),
      emptyHint: $('empty-hint'),
      count: $('count'),
      preview: $('preview'),
      btnPlay: $('btn-play'),
      timeInfo: $('time-info'),
      canvasMeta: $('canvas-meta'),
      rangeTransition: $('range-transition'),
      numTransition: $('num-transition'),
      rangeHold: $('range-hold'),
      numHold: $('num-hold'),
      selBg: $('sel-bg'),
      numTarget: $('num-target'),
      chkUnlimited: $('chk-unlimited'),
      btnExport: $('btn-export'),
      status: $('status')
    };

    preview = el.preview;
    pctx = preview.getContext('2d', { willReadFrequently: true });

    bindEvents();
    renderList();
    onItemsChanged();

    playing = false;
    el.btnPlay.textContent = '播放';

    setStatus('就绪：添加 2 张以上图片后即可导出');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
