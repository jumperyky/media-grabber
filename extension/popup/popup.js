// ポップアップ UI: 検出済みメディアの一覧表示とダウンロード操作。
import { formatBytes, formatDuration, mergeCommand } from '../lib/util.js';

const listEl = document.getElementById('list');
const jobsEl = document.getElementById('jobs');
const statusEl = document.getElementById('status');
const settingsEl = document.getElementById('settings');

let currentTabId = null;
/** itemId -> probe 結果（画質一覧など） */
const probeCache = new Map();
/** itemId -> 画質確認に失敗した理由 */
const probeFailed = new Map();
/** itemId -> 選択中のバリアント index */
const selectedVariant = new Map();
/** 画質確認が進むたびに増やして、再描画のきっかけにする */
let probeGeneration = 0;
let lastSignature = '';

const KIND_LABEL = { direct: '直リンク', hls: 'HLS', dash: 'DASH' };
const MAX_AUTO_PROBE = 8;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// 画質確認（マスターかどうかの自動判別）
// ---------------------------------------------------------------------------

/** 1 件だけ画質を確認して結果を控える。 */
async function probeItem(item) {
  if (probeCache.has(item.id) || probeFailed.has(item.id)) return;
  const res = await send({ type: 'PROBE', tabId: currentTabId, itemId: item.id });
  if (res && res.ok) probeCache.set(item.id, res);
  else probeFailed.set(item.id, (res && res.error) || '画質情報を取得できませんでした');
  probeGeneration += 1;
}

/**
 * 一覧に出ている HLS/DASH をまとめて確認する。
 * 同じ動画のマスターと個別リストが並ぶことが多いため、開いた時点で見分けられるようにする。
 */
let autoProbeRunning = false;
async function autoProbe(items) {
  if (autoProbeRunning) return;
  const targets = items
    .filter((i) => i.kind !== 'direct' && !probeCache.has(i.id) && !probeFailed.has(i.id))
    .slice(0, MAX_AUTO_PROBE);
  if (!targets.length) return;

  autoProbeRunning = true;
  try {
    // 同時に叩きすぎないよう 3 本ずつ処理する
    const queue = targets.slice();
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        await probeItem(item);
        render();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    autoProbeRunning = false;
  }
}

/** 確認済みのマスターが束ねている再生リストの URL 一覧。 */
function containedUrls() {
  const set = new Set();
  for (const res of probeCache.values()) {
    if (!res.isMaster) continue;
    for (const v of res.variants || []) if (v.url) set.add(v.url);
    for (const u of res.audioUrls || []) set.add(u);
  }
  return set;
}

// ---------------------------------------------------------------------------
// 一覧の描画
// ---------------------------------------------------------------------------

function renderEmpty() {
  listEl.replaceChildren();
  const box = el('div', 'empty');
  box.append(
    el('p', null, 'このタブでは動画が見つかりませんでした。'),
    el('p', null, '動画を再生（または少しシーク）すると検出されます。'),
    el('p', null, '検出後にページを再読み込みした場合は、もう一度再生してください。'),
  );
  listEl.append(box);
}

function itemTitle(item) {
  if (item.title) return item.title;
  try {
    const name = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
    return name || item.url;
  } catch {
    return item.url;
  }
}

/** サムネイル欄。画像が無い場合や読み込みに失敗した場合は種別を示す代替表示にする。 */
function renderThumb(item, duration) {
  const box = el('div', 'thumb');

  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.remove();
      box.prepend(el('span', 'thumb-placeholder', KIND_LABEL[item.kind] || item.kind));
    });
    box.append(img);
  } else {
    box.append(el('span', 'thumb-placeholder', KIND_LABEL[item.kind] || item.kind));
  }

  if (duration) box.append(el('span', 'thumb-duration', formatDuration(duration)));
  return box;
}

/** 画質選択のプルダウン。確認前は無効にしておく。 */
function renderVariantSelect(item, probe) {
  const select = el('select');

  if (!probe) {
    select.append(new Option('画質: 確認中…', ''));
    select.disabled = true;
    return select;
  }
  if (!probe.variants.length) {
    select.append(new Option('単一画質', ''));
    select.disabled = true;
    return select;
  }

  probe.variants.forEach((v, i) => {
    const parts = [v.height ? v.height + 'p' : '画質 ' + (i + 1)];
    if (v.bandwidth) parts.push(Math.round(v.bandwidth / 1000) + ' kbps');
    // ビットレート×再生時間から求めた概算。実サイズはこれと前後する
    if (v.estimatedBytes) parts.push('約 ' + formatBytes(v.estimatedBytes));
    select.append(new Option(parts.join(' · '), String(v.index)));
  });

  const chosen = selectedVariant.has(item.id) ? selectedVariant.get(item.id) : probe.variants[0].index;
  selectedVariant.set(item.id, chosen);
  select.value = String(chosen);
  select.addEventListener('change', () => {
    selectedVariant.set(item.id, Number(select.value));
  });
  return select;
}

function renderItem(item, contained) {
  const probe = probeCache.get(item.id) || null;
  const failure = probeFailed.get(item.id) || null;
  const isContained = contained.has(item.url);
  const isEncrypted = !!(probe && probe.encrypted);
  // 取得できないものを勧めても仕方がないので、暗号化されている場合は推奨扱いにしない
  const isMaster = !!(probe && probe.isMaster && probe.variants.length > 0 && !isEncrypted);

  const node = el('div', 'item' + (isContained ? ' item-secondary' : ''));
  node.append(renderThumb(item, (probe && probe.duration) || item.duration));

  const body = el('div', 'item-body');
  node.append(body);

  const head = el('div', 'item-head');
  head.append(
    el('span', 'badge ' + item.kind, KIND_LABEL[item.kind] || item.kind),
    el('span', 'item-title', itemTitle(item)),
  );
  if (isMaster) head.append(el('span', 'tag recommended', '推奨'));
  body.append(head);

  body.append(el('div', 'item-url', item.url));

  const meta = el('div', 'item-meta');
  if (item.size) {
    // 直リンクは動画そのもののサイズだが、HLS/DASH は「再生リストのテキスト」のサイズなので区別する
    meta.append(el('span', null, item.kind === 'direct'
      ? formatBytes(item.size)
      : '再生リスト ' + formatBytes(item.size)));
  }
  if (item.contentType) meta.append(el('span', null, item.contentType));
  if (item.width && item.height) meta.append(el('span', null, item.width + 'x' + item.height));
  meta.append(el('span', null, item.source === 'dom' ? 'ページ内要素' : '通信から検出'));
  if (meta.childElementCount) body.append(meta);

  // 画質確認で分かった中身の情報
  if (probe) {
    const info = el('div', 'item-meta');
    info.append(el('span', 'strong', isMaster
      ? 'マスター（' + probe.variants.length + ' 画質を選択可能）'
      : '単一画質の再生リスト'));
    if (probe.duration) info.append(el('span', null, '長さ ' + formatDuration(probe.duration)));
    if (probe.segmentCount) info.append(el('span', null, probe.segmentCount + ' セグメント'));
    if (probe.isLive) info.append(el('span', null, 'ライブ配信'));
    if (probe.encrypted) info.append(el('span', 'warn', '暗号化（非対応）'));
    body.append(info);
  } else if (failure) {
    body.append(el('div', 'item-meta', '画質を確認できませんでした: ' + failure));
  }

  if (isContained) {
    body.append(el('div', 'item-note', 'この再生リストは上のマスターに含まれています。'
      + '通常はマスターの方を選んでください。'));
  }

  if (isEncrypted) {
    body.append(el('div', 'item-note', 'この配信は暗号化されています（AES-128）。'
      + '本拡張機能は暗号化の解除に対応していないため、保存できません。'));
  }

  const actions = el('div', 'item-actions');
  const dl = el('button', (isContained || isEncrypted ? 'small' : 'primary small'), 'ダウンロード');
  if (isEncrypted) {
    // 取得できないと分かっているので、押してエラーを積み上げないようにする
    dl.disabled = true;
    dl.title = '暗号化されたストリームには対応していません';
  } else {
    dl.addEventListener('click', () => startDownload(item, dl));
  }
  actions.append(dl);

  if (item.kind !== 'direct') {
    actions.append(renderVariantSelect(item, probe));
    if (failure) {
      const retry = el('button', 'small', '再確認');
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        probeFailed.delete(item.id);
        await probeItem(item);
        render();
      });
      actions.append(retry);
    }
  }

  const copy = el('button', 'small', 'URL をコピー');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(item.url);
    copy.textContent = 'コピー済み';
    setTimeout(() => { copy.textContent = 'URL をコピー'; }, 1200);
  });
  actions.append(copy);

  body.append(actions);
  return node;
}

/** マスターや単独の動画を上に、マスターに含まれる再生リストを下にまとめる。 */
function sortForDisplay(items, contained) {
  return items.slice().sort((a, b) => {
    const rank = (x) => (contained.has(x.url) ? 1 : 0);
    return rank(a) - rank(b) || b.foundAt - a.foundAt;
  });
}

let lastItems = [];

function render() {
  const contained = containedUrls();
  const signature = JSON.stringify([
    lastItems.map((i) => [i.id, i.title, i.duration, i.size, i.thumbnail ? 1 : 0]),
    probeGeneration,
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  if (!lastItems.length) { renderEmpty(); return; }
  const ordered = sortForDisplay(lastItems, contained);
  listEl.replaceChildren(...ordered.map((item) => renderItem(item, contained)));
}

// ---------------------------------------------------------------------------
// ジョブの描画
// ---------------------------------------------------------------------------

function renderJob(job) {
  const node = el('div', 'job');

  const head = el('div', 'job-head');
  head.append(el('span', 'job-name', job.title || job.url));

  const stateText = {
    starting: '準備中…',
    running: '取得中…',
    done: '保存しました',
    error: 'エラー',
  }[job.state] || job.state;
  head.append(el('span', 'job-state ' + job.state, stateText));
  node.append(head);

  if (job.state === 'running' || job.state === 'starting') {
    const p = job.progress || { completed: 0, total: 0, bytes: 0 };
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = p.total ? Math.round((p.completed / p.total) * 100) + '%' : '0%';
    bar.append(fill);
    node.append(bar);
    node.append(el('div', 'item-meta',
      p.total
        ? p.completed + ' / ' + p.total + ' セグメント · ' + formatBytes(p.bytes)
        : 'マニフェストを解析中…'));

    const cancel = el('button', 'small', '中断');
    cancel.addEventListener('click', () => send({ type: 'CANCEL', jobId: job.id }));
    const actions = el('div', 'item-actions');
    actions.append(cancel);
    node.append(actions);
  }

  if (job.state === 'error') {
    node.append(el('div', 'item-meta', job.error || '不明なエラー'));
  }

  if (job.state === 'done' && job.files) {
    for (const f of job.files) {
      node.append(el('div', 'item-meta', f.filename + (f.bytes ? ' · ' + formatBytes(f.bytes) : '')));
    }
    // .bat を一緒に保存できていれば、そちらを案内する
    const helper = job.files.find((f) => f.role === 'helper');
    const v = job.files.find((f) => f.role === 'video');
    const a = job.files.find((f) => f.role === 'audio');

    if (helper) {
      const hint = el('div', 'hint');
      hint.append(document.createTextNode(
        helper.filename + ' をダブルクリックすると MP4 にできます。保存名はその場で変更できます。'));
      node.append(hint);
    } else if (v && a) {
      const out = v.filename.replace(/\.video\.[a-z0-9]+$/i, '.mp4');
      const hint = el('div', 'hint');
      hint.append(document.createTextNode('映像と音声が別ファイルです。次のコマンドで結合できます:'));
      hint.append(document.createElement('br'));
      hint.append(el('code', null,
        mergeCommand(v.filename.split('/').pop(), a.filename.split('/').pop(), out.split('/').pop())));
      node.append(hint);
    }
  }

  return node;
}

function renderJobs(jobs) {
  const recent = jobs.filter((j) => j.state !== 'done' || Date.now() - j.startedAt < 10 * 60 * 1000);
  jobsEl.replaceChildren(...recent.map(renderJob));
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function startDownload(item, button) {
  button.disabled = true;
  button.textContent = '開始しました';
  const res = await send({
    type: 'START_DOWNLOAD',
    tabId: currentTabId,
    itemId: item.id,
    variantIndex: selectedVariant.has(item.id) ? selectedVariant.get(item.id) : undefined,
  });
  if (!res || !res.ok) {
    statusEl.textContent = res?.error || 'ダウンロードを開始できませんでした';
    button.disabled = false;
    button.textContent = 'ダウンロード';
    return;
  }
  setTimeout(() => { button.disabled = false; button.textContent = 'ダウンロード'; }, 1500);
  refresh();
}

async function refresh() {
  const res = await send({ type: 'LIST', tabId: currentTabId });
  if (!res || !res.ok) return;
  lastItems = res.items;
  render();
  renderJobs(res.jobs);
  applySettings(res.settings);
  const n = res.items.length;
  statusEl.textContent = n ? n + ' 件のメディアを検出' : '検出待ち';
  autoProbe(res.items);
}

function applySettings(settings) {
  if (!settings || settingsEl.dataset.loaded) return;
  document.getElementById('subfolder').value = settings.subfolder;
  document.getElementById('concurrency').value = settings.concurrency;
  document.getElementById('saveAs').checked = settings.saveAs;
  document.getElementById('saveHelperBat').checked = settings.saveHelperBat;
  settingsEl.dataset.loaded = '1';
}

document.getElementById('settings-toggle').addEventListener('click', () => {
  settingsEl.classList.toggle('hidden');
});

document.getElementById('save-settings').addEventListener('click', async () => {
  await send({
    type: 'SAVE_SETTINGS',
    settings: {
      subfolder: document.getElementById('subfolder').value.trim(),
      concurrency: Math.max(1, Math.min(16, Number(document.getElementById('concurrency').value) || 6)),
      saveAs: document.getElementById('saveAs').checked,
      saveHelperBat: document.getElementById('saveHelperBat').checked,
    },
  });
  statusEl.textContent = '設定を保存しました';
});

document.getElementById('clear').addEventListener('click', async () => {
  await send({ type: 'CLEAR', tabId: currentTabId });
  probeCache.clear();
  probeFailed.clear();
  selectedVariant.clear();
  lastSignature = '';
  refresh();
});

// 背景からの進捗通知で即座に再描画する
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'JOB_UPDATE') refresh();
});

(async () => {
  // 通常はアクティブなタブを対象にする。
  // popup.html?tabId=123 のようにタブとして開いた場合は、指定タブを対象にする（動作確認・デバッグ用）。
  const override = new URLSearchParams(location.search).get('tabId');
  if (override !== null && Number.isInteger(Number(override))) {
    currentTabId = Number(override);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id ?? null;
  }
  if (currentTabId === null) {
    statusEl.textContent = 'タブを取得できませんでした';
    return;
  }
  await refresh();
  setInterval(refresh, 1500);
})();
