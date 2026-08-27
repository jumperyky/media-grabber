// 生成した .bat を実際に cmd.exe で実行して、MP4 が作られるところまで確認する。
// 使い方: node test/test-batch.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildMergeBat, buildConvertBat, mp4NameFor, escapeForBatch } from '../extension/lib/batch.js';
import { encodeCp932, encodeBatchFile } from '../extension/lib/cp932.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const sample = path.join(fixtures, 'direct', 'sample.mp4');
const CRLF = String.fromCharCode(13, 10);

let passed = 0;
let failed = 0;
const tempDirs = [];

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

/** 映像のみ / 音声のみの .ts を用意した作業用ディレクトリを作る。 */
function freshDir(videoName = 'テスト動画.video.ts', audioName = 'テスト動画.audio.ts') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
  tempDirs.push(dir);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-map', '0:v', '-c', 'copy', '-f', 'mpegts', path.join(dir, videoName)]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-map', '0:a', '-c', 'copy', '-f', 'mpegts', path.join(dir, audioName)]);
  return dir;
}

/**
 * .bat を UTF-8（BOM なし）で書き出して実行する。
 * 対話項目は引数で渡す。パイプ経由の stdin では set /p が 2 回目以降を読めないため、
 * stdin で答えられるのは最初の 1 つだけ。
 */
function runBat(dir, batName, content, answers = [], args = []) {
  const batPath = path.join(dir, batName);
  // cmd.exe は起動時のコードページで解析するため CP932 で書き出す
  fs.writeFileSync(batPath, Buffer.from(encodeBatchFile(content)));
  // 入力もコンソールと同じ CP932 で渡す（手で打つ場合と同じ条件にする）
  const stdin = Buffer.from(encodeCp932(answers.map((a) => a + CRLF).join('')) || new Uint8Array());
  try {
    const stdout = execFileSync('cmd.exe', ['/c', batPath, ...args], { cwd: dir, input: stdin, timeout: 60000 });
    return { ok: true, output: decodeConsole(stdout) };
  } catch (err) {
    return {
      ok: false,
      output: [err.stdout, err.stderr].filter(Boolean).map(decodeConsole).join(String.fromCharCode(10)),
      status: err.status,
    };
  }
}

/** コンソール出力は CP932 で返ってくる。 */
const consoleDecoder = new TextDecoder('shift_jis');
function decodeConsole(buf) {
  return consoleDecoder.decode(buf);
}

/** 解析エラー（行の破損）が起きていないか。 */
function noParseError(output) {
  return !output.includes('not recognized') && !output.includes('認識されて');
}

const mergeBat = buildMergeBat({
  videoFile: 'テスト動画.video.ts',
  audioFile: 'テスト動画.audio.ts',
  outputFile: 'テスト動画.mp4',
});

try {
  // ---------------------------------------------------------------
  section('1. 生成される中身');
  check('CRLF 改行で書き出す', mergeBat.includes(CRLF) && !/[^\r]\n/.test(mergeBat));
  check('CP932 で書き出せる（chcp に頼らない）',
    encodeCp932(mergeBat) !== null && !mergeBat.includes('chcp'));
  check('置き場所に依存しないよう cd している', mergeBat.includes('cd /d "%~dp0"'));
  check('再エンコードしない (-c copy)', mergeBat.includes('-c copy'));
  check('ffmpeg の有無を先に調べる', mergeBat.includes('where ffmpeg'));
  check('保存名を入力できる', mergeBat.includes('set /p "NEWNAME='));
  check('音ズレ補正を入力できる', mergeBat.includes('set /p "OFFSET='));
  check('補正は -itsoffset で行う', mergeBat.includes('-itsoffset'));
  check('負の補正は映像側をずらす', mergeBat.includes('if "%OFFSET:~0,1%"=="-" set "OFFV=-itsoffset %OFFSET:~1%"'));
  check('元ファイルの削除を確認する', mergeBat.includes('set /p "DELSRC='));
  check('自身の削除を確認する', mergeBat.includes('set /p "DELSELF='));
  check('削除の既定は「削除する」', mergeBat.includes('if "%DELSRC%"=="" set "DELSRC=y"')
    && mergeBat.includes('if "%DELSELF%"=="" set "DELSELF=y"'));
  check('出力ができたことを確かめてから削除に進む', mergeBat.includes('if not exist "%OUTPUT%" (echo.&echo 出力ファイルが作られませんでした'));
  check('自身の削除は最終行で行う',
    mergeBat.trimEnd().endsWith('if /i "%DELSELF%"=="y" ((goto) 2>nul & del /q "%~f0")'));
  check('拡張子が無ければ .mp4 を補う', mergeBat.includes('"%OUTPUT:~-4%"==".mp4"'));
  check('ラベル付きの goto を使わない（日本語入りだと飛び先がずれるため）',
    !/goto\s+\S/.test(mergeBat), (mergeBat.match(/goto\s+\S+/g) || []).join(', '));
  check('遅延展開を使わない（! を含む名前で壊れないため）', !mergeBat.includes('enabledelayedexpansion'));
  check('echo 行にリダイレクト記号が混ざらない',
    mergeBat.split(CRLF).filter((l) => l.startsWith('echo ') && /[<>|]/.test(l)).length === 0);
  check('各項目は引数でも渡せる',
    mergeBat.includes('set "NEWNAME=%~1"') && mergeBat.includes('set "OFFSET=%~2"')
    && mergeBat.includes('set "DELSRC=%~3"') && mergeBat.includes('set "DELSELF=%~4"'));

  check('% を含む名前をエスケープする', escapeForBatch('100%達成.ts') === '100%%達成.ts');
  check('出力名は .video を外して .mp4 にする', mp4NameFor('動画.video.ts') === '動画.mp4');
  check('.ts 単体からも .mp4 名を作れる', mp4NameFor('動画.ts') === '動画.mp4');

  // ---------------------------------------------------------------
  section('2. 既定の名前で結合する（元ファイルは残す）');
  {
    const dir = freshDir();
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [''], ['', '0', 'n', 'n']);
    check('エラーにならず終了する', r.ok, r.output);
    check('解析エラーが起きない', noParseError(r.output), r.output.slice(0, 200));

    const out = path.join(dir, 'テスト動画.mp4');
    check('既定の名前で MP4 ができる', fs.existsSync(out), fs.readdirSync(dir).join(', '));
    if (fs.existsSync(out)) {
      const info = probeFile(out);
      check('MP4 コンテナになっている', info.format.includes('mp4'), info.format);
      check('映像と音声が両方入っている', info.hasVideo && info.hasAudio, JSON.stringify(info));
      check('長さが元と同じ 6 秒', Math.abs(info.duration - 6) < 0.6, String(info.duration));
      check('補正なしなら映像と音声が揃う', Math.abs(avOffset(out)) < 0.01, String(avOffset(out)));
    }
    check('n を指定したので元ファイルが残る',
      fs.existsSync(path.join(dir, 'テスト動画.video.ts')) && fs.existsSync(path.join(dir, 'テスト動画.audio.ts')));
    check('n を指定したので .bat も残る', fs.existsSync(path.join(dir, 'テスト動画.結合.bat')));
  }

  // ---------------------------------------------------------------
  section('3. 保存名を入力して結合する');
  {
    const dir = freshDir();
    const renamed = 'VIVANT_第14話';
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [renamed], ['', '0', 'n', 'n']);
    check('エラーにならず終了する', r.ok, r.output);
    const out = path.join(dir, renamed + '.mp4');
    check('入力した名前で保存される（.mp4 は自動で付く）', fs.existsSync(out), fs.readdirSync(dir).join(', '));
    if (fs.existsSync(out)) {
      const info = probeFile(out);
      check('中身は正しく結合されている', info.hasVideo && info.hasAudio, JSON.stringify(info));
    }
  }

  // ---------------------------------------------------------------
  section('4. 上書き確認');
  {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'dup.mp4'), 'dummy');
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, ['n'], ['dup', '0', 'n', 'n']);
    check('既存ファイルがあるとき n で中止する', r.output.includes('中止しました'), r.output.slice(-200));
    check('中止したので元のファイルは残る', fs.readFileSync(path.join(dir, 'dup.mp4'), 'utf8') === 'dummy');
  }

  // ---------------------------------------------------------------
  section('5. 音ズレ補正');
  for (const [label, answer, expected] of [
    ['音声を遅らせる', '0.2', 0.2],
    ['音声を早める', '-0.15', -0.15],
  ]) {
    const dir = freshDir();
    // 引数はコマンドラインのコードページを通るため、ここでは ASCII 名を使う
    // （日本語名での入力は 3. で確認している）
    const name = 'sync' + answer.replace('.', '_').replace('-', 'minus');
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [], [name, answer, 'n', 'n']);
    const out = path.join(dir, name + '.mp4');
    check(label + ': 生成される', fs.existsSync(out), r.output.slice(-200));
    if (fs.existsSync(out)) {
      const actual = avOffset(out);
      check(label + ': 指定どおりの補正がかかる (' + expected + '秒)', Math.abs(actual - expected) < 0.01, String(actual));
      const info = probeFile(out);
      check(label + ': 映像と音声が両方残る', info.hasVideo && info.hasAudio, JSON.stringify(info));
    }
  }

  // ---------------------------------------------------------------
  section('6. 元ファイルの削除');
  {
    const dir = freshDir();
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['merged', '0', 'y', 'n']);
    check('エラーにならず終了する', r.ok, r.output);
    check('MP4 はできている', fs.existsSync(path.join(dir, 'merged.mp4')), fs.readdirSync(dir).join(', '));
    check('映像の元ファイルが削除される', !fs.existsSync(path.join(dir, 'テスト動画.video.ts')));
    check('音声の元ファイルが削除される', !fs.existsSync(path.join(dir, 'テスト動画.audio.ts')));
    check('削除した旨を表示する', r.output.includes('元のファイルを削除しました'), r.output.slice(-300));
  }
  {
    const dir = freshDir();
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['merged', '0', 'n', 'n']);
    check('n を指定すると元ファイルは残る',
      fs.existsSync(path.join(dir, 'テスト動画.video.ts')) && fs.existsSync(path.join(dir, 'テスト動画.audio.ts')));
    check('残した旨を表示する', r.output.includes('元のファイルは残しました'), r.output.slice(-300));
  }

  // ---------------------------------------------------------------
  section('7. .bat 自身の削除');
  {
    const dir = freshDir();
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['merged', '0', 'n', 'y']);
    check('y を指定すると .bat が消える', !fs.existsSync(path.join(dir, 'テスト動画.結合.bat')),
      fs.readdirSync(dir).join(', '));
    check('MP4 は残る', fs.existsSync(path.join(dir, 'merged.mp4')));
    check('削除後に余計なエラーを出さない',
      !r.output.includes('cannot be found') && !r.output.includes('見つかりません'), r.output.slice(-200));
  }
  {
    const dir = freshDir();
    runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['merged', '0', 'n', 'n']);
    check('n を指定すると .bat は残る', fs.existsSync(path.join(dir, 'テスト動画.結合.bat')));
  }
  {
    // 元ファイルと .bat の両方を消す = 既定の動作
    const dir = freshDir();
    runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['merged', '0', 'y', 'y']);
    const left = fs.readdirSync(dir);
    check('既定どおり両方消すと MP4 だけが残る',
      left.length === 1 && left[0] === 'merged.mp4', left.join(', '));
  }

  // ---------------------------------------------------------------
  section('8. .ts 単体の変換用 .bat');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
    tempDirs.push(dir);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-c', 'copy', '-f', 'mpegts', path.join(dir, '単体動画.ts')]);
    const convertBat = buildConvertBat({ inputFile: '単体動画.ts', outputFile: '単体動画.mp4' });

    check('引数は 保存名 / 元削除 / 自身削除 の順',
      convertBat.includes('set "NEWNAME=%~1"') && convertBat.includes('set "DELSRC=%~2"')
      && convertBat.includes('set "DELSELF=%~3"'));
    check('音ズレ補正は用意しない（多重化済みのため）', !convertBat.includes('OFFSET'));

    const r = runBat(dir, '単体動画.変換.bat', convertBat, [], ['', 'n', 'n']);
    check('エラーにならず終了する', r.ok, r.output);
    check('解析エラーが起きない', noParseError(r.output), r.output.slice(0, 200));

    const out = path.join(dir, '単体動画.mp4');
    check('MP4 ができる', fs.existsSync(out), fs.readdirSync(dir).join(', '));
    if (fs.existsSync(out)) {
      const info = probeFile(out);
      check('MP4 コンテナになっている', info.format.includes('mp4'), info.format);
      check('映像と音声が保持される', info.hasVideo && info.hasAudio, JSON.stringify(info));
      check('長さが変わらない', Math.abs(info.duration - 6) < 0.6, String(info.duration));
    }
    check('n を指定したので .ts は残る', fs.existsSync(path.join(dir, '単体動画.ts')));

    // 既定どおり両方消す
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
    tempDirs.push(dir2);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-c', 'copy', '-f', 'mpegts', path.join(dir2, '単体動画.ts')]);
    runBat(dir2, '単体動画.変換.bat', convertBat, [], ['', 'y', 'y']);
    const left = fs.readdirSync(dir2);
    check('既定どおり両方消すと MP4 だけが残る',
      left.length === 1 && left[0] === '単体動画.mp4', left.join(', '));
  }

  // ---------------------------------------------------------------
  section('9. 元ファイルが無い場合');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
    tempDirs.push(dir);
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, [], ['', '0', 'y', 'y']);
    check('見つからない旨を伝えて終わる', r.output.includes('見つかりません'), r.output.slice(0, 200));
    check('MP4 は作られない', !fs.existsSync(path.join(dir, 'テスト動画.mp4')));
    check('失敗したときは .bat を消さない', fs.existsSync(path.join(dir, 'テスト動画.結合.bat')));
    check('見つからない経路でも行が壊れない', noParseError(r.output),
      r.output.split(String.fromCharCode(10)).filter((l) => l.includes('認識') || l.includes('recognized')).join(' | '));
  }

  // ---------------------------------------------------------------
  section('10. 保存後にファイル名を変更した場合');
  {
    // 映像・音声・.bat をまとめて別の名前に変えた（.bat の名前から辿れる）
    const dir = freshDir('新しい名前.video.ts', '新しい名前.audio.ts');
    const r = runBat(dir, '新しい名前.結合.bat', mergeBat, [''], ['', '0', 'n', 'n']);
    check('結合: 変更後の名前で元ファイルを見つける', r.ok && !r.output.includes('見つかりません'),
      r.output.slice(-300));
    check('結合: 変更後の名前で MP4 ができる', fs.existsSync(path.join(dir, '新しい名前.mp4')),
      fs.readdirSync(dir).join(', '));
  }
  {
    // .bat の名前だけでは辿れない場合は、共通部分の入力で解決できる
    const dir = freshDir('renamed-only.video.ts', 'renamed-only.audio.ts');
    const r = runBat(dir, 'テスト動画.結合.bat', mergeBat, ['renamed-only'], ['', '0', 'n', 'n']);
    check('結合: 共通部分を入力すれば解決できる', fs.existsSync(path.join(dir, 'renamed-only.mp4')),
      fs.readdirSync(dir).join(', ') + ' / ' + r.output.slice(-200));
  }
  {
    // 変換用も同様に、.bat の名前から辿れる
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
    tempDirs.push(dir);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-c', 'copy', '-f', 'mpegts', path.join(dir, '別の名前.ts')]);
    const convertBat = buildConvertBat({ inputFile: '単体動画.ts', outputFile: '単体動画.mp4' });
    const r = runBat(dir, '別の名前.変換.bat', convertBat, [''], ['', 'n', 'n']);
    check('変換: 変更後の名前で変換元を見つける', r.ok && !r.output.includes('見つかりません'),
      r.output.slice(-300));
    check('変換: 変更後の名前で MP4 ができる', fs.existsSync(path.join(dir, '別の名前.mp4')),
      fs.readdirSync(dir).join(', '));
  }
  {
    // 動画だけ名前を変えて .bat は元のままの場合は、名前の入力で解決できる
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bat-'));
    tempDirs.push(dir);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', sample, '-c', 'copy', '-f', 'mpegts', path.join(dir, 'renamed-single.ts')]);
    const convertBat = buildConvertBat({ inputFile: '単体動画.ts', outputFile: '単体動画.mp4' });
    const r = runBat(dir, '単体動画.変換.bat', convertBat, ['renamed-single'], ['', 'n', 'n']);
    check('変換: 名前を入力すれば解決できる', fs.existsSync(path.join(dir, 'renamed-single.mp4')),
      fs.readdirSync(dir).join(', ') + ' / ' + r.output.slice(-200));
  }

  console.log('\n===================================');
  console.log('  成功 ' + passed + ' / 失敗 ' + failed);
  console.log('===================================');
} finally {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
}

process.exit(failed === 0 ? 0 : 1);
