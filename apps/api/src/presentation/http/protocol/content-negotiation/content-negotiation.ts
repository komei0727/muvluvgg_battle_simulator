interface AcceptEntry {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

/**
 * RFC 7231 `Accept`ヘッダーの`media-range[;q=value]`を単純にパースする。
 * RFC 9110 §8.3.1: media typeのtype/subtypeは大文字小文字を区別しない。
 * RFC 9110 §5.6.6: パラメータ名（`q`）も大文字小文字を区別しない。両方とも
 * 比較のために小文字へ正規化する。
 */
function parseAcceptHeader(value: string): readonly AcceptEntry[] {
  return value.split(",").map((entry): AcceptEntry => {
    const [mediaRange = "*/*", ...params] = entry.split(";").map((part) => part.trim());
    const [type = "*", subtype = "*"] = mediaRange.toLowerCase().split("/");
    let q = 1;
    for (const param of params) {
      const [key, rawValue] = param.split("=").map((part) => part.trim());
      if (key?.toLowerCase() === "q" && rawValue !== undefined) {
        const parsed = Number(rawValue);
        if (!Number.isNaN(parsed)) {
          q = parsed;
        }
      }
    }
    return { type, subtype, q };
  });
}

/**
 * `10_API設計.md`「HTTPヘッダー」: `Accept`省略時は`application/json`と
 * みなす。指定されている場合は、最も詳細度の高い一致（完全一致、
 * 次に"application"のtypeワイルドカード、次に完全ワイルドカード）のq値で
 * 判定する。単純な部分文字列一致では `Accept: application/json;q=0` や
 * 完全ワイルドカードだけをq=0にする指定のような明示的な除外を見逃す
 * （q=0は「受理不可」を意味する、RFC 7231）。
 */
export function acceptsJson(header: string | string[] | undefined): boolean {
  if (header === undefined) {
    return true;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  const entries = parseAcceptHeader(value);

  const exact = entries.find((entry) => entry.type === "application" && entry.subtype === "json");
  if (exact !== undefined) {
    return exact.q > 0;
  }
  const typeWildcard = entries.find(
    (entry) => entry.type === "application" && entry.subtype === "*",
  );
  if (typeWildcard !== undefined) {
    return typeWildcard.q > 0;
  }
  const fullWildcard = entries.find((entry) => entry.type === "*" && entry.subtype === "*");
  if (fullWildcard !== undefined) {
    return fullWildcard.q > 0;
  }
  return false;
}
