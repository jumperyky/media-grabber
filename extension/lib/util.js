// 共通ユーティリティ。chrome API に依存しない（Node からテスト可能）。

/** URL を絶対化する。失敗したら元の文字列を返す。 */
export function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/** ファイル名に使えない文字を除去し、長さを制限する。 */
export function sanitizeFilename(name, maxLen = 120) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  const safe = cleaned || 'video';
  return safe.length > maxLen ? safe.slice(0, maxLen).trim() : safe;
}

/** ページタイトルと URL から保存ファイル名を決める。 */
export function suggestFilename({ title, url, ext }) {
  let base = sanitizeFilename(title);
  if (!base || base === 'video') {
    try {
      const path = new URL(url).pathname;
      const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
      const stripped = last.replace(/\.[a-z0-9]{1,5}$/i, '');
      if (stripped) base = sanitizeFilename(stripped);
    } catch { /* URL が壊れている場合は base のまま */ }
  }
  return `${base}.${ext.replace(/^\./, '')}`;
}

/** 先頭バイト列からコンテナ形式を推定する。 */
export function sniffContainer(bytes) {
  if (!bytes || bytes.length < 8) return 'unknown';
  // ISO BMFF: 4バイトのサイズに続いて 'ftyp' / 'styp' / 'moof'
  const tag = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (tag === 'ftyp' || tag === 'styp' || tag === 'moof' || tag === 'sidx') return 'mp4';
  // MPEG-TS: 0x47 の同期バイトが 188 バイト間隔で並ぶ
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'ts';
  // WebM / Matroska: EBML ヘッダ
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return 'unknown';
}

/** コンテナ形式に対応する拡張子。 */
export function containerToExt(container) {
  switch (container) {
    case 'mp4': return 'mp4';
    case 'ts': return 'ts';
    case 'webm': return 'webm';
    default: return 'bin';
  }
}

/** バイト数を人間可読な文字列にする。 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 秒数を mm:ss / h:mm:ss にする。 */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** URL と Content-Type からメディア種別を判定する。対象外なら null。 */
export function classifyMedia(url, contentType = '') {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch { /* 相対 URL 等はそのまま拡張子判定に回す */ }
  const ct = String(contentType).toLowerCase().split(';')[0].trim();
  const ext = (pathname.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase();

  if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' ||
      ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl' || ext === 'm3u8' || ext === 'm3u') {
    return 'hls';
  }
  if (ct === 'application/dash+xml' || ext === 'mpd') return 'dash';

  // 個々のセグメントは一覧に出さない（プレイリスト側で扱う）
  if (ext === 'ts' || ext === 'm4s' || ext === 'aac' || ext === 'vtt') return null;

  const directExts = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ogv', 'm4a', 'mp3', 'ogg', 'wav', 'flac'];
  if (directExts.includes(ext)) return 'direct';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'direct';
  return null;
}

/** ビットレート(bps)と長さ(秒)からおおよそのファイルサイズ(バイト)を求める。 */
export function estimateBytes(bandwidth, durationSec) {
  if (!Number.isFinite(bandwidth) || !Number.isFinite(durationSec)) return 0;
  if (bandwidth <= 0 || durationSec <= 0) return 0;
  return Math.round((bandwidth / 8) * durationSec);
}

/** 映像と音声を結合するための ffmpeg コマンド文字列。 */
export function mergeCommand(videoFile, audioFile, outFile) {
  const q = (s) => `"${s}"`;
  return `ffmpeg -i ${q(videoFile)} -i ${q(audioFile)} -c copy ${q(outFile)}`;
}
