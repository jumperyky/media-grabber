// ダウンロードしたファイルを ffmpeg で MP4 にするための Windows バッチファイルを組み立てる。
// chrome API に依存しないため、Node からそのまま実行してテストできる。
//
// 注意 0: 書き出しは必ず lib/cp932.js の encodeBatchFile を通す。
//   cmd.exe は起動時のコードページ（日本語環境では CP932）でバッチを解析するため、
//   UTF-8 で書くとバイト境界がずれて行が分断される。
//
// 注意 1: ラベル付きの goto は使わない。
//   cmd.exe は goto の飛び先をバイト位置で探すため、日本語（マルチバイト）を含む
//   バッチファイルでは文字の途中に着地して行が壊れることがある。
//   そのため分岐は 1 行内で完結させ、打ち切りは exit /b で行う。
//
// 注意 2: 対話で聞く項目はコマンドライン引数でも渡せるようにしてある。
//   パイプ経由の stdin では set /p が 2 回目以降を読めないため、
//   自動テストから複数の項目を与えるには引数が必要になる。
//
// 注意 3: 元ファイルの名前は決め打ちにしない。
//   保存後にファイル名を変更することがあるため、決め打ちの名前が見つからない場合は
//   この .bat 自身の名前から探し、それでも見つからなければ入力を求める。

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

/** 先頭の共通部分。CP932 で書き出すため chcp は使わない。 */
function header(title) {
  return [
    '@echo off',
    'cd /d "%~dp0"',
    'title ' + title,
    '',
  ];
}

/**
 * この .bat の名前から、元ファイルの共通部分を割り出す。
 * 「動画.変換.bat」なら %~n0 が「動画.変換」なので、さらに拡張子を落として「動画」を得る。
 * ファイル名を変更した場合は .bat も同じ名前に変えれば、これで対応が付く。
 */
function deriveBase() {
  return [
    'for %%A in ("%~n0") do set "BASE=%%~nA"',
    '',
  ];
}

/** 結合用: BASE から映像・音声を探す。見つかっているものは触らない。 */
function findMergeSources() {
  const lines = [];
  for (const [role, varName] of [['video', 'VIDEO'], ['audio', 'AUDIO']]) {
    for (const ext of ['ts', 'mp4', 'webm', 'mkv']) {
      lines.push('if not exist "%' + varName + '%" if exist "%BASE%.' + role + '.' + ext
        + '" set "' + varName + '=%BASE%.' + role + '.' + ext + '"');
    }
  }
  lines.push('');
  return lines;
}

/** 変換用: BASE から変換元を探す。.mp4 は出力と紛らわしいので最後に試す。 */
function findConvertSource() {
  const lines = [];
  for (const ext of ['ts', 'webm', 'mkv', 'm4v', 'mp4']) {
    lines.push('if not exist "%INPUT%" if exist "%BASE%.' + ext + '" set "INPUT=%BASE%.' + ext + '"');
  }
  lines.push('');
  return lines;
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
 * 音ズレの補正値をたずねる（第 2 引数でも指定可）。
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

/** ffmpeg を実行し、出力ができたことまで確かめる。 */
function runFfmpeg(command) {
  return [
    'echo.',
    'echo 処理しています... (再エンコードしないためすぐ終わります)',
    command,
    'if errorlevel 1 ' + bail('失敗しました。上に表示されたメッセージを確認してください。'),
    // 元ファイルを消す前に、出力が本当にできているかを必ず確認する
    'if not exist "%OUTPUT%" ' + bail('出力ファイルが作られませんでした。元のファイルはそのまま残します。'),
    'echo.',
    'echo 完了しました: %OUTPUT%',
    '',
  ];
}

/**
 * 元ファイルを消すかたずねる。既定は削除で、残したいときだけ n を入力する。
 * 出力ができていることを確認したあとでのみ呼ぶこと。
 */
function askDeleteSources(vars, argRef) {
  const lines = [
    'set "DELSRC=' + argRef + '"',
    'if "%DELSRC%"=="" set /p "DELSRC=元のファイルを削除しますか? (Enter で削除 / n で残す): "',
    'if "%DELSRC%"=="" set "DELSRC=y"',
    '',
  ];
  for (const name of vars) {
    lines.push('if /i "%DELSRC%"=="y" if exist "%' + name + '%" del /q "%' + name + '%"');
  }
  lines.push(
    'if /i "%DELSRC%"=="y" echo 元のファイルを削除しました。',
    'if /i not "%DELSRC%"=="y" echo 元のファイルは残しました。',
    '',
  );
  return lines;
}

/**
 * この .bat 自身を消すかたずねる。既定は削除。
 * 実際の削除は最終行で行う（削除後は以降の行を読めないため）。
 */
function askDeleteSelf(argRef) {
  return [
    'set "DELSELF=' + argRef + '"',
    'if "%DELSELF%"=="" set /p "DELSELF=この .bat も削除しますか? (Enter で削除 / n で残す): "',
    'if "%DELSELF%"=="" set "DELSELF=y"',
    'if /i "%DELSELF%"=="y" echo この .bat は閉じるときに削除されます。',
    '',
  ];
}

/**
 * 終了処理。自身の削除は必ず最終行に置く。
 *
 * 単に del すると、削除後に cmd が次の行を読もうとして
 * 「The batch file cannot be found.」を表示してしまう。
 * ラベルなしの `(goto)` はバッチの実行文脈をその場で打ち切るため、これを防げる。
 * ラベルを持たないので、goto 本来のバイト位置探索（日本語行が壊れる原因）は起きない。
 */
function finish() {
  return [
    'echo.',
    'pause',
    'if /i "%DELSELF%"=="y" ((goto) 2>nul & del /q "%~f0")',
  ];
}

/**
 * 映像と音声が別ファイルになった場合の、結合用バッチファイル。
 * 再エンコードしないため画質・音質は劣化しない。
 * 引数: %1 保存名 / %2 音ズレ補正 / %3 元ファイル削除 / %4 自身の削除
 */
export function buildMergeBat({ videoFile, audioFile }) {
  return join([
    ...header('映像と音声を結合して MP4 にする'),
    'echo ------------------------------------------------',
    'echo  映像と音声を結合して MP4 にします',
    'echo ------------------------------------------------',
    '',
    // 保存時の名前をまず試す（名前を渡さない場合は .bat 名からの推定だけで解決する）
    ...(videoFile && audioFile ? [
      'set "VIDEO=' + escapeForBatch(videoFile) + '"',
      'set "AUDIO=' + escapeForBatch(audioFile) + '"',
      'if not exist "%VIDEO%" set "VIDEO="',
      'if not exist "%AUDIO%" set "AUDIO="',
    ] : ['set "VIDEO="', 'set "AUDIO="']),
    '',
    // 見つからなければ、この .bat の名前から探す
    ...deriveBase(),
    ...findMergeSources(),
    // それでも見つからなければ、共通部分を入力してもらう
    'if not exist "%VIDEO%" echo.',
    'if not exist "%VIDEO%" echo 元のファイルが見つかりませんでした。',
    'if not exist "%VIDEO%" echo 名前を変更した場合は、その共通部分を入力してください。',
    'if not exist "%VIDEO%" echo 例) 動画.video.ts なら 動画 と入力',
    'if not exist "%VIDEO%" set /p "BASE=共通部分: "',
    ...findMergeSources(),
    '',
    'if not exist "%VIDEO%" ' + bail('映像ファイルが見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    'if not exist "%AUDIO%" ' + bail('音声ファイルが見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    '',
    'set "OUTPUT=%BASE%.mp4"',
    'echo.',
    'echo   映像: %VIDEO%',
    'echo   音声: %AUDIO%',
    'echo.',
    '',
    ...requireFfmpeg(),
    ...askOutputName(),
    ...askOffset(),
    ...confirmOverwrite(),
    ...runFfmpeg('ffmpeg -hide_banner -loglevel error -y %OFFV% -i "%VIDEO%" %OFFA% -i "%AUDIO%" -c copy "%OUTPUT%"'),
    'echo ズレが残る場合は、元のファイルを残したうえで補正値を変えて実行し直してください。',
    'echo.',
    ...askDeleteSources(['VIDEO', 'AUDIO'], '%~3'),
    ...askDeleteSelf('%~4'),
    ...finish(),
  ]);
}

/**
 * 1 本の .ts などを MP4 に変換するバッチファイル。
 * こちらも入れ物を作り直すだけで、再エンコードはしない。
 * 映像と音声が同じファイルに入っているため、音ズレ補正は用意しない。
 * 引数: %1 保存名 / %2 元ファイル削除 / %3 自身の削除
 */
export function buildConvertBat({ inputFile }) {
  return join([
    ...header('MP4 に変換する'),
    'echo ------------------------------------------------',
    'echo  MP4 に変換します',
    'echo ------------------------------------------------',
    '',
    ...(inputFile ? [
      'set "INPUT=' + escapeForBatch(inputFile) + '"',
      'if not exist "%INPUT%" set "INPUT="',
    ] : ['set "INPUT="']),
    '',
    ...deriveBase(),
    ...findConvertSource(),
    'if not exist "%INPUT%" echo.',
    'if not exist "%INPUT%" echo 変換元が見つかりませんでした。',
    'if not exist "%INPUT%" echo 名前を変更した場合は、拡張子を除いた名前を入力してください。',
    'if not exist "%INPUT%" echo 例) 動画.ts なら 動画 と入力',
    'if not exist "%INPUT%" set /p "BASE=名前: "',
    ...findConvertSource(),
    '',
    'if not exist "%INPUT%" ' + bail('変換元が見つかりません。この .bat は動画と同じフォルダーで実行してください。'),
    '',
    'set "OUTPUT=%BASE%.mp4"',
    'echo.',
    'echo   変換元: %INPUT%',
    'echo.',
    '',
    ...requireFfmpeg(),
    ...askOutputName(),
    ...confirmOverwrite(),
    ...runFfmpeg('ffmpeg -hide_banner -loglevel error -y -i "%INPUT%" -c copy "%OUTPUT%"'),
    ...askDeleteSources(['INPUT'], '%~2'),
    ...askDeleteSelf('%~3'),
    ...finish(),
  ]);
}

/** 拡張子を .mp4 に置き換えた名前を作る。`.video` のような役割部分も取り除く。 */
export function mp4NameFor(filename) {
  return String(filename)
    .replace(/\.(video|audio)(\.[a-z0-9]+)?$/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    + '.mp4';
}
