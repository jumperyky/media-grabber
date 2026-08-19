// 生成した .bat を実際に cmd.exe で実行して、MP4 が作られるところまで確認する。
// 使い方: node test/test-batch.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildMergeBat, buildConvertBat, mp4NameFor, escapeForBatch } from '../extension/lib/batch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + name); }
  else { failed += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

function probeFile(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  const json = JSON.parse(out);
  return {
    format: json.format.format_name,
    duration: Number(json.format.duration || 0),
    hasVideo: json.streams.some((s) => s.codec_type === 'video'),
    hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** 出力の「音声 - 映像」の開始時刻差を秒で返す。0 に近いほど揃っている。 */
function avOffset(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { encoding: 'utf8' });
  const streams = JSON.parse(out).streams;
  const v = streams.find((x) => x.codec_type === 'video');
  const a = streams.find((x) => x.codec_type === 'audio');
  return Number(a.start_time) - Number(v.start_time);
}

/** .bat を UTF-8（BOM なし）で書き出して実行する。stdin で set /p に答える。 */
function runBat(dir, batName, content, answers, args = []) {
  const batPath = path.join(dir, batName);
  fs.writeFileSync(batPath, content, { encoding: 'utf8' });
  // パイプ経由の stdin では set /p が 2 回目以降を読めないため、
  // 対話で聞く項目は引数でも渡せるようにしてある（手で実行する場合は入力で動く）。
  const CRLF = String.fromCharCode(13, 10);
  const stdin = answers.map((a) => a + CRLF).join('');
  try {
    const stdout = execFileSync('cmd.exe', ['/c', batPath, ...args], {
      cwd: dir,
      input: stdin,
      timeout: 60000,
    });
    return { ok: true, output: stdout.toString('utf8') };
  } catch (err) {
    return {
      ok: false,
      output: [err.stdout, err.stderr].filter(Boolean).map((b) => b.toString('utf8')).join('\n'),
      status: err.status,
    };
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));

try {
  // ---------------------------------------------------------------
  section('1. 生成される中身');

  const merge = buildMergeBat({
    videoFile: 'サンプル動画.video.ts',
    audioFile: 'サンプル動画.audio.ts',
    outputFile: 'サンプル動画.mp4',
  });

  check('CRLF 改行で書き出す', merge.includes('\r\n') && !/[^\r]\n/.test(merge));
  check('文字化け対策の chcp がある', merge.includes('chcp 65001'));
  check('置き場所に依存しないよう cd している', merge.includes('cd /d "%~dp0"'));
  check('再エンコードしない (-c copy)', merge.includes('-c copy'));
  check('ffmpeg の有無を先に調べる', merge.includes('where ffmpeg'));
  check('保存名を入力できる', merge.includes('set /p "NEWNAME='));
  check('拡張子が無ければ .mp4 を補う', merge.includes('"%OUTPUT:~-4%"==".mp4"'));
  check('閉じないよう pause で終わる', merge.trimEnd().endsWith('pause'));
  check('goto を使わない（日本語入りだと飛び先がずれるため）', !/goto/.test(merge));
  check('遅延展開を使わない（! を含む名前で壊れないため）', !merge.includes('enabledelayedexpansion'));
  check('音ズレ補正を入力できる', merge.includes('set /p "OFFSET='));
  check('echo 行にリダイレクト記号が混ざらない',
    merge.split(String.fromCharCode(13, 10)).filter((l) => l.startsWith('echo ') && /[<>|]/.test(l)).length === 0,
    merge.split(String.fromCharCode(13, 10)).filter((l) => l.startsWith('echo ') && /[<>|]/.test(l)).join(' | '));
  check('補正は -itsoffset で行う', merge.includes('-itsoffset'));
  check('保存名と補正値は引数でも渡せる',
    merge.includes('set "NEWNAME=%~1"') && merge.includes('set "OFFSET=%~2"'));
  check('負の補正は映像側をずらす', merge.includes('if "%OFFSET:~0,1%"=="-" set "OFFV=-itsoffset %OFFSET:~1%"'));

  check('% を含む名前をエスケープする', escapeForBatch('100%達成.ts') === '100%%達成.ts');
  check('出力名は .video を外して .mp4 にする', mp4NameFor('動画.video.ts') === '動画.mp4', mp4NameFor('動画.video.ts'));
  check('.ts 単体からも .mp4 名を作れる', mp4NameFor('動画.ts') === '動画.mp4', mp4NameFor('動画.ts'));

  // ---------------------------------------------------------------
  section('2. 素材の用意');
  const sample = path.join(fixtures, 'direct', 'sample.mp4');
  const videoOnly = path.join(work, 'テスト動画.video.ts');
  const audioOnly = path.join(work, 'テスト動画.audio.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-map', '0:v', '-c', 'copy', '-f', 'mpegts', videoOnly]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-map', '0:a', '-c', 'copy', '-f', 'mpegts', audioOnly]);

  const vInfo = probeFile(videoOnly);
  const aInfo = probeFile(audioOnly);
  check('映像のみの .ts を用意（音声なし）', vInfo.hasVideo && !vInfo.hasAudio);
  check('音声のみの .ts を用意（映像なし）', aInfo.hasAudio && !aInfo.hasVideo);

  // ---------------------------------------------------------------
  section('3. 結合用 .bat をそのまま実行（Enter で既定の名前）');
  const mergeBat = buildMergeBat({
    videoFile: 'テスト動画.video.ts',
    audioFile: 'テスト動画.audio.ts',
    outputFile: 'テスト動画.mp4',
  });
  const r1 = runBat(work, 'テスト動画.結合.bat', mergeBat, ['', '']);
  check('エラーにならず終了する', r1.ok, r1.output);

  const defaultOut = path.join(work, 'テスト動画.mp4');
  check('既定の名前で MP4 ができる', fs.existsSync(defaultOut), r1.output);
  if (fs.existsSync(defaultOut)) {
    const info = probeFile(defaultOut);
    check('MP4 コンテナになっている', info.format.includes('mp4'), info.format);
    check('映像と音声が両方入っている', info.hasVideo && info.hasAudio, JSON.stringify(info));
    check('長さが元と同じ 6 秒', Math.abs(info.duration - 6) < 0.6, String(info.duration));
    check('補正なしなら映像と音声が揃う', Math.abs(avOffset(defaultOut)) < 0.01, String(avOffset(defaultOut)));
  }
  check('日本語のファイル名が文字化けしない', !r1.output.includes('見つかりません'), r1.output.slice(0, 200));
  check('解析エラー（行の破損）が起きない',
    !r1.output.includes('not recognized') && !r1.output.includes('認識されて'),
    r1.output.split(String.fromCharCode(10)).filter((l) => l.includes('recognized') || l.includes('認識')).join(' | '));

  // ---------------------------------------------------------------
  section('4. 保存名を入力して実行');
  const renamed = 'VIVANT_第14話';
  const r2 = runBat(work, 'テスト動画.結合2.bat', mergeBat, [renamed, '']);
  check('エラーにならず終了する', r2.ok, r2.output);
  const renamedOut = path.join(work, renamed + '.mp4');
  check('入力した名前で保存される（.mp4 は自動で付く）', fs.existsSync(renamedOut),
    fs.readdirSync(work).join(', '));
  if (fs.existsSync(renamedOut)) {
    const info = probeFile(renamedOut);
    check('中身は正しく結合されている', info.hasVideo && info.hasAudio, JSON.stringify(info));
  }

  // ---------------------------------------------------------------
  section('5. 上書き確認');
  const r3 = runBat(work, 'テスト動画.結合3.bat', mergeBat, ['', '', 'n']);
  check('既存ファイルがあるとき、n で中止する',
    r3.output.includes('中止しました'), r3.output.slice(-200));

  // ---------------------------------------------------------------
  section('6. 音ズレ補正');
  for (const [label, answer, expected] of [
    ['音声を遅らせる', '0.2', 0.2],
    ['音声を早める', '-0.15', -0.15],
  ]) {
    // 引数はコマンドラインのコードページを通るため、この検証では ASCII 名を使う
    // （手入力の場合は日本語の名前でも問題なく、それは 4. で確認している）
    const name = 'sync' + answer.replace('.', '_').replace('-', 'minus');
    const r = runBat(work, name + '.bat', mergeBat, [], [name, answer]);
    const outFile = path.join(work, name + '.mp4');
    check(label + ': 生成される', fs.existsSync(outFile), r.output.slice(-200));
    if (fs.existsSync(outFile)) {
      const actual = avOffset(outFile);
      check(label + ': 指定どおりの補正がかかる (' + expected + '秒)',
        Math.abs(actual - expected) < 0.01, String(actual));
      const info = probeFile(outFile);
      check(label + ': 映像と音声が両方残る', info.hasVideo && info.hasAudio, JSON.stringify(info));
    }
  }

  // ---------------------------------------------------------------
  section('7. .ts 単体の変換用 .bat');
  const single = path.join(work, '単体動画.ts');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-c', 'copy', '-f', 'mpegts', single]);

  const convertBat = buildConvertBat({ inputFile: '単体動画.ts', outputFile: '単体動画.mp4' });
  const r4 = runBat(work, '単体動画.変換.bat', convertBat, ['']);
  check('エラーにならず終了する', r4.ok, r4.output);

  const convertedOut = path.join(work, '単体動画.mp4');
  check('MP4 ができる', fs.existsSync(convertedOut), fs.readdirSync(work).join(', '));
  if (fs.existsSync(convertedOut)) {
    const info = probeFile(convertedOut);
    check('MP4 コンテナになっている', info.format.includes('mp4'), info.format);
    check('映像と音声が保持される', info.hasVideo && info.hasAudio, JSON.stringify(info));
    check('長さが変わらない', Math.abs(info.duration - 6) < 0.6, String(info.duration));
  }

  // ---------------------------------------------------------------
  section('8. 元ファイルが無い場合');
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-empty-'));
  const r5 = runBat(orphan, 'テスト動画.結合.bat', mergeBat, ['', '']);
  check('見つからない旨を伝えて終わる', r5.output.includes('見つかりません'), r5.output.slice(0, 200));
  check('MP4 は作られない', !fs.existsSync(path.join(orphan, 'テスト動画.mp4')));
  fs.rmSync(orphan, { recursive: true, force: true });

  console.log('\n===================================');
  console.log('  成功 ' + passed + ' / 失敗 ' + failed);
  console.log('===================================');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
