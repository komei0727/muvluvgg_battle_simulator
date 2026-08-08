/**
 * production Catalog 全ID網羅監査のallowlist台帳。
 *
 * 全Unit・Memoryは最終的に `src/__tests__/production-catalog/units/<UNIT_ID>.test.ts`
 * ／`memories/<MEM_ID>.test.ts` のユニット単位結合テストで全Skill・全EffectActionの
 * 効果発現が検証される（`12_テスト戦略.md`）。この台帳は移行が完了していない定義を
 * 明示的に列挙する。掲載中の定義には対応テストファイルが存在してはならず
 * （カバー済みの残留を禁止し、バッチごとの縮小を強制する）、掲載外の定義には
 * 全ID参照を含むテストファイルが存在しなければならない。検証は
 * {@link ./production-id-coverage.test.ts} が行う。
 *
 * 台帳はIDを增やす方向へ編集してはならない。新規Unit・Memoryを追加する場合は
 * 同一PRでユニット単位結合テストを書く。
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

export const UNCOVERED_UNIT_IDS: readonly string[] = [
  "UNIT_AOI_ELEGANT",
  "UNIT_CHIYURU_MAZE",
  "UNIT_CHIYURU_NEWYEAR",
  "UNIT_CHIZURU_DOMESTIC",
  "UNIT_CLARA_SANTA",
  "UNIT_DOROTHEA_PIONEER",
  "UNIT_EVIE_KYONSHI",
  "UNIT_FEE_BATH",
  "UNIT_FLUTE_VAMPIRE",
  "UNIT_HARRIET_SAGE",
  "UNIT_JULIE_SNOW",
  "UNIT_KARINA_DOWNER",
  "UNIT_KATE_PALADIN",
  "UNIT_KEI_JACKKNIFE",
  "UNIT_KOKORO_SPORTSDAY",
  "UNIT_LAURA_MOUNTAIN",
  "UNIT_LILY_SINGER",
  "UNIT_LUCIE_COMPANION",
  "UNIT_LUCIE_MAID",
  "UNIT_LUNA_HUNGRY",
  "UNIT_LYDIA_GENIUS",
  "UNIT_MAIA_LAZY",
  "UNIT_MAIA_SALON",
  "UNIT_MAO_COMMITTEE",
  "UNIT_MEIYA_FATED",
  "UNIT_MERU_FLATSPIN",
  "UNIT_MERU_SIRIUS",
  "UNIT_MIHIME_SNIPER",
  "UNIT_MIKOTO_SURVIVOR",
  "UNIT_MIRIAM_MAGE",
  "UNIT_NADYA_SUCCESSOR",
  "UNIT_NANAE_COMMANDER",
  "UNIT_NOEL_RUMBLE",
  "UNIT_OLGA_VETERAN",
  "UNIT_RAMI_NEWYEAR",
  "UNIT_RAMI_UNYIELDING",
  "UNIT_RAVEL_MODEL",
  "UNIT_SENKA_CHRISTMAS",
  "UNIT_SENKA_SCHEMER",
  "UNIT_SHIRANA_LUCKY",
  "UNIT_SHIRANA_SORA",
  "UNIT_SHOUKA_SCHEMER",
  "UNIT_SIENA_DIVA",
  "UNIT_SIENA_OFFSTAGE",
  "UNIT_STELLA_STATUE",
  "UNIT_SUIRAN_CASINO",
  "UNIT_TARISA_TROUBLEMAKER",
  "UNIT_TATIANA_SAGE",
  "UNIT_YUI_HEIR",
  "UNIT_YURIA_YUKATA",
];

export const UNCOVERED_MEMORY_IDS: readonly string[] = [
  "MEM_ALWAYS_PICO_BESIDE_YOU",
  "MEM_BUSY_DAY_SLUMBER",
  "MEM_CATS_AND_DOGS_BOND",
  "MEM_CHAOS_MAIDEN",
  "MEM_CHAOS_MAIDEN_TWINTAIL_FEST",
  "MEM_COLORFUL_BOUQUET",
  "MEM_CURIOUS_EQUIPMENT",
  "MEM_DISCONTENT_AND_ANXIETY",
  "MEM_ELOPEMENT_FULL_THROTTLE",
  "MEM_ENCOUNTER_WITH_GIRLS",
  "MEM_FUUKI_IINKAI",
  "MEM_INCOGNITO_SISTER_ADVENTURE",
  "MEM_MOMOZONO_NEW_YEAR",
  "MEM_NAUGHTY_PENALTY_GAME",
  "MEM_NEW_YEAR_GREETING",
  "MEM_PANTS_STRAY_CAT",
  "MEM_PYXIS_MA_SOEUR",
  "MEM_SHAPING_FAMILY",
  "MEM_SIRIUS_SUGAR",
  "MEM_SOOTHING_SCENT",
  "MEM_STRANGERS",
  "MEM_TENT_COMMOTION",
  "MEM_THREE_MAIDS_HOSPITALITY",
  "MEM_TREBLE_QUINTET",
  "MEM_TRINITY_JEWEL",
];
