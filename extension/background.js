// Service Worker: メディア検出・状態管理・ダウンロード指示を担当する。
import { classifyMedia, suggestFilename } from './lib/util.js';

/** タブ ID -> 検出したメディア項目の Map */
const mediaByTab = new Map();
/** 実行中／完了したジョブ */
const jobs = new Map();
/** タブ ID -> ページ情報 */
const pageInfoByTab = new Map();

let nextItemId = 1;
let nextJobId = 1;
// 画質確認用の DNR ルール ID。ジョブ用の ID と衝突しない範囲を使う。
let nextProbeRuleId = 1000000;

const MAX_ITEMS_PER_TAB = 150;
const DEFAULT_SETTINGS = { subfolder: 'MediaGrabber', saveAs: false, concurrency: 6 };

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ---------------------------------------------------------------------------
// メディア検出
// ---------------------------------------------------------------------------

function getTabItems(tabId) {
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, []);
  return mediaByTab.get(tabId);
}

function updateBadge(tabId) {
  const count = (mediaByTab.get(tabId) || []).length;
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
}

function addItem(tabId, item) {
  if (tabId < 0) return null;
  const items = getTabItems(tabId);
  const existing = items.find((x) => x.url === item.url);
  if (existing) {
    // 後から判明した情報（サイズなど）で補完する
    if (item.size && !existing.size) existing.size = item.size;
    if (item.title && !existing.title) existing.title = item.title;
    return existing;
  }
  if (items.length >= MAX_ITEMS_PER_TAB) return null;
  const record = { id: nextItemId += 1, foundAt: Date.now(), ...item };
  items.push(record);
  updateBadge(tabId);
  return record;
}

function clearTab(tabId) {
  mediaByTab.delete(tabId);
  pageInfoByTab.delete(tabId);
  updateBadge(tabId);
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const get = (name) => {
      const h = headers.find((x) => x.name.toLowerCase() === name);
      return h ? h.value : '';
    };
    const contentType = get('content-type');
    const kind = classifyMedia(details.url, contentType);
    if (!kind) return;

    // 極端に小さい応答（エラーページ等）は無視する
    const size = Number(get('content-length')) || 0;
    if (kind === 'direct' && size > 0 && size < 32 * 1024) return;

    addItem(details.tabId, {
      url: details.url,
      kind,
      size,
      contentType: contentType.split(';')[0].trim(),
      source: 'network',
      title: pageInfoByTab.get(details.tabId)?.title || '',
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders'],
);

// ページ遷移で検出結果をリセットする
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// ---------------------------------------------------------------------------
// Offscreen ドキュメント（Blob 生成のため）
// ---------------------------------------------------------------------------

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'ストリーミング動画のセグメントを結合して保存用の Blob を作成するため',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

// ---------------------------------------------------------------------------
// Referer 付与（CDN が Referer を要求する場合の対策）
// ---------------------------------------------------------------------------

async function setRefererRule(ruleId, mediaUrl, pageUrl) {
  if (!pageUrl) return;
  let host;
  try {
    host = new URL(mediaUrl).hostname;
  } catch {
    return;
  }
  let origin;
  try {
    origin = new URL(pageUrl).origin + '/';
  } catch {
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: origin },
            { header: 'origin', operation: 'set', value: new URL(pageUrl).origin },
          ],
        },
        condition: {
          requestDomains: [host],
          resourceTypes: ['xmlhttprequest'],
          tabIds: [-1],
        },
      }],
    });
  } catch {
    // ルール追加に失敗しても本体のダウンロードは続行する
  }
}

async function clearRefererRule(ruleId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch { /* 失敗しても無視 */ }
}

// ---------------------------------------------------------------------------
// ダウンロード
// ---------------------------------------------------------------------------

function buildPath(subfolder, filename) {
  const folder = String(subfolder || '').replace(/^[/\\]+|[/\\]+$/g, '');
  return folder ? folder + '/' + filename : filename;
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => { /* ポップアップが閉じている場合は無視 */ });
}

function setJob(jobId, patch) {
  const job = jobs.get(jobId) || { id: jobId };
  Object.assign(job, patch);
  jobs.set(jobId, job);
  notifyPopup({ type: 'JOB_UPDATE', job });
  return job;
}

/** 直リンクは Chrome のダウンローダに任せる（メモリを消費せず、大きなファイルも扱える）。 */
async function downloadDirect(item, settings) {
  const ext = (() => {
    try {
      const m = new URL(item.url).pathname.match(/\.([a-z0-9]{1,5})$/i);
      if (m) return m[1].toLowerCase();
    } catch { /* URL 解析失敗時は Content-Type から決める */ }
    if (item.contentType && item.contentType.includes('/')) {
      const sub = item.contentType.split('/')[1];
      if (sub === 'quicktime') return 'mov';
      if (sub === 'x-matroska') return 'mkv';
      return sub.replace(/^x-/, '');
    }
    return 'mp4';
  })();

  const filename = suggestFilename({ title: item.title, url: item.url, ext });
  const downloadId = await chrome.downloads.download({
    url: item.url,
    filename: buildPath(settings.subfolder, filename),
    saveAs: settings.saveAs,
    conflictAction: 'uniquify',
  });
  return { downloadId, filename };
}

/** HLS / DASH は offscreen 側で全セグメントを取得して結合する。 */
async function downloadStreamJob(jobId, item, settings, variantIndex) {
  await ensureOffscreen();
  await setRefererRule(jobId, item.url, item.pageUrl);

  setJob(jobId, { state: 'running', progress: { completed: 0, total: 0, bytes: 0 } });

  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'DOWNLOAD_STREAM',
    jobId,
    kind: item.kind,
    url: item.url,
    variantIndex,
    concurrency: settings.concurrency,
  });

  await clearRefererRule(jobId);

  if (!result || !result.ok) {
    throw new Error(result?.error || '不明なエラー');
  }

  const files = [];
  const multi = result.parts.length > 1;
  for (const part of result.parts) {
    const suffix = multi ? (part.role === 'audio' ? '.audio' : '.video') : '';
    const base = suggestFilename({ title: item.title, url: item.url, ext: part.ext });
    const filename = base.replace(/\.([a-z0-9]+)$/i, suffix + '.$1');
    const downloadId = await chrome.downloads.download({
      url: part.blobUrl,
      filename: buildPath(settings.subfolder, filename),
      saveAs: settings.saveAs,
      conflictAction: 'uniquify',
    });
    files.push({ downloadId, filename, role: part.role, bytes: part.bytes });
  }

  // 保存が始まったら Blob URL を解放する
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'RELEASE', jobId }).catch(() => {});
  return files;
}

async function startDownload({ tabId, itemId, variantIndex }) {
  const items = mediaByTab.get(tabId) || [];
  const item = items.find((x) => x.id === itemId);
  if (!item) throw new Error('対象のメディアが見つかりません');

  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const enriched = {
    ...item,
    title: item.title || pageInfoByTab.get(tabId)?.title || tab?.title || '',
    pageUrl: pageInfoByTab.get(tabId)?.url || tab?.url || '',
  };

  const jobId = nextJobId += 1;
  setJob(jobId, {
    id: jobId,
    tabId,
    itemId,
    kind: item.kind,
    url: item.url,
    title: enriched.title,
    state: 'starting',
    startedAt: Date.now(),
  });

  (async () => {
    try {
      if (item.kind === 'direct') {
        const r = await downloadDirect(enriched, settings);
        setJob(jobId, { state: 'done', files: [r], handedToBrowser: true });
      } else {
        const files = await downloadStreamJob(jobId, enriched, settings, variantIndex);
        setJob(jobId, { state: 'done', files });
      }
    } catch (err) {
      await clearRefererRule(jobId);
      setJob(jobId, { state: 'error', error: err?.message || String(err) });
    }
  })();

  return { jobId };
}

// ---------------------------------------------------------------------------
// メッセージ処理
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen 宛のメッセージはここでは扱わない
  if (msg && msg.target === 'offscreen') return false;

  (async () => {
    switch (msg?.type) {
      case 'PAGE_INFO': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined && sender.frameId === 0) {
          const prev = pageInfoByTab.get(tabId) || {};
          pageInfoByTab.set(tabId, { ...prev, title: msg.title, url: msg.url });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PAGE_MEDIA': {
        // ページの代表サムネイルと再生時間。ネットワークから検出したストリームの表示に使う。
        const tabId = sender.tab?.id;
        if (tabId !== undefined && sender.frameId === 0) {
          const prev = pageInfoByTab.get(tabId) || {};
          pageInfoByTab.set(tabId, {
            ...prev,
            title: msg.title || prev.title,
            url: msg.url || prev.url,
            // 動画のコマを取れた場合はそちらを優先する（OGP 画像より内容に忠実）
            thumbnail: msg.thumbnail || prev.thumbnail || null,
            duration: msg.duration || prev.duration || 0,
          });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'MEDIA_FOUND': {
        const tabId = sender.tab?.id;
        if (tabId === undefined) { sendResponse({ ok: false }); break; }
        for (const found of msg.items || []) {
          const kind = classifyMedia(found.url, found.contentType || '');
          if (!kind) continue;
          addItem(tabId, {
            url: found.url,
            kind,
            size: 0,
            contentType: found.contentType || '',
            source: 'dom',
            title: msg.title || '',
            width: found.width || null,
            height: found.height || null,
            duration: found.duration || 0,
            thumbnail: found.thumbnail || null,
          });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'LIST': {
        const tabId = msg.tabId;
        const page = pageInfoByTab.get(tabId) || {};
        // 個別に取れていない項目は、ページの代表サムネイル／再生時間で補う
        const items = (mediaByTab.get(tabId) || []).slice()
          .sort((a, b) => b.foundAt - a.foundAt)
          .map((item) => ({
            ...item,
            // マニフェストの取得がタイトル通知より先に来ることがあるため、ここでも補う
            title: item.title || page.title || '',
            thumbnail: item.thumbnail || page.thumbnail || null,
            duration: item.duration || page.duration || 0,
          }));
        const tabJobs = [...jobs.values()].filter((j) => j.tabId === tabId).sort((a, b) => b.startedAt - a.startedAt);
        sendResponse({
          ok: true,
          items,
          jobs: tabJobs,
          page: pageInfoByTab.get(tabId) || null,
          settings: await getSettings(),
        });
        break;
      }

      case 'START_DOWNLOAD': {
        try {
          sendResponse({ ok: true, ...(await startDownload(msg)) });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
        break;
      }

      case 'PROBE': {
        // 画質確認もマニフェストの取得を伴うため、ダウンロードと同じく Referer を付ける
        const ruleId = nextProbeRuleId += 1;
        try {
          const items = mediaByTab.get(msg.tabId) || [];
          const item = items.find((x) => x.id === msg.itemId);
          if (!item) throw new Error('対象のメディアが見つかりません');
          const pageUrl = pageInfoByTab.get(msg.tabId)?.url || '';
          await ensureOffscreen();
          await setRefererRule(ruleId, item.url, pageUrl);
          const res = await chrome.runtime.sendMessage({
            target: 'offscreen', type: 'PROBE_STREAM', kind: item.kind, url: item.url,
          });
          sendResponse(res);
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        } finally {
          await clearRefererRule(ruleId);
        }
        break;
      }

      case 'CANCEL': {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'ABORT', jobId: msg.jobId }).catch(() => {});
        setJob(msg.jobId, { state: 'error', error: '中断しました' });
        sendResponse({ ok: true });
        break;
      }

      case 'CLEAR': {
        clearTab(msg.tabId);
        for (const [id, job] of jobs) if (job.tabId === msg.tabId) jobs.delete(id);
        sendResponse({ ok: true });
        break;
      }

      case 'SAVE_SETTINGS': {
        await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...msg.settings } });
        sendResponse({ ok: true });
        break;
      }

      case 'JOB_PROGRESS': {
        const job = jobs.get(msg.jobId);
        if (job) setJob(msg.jobId, { progress: msg.progress, state: 'running' });
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: '未対応のメッセージです' });
    }
  })();

  return true; // 非同期応答
});
