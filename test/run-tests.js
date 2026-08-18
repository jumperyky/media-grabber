// 拡張機能の中核ロジックを、実際に生成した動画・HLS・DASH に対して実行して検証する。
// 使い方: node test/run-tests.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { parseM3U8, parseAttributes } from '../extension/lib/m3u8.js';
import { parseMPD, parseISODuration, fillTemplate } from '../extension/lib/mpd.js';
import { downloadHls, downloadDash, probeStream, DownloadError } from '../extension/lib/downloader.js';
import { classifyMedia, sniffContainer, suggestFilename, mergeCommand, estimateBytes } from '../extension/lib/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const outDir = path.join(here, 'out');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  PASS  ' + name);
  } else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/** fixtures ディレクトリを配信する簡易 HTTP サーバ。 */
function startServer() {
  const types = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.mpd': 'application/dash+xml',
    '.ts': 'video/mp2t',
    '.m4s': 'video/iso.segment',
    '.mp4': 'video/mp4',
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(fixtures, rel);
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** ffprobe で動画の情報を読む。 */
function probeFile(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { encoding: 'utf8' });
  const json = JSON.parse(out);
  const video = json.streams.find((s) => s.codec_type === 'video') || null;
  const audio = json.streams.find((s) => s.codec_type === 'audio') || null;
  return {
    duration: Number(json.format.duration || (video && video.duration) || 0),
    width: video ? video.width : null,
    height: video ? video.height : null,
    hasVideo: !!video,
    hasAudio: !!audio,
  };
}

function writeOut(name, bytes) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}

async function main() {
  const { server, port } = await startServer();
  const base = 'http://127.0.0.1:' + port;
  const opts = { fetchFn: fetch, concurrency: 4 };
  fs.rmSync(outDir, { recursive: true, force: true });

  try {
    // ---------------------------------------------------------------
    section('1. URL / コンテナ判定');
    check('m3u8 を HLS と判定', classifyMedia(base + '/hls-ts/index.m3u8', 'application/vnd.apple.mpegurl') === 'hls');
    check('mpd を DASH と判定', classifyMedia(base + '/dash/manifest.mpd', 'application/dash+xml') === 'dash');
    check('mp4 を direct と判定', classifyMedia(base + '/direct/sample.mp4', 'video/mp4') === 'direct');
    check('拡張子なしでも Content-Type で判定', classifyMedia('https://x/api/stream?id=9', 'video/mp4') === 'direct');
    check('セグメント(.ts)は一覧に出さない', classifyMedia('https://x/seg1.ts', 'video/mp2t') === null);
    check('画像は対象外', classifyMedia('https://x/a.png', 'image/png') === null);

    const tsBytes = fs.readFileSync(path.join(fixtures, 'hls-ts/seg0.ts'));
    const mp4Bytes = fs.readFileSync(path.join(fixtures, 'direct/sample.mp4'));
    check('TS のコンテナ判定', sniffContainer(new Uint8Array(tsBytes)) === 'ts');
    check('MP4 のコンテナ判定', sniffContainer(new Uint8Array(mp4Bytes)) === 'mp4');
    check('ファイル名の記号を除去', suggestFilename({ title: 'a/b:c*d', url: 'https://x/y.mp4', ext: 'mp4' }) === 'a_b_c_d.mp4');

    // ---------------------------------------------------------------
    section('2. プレイリスト解析');
    const attrs = parseAttributes('BANDWIDTH=800000,CODECS="avc1,mp4a",RESOLUTION=320x180');
    check('属性解析（引用符内のカンマを保持）', attrs.CODECS === 'avc1,mp4a' && attrs.BANDWIDTH === '800000');

    const mediaText = fs.readFileSync(path.join(fixtures, 'hls-ts/index.m3u8'), 'utf8');
    const media = parseM3U8(mediaText, base + '/hls-ts/index.m3u8');
    check('メディアプレイリストを認識', media.type === 'media');
    check('セグメント数 3', media.segments.length === 3, 'got ' + media.segments.length);
    check('セグメント URL が絶対化される', media.segments[0].url === base + '/hls-ts/seg0.ts', media.segments[0].url);
    check('総再生時間 6 秒', Math.abs(media.duration - 6) < 0.5, String(media.duration));
    check('VOD なので isLive=false', media.isLive === false);

    const masterText = fs.readFileSync(path.join(fixtures, 'hls-master/master.m3u8'), 'utf8');
    const master = parseM3U8(masterText, base + '/hls-master/master.m3u8');
    check('マスタープレイリストを認識', master.type === 'master');
    check('バリアント 2 本', master.variants.length === 2);
    check('高画質が先頭にくる', master.variants[0].height === 360, String(master.variants[0].height));

    const encrypted = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:2,\na.ts\n', base + '/x/');
    check('暗号化を検出', encrypted.encryption && encrypted.encryption.method === 'AES-128');

    check('ISO8601 期間の解析', Math.abs(parseISODuration('PT1M6.5S') - 66.5) < 0.001);
    check('テンプレート展開($Number%05d$)', fillTemplate('s-$Number%05d$.m4s', { Number: 7 }) === 's-00007.m4s');
    check('テンプレート展開($RepresentationID$)', fillTemplate('init-$RepresentationID$.m4s', { RepresentationID: '0' }) === 'init-0.m4s');

    const mpdText = fs.readFileSync(path.join(fixtures, 'dash/manifest.mpd'), 'utf8');
    const mpd = parseMPD(mpdText, base + '/dash/manifest.mpd');
    check('MPD: DRM なし', mpd.protected === false);
    check('MPD: 再生時間 約6秒', Math.abs(mpd.duration - 6) < 0.6, String(mpd.duration));
    check('MPD: 映像トラックあり', mpd.representations.some((r) => r.kind === 'video'));
    check('MPD: 音声トラックあり', mpd.representations.some((r) => r.kind === 'audio'));
    const dashVideo = mpd.representations.find((r) => r.kind === 'video');
    check('MPD: init セグメントを解決', !!dashVideo.initUrl, String(dashVideo.initUrl));
    check('MPD: $RepresentationID$ と $Number%05d$ を展開',
      dashVideo.segmentUrls[0] === base + '/dash/chunk-stream0-00001.m4s', dashVideo.segmentUrls[0]);
    const dashAudio = mpd.representations.find((r) => r.kind === 'audio');
    check('MPD: SegmentTimeline の複数 S を展開（音声 3 本）',
      dashAudio.segmentUrls.length === 3, String(dashAudio.segmentUrls.length));

    // SegmentTimeline の r= 繰り返しと、duration 指定（timeline 無し）を個別に検証する
    const timelineMpd = parseMPD(
      '<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="video">'
      + '<Representation id="v" bandwidth="1" width="1280" height="720">'
      + '<SegmentTemplate timescale="1" startNumber="1" initialization="i-$RepresentationID$.mp4" media="s-$Number$.m4s">'
      + '<SegmentTimeline><S t="0" d="2" r="4"/></SegmentTimeline>'
      + '</SegmentTemplate></Representation></AdaptationSet></Period></MPD>',
      base + '/x/manifest.mpd',
    );
    check('MPD: r=4 が 5 セグメントに展開される',
      timelineMpd.representations[0].segmentUrls.length === 5,
      String(timelineMpd.representations[0].segmentUrls.length));
    check('MPD: 展開後の最終セグメント URL',
      timelineMpd.representations[0].segmentUrls[4] === base + '/x/s-5.m4s',
      timelineMpd.representations[0].segmentUrls[4]);

    const durationMpd = parseMPD(
      '<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="video">'
      + '<Representation id="v" bandwidth="1"><SegmentTemplate timescale="1" duration="4" startNumber="0" media="p-$Number$.m4s"/>'
      + '</Representation></AdaptationSet></Period></MPD>',
      base + '/y/manifest.mpd',
    );
    check('MPD: duration 指定から本数を算出（10秒/4秒=3本）',
      durationMpd.representations[0].segmentUrls.length === 3,
      String(durationMpd.representations[0].segmentUrls.length));

    const drmMpd = parseMPD(
      '<MPD><Period><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:EDEF8BA9"/>'
      + '<Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>',
      base + '/z/manifest.mpd',
    );
    check('MPD: DRM (ContentProtection) を検出', drmMpd.protected === true);

    // ---------------------------------------------------------------
    section('3. 実ダウンロード: HLS (MPEG-TS)');
    let progressSeen = 0;
    const hlsTs = await downloadHls(base + '/hls-ts/index.m3u8', {
      ...opts,
      onProgress: (p) => { progressSeen = p.completed; },
    });
    check('パート数 1（音声多重化済み）', hlsTs.parts.length === 1);
    check('拡張子 ts', hlsTs.parts[0].ext === 'ts');
    check('進捗コールバックが発火', progressSeen === 3, String(progressSeen));
    const tsFile = writeOut('hls-ts.ts', hlsTs.parts[0].data);
    const tsInfo = probeFile(tsFile);
    check('再生可能で 6 秒', Math.abs(tsInfo.duration - 6) < 0.5, String(tsInfo.duration));
    check('解像度 640x360', tsInfo.width === 640 && tsInfo.height === 360, tsInfo.width + 'x' + tsInfo.height);
    check('音声トラックあり', tsInfo.hasAudio);

    // ---------------------------------------------------------------
    section('4. 実ダウンロード: HLS (fMP4)');
    const hlsFmp4 = await downloadHls(base + '/hls-fmp4/index.m3u8', opts);
    check('拡張子 mp4', hlsFmp4.parts[0].ext === 'mp4', hlsFmp4.parts[0].ext);
    const fmp4File = writeOut('hls-fmp4.mp4', hlsFmp4.parts[0].data);
    const fmp4Info = probeFile(fmp4File);
    check('再生可能で 6 秒', Math.abs(fmp4Info.duration - 6) < 0.5, String(fmp4Info.duration));
    check('解像度 640x360', fmp4Info.width === 640 && fmp4Info.height === 360);
    check('音声トラックあり', fmp4Info.hasAudio);

    // ---------------------------------------------------------------
    section('5. 実ダウンロード: HLS マスター（画質選択）');
    const probe = await probeStream('hls', base + '/hls-master/master.m3u8', opts);
    check('画質候補を 2 件提示', probe.variants.length === 2);
    check('マスタープレイリストと判別', probe.isMaster === true);
    check('マスターでも動画の長さが分かる（バリアントを1本読む）',
      Math.abs(probe.duration - 6) < 0.5, String(probe.duration));
    check('セグメント数が分かる', probe.segmentCount === 3, String(probe.segmentCount));
    check('画質ごとに推定サイズを算出', probe.variants.every((v) => v.estimatedBytes > 0),
      JSON.stringify(probe.variants.map((v) => v.estimatedBytes)));
    check('高画質のほうが推定サイズが大きい',
      probe.variants[0].estimatedBytes > probe.variants[1].estimatedBytes);

    const mediaProbe = await probeStream('hls', base + '/hls-ts/index.m3u8', opts);
    check('メディアプレイリストは isMaster=false', mediaProbe.isMaster === false);
    check('メディアプレイリストでも長さが分かる', Math.abs(mediaProbe.duration - 6) < 0.5);

    const dashProbe = await probeStream('dash', base + '/dash/manifest.mpd', opts);
    check('DASH でも推定サイズを算出', dashProbe.variants[0].estimatedBytes > 0,
      String(dashProbe.variants[0].estimatedBytes));
    check('DASH は音声が別トラックだと分かる', dashProbe.variants[0].hasSeparateAudio === true);

    check('推定サイズの計算（1000kbps × 60秒 = 7.5MB)',
      estimateBytes(1000000, 60) === 7500000, String(estimateBytes(1000000, 60)));
    check('不正な入力では 0', estimateBytes(0, 60) === 0 && estimateBytes(NaN, 10) === 0);

    const best = await downloadHls(base + '/hls-master/master.m3u8', opts);
    const bestFile = writeOut('hls-best.ts', best.parts[0].data);
    const bestInfo = probeFile(bestFile);
    check('既定で最高画質(640x360)を選ぶ', bestInfo.width === 640 && bestInfo.height === 360, bestInfo.width + 'x' + bestInfo.height);

    const low = await downloadHls(base + '/hls-master/master.m3u8', { ...opts, variantIndex: 1 });
    const lowFile = writeOut('hls-low.ts', low.parts[0].data);
    const lowInfo = probeFile(lowFile);
    check('画質指定(320x180)が効く', lowInfo.width === 320 && lowInfo.height === 180, lowInfo.width + 'x' + lowInfo.height);

    // ---------------------------------------------------------------
    section('6. 実ダウンロード: DASH（映像+音声の分離トラック）');
    const dash = await downloadDash(base + '/dash/manifest.mpd', opts);
    check('パート数 2（映像/音声）', dash.parts.length === 2, String(dash.parts.length));
    const vPart = dash.parts.find((p) => p.role === 'video');
    const aPart = dash.parts.find((p) => p.role === 'audio');
    const vFile = writeOut('dash.video.mp4', vPart.data);
    const aFile = writeOut('dash.audio.mp4', aPart.data);
    const vInfo = probeFile(vFile);
    const aInfo = probeFile(aFile);
    check('映像パートが再生可能', vInfo.hasVideo && Math.abs(vInfo.duration - 6) < 0.6, String(vInfo.duration));
    check('映像パートの解像度 640x360', vInfo.width === 640 && vInfo.height === 360);
    check('音声パートが再生可能', aInfo.hasAudio && Math.abs(aInfo.duration - 6) < 0.6, String(aInfo.duration));

    const mergedFile = path.join(outDir, 'dash.merged.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vFile, '-i', aFile, '-c', 'copy', mergedFile]);
    const mergedInfo = probeFile(mergedFile);
    check('提示する ffmpeg コマンドで結合できる', mergedInfo.hasVideo && mergedInfo.hasAudio, JSON.stringify(mergedInfo));
    check('結合コマンド文字列が正しい形', mergeCommand('a.mp4', 'b.mp4', 'c.mp4').startsWith('ffmpeg -i "a.mp4" -i "b.mp4" -c copy'));

    // ---------------------------------------------------------------
    section('7. エラー処理');
    const encProbe = await probeStream('hls', base + '/hls-encrypted/index.m3u8', opts);
    check('暗号化された配信を事前に判別できる', encProbe.encrypted === true);

    let encryptedError = null;
    try {
      await downloadHls(base + '/hls-encrypted/index.m3u8', opts);
    } catch (err) {
      encryptedError = err;
    }
    check('暗号化された配信はダウンロードを中止する',
      encryptedError instanceof DownloadError && encryptedError.code === 'ENCRYPTED',
      encryptedError && encryptedError.code);
    check('中止の理由が分かるメッセージ',
      encryptedError && encryptedError.message.includes('AES-128'), encryptedError && encryptedError.message);

    let missingRejected = false;
    try {
      await downloadHls(base + '/does-not-exist.m3u8', opts);
    } catch (err) {
      missingRejected = err instanceof DownloadError;
    }
    check('存在しない/不正なプレイリストで例外', missingRejected);

    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await downloadHls(base + '/hls-ts/index.m3u8', { ...opts, signal: controller.signal });
    } catch (err) {
      aborted = err instanceof DownloadError && err.code === 'ABORTED';
    }
    check('中断シグナルで停止する', aborted);

    // ---------------------------------------------------------------
    console.log('\n===================================');
    console.log('  成功 ' + passed + ' / 失敗 ' + failed);
    console.log('  出力ファイル: ' + outDir);
    console.log('===================================');
  } finally {
    server.close();
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('テストが異常終了しました:', err);
  process.exit(1);
});
