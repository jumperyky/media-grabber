// 実際の Chrome に拡張機能を読み込み、ポップアップ UI を操作して動画を保存するところまで確認する。
// Chrome 137 以降は --load-extension に --remote-debugging-pipe が必要なため、パイプ経由の CDP を使う。
// 使い方: node test/e2e-chrome.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp-pipe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, '..', 'extension');
const fixtures = path.join(here, 'fixtures');
const pageDir = path.join(here, 'page');
const downloadDir = path.join(here, 'e2e-downloads');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + name); }
  else { failed += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  // 通常版 Chrome (137 以降) は --load-extension を受け付けないため、
  // test/browser に取得した Chrome for Testing を優先して使う。
  //   npx @puppeteer/browsers install chrome@stable --path test/browser
  const cftRoot = path.join(here, 'browser', 'chrome');
  if (fs.existsSync(cftRoot)) {
    for (const dir of fs.readdirSync(cftRoot)) {
      const exe = path.join(cftRoot, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function startServer() {
  const types = {
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.mpd': 'application/dash+xml',
    '.ts': 'video/mp2t',
    '.m4s': 'video/iso.segment',
    '.mp4': 'video/mp4',
    '.html': 'text/html; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const root = rel === '/index.html' ? pageDir : fixtures;
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(label, fn, timeoutMs = 40000, intervalMs = 500) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('タイムアウト: ' + label);
    await sleep(intervalMs);
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map(String)
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
}

function probeFile(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  const json = JSON.parse(out);
  const v = json.streams.find((s) => s.codec_type === 'video') || null;
  const a = json.streams.find((s) => s.codec_type === 'audio') || null;
  return {
    duration: Number(json.format.duration || 0),
    width: v ? v.width : null,
    height: v ? v.height : null,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

/** 一覧の中から指定バッジの項目のボタンを押す式。 */
function clickExpr(badgeText) {
  return `(() => {
    const nodes = [...document.querySelectorAll('.item')];
    const target = nodes.find(n => n.querySelector('.badge').textContent === ${JSON.stringify(badgeText)});
    if (!target) return 'not-found';
    target.querySelector('button.primary').click();
    return 'clicked';
  })()`;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('Chrome が見つかりませんでした。E2E をスキップします。');
    process.exit(0);
  }

  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const { server, port } = await startServer();
  const pageUrl = 'http://127.0.0.1:' + port + '/index.html';
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-profile-'));
  // 保存先はプロファイル設定で指定する。
  // CDP の Browser.setDownloadBehavior を使うと拡張機能が指定したファイル名が
  // GUID で上書きされてしまい、命名規則を検証できないため。
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({
    download: {
      default_directory: downloadDir,
      prompt_for_download: false,
      directory_upgrade: true,
    },
    savefile: { default_directory: downloadDir },
    extensions: { ui: { developer_mode: true } },
  }));

  section('0. Chrome を起動して拡張機能を読み込む');
  const { child, cdp } = launchChrome(chromePath, [
    '--user-data-dir=' + profileDir,
    '--load-extension=' + extDir,
    '--disable-extensions-except=' + extDir,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ]);

  try {
    await waitFor('Chrome の起動', async () => {
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      return true;
    }, 30000, 500);
    check('Chrome が起動した', true);

    // 拡張機能の Service Worker を見つけて、それが自分の拡張か確認する
    const swInfo = await waitFor('拡張機能の Service Worker', async () => {
      const targets = await cdp.getTargets();
      for (const t of targets) {
        if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://')) continue;
        const sessionId = await cdp.attach(t.targetId);
        const name = await cdp.evaluate(sessionId, 'chrome.runtime.getManifest().name');
        if (name === 'Media Grabber') return { target: t, sessionId };
      }
      return null;
    }, 30000);
    const extId = new URL(swInfo.target.url).host;
    check('拡張機能 "Media Grabber" が読み込まれた', !!extId, extId);

    // ---------------------------------------------------------------
    section('1. ページ上の動画を検出する');
    const pageTargetId = await cdp.createTarget(pageUrl);
    const pageSession = await cdp.attach(pageTargetId);
    await cdp.send('Runtime.enable', {}, pageSession);
    await waitFor('テストページの読み込み', async () => {
      const text = await cdp.evaluate(pageSession, 'document.getElementById("log").textContent');
      return text && text.includes('ready');
    });
    check('テストページを開いた', true);

    // Service Worker 側から対象タブの ID を取得する
    const contentTabId = await waitFor('タブ ID の取得', async () => {
      const id = await cdp.evaluate(swInfo.sessionId,
        'chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ' + JSON.stringify(pageUrl) + ') || {}).id ?? null)');
      return Number.isInteger(id) ? id : null;
    });
    check('対象タブの ID を取得', Number.isInteger(contentTabId), String(contentTabId));

    // 検出結果はポップアップ（拡張機能ページ）から確認する
    const popupUrl = 'chrome-extension://' + extId + '/popup/popup.html?tabId=' + contentTabId;
    const popupTargetId = await cdp.createTarget(popupUrl);
    const popup = await cdp.attach(popupTargetId);
    await cdp.send('Runtime.enable', {}, popup);

    const detected = await waitFor('メディアの検出', async () => {
      const list = await cdp.evaluate(popup,
        'chrome.runtime.sendMessage({type:"LIST", tabId:' + contentTabId + '}).then(r => r.items)');
      return list && list.length >= 3 ? list : null;
    });

    const kinds = detected.map((i) => i.kind);
    check('直リンク(MP4)を検出', kinds.includes('direct'), JSON.stringify(kinds));
    check('HLS を検出', kinds.includes('hls'), JSON.stringify(kinds));
    check('DASH を検出', kinds.includes('dash'), JSON.stringify(kinds));

    const rendered = await waitFor('一覧の描画', async () => {
      const n = await cdp.evaluate(popup, 'document.querySelectorAll(".item").length');
      return n >= 3 ? n : null;
    });
    check('ポップアップ UI に一覧が表示される', rendered >= 3, String(rendered));

    const badge = await cdp.evaluate(popup, 'chrome.action.getBadgeText({tabId:' + contentTabId + '})');
    check('ツールバーのバッジに件数が出る', Number(badge) >= 3, String(badge));

    // 再生中の動画からコマを取り出してサムネイルにできているか
    const thumbInfo = await waitFor('サムネイルの生成', async () => {
      const r = await cdp.evaluate(popup, `(() => {
        const imgs = [...document.querySelectorAll('.thumb img')];
        return JSON.stringify({
          count: imgs.length,
          isFrame: imgs.every(i => i.src.startsWith('data:image/jpeg')),
          loaded: imgs.filter(i => i.naturalWidth > 0).length,
          durations: [...document.querySelectorAll('.thumb-duration')].map(d => d.textContent),
        });
      })()`);
      const parsed = JSON.parse(r);
      return parsed.count >= 3 && parsed.loaded >= 3 ? parsed : null;
    }, 30000, 1000);
    check('全項目にサムネイルが表示される', thumbInfo.count >= 3, JSON.stringify(thumbInfo));
    check('動画のコマから生成されている', thumbInfo.isFrame, JSON.stringify(thumbInfo));
    check('サムネイル画像が実際に読み込まれている', thumbInfo.loaded >= 3, String(thumbInfo.loaded));
    check('再生時間バッジが出る（6秒 = 0:06）',
      thumbInfo.durations.some((d) => d === '0:06'), JSON.stringify(thumbInfo.durations));

    // ---------------------------------------------------------------
    section('2. マスターかどうかを自動で見分ける');
    const labels = await waitFor('画質の自動判別', async () => {
      const r = await cdp.evaluate(popup, `(() => {
        const items = [...document.querySelectorAll('.item')];
        return JSON.stringify(items.map(n => ({
          kind: n.querySelector('.badge').textContent,
          recommended: !!n.querySelector('.tag.recommended'),
          info: ([...n.querySelectorAll('.item-meta .strong')][0] || {}).textContent || null,
          options: [...n.querySelectorAll('select option')].map(o => o.textContent),
        })));
      })()`);
      const parsed = JSON.parse(r);
      return parsed.filter((p) => p.kind !== '直リンク').every((p) => p.info) ? parsed : null;
    }, 40000, 1000);

    const hlsLabel = labels.find((l) => l.kind === 'HLS');
    check('開いただけで HLS がマスターと判別される',
      hlsLabel && hlsLabel.info.includes('マスター'), JSON.stringify(hlsLabel));
    check('マスターに推奨マークが付く', hlsLabel && hlsLabel.recommended === true);
    check('画質候補が推定サイズ付きで並ぶ',
      hlsLabel.options.some((o) => o.includes('360p') && o.includes('約')), JSON.stringify(hlsLabel.options));
    check('画質候補が 2 件（ボタンを押さずに取得済み）', hlsLabel.options.length === 2,
      JSON.stringify(hlsLabel.options));

    // ---------------------------------------------------------------
    section('3. UI のボタンを押して HLS を保存する');
    const clicked = await cdp.evaluate(popup, clickExpr('HLS'));
    check('HLS 項目のダウンロードボタンを押せた', clicked === 'clicked', String(clicked));

    const hlsFile = await waitFor('HLS の保存完了', () => {
      const files = listFiles(downloadDir).filter((f) => !f.endsWith('.crdownload'));
      return files.length ? files[0] : null;
    }, 90000, 700);
    await waitFor('書き込みの完了', () => fs.statSync(hlsFile).size > 100000, 30000, 400);
    await sleep(1000);

    const info = probeFile(hlsFile);
    check('保存されたファイルが再生可能', info.hasVideo, JSON.stringify(info));
    check('長さが 6 秒', Math.abs(info.duration - 6) < 0.6, String(info.duration));
    check('最高画質 640x360 が選ばれる', info.width === 640 && info.height === 360, info.width + 'x' + info.height);
    check('音声が含まれる', info.hasAudio);
    check('設定したサブフォルダに保存される',
      hlsFile.replace(/\\/g, '/').includes('/MediaGrabber/'), hlsFile);

    // ---------------------------------------------------------------
    section('4. 直リンク(MP4)を保存する');
    const before = listFiles(downloadDir).length;
    const clicked2 = await cdp.evaluate(popup, clickExpr('直リンク'));
    check('直リンク項目のダウンロードボタンを押せた', clicked2 === 'clicked', String(clicked2));

    const mp4File = await waitFor('MP4 の保存完了', () => {
      const files = listFiles(downloadDir).filter((f) => !f.endsWith('.crdownload') && /\.mp4$/i.test(f));
      return files.length && listFiles(downloadDir).length > before ? files[files.length - 1] : null;
    }, 60000, 700);
    await sleep(1000);
    const mp4Info = probeFile(mp4File);
    check('MP4 が再生可能で 6 秒', mp4Info.hasVideo && Math.abs(mp4Info.duration - 6) < 0.6, JSON.stringify(mp4Info));

    // ---------------------------------------------------------------
    section('5. ジョブの状態を確認する');
    const jobStates = await cdp.evaluate(popup,
      'chrome.runtime.sendMessage({type:"LIST", tabId:' + contentTabId + '}).then(r => r.jobs.map(j => j.state + (j.error ? ":" + j.error : "")))');
    check('失敗したジョブが無い', !jobStates.some((s) => s.startsWith('error')), JSON.stringify(jobStates));
    check('完了したジョブが 2 件', jobStates.filter((s) => s === 'done').length >= 2, JSON.stringify(jobStates));

    console.log('\n保存されたファイル:');
    for (const f of listFiles(downloadDir)) {
      console.log('  ' + path.relative(downloadDir, f) + '  (' + fs.statSync(f).size + ' bytes)');
    }
  } finally {
    try { child.kill(); } catch { /* 既に終了している */ }
    await sleep(1200);
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  console.log('\n===================================');
  console.log('  成功 ' + passed + ' / 失敗 ' + failed);
  console.log('===================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E が異常終了しました:', err);
  process.exit(1);
});
