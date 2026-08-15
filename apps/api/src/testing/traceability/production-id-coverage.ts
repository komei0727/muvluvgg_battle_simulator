/**
 * production Catalog 全ID網羅監査のallowlist台帳。
 *
 * 全Unit・Memoryは `src/__tests__/production-catalog/units/<UNIT_ID>.test.ts`
 * ／`memories/<MEM_ID>.test.ts` のユニット単位結合テストで全Skill・全EffectActionの
 * 効果発現が検証される（`12_テスト戦略.md`）。この台帳はまだ載っていない定義を
 * 明示的に列挙する。掲載中の定義には対応テストファイルが存在してはならず
 * （カバー済みの残留を禁止する）、掲載外の定義には全ID参照を含むテストファイルが
 * 存在しなければならない。検証は {@link ./production-id-coverage.test.ts} が行う。
 *
 * **両台帳は現在空である。** 機構自体は将来のUnit・Memory追加へ備えて存置するが、
 * 台帳はIDを増やす方向へ編集してはならないため、追加分をここへ載せて先送りすることは
 * できない — 新規Unit・Memoryは同一PRでユニット単位結合テストを書く。
 */

/**
 * `requiredIds`のうち、テストソースが参照していないIDを返す。
 *
 * 照合は語境界（`\b`）で行う。単純な部分文字列一致では、一方が他方の接頭辞に
 * なっているID（production Catalogに43組実在。例:
 * `ACT_FEE_BATH_EX_DAMAGE`と`ACT_FEE_BATH_EX_DAMAGE_BOOSTED`）で、
 * 長い方だけを書いたテストが短い方も参照済みと判定され、基礎ダメージ側が
 * 一度も検証されないまま監査を通ってしまう。JSの`\w`は`_`を含むため、
 * `\b`が後続の`_BOOSTED`との境界に一致せず、この取りこぼしを塞げる。
 * IDは`[A-Z0-9_]`のみで正規表現メタ文字を含まないためエスケープは不要。
 */
export function unreferencedIds(source: string, requiredIds: readonly string[]): readonly string[] {
  return requiredIds.filter((id) => !new RegExp(String.raw`${id}\b`).test(source));
}

/**
 * JSONツリーから `effectActionDefinitionId` 参照を再帰収集する。skill定義の
 * `resolution`／`chargeRelease` はstep種別（BRANCH/RANDOM_BRANCH/REPEAT）ごとに
 * ネスト形状が異なるため、形状を列挙せずキー名だけで拾う（形状の追加に追随できる）。
 * 生JSONにもDomain定義オブジェクトにも同じキー名で載るため、両方へ使える。
 */
export function collectEffectActionReferences(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectEffectActionReferences(item, into);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "effectActionDefinitionId" && typeof value === "string") {
      into.add(value);
      continue;
    }
    collectEffectActionReferences(value, into);
  }
}

/**
 * 起点集合から、EffectAction payloadが参照する別のEffectActionまで閉包を取る。
 * production Catalogには payload 経由の EffectAction間参照が実在するため
 * （例: 付与した効果が別のEffectActionを起動する定義）、skill直下の参照だけでは
 * 「そのUnitが発揮しうる全効果」に届かない。
 */
export function effectActionClosure(
  seeds: ReadonlySet<string>,
  effectPayloadsById: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  const closure = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) {
      break;
    }
    const referenced = new Set<string>();
    collectEffectActionReferences(effectPayloadsById.get(id), referenced);
    for (const next of referenced) {
      if (!closure.has(next)) {
        closure.add(next);
        queue.push(next);
      }
    }
  }
  return closure;
}

/**
 * 全69ユニットが `production-catalog/units/<UNIT_ID>.test.ts` に載ったため空。
 * 新しいユニットを追加するときも、ここへ積むのではなくユニット効果軸のファイルを
 * 同じPRで用意する（`12_テスト戦略.md`「ユニット効果軸の標準形」）。
 */
export const UNCOVERED_UNIT_IDS: readonly string[] = [];

/**
 * 全37メモリーが `production-catalog/memories/<MEM_ID>.test.ts` に載ったため空。
 * 新しいメモリーを追加するときも、ここへ積むのではなくユニット効果軸のファイルを
 * 同じPRで用意する（`12_テスト戦略.md`「Memory 側の標準形」）。
 */
export const UNCOVERED_MEMORY_IDS: readonly string[] = [];
