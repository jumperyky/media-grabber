// テスト用の実動画・HLS・DASH を ffmpeg で生成する。
// 使い方: node tools/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

// AES-128 で暗号化された配信（非対応であることを確認するための入力）
fs.mkdirSync(path.join(out, 'hls-encrypted'), { recursive: true });
fs.writeFileSync(path.join(out, 'hls-encrypted', 'index.m3u8'), [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000',
  '#EXTINF:2.000000,',
  'seg0.ts',
  '#EXTINF:2.000000,',
  'seg1.ts',
  '#EXT-X-ENDLIST',
  '',
].join('\n'));

console.log('完了: ' + out);
