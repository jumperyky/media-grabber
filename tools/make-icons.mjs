// 拡張機能のアイコン PNG を生成する（外部依存なし）。
// 使い方: node tools/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA のピクセル配列を PNG バイト列にする。 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // フィルタタイプ: None
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // ビット深度
  ihdr[9] = 6;  // カラータイプ: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 角丸四角の内側かどうか。 */
function insideRoundedRect(x, y, size, radius) {
  const min = radius;
  const max = size - radius;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 下向き矢印（縦棒 + 三角）の内側かどうか。座標は 0..1 に正規化。 */
function insideArrow(u, v) {
  // 縦棒
  if (u >= 0.42 && u <= 0.58 && v >= 0.20 && v <= 0.58) return true;
  // 三角のヘッド
  if (v >= 0.55 && v <= 0.80) {
    const t = (v - 0.55) / 0.25;
    const half = 0.30 * (1 - t);
    if (Math.abs(u - 0.5) <= half) return true;
  }
  return false;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size * 0.22));
  // 背景色（青）と前景色（白）
  const bg = [37, 99, 235];
  const fg = [255, 255, 255];

  // アンチエイリアスのために 3x3 でスーパーサンプリングする
  const S = 3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (!insideRoundedRect(px, py, size, radius)) continue;
          bgHits += 1;
          if (insideArrow(px / size, py / size)) fgHits += 1;
        }
      }
      const total = S * S;
      const alpha = Math.round((bgHits / total) * 255);
      const mix = bgHits > 0 ? fgHits / bgHits : 0;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(bg[0] * (1 - mix) + fg[0] * mix);
      rgba[i + 1] = Math.round(bg[1] * (1 - mix) + fg[1] * mix);
      rgba[i + 2] = Math.round(bg[2] * (1 - mix) + fg[2] * mix);
      rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, drawIcon(size));
  console.log('生成: ' + file);
}
