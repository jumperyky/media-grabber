// テスト用の実動画・HLS・DASH を ffmpeg で生成する。
// 使い方: node tools/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'fixtures');

function ff(args, cwd) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit', cwd });
}

fs.rmSync(out, { recursive: true, force: true });
for (const dir of ['direct', 'hls-ts', 'hls-fmp4', 'hls-master/v360', 'hls-master/v180', 'dash']) {
  fs.mkdirSync(path.join(out, dir), { recursive: true });
}

const sample = path.join(out, 'direct', 'sample.mp4');

// 2 秒ごとにキーフレームを置く（そうしないとセグメントに分割されない）
console.log('元動画を生成中...');
ff([
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
  '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
  '-c:a', 'aac', '-shortest', sample,
]);

console.log('HLS (MPEG-TS) を生成中...');
ff(['-i', sample, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(out, 'hls-ts', 'seg%d.ts'), path.join(out, 'hls-ts', 'index.m3u8')]);

// init セグメント名はカレントディレクトリ基準で解決されるため、出力先で実行する
console.log('HLS (fMP4) を生成中...');
ff(['-i', sample, '-c', 'copy', '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_time', '2',
  '-hls_playlist_type', 'vod', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', 'seg%d.m4s', 'index.m3u8'], path.join(out, 'hls-fmp4'));

// DASH のセグメントもカレントディレクトリ基準で出力されるため、出力先で実行する
console.log('DASH を生成中...');
ff(['-i', sample, '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
  'manifest.mpd'], path.join(out, 'dash'));

console.log('マスタープレイリスト用の 2 画質を生成中...');
ff(['-i', sample, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(out, 'hls-master', 'v360', 'seg%d.ts'),
  path.join(out, 'hls-master', 'v360', 'index.m3u8')]);
ff(['-i', sample, '-vf', 'scale=320:180', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:a', 'aac',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(out, 'hls-master', 'v180', 'seg%d.ts'),
  path.join(out, 'hls-master', 'v180', 'index.m3u8')]);

fs.writeFileSync(path.join(out, 'hls-master', 'master.m3u8'), [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.42c015,mp4a.40.2"',
  'v180/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"',
  'v360/index.m3u8',
  '',
].join('\n'));

// AES-128 で暗号化された配信（復号して保存できることを確認するための入力）。
// hls-ts のセグメントをそのまま AES-128-CBC で暗号化する（HLS 仕様どおり PKCS#7 パディング）。
// ffmpeg の -hls_key_info_file は全セグメントに同じ IV を書くため、
// 「IV 省略 → メディアシーケンス番号を IV にする」経路は自前で作る。
console.log('HLS (AES-128) を生成中...');
const aesKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
function encryptSegment(plain, iv) {
  const c = crypto.createCipheriv('aes-128-cbc', aesKey, iv);
  return Buffer.concat([c.update(plain), c.final()]);
}
function ivFromSequence(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq, 12);
  return iv;
}
const tsSegments = fs.readdirSync(path.join(out, 'hls-ts'))
  .filter((f) => /^seg\d+\.ts$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

// (a) IV 省略。メディアシーケンスを 0 以外から始めて、番号を正しく使っているか分かるようにする
{
  const dir = path.join(out, 'hls-encrypted');
  const firstSeq = 7;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.bin'), aesKey);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:' + firstSeq, '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'];
  tsSegments.forEach((name, i) => {
    fs.writeFileSync(path.join(dir, name),
      encryptSegment(fs.readFileSync(path.join(out, 'hls-ts', name)), ivFromSequence(firstSeq + i)));
    lines.push('#EXTINF:2.000000,', name);
  });
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n'));
}

// (b) IV 明示（全セグメント共通）。大文字 0X も正しく読めるか確認するため接頭辞を変えておく
{
  const dir = path.join(out, 'hls-encrypted-iv');
  const iv = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'key.bin'), aesKey);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0X' + iv.toString('hex').toUpperCase()];
  for (const name of tsSegments) {
    fs.writeFileSync(path.join(dir, name), encryptSegment(fs.readFileSync(path.join(out, 'hls-ts', name)), iv));
    lines.push('#EXTINF:2.000000,', name);
  }
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, 'index.m3u8'), lines.join('\n'));
}

// SAMPLE-AES（FairPlay 系）は非対応。中止することを確認するための入力
fs.mkdirSync(path.join(out, 'hls-sample-aes'), { recursive: true });
fs.writeFileSync(path.join(out, 'hls-sample-aes', 'index.m3u8'), [
  '#EXTM3U',
  '#EXT-X-VERSION:5',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://example",KEYFORMAT="com.apple.streamingkeydelivery"',
  '#EXTINF:2.000000,',
  'seg0.ts',
  '#EXTINF:2.000000,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n'));

console.log('完了: ' + out);
