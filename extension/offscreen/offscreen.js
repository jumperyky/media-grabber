// Offscreen ドキュメント: セグメントの取得と Blob の生成を担当する。
// Service Worker では URL.createObjectURL が使えないため、この文脈で処理する。
import { downloadStream, probeStream } from '../lib/downloader.js';

/** jobId -> { controller, blobUrls } */
const activeJobs = new Map();

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  ts: 'video/mp2t',
  webm: 'video/webm',
  bin: 'application/octet-stream',
};

function reportProgress(jobId, progress) {
  chrome.runtime.sendMessage({ type: 'JOB_PROGRESS', jobId, progress }).catch(() => {});
}

async function handleDownload(msg) {
  const controller = new AbortController();
  const entry = { controller, blobUrls: [] };
  activeJobs.set(msg.jobId, entry);

  try {
    const result = await downloadStream(msg.kind, msg.url, {
      fetchFn: (url, opts) => fetch(url, opts),
      signal: controller.signal,
      concurrency: msg.concurrency || 6,
      variantIndex: msg.variantIndex,
      videoIndex: msg.variantIndex,
      onProgress: (p) => reportProgress(msg.jobId, p),
    });

    const parts = result.parts.map((part) => {
      const blob = new Blob([part.data], { type: MIME_BY_EXT[part.ext] || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      entry.blobUrls.push(blobUrl);
      return { role: part.role, ext: part.ext, bytes: part.data.length, blobUrl };
    });

    return { ok: true, parts, duration: result.duration || 0 };
  } catch (err) {
    releaseJob(msg.jobId);
    return { ok: false, error: err?.message || String(err), code: err?.code || 'ERROR' };
  }
}

function releaseJob(jobId) {
  const entry = activeJobs.get(jobId);
  if (!entry) return;
  for (const url of entry.blobUrls) URL.revokeObjectURL(url);
  activeJobs.delete(jobId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  (async () => {
    switch (msg.type) {
      case 'DOWNLOAD_STREAM':
        sendResponse(await handleDownload(msg));
        break;

      case 'PROBE_STREAM':
        try {
          const info = await probeStream(msg.kind, msg.url, { fetchFn: (u, o) => fetch(u, o) });
          sendResponse({ ok: true, ...info });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
        break;

      case 'ABORT':
        activeJobs.get(msg.jobId)?.controller.abort();
        sendResponse({ ok: true });
        break;

      case 'RELEASE':
        // ダウンロードの取り込みが終わるまで少し待ってから解放する
        setTimeout(() => releaseJob(msg.jobId), 60000);
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: '未対応のメッセージです' });
    }
  })();

  return true;
});
