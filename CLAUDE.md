# CLAUDE.md

Media Grabber。ページ上の動画（直リンク / HLS / DASH）を検出して保存する Chrome 拡張機能（Manifest V3）。
使い方・構成・既知の制約は [README.md](./README.md)。ここには守ることだけを書く。

GitHub のリポジトリ名は `media-grabber`（**公開**）。フォルダ名と違うので注意。

## 守ること

- **DRM 保護コンテンツには対応しない。** DASH の `ContentProtection` や SAMPLE-AES を検出したら中止する、
  という現在の挙動を外したり緩めたりしない。鍵が URL で公開されている AES-128 の HLS だけが対象。
- `extension/lib/` は Chrome API に依存させない。Node からそのまま実行してテストしているため。
- `.bat` は CP932 で書き出す（`lib/cp932.js`）。UTF-8 にすると日本語のファイル名で壊れる。
- 公開リポジトリなので、テスト用の動画は `tools/make-fixtures.mjs` で生成したものだけを置く。

## テスト

```bash
npm run fixtures   # 初回だけ。ffmpeg / ffprobe が必要
npm test
```

`test:core` / `test:bat` / `test:ext` / `test:e2e` の 4 つをまとめて走らせる。
E2E は Chrome for Testing を使う（通常の Chrome は 137 以降 `--load-extension` が無効）。
入れ方は README の「テスト」を参照。

## 関連

YouTube は配信方式が違うため、この拡張では扱わない。`N:\Project\youtube-media-saver` が別実装。
