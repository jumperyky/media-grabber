// 拡張機能本体（manifest / background）の検証。
// chrome API をスタブ化して background.js を読み込み、実際の呼ばれ方を確認する。
// 使い方: node test/test-extension.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, '..', 'extension');

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

// ---------------------------------------------------------------------------
section('1. manifest とファイル構成');

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
check('manifest_version が 3', manifest.manifest_version === 3);
check('Service Worker が module 形式', manifest.background.type === 'module');

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((cs) => cs.js),
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'popup/popup.css',
  'popup/popup.js',
  'lib/util.js',
  'lib/m3u8.js',
  'lib/mpd.js',
  'lib/xml.js',
  'lib/downloader.js',
];
const missing = referenced.filter((rel) => !fs.existsSync(path.join(extDir, rel)));
check('参照している全ファイルが存在する', missing.length === 0, missing.join(', '));

const needed = ['webRequest', 'downloads', 'storage', 'tabs', 'offscreen', 'declarativeNetRequestWithHostAccess'];
check('必要な権限が揃っている', needed.every((p) => manifest.permissions.includes(p)));

// 全 JS ファイルの構文チェック
const jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
})(extDir);

const syntaxErrors = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-syntax-'));
for (const file of jsFiles) {
  const copy = path.join(tmp, path.basename(file) + '.mjs');
  fs.writeFileSync(copy, fs.readFileSync(file));
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
  } catch (err) {
    syntaxErrors.push(path.basename(file) + ': ' + String(err.stderr || err.message).split('\n')[0]);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
check('全 JS ファイルが構文エラーなし (' + jsFiles.length + ' 件)', syntaxErrors.length === 0, syntaxErrors.join(' | '));

// ---------------------------------------------------------------------------
section('2. background.js の動作（chrome API スタブ）');

const calls = { downloads: [], badges: [], offscreenCreated: 0, dnrRules: [], notifications: [] };
let headersListener = null;
let messageListener = null;
let tabUpdatedListener = null;

function listenerSlot(assign) {
  return { addListener: (fn) => assign(fn) };
}

let offscreenResponder = async () => ({ ok: false, error: 'stub 未設定' });

globalThis.chrome = {
  runtime: {
    onMessage: listenerSlot((fn) => { messageListener = fn; }),
    sendMessage: async (msg) => {
      if (msg && msg.target === 'offscreen') return offscreenResponder(msg);
      calls.notifications.push(msg);
      return undefined;
    },
    getContexts: async () => (calls.offscreenCreated ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
  },
  storage: {
    local: {
      _data: {},
      async get(key) { return key in this._data ? { [key]: this._data[key] } : {}; },
      async set(obj) { Object.assign(this._data, obj); },
    },
  },
  action: {
    setBadgeText: async (o) => { calls.badges.push(o); },
    setBadgeBackgroundColor: async () => {},
  },
  webRequest: { onHeadersReceived: listenerSlot((fn) => { headersListener = fn; }) },
  tabs: {
    onUpdated: listenerSlot((fn) => { tabUpdatedListener = fn; }),
    onRemoved: listenerSlot(() => {}),
    get: async (id) => ({ id, title: 'タブのタイトル', url: 'https://example.com/watch' }),
  },
  downloads: {
    download: async (opts) => { calls.downloads.push(opts); return calls.downloads.length; },
  },
  offscreen: {
    createDocument: async () => { calls.offscreenCreated += 1; },
  },
  declarativeNetRequest: {
    updateSessionRules: async (o) => { calls.dnrRules.push(o); },
  },
};

await import(pathToFileURL(path.join(extDir, 'background.js')).href);

check('webRequest リスナーを登録した', typeof headersListener === 'function');
check('メッセージリスナーを登録した', typeof messageListener === 'function');

/** background にメッセージを送って応答を受け取る。 */
function sendToBackground(msg, sender = {}) {
  return new Promise((resolve) => {
    messageListener(msg, sender, resolve);
  });
}

function fireHeaders(url, contentType, contentLength, tabId = 1) {
  headersListener({
    tabId,
    url,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Content-Length', value: String(contentLength) },
    ],
  });
}

const TAB = 1;
await sendToBackground({ type: 'PAGE_INFO', title: 'サンプル動画のページ', url: 'https://example.com/watch' },
  { tab: { id: TAB }, frameId: 0 });
await sendToBackground({
  type: 'PAGE_MEDIA',
  title: 'サンプル動画のページ',
  url: 'https://example.com/watch',
  thumbnail: 'data:image/jpeg;base64,AAAA',
  duration: 754,
}, { tab: { id: TAB }, frameId: 0 });

fireHeaders('https://cdn.example.com/master.m3u8', 'application/vnd.apple.mpegurl', 1200);
fireHeaders('https://cdn.example.com/movie.mp4', 'video/mp4', 50 * 1024 * 1024);
fireHeaders('https://cdn.example.com/tiny.mp4', 'video/mp4', 4096);
fireHeaders('https://cdn.example.com/seg1.ts', 'video/mp2t', 900000);
fireHeaders('https://cdn.example.com/logo.png', 'image/png', 20000);
fireHeaders('https://cdn.example.com/manifest.mpd', 'application/dash+xml', 3000);
fireHeaders('https://cdn.example.com/master.m3u8', 'application/vnd.apple.mpegurl', 1200); // 重複

const listed = await sendToBackground({ type: 'LIST', tabId: TAB });
const kinds = listed.items.map((i) => i.kind).sort();
check('HLS / DASH / 直リンクの 3 件のみ検出', listed.items.length === 3,
  JSON.stringify(listed.items.map((i) => i.url)));
check('種別が正しい', JSON.stringify(kinds) === JSON.stringify(['dash', 'direct', 'hls']), JSON.stringify(kinds));
check('同一 URL は重複登録しない', listed.items.filter((i) => i.url.endsWith('master.m3u8')).length === 1);
check('セグメント(.ts)と画像は除外', !listed.items.some((i) => /seg1\.ts|logo\.png/.test(i.url)));
check('小さすぎる mp4 は除外', !listed.items.some((i) => i.url.includes('tiny.mp4')));
check('ページのタイトルを保持', listed.page.title === 'サンプル動画のページ');
check('ネットワーク検出の項目にもページのサムネイルが付く',
  listed.items.every((i) => i.thumbnail === 'data:image/jpeg;base64,AAAA'));
check('再生時間もページから補完される', listed.items.every((i) => i.duration === 754));
check('再生リストのサイズは動画サイズと別扱い',
  listed.items.find((i) => i.kind === 'hls').size === 1200);
check('バッジに件数を表示', calls.badges.at(-1).text === '3', JSON.stringify(calls.badges.at(-1)));

// ---------------------------------------------------------------------------
section('3. 直リンクのダウンロード');

await sendToBackground({
  type: 'SAVE_SETTINGS',
  settings: { subfolder: 'MediaGrabber', saveAs: false, concurrency: 6 },
});

const directItem = listed.items.find((i) => i.kind === 'direct');
const r1 = await sendToBackground({ type: 'START_DOWNLOAD', tabId: TAB, itemId: directItem.id });
check('ダウンロード開始が成功を返す', r1.ok === true, JSON.stringify(r1));
await new Promise((r) => setTimeout(r, 50));

const dl = calls.downloads.at(-1);
check('chrome.downloads.download を呼ぶ', !!dl);
check('元 URL をそのまま渡す（大容量でもメモリを使わない）', dl.url === 'https://cdn.example.com/movie.mp4');
check('サブフォルダとページタイトルからファイル名を決める',
  dl.filename === 'MediaGrabber/サンプル動画のページ.mp4', dl.filename);
check('重複時は自動連番', dl.conflictAction === 'uniquify');

// ---------------------------------------------------------------------------
section('4. HLS のダウンロード（offscreen 連携）');

let offscreenRequest = null;
offscreenResponder = async (msg) => {
  if (msg.type === 'DOWNLOAD_STREAM') {
    offscreenRequest = msg;
    return {
      ok: true,
      parts: [
        { role: 'video', ext: 'mp4', bytes: 1000, blobUrl: 'blob:chrome-extension://x/v' },
        { role: 'audio', ext: 'mp4', bytes: 200, blobUrl: 'blob:chrome-extension://x/a' },
      ],
    };
  }
  return { ok: true };
};

const hlsItem = listed.items.find((i) => i.kind === 'hls');
calls.downloads.length = 0;
await sendToBackground({ type: 'START_DOWNLOAD', tabId: TAB, itemId: hlsItem.id, variantIndex: 1 });
await new Promise((r) => setTimeout(r, 100));

check('offscreen ドキュメントを作成した', calls.offscreenCreated === 1);
check('offscreen に種別と URL を渡した',
  offscreenRequest && offscreenRequest.kind === 'hls' && offscreenRequest.url.endsWith('master.m3u8'));
check('選択した画質を渡した', offscreenRequest.variantIndex === 1);
check('Referer を付与する DNR ルールを追加した',
  calls.dnrRules.some((r) => (r.addRules || []).some((x) => x.action.requestHeaders.some((h) => h.header === 'referer'))));
check('ダウンロード後に DNR ルールを削除した',
  calls.dnrRules.at(-1).removeRuleIds && !calls.dnrRules.at(-1).addRules);
check('映像と音声を 2 ファイルとして保存', calls.downloads.length === 2, String(calls.downloads.length));
check('映像ファイル名に .video を付与',
  calls.downloads[0].filename === 'MediaGrabber/サンプル動画のページ.video.mp4', calls.downloads[0].filename);
check('音声ファイル名に .audio を付与',
  calls.downloads[1].filename === 'MediaGrabber/サンプル動画のページ.audio.mp4', calls.downloads[1].filename);

const afterJobs = await sendToBackground({ type: 'LIST', tabId: TAB });
check('ジョブが完了状態になる', afterJobs.jobs.some((j) => j.state === 'done'));

// ---------------------------------------------------------------------------
section('5. エラーと後片付け');

offscreenResponder = async () => ({ ok: false, error: '暗号化されたストリームには対応していません' });
calls.downloads.length = 0;
await sendToBackground({ type: 'START_DOWNLOAD', tabId: TAB, itemId: hlsItem.id });
await new Promise((r) => setTimeout(r, 100));
const jobsAfterError = await sendToBackground({ type: 'LIST', tabId: TAB });
check('失敗したジョブがエラーとして残る',
  jobsAfterError.jobs.some((j) => j.state === 'error' && j.error.includes('暗号化')));
check('失敗時はファイルを保存しない', calls.downloads.length === 0);

tabUpdatedListener(TAB, { url: 'https://example.com/other' });
const afterNav = await sendToBackground({ type: 'LIST', tabId: TAB });
check('ページ遷移で検出結果をリセット', afterNav.items.length === 0);
check('リセット時にバッジを消す', calls.badges.at(-1).text === '');

// ---------------------------------------------------------------------------
console.log('\n===================================');
console.log('  成功 ' + passed + ' / 失敗 ' + failed);
console.log('===================================');
process.exit(failed === 0 ? 0 : 1);
