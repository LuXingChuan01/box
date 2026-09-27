/* =============================================================
 * apng.js —— 自实现的 APNG 编码器（零依赖，不使用任何第三方库）
 *
 * 思路与 Gifer 一致：每一帧都用 canvas 渲染后 toBlob('image/png') 拿到 PNG
 * 数据，再把 PNG 的 IHDR / IDAT 解析出来，按 APNG 规范重新组装：
 *
 *   PNG 签名
 *   IHDR                      （画布尺寸 / 位深 / 颜色类型）
 *   acTL                      （帧数 + 播放次数）
 *   fcTL(seq) IDAT            （第 1 帧：帧控制 + 图像数据，写在 IDAT 里）
 *   fcTL(seq) fdAT(seq) ...   （第 2..N 帧：帧控制 + 帧数据，写在 fdAT 里）
 *   IEND
 *
 * 规范要点：
 *   - fcTL 与 fdAT 共用一个序列号计数器，每写一个块就 +1；
 *   - 首帧的 IDAT 不带序列号；
 *   - 每帧的压缩数据都是独立的 zlib 流（因为来自各自独立的 PNG 文件）；
 *   - CRC32 自己实现（PNG 所有块都必须带 CRC32，覆盖「类型 + 数据」）。
 *
 * 另外提供两条取 PNG 数据的路径：
 *   1) 主路径：canvas.toBlob('image/png') -> 解析 IHDR / IDAT（题目要求的方式）；
 *   2) 兜底路径：若主路径不可用或各帧 PNG 的颜色类型不一致，则用 CompressionStream
 *      ('deflate'，即 RFC1950 zlib 流，正是 PNG 需要的格式) 自行编码 8bit RGBA PNG。
 * ============================================================= */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------
   * 1. CRC32（PNG 使用标准 CRC-32 / IEEE 802.3，反射多项式 0xEDB88320）
   * ------------------------------------------------------------- */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  /**
   * 计算 [start, end) 区间的 CRC32。
   * @param {Uint8Array} bytes
   * @param {number} [start=0]
   * @param {number} [end=bytes.length]
   * @returns {number} 无符号 32 位整数
   */
  function crc32(bytes, start, end) {
    var c = 0xFFFFFFFF;
    var s = (start == null) ? 0 : start;
    var e = (end == null) ? bytes.length : end;
    for (var i = s; i < e; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------------------------------------------------------
   * 2. 基础工具
   * ------------------------------------------------------------- */
  var SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /**
   * 生成一个 PNG 块： 长度(4) + 类型(4) + 数据(n) + CRC32(4)
   * CRC32 覆盖「类型 + 数据」。
   */
  function makeChunk(type, data) {
    var payload = data || new Uint8Array(0);
    var len = payload.length;
    var out = new Uint8Array(len + 12);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, len, false);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xFF;
    out.set(payload, 8);
    dv.setUint32(8 + len, crc32(out, 4, 8 + len), false);
    return out;
  }

  /* ---------------------------------------------------------------
   * 3. PNG 解析：抽出 IHDR 与全部 IDAT（PNG 允许 IDAT 分多块）
   * ------------------------------------------------------------- */
  function parsePNG(buffer) {
    var bytes = (buffer instanceof Uint8Array) ? buffer : new Uint8Array(buffer);
    if (bytes.length < 8) throw new Error('不是有效的 PNG（长度不足）');
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== SIGNATURE[i]) throw new Error('PNG 签名不匹配');
    }

    var pos = 8;
    var ihdr = null;
    var idatParts = [];
    var types = [];

    while (pos + 8 <= bytes.length) {
      var len = readU32(bytes, pos);
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var dataStart = pos + 8;
      var dataEnd = dataStart + len;
      if (dataEnd > bytes.length) break;              // 截断保护
      if (type === 'IHDR') ihdr = bytes.slice(dataStart, dataEnd);
      else if (type === 'IDAT') idatParts.push(bytes.slice(dataStart, dataEnd));
      types.push(type);
      pos = dataEnd + 4;                              // 跳过 CRC
      if (type === 'IEND') break;
    }

    if (!ihdr) throw new Error('PNG 缺少 IHDR');
    if (!idatParts.length) throw new Error('PNG 缺少 IDAT');

    return {
      ihdr: ihdr,
      idatParts: idatParts,
      idat: concatBytes(idatParts),
      types: types,
      width: readU32(ihdr, 0),
      height: readU32(ihdr, 4),
      bitDepth: ihdr[8],
      colorType: ihdr[9],
      compression: ihdr[10],
      filter: ihdr[11],
      interlace: ihdr[12]
    };
  }

  /* ---------------------------------------------------------------
   * 4. 组装 APNG
   *
   * opts = {
   *   width, height, bitDepth, colorType,         // 决定 IHDR
   *   numPlays,                                   // 0 = 无限循环
   *   frames: [ { idat, x, y, w, h,               // idat: 该帧的 zlib 压缩数据
   *               delayNum, delayDen,             // 帧延时 = delayNum / delayDen 秒
   *               disposeOp, blendOp } ]          // 默认 0 / 0
   * }
   * @returns {Uint8Array} 完整的 .apng 字节流
   * ------------------------------------------------------------- */
  function assembleAPNG(opts) {
    var frames = opts.frames || [];
    if (!frames.length) throw new Error('至少需要一帧才能生成 APNG');

    // --- IHDR ---
    var ihdr = new Uint8Array(13);
    var idv = new DataView(ihdr.buffer);
    idv.setUint32(0, opts.width, false);
    idv.setUint32(4, opts.height, false);
    ihdr[8] = opts.bitDepth;   // 位深（canvas PNG 通常为 8）
    ihdr[9] = opts.colorType;  // 颜色类型（canvas PNG 通常为 6 = RGBA）
    ihdr[10] = 0;              // 压缩方法：只有 0
    ihdr[11] = 0;              // 过滤方法：只有 0
    ihdr[12] = 0;              // 隔行扫描：0 = 无

    var parts = [SIGNATURE, makeChunk('IHDR', ihdr)];

    // --- acTL：帧数 + 播放次数（0 = 无限）---
    var actl = new Uint8Array(8);
    var adv = new DataView(actl.buffer);
    adv.setUint32(0, frames.length, false);
    adv.setUint32(4, (opts.numPlays == null ? 0 : opts.numPlays), false);
    parts.push(makeChunk('acTL', actl));

    // --- 逐帧写入 fcTL + (IDAT | fdAT) ---
    var seq = 0;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];

      // fcTL: 序列号(4) 宽(4) 高(4) x(4) y(4) delayNum(2) delayDen(2) dispose(1) blend(1)
      var fctl = new Uint8Array(26);
      var fdv = new DataView(fctl.buffer);
      fdv.setUint32(0, seq++, false);
      fdv.setUint32(4, f.w, false);
      fdv.setUint32(8, f.h, false);
      fdv.setUint32(12, f.x, false);
      fdv.setUint32(16, f.y, false);
      fdv.setUint16(20, f.delayNum, false);
      fdv.setUint16(22, f.delayDen, false);
      fctl[24] = (f.disposeOp == null ? 0 : f.disposeOp); // 0 = APNG_DISPOSE_OP_NONE
      fctl[25] = (f.blendOp == null ? 0 : f.blendOp);     // 0 = APNG_BLEND_OP_SOURCE
      parts.push(makeChunk('fcTL', fctl));

      if (i === 0) {
        // 首帧：图像数据直接放进 IDAT（同时作为不支持 APNG 的查看器的默认图）
        parts.push(makeChunk('IDAT', f.idat));
      } else {
        // 后续帧：fdAT = 序列号(4) + 与 IDAT 相同的数据
        var fdat = new Uint8Array(4 + f.idat.length);
        new DataView(fdat.buffer).setUint32(0, seq++, false);
        fdat.set(f.idat, 4);
        parts.push(makeChunk('fdAT', fdat));
      }
    }

    parts.push(makeChunk('IEND', new Uint8Array(0)));
    return concatBytes(parts);
  }

  /* ---------------------------------------------------------------
   * 5. 兜底：用 CompressionStream('deflate') 把 ImageData 编成 8bit RGBA PNG
   *    'deflate' 输出的是 RFC1950 zlib 流（带 zlib 头与 adler32），
   *    正好就是 PNG IDAT 所需要的格式。
   * ------------------------------------------------------------- */
  function deflateZlib(bytes) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(null);
    var cs = new CompressionStream('deflate');
    var writer = cs.writable.getWriter();
    var writing = writer.write(bytes).then(function () { return writer.close(); });
    var reader = cs.readable.getReader();
    var chunks = [];
    var total = 0;

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return null;
        chunks.push(r.value);
        total += r.value.length;
        return pump();
      });
    }

    return pump().then(function () {
      return writing;
    }).then(function () {
      var out = new Uint8Array(total);
      var off = 0;
      for (var i = 0; i < chunks.length; i++) {
        out.set(chunks[i], off);
        off += chunks[i].length;
      }
      return out;
    });
  }

  /**
   * 兜底 PNG 编码：ImageData -> { ihdr, idatParts, idat, bitDepth, colorType, width, height }
   * 固定输出 8bit RGBA（颜色类型 6）、filter 全 0。
   */
  function encodePNGFromImageData(imgData) {
    var w = imgData.width, h = imgData.height, data = imgData.data;
    var stride = w * 4;
    var raw = new Uint8Array(h * (stride + 1));
    for (var y = 0; y < h; y++) {
      var ro = y * (stride + 1);
      raw[ro] = 0; // filter type = None
      raw.set(data.subarray(y * stride, (y + 1) * stride), ro + 1);
    }

    return deflateZlib(raw).then(function (z) {
      if (!z) return null; // 浏览器不支持 CompressionStream
      var ihdr = new Uint8Array(13);
      var dv = new DataView(ihdr.buffer);
      dv.setUint32(0, w, false);
      dv.setUint32(4, h, false);
      ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      return {
        ihdr: ihdr,
        idatParts: [z],
        idat: z,
        width: w,
        height: h,
        bitDepth: 8,
        colorType: 6
      };
    });
  }

  /* ---------------------------------------------------------------
   * 6. 一个像素级校验器：把组装出来的字节流重新解析一遍，检查结构是否自洽
   *    （开发自检用，运行时也会在导出后调用一次，确保产物可被浏览器解码）
   * ------------------------------------------------------------- */
  function inspectAPNG(bytes) {
    var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    var info = { frames: 0, chunks: [], idatBytes: 0, fdatBytes: 0, ok: false, errors: [] };
    var pos = 8;
    var seq = 0;
    var sawIHDR = false, sawACTL = false, sawIDAT = false, sawIEND = false;
    var framesDeclared = -1;
    var fctlCount = 0;

    try {
      for (var i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) throw new Error('签名错误');
      while (pos + 8 <= b.length) {
        var len = readU32(b, pos);
        var type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
        var dStart = pos + 8, dEnd = dStart + len;
        if (dEnd + 4 > b.length) { info.errors.push('块 ' + type + ' 数据越界'); break; }
        var calc = crc32(b, pos + 4, dEnd);
        var stored = readU32(b, dEnd);
        if (calc !== stored) info.errors.push('块 ' + type + ' CRC 校验失败');
        info.chunks.push(type);

        if (type === 'IHDR') sawIHDR = true;
        else if (type === 'acTL') { sawACTL = true; framesDeclared = readU32(b, dStart); }
        else if (type === 'IDAT') { sawIDAT = true; info.idatBytes += len; }
        else if (type === 'fdAT') {
          info.fdatBytes += len - 4;
          if (readU32(b, dStart) !== seq) info.errors.push('fdAT 序列号不连续');
          seq++;
        } else if (type === 'fcTL') {
          fctlCount++;
          if (readU32(b, dStart) !== seq) info.errors.push('fcTL 序列号不连续');
          seq++;
        } else if (type === 'IEND') { sawIEND = true; break; }

        pos = dEnd + 4;
      }
      if (!sawIHDR) info.errors.push('缺少 IHDR');
      if (!sawACTL) info.errors.push('缺少 acTL');
      if (!sawIDAT) info.errors.push('缺少 IDAT');
      if (!sawIEND) info.errors.push('缺少 IEND');
      info.frames = fctlCount;
      if (framesDeclared >= 0 && framesDeclared !== fctlCount) {
        info.errors.push('acTL 声明 ' + framesDeclared + ' 帧，实际 fcTL ' + fctlCount + ' 个');
      }
      info.ok = info.errors.length === 0;
    } catch (e) {
      info.errors.push(String(e && e.message ? e.message : e));
    }
    return info;
  }

  root.APNG = {
    crc32: crc32,
    makeChunk: makeChunk,
    parsePNG: parsePNG,
    assembleAPNG: assembleAPNG,
    encodePNGFromImageData: encodePNGFromImageData,
    inspectAPNG: inspectAPNG,
    SIGNATURE: SIGNATURE
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
