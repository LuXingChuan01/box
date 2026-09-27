/* =============================================================
 * render.js —— 帧几何 + 画面合成（纯计算为主，只有 draw* 会碰 canvas）
 *
 * 职责：
 *   - drawContain / drawScene：把「场景」画到 canvas 上（预览与导出共用同一套逻辑，
 *     保证「所见即所得」）；
 *   - buildSpecs：把参数（模式 / 过渡时长 / 停留时长）展开成一条帧时间线；
 *   - sceneAtSpecs：按时间查当前应该显示的场景（供预览播放器使用）；
 *   - diffBounds：比较两帧像素，求出变化区域的最小外接矩形，用于帧差编码
 *     （扫描线擦除模式下每帧只有一条窄带变化，只编码这条窄带即可大幅减小体积）。
 * ============================================================= */
(function (root) {
  'use strict';

  /**
   * 把图片按 contain 方式缩放并居中绘制（不裁切，比例不一致处留边）。
   */
  function drawContain(ctx, img, W, H) {
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var scale = Math.min(W / iw, H / ih);
    var dw = iw * scale;
    var dh = ih * scale;
    var dx = (W - dw) / 2;
    var dy = (H - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  /**
   * 绘制一个「场景」。
   * scene = { a: 当前图下标, b: 下一张图下标 | null, progress: 0..1 }
   *   - b 为 null：只画 a（停留阶段 / 逐帧模式）
   *   - progress：扫描线从左往右扫过的比例，[0, progress*W) 区域显示 b，其余显示 a
   */
  function drawScene(ctx, W, H, scene, images, bgColor) {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    var a = images[scene.a];
    if (a) drawContain(ctx, a, W, H);

    if (scene.b != null && scene.progress > 0) {
      var b = images[scene.b];
      if (b) {
        var x = Math.round(scene.progress * W); // 扫描线位置（整数像素，便于帧差对齐）
        if (x > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, x, H);
          ctx.clip();
          drawContain(ctx, b, W, H);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  /**
   * 比较两帧 RGBA 像素，返回变化区域的最小外接矩形（含边界）。
   * @returns {{x:number,y:number,w:number,h:number}|null} 完全相同则返回 null
   */
  function diffBounds(prev, cur, w, h) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    var stride = w * 4;

    for (var y = 0; y < h; y++) {
      var row = y * stride;
      // 先快速跳过整行相同的部分
      var rowChanged = false;
      var rowMin = w, rowMax = -1;
      for (var x = 0; x < w; x++) {
        var o = row + x * 4;
        if (prev[o] !== cur[o] || prev[o + 1] !== cur[o + 1] ||
            prev[o + 2] !== cur[o + 2] || prev[o + 3] !== cur[o + 3]) {
          if (x < rowMin) rowMin = x;
          if (x > rowMax) rowMax = x;
          rowChanged = true;
        }
      }
      if (rowChanged) {
        if (rowMin < minX) minX = rowMin;
        if (rowMax > maxX) maxX = rowMax;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /**
   * 生成帧时间线。
   *
   * mode = 'scan'   扫描线擦除：每张图先用一条竖直扫描线从左到右扫到下一张，
   *                 扫完后停留 holdMs；「停留」被合并进「扫到终点那一帧」的延时里，
   *                 所以停留时长不会额外增加帧数。
   * mode = 'frames' 普通逐帧：每张图按 holdMs 直接切换。
   *
   * @returns {Array<{a:number,b:(number|null),progress:number,delay:number}>}
   */
  function buildSpecs(N, mode, transitionMs, holdMs, frameInterval) {
    var specs = [];
    if (!N) return specs;

    var interval = Math.max(10, frameInterval || 40);
    var hold = Math.max(0, holdMs || 0);

    if (mode === 'scan') {
      // 扫描步数 K：过渡时长 / 单步间隔；至少 1 步
      var K = Math.max(1, Math.round((transitionMs || 0) / interval));
      var stepMs = Math.max(10, Math.round((transitionMs || 0) / K));

      // 第 0 帧：首图整幅（后面所有帧都以它为基准做帧差）
      specs.push({ a: 0, b: null, progress: 0, delay: stepMs });

      for (var i = 0; i < N; i++) {
        for (var k = 1; k <= K; k++) {
          var delay = stepMs;
          if (k === K) delay = stepMs + Math.round(hold); // 停留并入「扫到终点」这一帧
          specs.push({
            a: i,
            b: (i + 1) % N,
            progress: k / K,
            delay: delay
          });
        }
      }
    } else {
      // 逐帧模式：没有过渡，每张图停留 holdMs
      var per = Math.max(20, Math.round(hold || interval));
      for (var j = 0; j < N; j++) {
        specs.push({ a: j, b: null, progress: 0, delay: per });
      }
    }

    return specs;
  }

  /** 整条时间线的总时长（毫秒） */
  function totalOf(specs) {
    var t = 0;
    for (var i = 0; i < specs.length; i++) t += specs[i].delay;
    return t;
  }

  /** 按播放时间 t（毫秒）取当前场景，循环播放 */
  function sceneAtSpecs(t, specs, total) {
    if (!specs.length) return null;
    if (!total || total <= 0) return specs[0];
    var tt = ((t % total) + total) % total;
    var acc = 0;
    for (var i = 0; i < specs.length; i++) {
      acc += specs[i].delay;
      if (tt < acc) return specs[i];
    }
    return specs[specs.length - 1];
  }

  root.RENDER = {
    drawContain: drawContain,
    drawScene: drawScene,
    diffBounds: diffBounds,
    buildSpecs: buildSpecs,
    totalOf: totalOf,
    sceneAtSpecs: sceneAtSpecs
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
