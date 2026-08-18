// ポップアップの見た目を実際の Chrome で撮影する。
// 使い方: node tools/screenshot-popup.mjs [出力先.png]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../test/cdp-pipe.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const fixtures = path.join(root, 'test', 'fixtures');
const pageDir = path.join(root, 'test', 'page');
const outFile = process.argv[2] || path.join(root, 'test', 'popup.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const cftRoot = path.join(root, 'test', 'browser', 'chrome');
  if (fs.existsSync(cftRoot)) {
    for (const dir of fs.readdirSync(cftRoot)) {
      const exe = path.join(cftRoot, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
    const file = path.join(rel === '/index.html' ? pageDir : fixtures, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(label, fn, timeoutMs = 40000) {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('タイムアウト: ' + label);
    await sleep(500);
  }
}

const { server, port } = await startServer();
const pageUrl = 'http://127.0.0.1:' + port + '/index.html';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-shot-'));

const { child, cdp } = launchChrome(findChrome(), [
  '--user-data-dir=' + profile,
  '--load-extension=' + extDir,
  '--disable-extensions-except=' + extDir,
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--hide-scrollbars',
  'about:blank',
]);

try {
  await waitFor('起動', async () => {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    return true;
  });

  const sw = await waitFor('拡張機能', async () => {
    for (const t of await cdp.getTargets()) {
      if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://')) continue;
      const sid = await cdp.attach(t.targetId);
      if (await cdp.evaluate(sid, 'chrome.runtime.getManifest().name') === 'Media Grabber') return { t, sid };
    }
    return null;
  });
  const extId = new URL(sw.t.url).host;

  const pageTarget = await cdp.createTarget(pageUrl);
  const pageSession = await cdp.attach(pageTarget);
  await cdp.send('Runtime.enable', {}, pageSession);
  await waitFor('ページ読み込み', async () => {
    const t = await cdp.evaluate(pageSession, 'document.getElementById("log").textContent');
    return t && t.includes('ready');
  });

  const tabId = await waitFor('タブ ID', async () => {
    const id = await cdp.evaluate(sw.sid,
      'chrome.tabs.query({}).then(ts => (ts.find(t => t.url === ' + JSON.stringify(pageUrl) + ') || {}).id ?? null)');
    return Number.isInteger(id) ? id : null;
  });

  const popupTarget = await cdp.createTarget('chrome-extension://' + extId + '/popup/popup.html?tabId=' + tabId);
  const popup = await cdp.attach(popupTarget);
  await cdp.send('Runtime.enable', {}, popup);
  await cdp.send('Page.enable', {}, popup);

  // サムネイルが揃うまで待つ
  await waitFor('サムネイル', async () => {
    const n = await cdp.evaluate(popup,
      '[...document.querySelectorAll(".thumb img")].filter(i => i.naturalWidth > 0).length');
    return n >= 3 ? n : null;
  });

  // ポップアップの実寸に合わせて撮影する
  const size = await cdp.evaluate(popup,
    'JSON.stringify({w: document.body.scrollWidth, h: Math.min(document.body.scrollHeight, 700)})');
  const { w, h } = JSON.parse(size);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 2, mobile: false }, popup);
  await sleep(500);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, popup);
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log('保存: ' + outFile);
} finally {
  try { child.kill(); } catch { /* 終了済み */ }
  await sleep(1000);
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
