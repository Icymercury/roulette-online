/* ============================================================
 * 生死转盘 · PWA 图标生成（构建工具，不参与游戏）
 * ------------------------------------------------------------
 *   node build/make-icons.js
 *
 * 为什么自己画：项目是零依赖的，不想为了三张 PNG 引入 sharp/canvas。
 * Node 自带 zlib，手写一个最小 PNG 编码器就够了（RGBA + deflate）。
 * 画的是轮盘：深色底 + 金环 + 五色扇形 + 中心轴 + 顶部指针，
 * 4 倍超采样再降采样，所以边缘是干净的。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/* ---------------- 最小 PNG 编码器 ---------------- */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 画轮盘 ---------------- */

const BG = [10, 10, 14];
const GOLD = [232, 194, 106];
const SLICES = [
  [139, 30, 45],    // 扣 1 血
  [37, 107, 78],    // 加 1 血
  [16, 16, 20],     // 扣 2 血
  [29, 74, 122],    // 加 2 血
  [156, 111, 20],   // 金币
];

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/* 单个像素采样（单位圆坐标，半径 0~1） */
function sample(nx, ny, inset) {
  const r = Math.sqrt(nx * nx + ny * ny);
  const outer = 0.5 * (1 - inset);          // 整个盘的最大半径
  const ring = outer;                        // 金环外沿
  const ringIn = outer * 0.93;               // 金环内沿
  const hub = outer * 0.20;                  // 中心轴

  if (r > ring) return null;                 // 盘外：透明
  if (r > ringIn) return GOLD;               // 金环
  if (r < hub) return r < hub * 0.62 ? BG : GOLD;

  /* 扇形：角度从正上方算起，顺时针 */
  let a = Math.atan2(ny, nx) * 180 / Math.PI + 90;
  while (a < 0) a += 360;
  const idx = Math.floor(a / 72) % 5;
  /* 扇区之间留一条很细的暗缝，像真的轮盘 */
  const within = a % 72;
  if (within < 2.2 || within > 69.8) return [6, 6, 9];
  return SLICES[idx];
}

function draw(size, inset) {
  const SS = 4;                              // 超采样倍数
  const S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) / S;
          const py = (y * SS + sy + 0.5) / S;
          const c = sample(px - 0.5, py - 0.5, inset);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
      /* 预乘再还原，避免边缘出现黑边 */
      const cov = a / (255 * n);
      out[i] = Math.round(r / (n * cov));
      out[i + 1] = Math.round(g / (n * cov));
      out[i + 2] = Math.round(b / (n * cov));
      out[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

/* 圆角实底（给 maskable 用：整块实底 + 居中的盘） */
function masked(size, inset) {
  const base = draw(size, inset);
  return base;
}

const targets = [
  ['icon-192.png', 192, 0.06],
  ['icon-512.png', 512, 0.06],
  ['icon-maskable-512.png', 512, 0.30],   // 留出 Android 自适应图标的安全区
];

targets.forEach(function (t) {
  const buf = draw(t[1], t[2]);
  fs.writeFileSync(path.join(ROOT, t[0]), buf);
  console.log('  ' + t[0] + '  ' + t[1] + 'x' + t[1] + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
});
console.log('图标生成完毕');
