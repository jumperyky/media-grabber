// 最小限の XML パーサ。DOMParser の無い環境（Service Worker / Node）でも MPD を読むために使う。
// 対応: 要素・属性・自己閉じタグ・コメント・XML宣言・CDATA・基本実体参照。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/** 名前空間接頭辞を落としてローカル名にする。 */
function localName(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * XML 文字列をノードツリーに変換する。
 * ノード: { name, attrs, children, text }
 */
export function parseXml(text) {
  const src = String(text);
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;

    if (lt > i) {
      const chunk = src.slice(i, lt).trim();
      if (chunk) stack[stack.length - 1].text += decodeEntities(chunk);
    }

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      const body = src.slice(lt + 9, end === -1 ? src.length : end);
      stack[stack.length - 1].text += body;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt === -1) break;
    const inner = src.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_:][\w.:-]*)/.exec(body);
    if (!nameMatch) { i = gt + 1; continue; }

    const node = {
      name: localName(nameMatch[1]),
      attrs: parseAttrs(body.slice(nameMatch[1].length)),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }

  return root.children[0] || root;
}

/** 直下の子から名前が一致するものを返す。 */
export function childrenNamed(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** 直下の子から名前が一致する最初のものを返す。 */
export function firstNamed(node, name) {
  return node ? node.children.find((c) => c.name === name) || null : null;
}

/** 子孫を再帰的に探して名前が一致するものを全て返す。 */
export function findAll(node, name, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
