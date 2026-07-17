/**
 * レビュー指摘: `14_Catalog定義スキーマ.md`のmanifest schemaは`catalogRevision`へ
 * `minLength: 1`しか強制しないため、改行・引用符・バックスラッシュを含む値も
 * 有効なCatalogとして通り得る。生のまま`ETag`ヘッダーへ埋め込むと、RFC 9110
 * §8.8.3の`opaque-tag = DQUOTE *etagc DQUOTE`（`etagc`は`"`・`\`・制御文字を
 * 含まない）に違反するだけでなく、実際にFastifyの
 * `FST_ERR_FAILED_ERROR_SERIALIZATION`による意図しない500
 * （`Cache-Control`・`X-Request-Id`も失われる）を引き起こした。
 *
 * レビュー再指摘: 変換対象外文字を可変長の16進数で`%XX`へ落とし込み、かつ
 * `%`自身をそのまま素通りさせる素朴な実装は単射（injective）ではなかった
 * ——`%`自身が「エスケープ済みの`%`」と「元から`%`だった文字」を区別できない
 * ため、例えば改行1文字(U+000A)は`%0a`（2文字）へ変換される一方、元から
 * リテラル文字列`"%0a"`（3文字の`%`・`0`・`a`）だった値もそのまま`%0a`
 * （素通り）になり、異なる`catalogRevision`が同じETagへ衝突していた
 * （実測: 改行と`"%0a"`、`あ`(U+3042)と`"%3042"`、U+0010+`"0"`と`"%100"`が
 * それぞれ衝突）。これはETagが「representationの変更を識別する」契約に反する
 * ——異なるrevisionへの更新後もクライアントが古いCatalog一覧を304として
 * 再利用してしまう。
 *
 * `etagc`範囲外の文字と`%`自身の両方をエスケープ対象にし、エスケープは常に
 * `%`＋4桁固定長16進（UTF-16コード単位ひとつ分、`￿`まで）にすることで、
 * 「素通りする1文字」と「`%`から始まる5文字のエスケープ」が曖昧さなく区別
 * できる自己区切り(self-delimiting)な符号化にし、単射性を保証する
 * （本プロセス内で自分自身が発行した値とだけ比較するため、他システムとの
 * 標準的なパーセントエンコーディング互換性は不要）。`encodeURIComponent`は
 * 単独サロゲートを含む文字列で例外を送出し得るため使わない。
 */
export function toOpaqueEntityTag(catalogRevision: string): string {
  return catalogRevision.replace(
    /[^\x21\x23-\x7E]|%/g,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * `10_API設計.md`「`If-None-Match`が現在のETagと一致する場合は本文なしの304を
 * 返す」。RFC 9110 §13.1.2: `If-None-Match`は弱い比較(weak comparison)を使う
 * ——`W/`接頭辞の有無を無視し、opaque-tagの値だけを比較する（レビュー指摘: 現在
 * 強いETagしか発行しなくても、クライアントが`W/`付きで送ってくる場合を拒否
 * すべきではない）。
 *
 * ヘッダーは`#entity-tag`（カンマ区切りリスト）で、`entity-tag`は
 * `[ "W/" ] DQUOTE *etagc DQUOTE`。`etagc`は`"`を含まないが、生カンマは含み
 * 得るため、単純な`split(",")`はopaque-tag内部のカンマを誤って分割し、正当な
 * ETagを見逃す（レビュー指摘）。ここでは引用符で囲まれた区間だけを正規表現で
 * 取り出し、カンマの位置に関わらず各`entity-tag`のopaque-tagを正しく分離する。
 */
function parseIfNoneMatchOpaqueTags(header: string): readonly string[] {
  const tags: string[] = [];
  const pattern = /(?:W\/)?"([^"]*)"/g;
  for (const match of header.matchAll(pattern)) {
    tags.push(match[1]!);
  }
  return tags;
}

export function matchesIfNoneMatch(
  header: string | string[] | undefined,
  opaqueTag: string,
): boolean {
  if (header === undefined) {
    return false;
  }
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value.trim() === "*") {
    return true;
  }
  return parseIfNoneMatchOpaqueTags(value).includes(opaqueTag);
}
