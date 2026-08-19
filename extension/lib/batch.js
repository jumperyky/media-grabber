// ダウンロードしたファイルを ffmpeg で MP4 にするための Windows バッチファイルを組み立てる。
// chrome API に依存しないため、Node からそのまま実行してテストできる。
//
// 注意: goto / ラベルは使わない。
// cmd.exe は goto の飛び先をバイト位置で探すため、日本語（マルチバイト）を含む
// バッチファイルでは文字の途中に着地して行が壊れることがある。
// そのため分岐は 1 行内で完結させ、打ち切りは exit /b で行う。

/**
 * バッチファイル内に埋め込む文字列を安全にする。
 * cmd.exe では % が変数展開の記号になるため二重にする。
 * その他の記号（& ^ < > |）は set "VAR=値" の形で引用符に囲まれるためそのままでよい。
 */
export function escapeForBatch(value) {
  return String(value).replace(/%/g, '%%');
}

/** バッチファイルは CRLF 改行で書き出す。 */
function join(lines) {
  return lines.join('\r\n') + '\r\n';
}

/** 異常終了する 1 行。メッセージを出して、閉じないように待ってから抜ける。 */
function bail(message) {
  return '(echo.&echo ' + message + '&echo.&pause&exit /b 1)';
}

/** 先頭の共通部分。UTF-8 で保存するため chcp 65001 で文字化けを防ぐ。 */
function header(title) {
  return [
    '@echo off',
    'chcp 65001>nul',
    'cd /d "%~dp0"',
    'title ' + title,
    '',
  ];
}

/** ffmpeg の有無を調べる。無ければその場で終了する。 */
function requireFfmpeg() {
  return [
    'where ffmpeg >nul 2>nul',
    'if errorlevel 1 ' + bail('ffmpeg が見つかりませんでした。ffmpeg を入手し、PATH を通してから実行してください。'),
    '',
  ];
}

/**
 * 保存名を決める。第 1 引数があればそれを使い、無ければ入力を求める。
 * 何も入力せずに Enter を押した場合は既定の名前を使う。拡張子が .mp4 でなければ補う。
 */
function askOutputName() {
  return [
    'set "NEWNAME=%~1"',
    'if "%NEWNAME%"=="" set /p "NEWNAME=保存する名前 (Enter でそのまま: %OUTPUT%): "',
    'if not "%NEWNAME%"=="" set "OUTPUT=%NEWNAME%"',
    'if /i not "%OUTPUT:~-4%"==".mp4" set "OUTPUT=%OUTPUT%.mp4"',
    '',
  ];
}

/**
 * 音ズレの補正値をたずねる。
 *
 * 正の値を指定すると音声を遅らせる（音声が先に聞こえるときに使う）。
 * 負の値は音声を早めることになるが、音声側をマイナス方向にずらすと
 * タイムスタンプが負になって 0 に丸められてしまうため、代わりに映像側を遅らせる。
 */
function askOffset() {
  return [
    'set "OFFSET=%~2"',
    'if "%OFFSET%"=="" echo.',
    'if "%OFFSET%"=="" echo 音ズレがある場合は秒数で補正できます。例 0.2 または -0.15',
    'if "%OFFSET%"=="" echo   音声が先に聞こえるなら 正の値',
    'if "%OFFSET%"=="" echo   音声が後から聞こえるなら 負の値',
    'if "%OFFSET%"=="" set /p "OFFSET=音ズレ補正の秒数 (Enter で補正なし): "',
    'if "%OFFSET%"=="" set "OFFSET=0"',
    '',
    'set "OFFV="',
    'set "OFFA="',
    'if "%OFFSET:~0,1%"=="-" set "OFFV=-itsoffset %OFFSET:~1%"',
    'if not "%OFFSET:~0,1%"=="-" if not "%OFFSET%"=="0" set "OFFA=-itsoffset %OFFSET%"',
    '',
  ];
}

/** 同名ファイルがある場合の上書き確認。 */
function confirmOverwrite() {
  return [
    'set "YN=y"',
    'if exist "%OUTPUT%" (set "YN="&set /p "YN=%OUTPUT% は既にあります。上書きしますか? [y/N]: ")',
    'if /i not "%YN%"=="y" ' + bail('中止しました。'),
    '',
  ];
}

/** 実行して結果を伝える部分。 */
function runAndReport(command, extraNote) {
  return [
    'echo.',
    'echo 処理しています... (再エンコードしないためすぐ終わります)',
    command,
    'if errorlevel 1 ' + bail('失敗しました。上に表示されたメッセージを確認してください。'),
    'echo.',
    'echo 完了しました: %OUTPUT%',
    ...(extraNote ? ['echo ' + extraNote] : []),
    'echo.',
    'pause',
  ];
}

/**
 * 映像と音声が別ファイルになった場合の、結合用バッチファイル。
 * 再エンコードしないため画質・音質は劣化しない。
 */
export function buildMergeBat({ videoFile, audioFile, outputFile }) {
  return join([
    ...header('映像と音声を結合して MP4 にする'),
    'set "VIDEO=' + escapeForBatch(videoFile) + '"',
    'set "AUDIO=' + escapeForBatch(audioFile) + '"',
    'set "OUTPUT=' + escapeForBatch(outputFile) + '"',
    '',
    'echo ------------------------------------------------',
    'echo  映像と音声を結合して MP4 にします',
    'echo ------------------------------------------------',
    'echo.',
    'echo   映像: %VIDEO%',
    'echo   音声: %AUDIO%',
    'echo.',
    '',
    'if not exist "%VIDEO%" ' + bail('映像ファイルが見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    'if not exist "%AUDIO%" ' + bail('音声ファイルが見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    '',
    ...requireFfmpeg(),
    ...askOutputName(),
    ...askOffset(),
    ...confirmOverwrite(),
    ...runAndReport(
      'ffmpeg -hide_banner -loglevel error -y %OFFV% -i "%VIDEO%" %OFFA% -i "%AUDIO%" -c copy "%OUTPUT%"',
      'ズレが残る場合は、もう一度実行して補正値を変えてください。',
    ),
  ]);
}

/**
 * 1 本の .ts などを MP4 に変換するバッチファイル。
 * こちらも入れ物を作り直すだけで、再エンコードはしない。
 * 映像と音声が同じファイルに入っているため、音ズレ補正は用意しない。
 */
export function buildConvertBat({ inputFile, outputFile }) {
  return join([
    ...header('MP4 に変換する'),
    'set "INPUT=' + escapeForBatch(inputFile) + '"',
    'set "OUTPUT=' + escapeForBatch(outputFile) + '"',
    '',
    'echo ------------------------------------------------',
    'echo  MP4 に変換します',
    'echo ------------------------------------------------',
    'echo.',
    'echo   変換元: %INPUT%',
    'echo.',
    '',
    'if not exist "%INPUT%" ' + bail('変換元が見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    '',
    ...requireFfmpeg(),
    ...askOutputName(),
    ...confirmOverwrite(),
    ...runAndReport('ffmpeg -hide_banner -loglevel error -y -i "%INPUT%" -c copy "%OUTPUT%"'),
  ]);
}

/** 拡張子を .mp4 に置き換えた名前を作る。`.video` のような役割部分も取り除く。 */
export function mp4NameFor(filename) {
  return String(filename)
    .replace(/\.(video|audio)(\.[a-z0-9]+)?$/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    + '.mp4';
}
