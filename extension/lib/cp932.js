// バッチファイルを CP932（Shift_JIS）で書き出すための符号化。
//
// なぜ必要か:
//   cmd.exe はバッチファイルの中身を、起動時のコンソール コードページで解析する。
//   日本語環境では CP932 なので、UTF-8 で書いたファイルはバイト境界がずれて読まれ、
//   行が途中で分断されて「'cho' は認識されていません」のようなエラーになる。
//   バッチ内の `chcp 65001` は表示には効くが、解析はそれより前に始まっているため間に合わない。
//
// TextEncoder は UTF-8 しか出力できないが、TextDecoder は shift_jis を読める。
// そこで全バイト列を一度復号して逆引き表を作り、それを使って符号化する。

let table = null;

function buildTable() {
  const decoder = new TextDecoder('shift_jis');
  const map = new Map();

  // ASCII 範囲はそのまま
  for (let b = 0; b < 0x80; b += 1) map.set(String.fromCharCode(b), [b]);

  // 半角カナ
  for (let b = 0xa1; b <= 0xdf; b += 1) {
    const ch = decoder.decode(new Uint8Array([b]));
    if (ch && ch !== '�') map.set(ch, [b]);
  }

  // 2 バイト文字
  for (let lead = 0x81; lead <= 0xfc; lead += 1) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (!ch || ch.length !== 1 || ch === '�') continue;
      if (!map.has(ch)) map.set(ch, [lead, trail]);
    }
  }

  return map;
}

/**
 * 文字列を CP932 のバイト列にする。
 * CP932 に無い文字（絵文字など）が含まれる場合は null を返す。
 */
export function encodeCp932(text) {
  if (!table) table = buildTable();
  const out = [];
  for (const ch of String(text)) {
    const bytes = table.get(ch);
    if (!bytes) return null;
    for (const b of bytes) out.push(b);
  }
  return new Uint8Array(out);
}

/**
 * バッチファイルとして書き出すバイト列を返す。
 * CP932 で書ければそれを使い、書けない文字がある場合だけ
 * UTF-8 で書いて `chcp 65001` を足す（この場合は解析ずれの可能性が残る）。
 */
export function encodeBatchFile(text) {
  const cp932 = encodeCp932(text);
  if (cp932) return cp932;

  const marker = '@echo off\r\n';
  const withChcp = text.startsWith(marker)
    ? marker + 'chcp 65001>nul\r\n' + text.slice(marker.length)
    : text;
  return new TextEncoder().encode(withChcp);
}
