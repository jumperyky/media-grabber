// MPEG-DASH (MPD) マニフェストのパーサ。
// SegmentTemplate($Number$/$Time$ + SegmentTimeline)、SegmentList、SegmentBase に対応する。
import { parseXml, childrenNamed, firstNamed, findAll } from './xml.js';
import { resolveUrl } from './util.js';

/** ISO 8601 期間表記 (PT1H2M3.5S) を秒に変換する。 */
export function parseISODuration(s) {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s).trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, sec] = m.map((v) => (v === undefined ? 0 : Number(v)));
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + sec;
}

/** $Number%05d$ のようなテンプレート識別子を展開する。 */
export function fillTemplate(template, vars) {
  return String(template).replace(/\$(\$|[A-Za-z]+)(%0(\d+)d)?\$/g, (whole, key, _fmt, width) => {
    if (key === '$') return '$';
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return whole;
    const value = vars[key];
    if (width) return String(value).padStart(Number(width), '0');
    return String(value);
  });
}

/** 要素チェーンの BaseURL を順に適用して基準 URL を求める。 */
function applyBaseUrl(node, currentBase) {
  const b = firstNamed(node, 'BaseURL');
  const v = b && b.text ? b.text.trim() : '';
  return v ? resolveUrl(v, currentBase) : currentBase;
}

/** SegmentTemplate / SegmentList / SegmentBase を親から継承しつつ取得する。 */
function inherit(name, ...nodes) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const found = firstNamed(nodes[i], name);
    if (found) return found;
  }
  return null;
}

function buildFromTemplate(tmpl, rep, base, periodDuration) {
  const attrs = tmpl.attrs;
  const timescale = Number(attrs.timescale || 1) || 1;
  const startNumber = Number(attrs.startNumber || 1);
  const vars = {
    RepresentationID: rep.attrs.id || '',
    Bandwidth: rep.attrs.bandwidth || '',
  };

  const initUrl = attrs.initialization
    ? resolveUrl(fillTemplate(attrs.initialization, { ...vars, Number: startNumber, Time: 0 }), base)
    : null;

  const media = attrs.media;
  if (!media) return { initUrl, segmentUrls: [] };

  const timeline = firstNamed(tmpl, 'SegmentTimeline');
  const segmentUrls = [];

  if (timeline) {
    // SegmentTimeline: S 要素の t / d / r から各セグメントの時刻と番号を復元する
    let time = 0;
    let number = startNumber;
    for (const s of childrenNamed(timeline, 'S')) {
      if (s.attrs.t !== undefined) time = Number(s.attrs.t);
      const d = Number(s.attrs.d || 0);
      const repeat = Number(s.attrs.r || 0);
      const count = repeat >= 0 ? repeat + 1 : 1;
      for (let k = 0; k < count; k += 1) {
        segmentUrls.push(resolveUrl(fillTemplate(media, { ...vars, Number: number, Time: time }), base));
        time += d;
        number += 1;
      }
    }
  } else {
    const segDuration = Number(attrs.duration || 0);
    if (segDuration > 0 && periodDuration > 0) {
      const count = Math.ceil((periodDuration * timescale) / segDuration);
      for (let k = 0; k < count; k += 1) {
        const number = startNumber + k;
        const time = k * segDuration;
        segmentUrls.push(resolveUrl(fillTemplate(media, { ...vars, Number: number, Time: time }), base));
      }
    }
  }

  return { initUrl, segmentUrls };
}

function buildFromList(list, base) {
  const init = firstNamed(list, 'Initialization');
  const initUrl = init && init.attrs.sourceURL ? resolveUrl(init.attrs.sourceURL, base) : null;
  const segmentUrls = childrenNamed(list, 'SegmentURL')
    .map((s) => s.attrs.media)
    .filter(Boolean)
    .map((u) => resolveUrl(u, base));
  return { initUrl, segmentUrls };
}

/**
 * MPD を解析して表現(Representation)一覧を返す。
 * 戻り値: { protected, duration, representations: [...] }
 */
export function parseMPD(text, baseUrl) {
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') throw new Error('有効な MPD マニフェストではありません');

  const isProtected = findAll(mpd, 'ContentProtection').length > 0;
  const mpdDuration = parseISODuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = applyBaseUrl(mpd, baseUrl);

  const representations = [];

  for (const period of childrenNamed(mpd, 'Period')) {
    const periodBase = applyBaseUrl(period, mpdBase);
    const periodDuration = parseISODuration(period.attrs.duration) || mpdDuration;

    for (const set of childrenNamed(period, 'AdaptationSet')) {
      const setBase = applyBaseUrl(set, periodBase);

      for (const rep of childrenNamed(set, 'Representation')) {
        const repBase = applyBaseUrl(rep, setBase);
        const mimeType = rep.attrs.mimeType || set.attrs.mimeType || '';
        const contentType = set.attrs.contentType || mimeType.split('/')[0] || '';

        const tmpl = inherit('SegmentTemplate', period, set, rep);
        const list = inherit('SegmentList', period, set, rep);

        let built = { initUrl: null, segmentUrls: [] };
        if (tmpl) {
          built = buildFromTemplate(tmpl, rep, repBase, periodDuration);
        } else if (list) {
          built = buildFromList(list, repBase);
        } else {
          // SegmentBase または BaseURL 単体 = 単一ファイル
          const single = firstNamed(rep, 'BaseURL');
          if (single && single.text) built = { initUrl: null, segmentUrls: [resolveUrl(single.text.trim(), setBase)] };
        }

        representations.push({
          id: rep.attrs.id || '',
          kind: contentType === 'audio' ? 'audio' : contentType === 'video' ? 'video' : 'other',
          mimeType,
          codecs: rep.attrs.codecs || set.attrs.codecs || '',
          bandwidth: Number(rep.attrs.bandwidth || 0),
          width: rep.attrs.width ? Number(rep.attrs.width) : (set.attrs.width ? Number(set.attrs.width) : null),
          height: rep.attrs.height ? Number(rep.attrs.height) : (set.attrs.height ? Number(set.attrs.height) : null),
          initUrl: built.initUrl,
          segmentUrls: built.segmentUrls,
        });
      }
    }
  }

  representations.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  return { protected: isProtected, duration: mpdDuration, representations };
}

/** 種別ごとに最も品質の高い表現を選ぶ。 */
export function pickBest(representations, kind) {
  return representations.filter((r) => r.kind === kind)[0] || null;
}
