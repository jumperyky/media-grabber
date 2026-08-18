// HLS (M3U8) プレイリストのパーサ。chrome API に依存しない。
import { resolveUrl } from './util.js';

/** `KEY=VALUE,KEY="V,A"` 形式の属性行を解析する。 */
export function parseAttributes(line) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** RESOLUTION=1920x1080 を {width,height} に。 */
function parseResolution(s) {
  const m = /^(\d+)x(\d+)$/.exec(String(s || '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * M3U8 テキストを解析する。
 * 戻り値: {type:'master', variants, audioRenditions} または {type:'media', segments, ...}
 */
export function parseM3U8(text, baseUrl) {
  const raw = String(text).split(/\r?\n/);
  const lines = raw.map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('有効な M3U8 プレイリストではありません');
  }
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const audioRenditions = [];
  const subtitles = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const entry = {
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        isDefault: a.DEFAULT === 'YES',
        url: a.URI ? resolveUrl(a.URI, baseUrl) : null,
      };
      if (a.TYPE === 'AUDIO' && entry.url) audioRenditions.push(entry);
      if (a.TYPE === 'SUBTITLES' && entry.url) subtitles.push(entry);
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      // 直後の最初の非コメント行が URI
      let uri = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].startsWith('#')) { uri = lines[j]; i = j; break; }
      }
      if (!uri) continue;
      const res = parseResolution(a.RESOLUTION);
      variants.push({
        url: resolveUrl(uri, baseUrl),
        bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
        codecs: a.CODECS || '',
        frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : null,
        width: res?.width ?? null,
        height: res?.height ?? null,
        audioGroup: a.AUDIO || null,
      });
    }
  }

  // 画質の高い順に並べる
  variants.sort((x, y) => (y.height || 0) - (x.height || 0) || (y.bandwidth || 0) - (x.bandwidth || 0));
  return { type: 'master', variants, audioRenditions, subtitles };
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let initSegment = null;
  let encryption = null;
  let targetDuration = 0;
  let hasEndList = false;
  let pendingDuration = 0;
  let pendingByteRange = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      encryption = a.METHOD && a.METHOD !== 'NONE' ? { method: a.METHOD } : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) {
        initSegment = { url: resolveUrl(a.URI, baseUrl), byteRange: parseByteRange(a.BYTERANGE) };
      }
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (!line.startsWith('#')) {
      segments.push({
        url: resolveUrl(line, baseUrl),
        duration: pendingDuration,
        byteRange: pendingByteRange,
      });
      pendingDuration = 0;
      pendingByteRange = null;
    }
  }

  const duration = segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  return {
    type: 'media',
    segments,
    initSegment,
    encryption,
    targetDuration,
    isLive: !hasEndList,
    duration,
  };
}

/** `LENGTH[@OFFSET]` を {start,end} に。オフセット省略時は前セグメントの続きだが、実用上は null を返す。 */
function parseByteRange(s) {
  if (!s) return null;
  const [lenStr, offStr] = String(s).split('@');
  const length = Number(lenStr);
  if (!Number.isFinite(length)) return null;
  const offset = Number(offStr);
  if (!Number.isFinite(offset)) return null;
  return { start: offset, end: offset + length - 1 };
}

/** バリアント一覧から表示用ラベルを作る。 */
export function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.bandwidth) parts.push(`${Math.round(v.bandwidth / 1000)} kbps`);
  return parts.join(' · ') || '既定';
}
