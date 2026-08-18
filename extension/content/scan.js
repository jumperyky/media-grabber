// コンテンツスクリプト: ページ内の <video>/<audio> 要素から直リンクとサムネイルを拾い、背景に通知する。
// ネットワーク由来の検出は background 側が担当するため、ここは DOM 由来の補完に徹する。

(() => {
  const reported = new Set();
  const THUMB_WIDTH = 240;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // 拡張機能の再読み込み直後などは送信できないことがある
    }
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return null;
    }
  }

  /**
   * 再生中の映像から 1 コマ取り出して data URL にする。
   * 別ドメインの動画では canvas が汚染されて例外になるため、その場合は null を返す。
   */
  function captureFrame(video) {
    try {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
      const width = Math.min(THUMB_WIDTH, video.videoWidth);
      const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(video, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  /** ページの代表画像（OGP など）。フレームを取れない場合の代替。 */
  function pageImage() {
    const selectors = [
      'meta[property="og:image"]',
      'meta[name="og:image"]',
      'meta[name="twitter:image"]',
      'meta[itemprop="thumbnailUrl"]',
    ];
    for (const sel of selectors) {
      const content = document.querySelector(sel)?.getAttribute('content');
      if (content) {
        const url = absolute(content);
        if (url) return url;
      }
    }
    return null;
  }

  /** 画面上で最も大きい動画を、このページの主動画とみなす。 */
  function mainVideo() {
    const videos = [...document.querySelectorAll('video')];
    if (!videos.length) return null;
    return videos
      .map((v) => ({ v, area: v.clientWidth * v.clientHeight }))
      .sort((a, b) => b.area - a.area)[0].v;
  }

  function thumbnailFor(video) {
    if (!video) return null;
    const frame = captureFrame(video);
    if (frame) return frame;
    if (video.poster) return absolute(video.poster);
    return null;
  }

  let bestThumbnail = null;
  let haveFrame = false;

  /** ページ全体の代表サムネイルと再生時間を送る。 */
  function reportPageMedia() {
    if (window.top !== window) return;

    const video = mainVideo();
    const frame = video ? captureFrame(video) : null;
    if (frame) {
      bestThumbnail = frame;
      haveFrame = true;
    } else if (!bestThumbnail) {
      bestThumbnail = (video && video.poster ? absolute(video.poster) : null) || pageImage();
    }

    const duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!bestThumbnail && !duration) return;

    send({
      type: 'PAGE_MEDIA',
      thumbnail: bestThumbnail,
      duration,
      title: document.title,
      url: location.href,
    });
  }

  function collect() {
    const items = [];
    const elements = document.querySelectorAll('video, audio, video source, audio source');

    for (const el of elements) {
      const raw = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (!raw) continue;

      const url = absolute(raw);
      if (!url) continue;

      // blob: / MediaSource は URL 単体では取得できない。実体はネットワーク側で拾う。
      if (url.startsWith('blob:') || url.startsWith('data:')) continue;
      if (reported.has(url)) continue;
      reported.add(url);

      const media = el.tagName === 'SOURCE' ? el.parentElement : el;
      items.push({
        url,
        contentType: el.getAttribute('type') || '',
        width: media && media.videoWidth ? media.videoWidth : null,
        height: media && media.videoHeight ? media.videoHeight : null,
        duration: media && Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0,
        thumbnail: thumbnailFor(media && media.tagName === 'VIDEO' ? media : null),
      });
    }

    if (items.length) {
      send({ type: 'MEDIA_FOUND', items, title: document.title });
    }
  }

  function reportPageInfo() {
    if (window.top === window) {
      send({ type: 'PAGE_INFO', title: document.title, url: location.href });
    }
  }

  reportPageInfo();
  collect();
  reportPageMedia();

  // 動的に差し込まれるプレイヤーに追従する（過剰に走らないよう間引く）
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      collect();
    }, 800);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 再生が始まってからでないとコマを取り出せないため、しばらく再挑戦する
  let attempts = 0;
  const thumbTimer = setInterval(() => {
    attempts += 1;
    reportPageMedia();
    if (haveFrame || attempts >= 15) clearInterval(thumbTimer);
  }, 2000);

  // 再生開始をきっかけにも取り直す
  document.addEventListener('play', () => setTimeout(reportPageMedia, 700), true);
  document.addEventListener('loadeddata', () => setTimeout(reportPageMedia, 300), true);

  // タイトルが後から決まる SPA に対応する
  let lastTitle = document.title;
  setInterval(() => {
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      reportPageInfo();
    }
  }, 2000);
})();
