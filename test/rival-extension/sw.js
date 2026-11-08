// Video Download Helper と同じ振る舞いの再現。
// 自分が始めたものかどうかに関わらず suggest() を「引数なし」で呼ぶ。
// これをされると、相手の拡張機能が downloads.download() に渡した filename は
// 捨てられ、ブラウザ既定の名前（blob URL なら UUID、data URL なら "ダウンロード"）
// で保存されてしまう。Media Grabber 側が自分で名乗り返せているかを確かめるために使う。
//
// なお onDeterminingFilename は「最後にインストールされた拡張機能」の提案が通る。
// E2E ではこの拡張機能を先に読み込み、Media Grabber をあとに読み込むことで、
// 利用者の環境（Media Grabber のほうがあとからインストールされている）に合わせている。
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggest();
});
