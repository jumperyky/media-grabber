// ストリーム(HLS/DASH)のダウンロード中核処理。
// fetch を引数で受け取るため、拡張機能からも Node のテストからも同じコードを実行できる。
import { parseM3U8 } from './m3u8.js';
import { parseMPD, pickBest } from './mpd.js';
import { sniffContainer, containerToExt, estimateBytes } from './util.js';

export class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code || 'ERROR';
  }
}

/** 中断可能な待機。 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DownloadError('中断しました', 'ABORTED'));
      }, { once: true });
    }
  });
}

/** 失敗時にリトライしながら 1 本の URL を取得する。 */
async function fetchBytes(url, { fetchFn, signal, byteRange, retries = 3, retryDelayMs = 400 }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal && signal.aborted) throw new DownloadError('中断しました', 'ABORTED');
    try {
      const headers = {};
      if (byteRange) headers.Range = 'bytes=' + byteRange.start + '-' + byteRange.end;
      const res = await fetchFn(url, { headers, signal, credentials: 'include' });
      if (!res.ok && res.status !== 206) {
        throw new DownloadError('HTTP ' + res.status + ' (' + url + ')', 'HTTP_' + res.status);
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      if (err instanceof DownloadError && err.code === 'ABORTED') throw err;
      if (err && err.name === 'AbortError') throw new DownloadError('中断しました', 'ABORTED');
      lastError = err;
      if (attempt < retries) await delay(retryDelayMs * (attempt + 1), signal);
    }
  }
  throw new DownloadError('取得に失敗しました: ' + ((lastError && lastError.message) || url), 'FETCH_FAILED');
}

/** テキストとして取得する。 */
async function fetchText(url, opts) {
  const bytes = await fetchBytes(url, opts);
  return new TextDecoder('utf-8').decode(bytes);
}

/** 順序を保ったまま、指定並列数でセグメントを取得する。 */
async function fetchAllSegments(segments, opts) {
  const { fetchFn, signal, onProgress } = opts;
  const concurrency = opts.concurrency || 6;
  const results = new Array(segments.length);
  let nextIndex = 0;
  let completed = 0;
  let bytesTotal = 0;

  const worker = async () => {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= segments.length) return;
      const seg = segments[i];
      const bytes = await fetchBytes(seg.url, {
        fetchFn, signal, byteRange: seg.byteRange, retries: opts.retries, retryDelayMs: opts.retryDelayMs,
      });
      results[i] = bytes;
      completed += 1;
      bytesTotal += bytes.length;
      if (onProgress) onProgress({ completed, total: segments.length, bytes: bytesTotal });
    }
  };

  const workers = [];
  const n = Math.min(concurrency, segments.length);
  for (let i = 0; i < n; i += 1) workers.push(worker());
  await Promise.all(workers);
  return { parts: results, bytes: bytesTotal };
}

/** Uint8Array の配列を 1 本に連結する。 */
export function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p ? p.length : 0;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    if (!p) continue;
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** AES-128 復号用のヘルパー関数 */
async function decryptSegment(ciphertext, keyBuf, ivBuf) {
  const key = await crypto.subtle.importKey(
    'raw', keyBuf, { name: 'AES-CBC' }, false, ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBuf }, key, ciphertext
  );
  return new Uint8Array(plaintext);
}

/** HLS のメディアプレイリストを 1 本のバイト列にする。 */
async function downloadHlsMedia(playlistUrl, opts) {
  const text = await fetchText(playlistUrl, opts);
  const playlist = parseM3U8(text, playlistUrl);
  if (playlist.type !== 'media') throw new DownloadError('メディアプレイリストではありません', 'BAD_PLAYLIST');
  
  // 変更: AES-128の場合は例外を投げずに処理を続行する
  if (playlist.encryption && playlist.encryption.method !== 'AES-128') {
    throw new DownloadError(
      '暗号化されたストリーム (' + playlist.encryption.method + ') には対応していません',
      'ENCRYPTED',
    );
  }
  if (!playlist.segments.length) throw new DownloadError('セグメントが見つかりません', 'NO_SEGMENTS');

  // 追加: 鍵の取得
  let keyData = null;
  if (playlist.encryption && playlist.encryption.method === 'AES-128') {
    if (!playlist.encryption.uri) throw new DownloadError('暗号化キーの URI がありません', 'ENCRYPTED');
    keyData = await fetchBytes(playlist.encryption.uri, opts);
  }

  const list = [];
  if (playlist.initSegment) list.push(playlist.initSegment);
  for (const s of playlist.segments) list.push(s);

  const got = await fetchAllSegments(list, opts);

  // 追加: 各セグメントの復号処理
  if (keyData) {
    let seq = playlist.mediaSequence || 0;
    let mediaIndex = 0;
    for (let i = 0; i < got.parts.length; i++) {
      if (!got.parts[i]) continue;
      
      // Init Segment は通常暗号化されないためスキップする
      if (playlist.initSegment && i === 0) continue;

      let ivData;
      if (playlist.encryption.iv) {
        // M3U8にIVが明記されている場合
        const hex = String(playlist.encryption.iv).replace(/^0x/i, '');
        ivData = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      } else {
        // IVが省略されている場合は、シーケンス番号をIVとして使用する
        ivData = new Uint8Array(16);
        const view = new DataView(ivData.buffer);
        view.setUint32(12, seq + mediaIndex, false);
      }
      
      // 復号
      got.parts[i] = await decryptSegment(got.parts[i], keyData, ivData);
      mediaIndex++;
    }
  }

  const data = concatBytes(got.parts);
  return {
    data,
    bytes: got.bytes,
    container: sniffContainer(data),
    duration: playlist.duration,
    isLive: playlist.isLive,
  };
}

/**
 * HLS をダウンロードする。
 * variantIndex を渡すとマスタープレイリスト内の画質を選択できる（既定は最高画質）。
 * 音声が別トラックの場合は audio パートも返す。
 */
export async function downloadHls(manifestUrl, opts = {}) {
  const text = await fetchText(manifestUrl, opts);
  const parsed = parseM3U8(text, manifestUrl);

  if (parsed.type === 'media') {
    const r = await downloadHlsMedia(manifestUrl, opts);
    return {
      parts: [{ role: 'video', data: r.data, ext: containerToExt(r.container) }],
      duration: r.duration,
      isLive: r.isLive,
    };
  }

  if (!parsed.variants.length) throw new DownloadError('再生可能なバリアントがありません', 'NO_VARIANTS');
  const index = Number.isInteger(opts.variantIndex) ? opts.variantIndex : 0;
  const variant = parsed.variants[Math.max(0, Math.min(index, parsed.variants.length - 1))];

  const video = await downloadHlsMedia(variant.url, opts);
  const parts = [{ role: 'video', data: video.data, ext: containerToExt(video.container) }];

  // 音声が別レンディションとして分離している場合は併せて取得する
  let audio = null;
  if (variant.audioGroup) {
    audio = parsed.audioRenditions.find((a) => a.groupId === variant.audioGroup && a.isDefault)
      || parsed.audioRenditions.find((a) => a.groupId === variant.audioGroup)
      || null;
  }
  if (audio && audio.url) {
    const a = await downloadHlsMedia(audio.url, opts);
    parts.push({ role: 'audio', data: a.data, ext: containerToExt(a.container) });
  }

  return { parts, duration: video.duration, isLive: video.isLive, variant };
}

/** DASH をダウンロードする。映像と音声が分離している場合は 2 パート返す。 */
export async function downloadDash(manifestUrl, opts = {}) {
  const text = await fetchText(manifestUrl, opts);
  const parsed = parseMPD(text, manifestUrl);
  if (parsed.protected) {
    throw new DownloadError('DRM で保護されたストリームには対応していません', 'PROTECTED');
  }

  const chosen = [];
  const videos = parsed.representations.filter((r) => r.kind === 'video');
  const video = Number.isInteger(opts.videoIndex) ? videos[opts.videoIndex] : pickBest(parsed.representations, 'video');
  const audio = pickBest(parsed.representations, 'audio');
  if (video) chosen.push({ role: 'video', rep: video });
  if (audio) chosen.push({ role: 'audio', rep: audio });
  if (!chosen.length) {
    const other = parsed.representations[0];
    if (!other) throw new DownloadError('ダウンロード可能なトラックがありません', 'NO_TRACKS');
    chosen.push({ role: 'video', rep: other });
  }

  const parts = [];
  for (const item of chosen) {
    const rep = item.rep;
    const list = [];
    if (rep.initUrl) list.push({ url: rep.initUrl });
    for (const u of rep.segmentUrls) list.push({ url: u });
    if (!list.length) throw new DownloadError('セグメントが見つかりません', 'NO_SEGMENTS');
    const got = await fetchAllSegments(list, opts);
    const data = concatBytes(got.parts);
    parts.push({ role: item.role, data, ext: containerToExt(sniffContainer(data)) });
  }

  return { parts, duration: parsed.duration };
}

/** 1 回の範囲要求の上限。これを超えない範囲でできるだけ大きく取る。 */
export const RANGE_CHUNK_MAX = 8 * 1024 * 1024;
/** 1 回の範囲要求で取ってよいのは、ファイル全体の約 1/12 まで（googlevideo の制限）。 */
export const RANGE_MAX_RATIO = 12;

/**
 * 分割の大きさを決める。googlevideo はファイル全体に対して大きすぎる範囲を
 * 403（text/plain）で拒む。1.3GB なら 100MB は通るが 200MB は不可、18MB なら
 * 1MB は通るが 8MB は不可、という具合に「全体の 1 割程度」が上限になっている。
 */
export function rangeChunkSize(totalBytes) {
  const share = Math.floor((Number(totalBytes) || 0) / RANGE_MAX_RATIO);
  return Math.max(64 * 1024, Math.min(RANGE_CHUNK_MAX, share));
}

/**
 * 1 本のファイルを範囲要求に分けて取得する。
 *
 * 使い捨て URL（1 回の範囲要求にしか応じず、2 回目以降は 403 になるもの）向けに、
 * 2 個目以降の範囲は opts.freshUrl() で URL を取り直しながら順番に取得する。
 */
export async function downloadRanged(url, totalBytes, opts = {}) {
  const size = Number(totalBytes) || 0;
  if (size <= 0) throw new DownloadError('ファイルサイズが分かりません', 'NO_SIZE');
  const chunk = opts.chunkSize || rangeChunkSize(size);
  const total = Math.ceil(size / chunk);
  const attempts = opts.retries === undefined ? 3 : opts.retries;

  const parts = [];
  let bytes = 0;
  let current = url;

  for (let index = 0; index < total; index += 1) {
    const start = index * chunk;
    const byteRange = { start, end: Math.min(start + chunk, size) - 1 };

    let got = null;
    let lastError = null;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      // 先頭以外、および失敗したあとは URL を取り直す
      if ((index > 0 || attempt > 0) && opts.freshUrl) {
        const next = await opts.freshUrl(index).catch(() => null);
        if (next) current = next;
      }
      try {
        got = await fetchBytes(current, { fetchFn: opts.fetchFn, signal: opts.signal, byteRange, retries: 0 });
        break;
      } catch (err) {
        if (err instanceof DownloadError && err.code === 'ABORTED') throw err;
        lastError = err;
        if (attempt < attempts) await delay((opts.retryDelayMs || 600) * (attempt + 1), opts.signal);
      }
    }
    if (!got) throw lastError || new DownloadError('取得に失敗しました', 'FETCH_FAILED');

    parts.push(got);
    bytes += got.length;
    if (opts.onProgress) opts.onProgress({ completed: index + 1, total, bytes });
  }

  return { parts, bytes };
}

/** 種別に応じて適切なダウンローダを呼ぶ。 */
export async function downloadStream(kind, manifestUrl, opts = {}) {
  if (kind === 'hls') return downloadHls(manifestUrl, opts);
  if (kind === 'dash') return downloadDash(manifestUrl, opts);
  throw new DownloadError('未対応の種別: ' + kind, 'UNSUPPORTED');
}

/** マニフェストを読んで、選択肢（画質一覧）だけを取得する。 */
export async function probeStream(kind, manifestUrl, opts = {}) {
  const text = await fetchText(manifestUrl, opts);

  if (kind === 'hls') {
    const parsed = parseM3U8(text, manifestUrl);

    if (parsed.type === 'media') {
      return {
        kind,
        isMaster: false,
        variants: [],
        audioUrls: [],
        duration: parsed.duration,
        segmentCount: parsed.segments.length,
        isLive: parsed.isLive,
        // 修正: AES-128以外の暗号化の場合のみ true にする
        encrypted: !!parsed.encryption && parsed.encryption.method !== 'AES-128',
      };
    }

    // マスタープレイリスト自体には長さが書かれていないため、
    // 先頭のバリアントを 1 本だけ読んで再生時間を求める。
    let duration = 0;
    let segmentCount = 0;
    let isLive = false;
    let encrypted = false;
    const first = parsed.variants[0];
    if (first) {
      try {
        const media = parseM3U8(await fetchText(first.url, opts), first.url);
        if (media.type === 'media') {
          duration = media.duration;
          segmentCount = media.segments.length;
          isLive = media.isLive;
          // 修正: AES-128以外の暗号化の場合のみ true にする
          encrypted = !!media.encryption && media.encryption.method !== 'AES-128';
        }
      } catch { /* 取得できなくても画質一覧は返す */ }
    }

    return {
      kind,
      isMaster: true,
      variants: parsed.variants.map((v, i) => ({
        index: i,
        // このマスターが束ねている再生リストの URL。
        // 同じ動画が複数検出されたとき、どれがどれに含まれるか判別するのに使う。
        url: v.url,
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
        estimatedBytes: estimateBytes(v.bandwidth, duration),
        hasSeparateAudio: !!v.audioGroup,
      })),
      audioUrls: parsed.audioRenditions.map((a) => a.url).filter(Boolean),
      duration,
      segmentCount,
      isLive,
      encrypted,
    };
  }

  const parsed = parseMPD(text, manifestUrl);
  const audio = pickBest(parsed.representations, 'audio');
  return {
    kind,
    isMaster: true,
    variants: parsed.representations
      .filter((r) => r.kind === 'video')
      .map((v, i) => ({
        index: i,
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
        // DASH は映像と音声が別トラックなので、音声分も足して見積もる
        estimatedBytes: estimateBytes(v.bandwidth + (audio ? audio.bandwidth : 0), parsed.duration),
        hasSeparateAudio: !!audio,
      })),
    audioUrls: [],
    duration: parsed.duration,
    segmentCount: (parsed.representations.find((r) => r.kind === 'video') || {}).segmentUrls?.length || 0,
    isLive: false,
    encrypted: parsed.protected,
  };
}