import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveDeclaredCriticalMode } from "../../domain/battle/combat/critical-policy.js";
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";
import type { EffectActionDefinitionInput } from "../../domain/catalog/definitions/effect-action-definition.js";
import { referencesTargetCurrentHp } from "../../domain/catalog/definitions/formula-definition.js";

/**
 * R-CRT-04（対象HP割合ダメージの会心不可）が実 Catalog で会心不可にする `DAMAGE`
 * 定義の集合を固定する。
 *
 * 規則は Formula 種別から会心モードを導出するため、対象は Catalog 側の宣言ではなく
 * **定義の形**で決まる。ユニット追加や既存定義の Formula 差し替えで範囲が黙って
 * 増減しても、個々のユニット結合テストは自分のスキルしか見ておらず気付けない。
 * ここだけが「どの production 定義が会心しなくなったか」を一覧として持つ。
 */
const EFFECTS_PATH = fileURLToPath(new URL("../../../catalog/effects.json", import.meta.url));

/**
 * 会心判定を行わない production 定義。上5件は raw原文が「対象の現在HP×N%分の
 * ダメージを与える攻撃」に当たるもので、いずれも `MIN` で使用者の攻撃力上限と
 * 組になっている。
 *
 * `ACT_FLUTE_VAMPIRE_AS1_HP_COST` は「自身の現在HPの25%を消費する」コストを
 * 自身への `DAMAGE` として表した定義であり、規則の導入前から `critical.mode:
 * PREVENTED` を宣言している。規則が既存 Catalog の意図と一致していることを示すため
 * 除外せずここへ並べる。
 */
const CRITICAL_PREVENTED_BY_RULE: readonly string[] = [
  "ACT_AOI_ELEGANT_AS2_BONUS_DAMAGE",
  "ACT_ELENA_MOODMAKER_AS2_DAMAGE",
  "ACT_FLUTE_VAMPIRE_AS1_HP_COST",
  "ACT_MERU_FLATSPIN_EX_DAMAGE_EXTRA",
  "ACT_SHOUKA_BEACH_EX_DAMAGE",
  "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE",
  "ACT_STELLA_STATUE_PS1_DAMAGE",
];

const DEFINITIONS = (
  JSON.parse(readFileSync(EFFECTS_PATH, "utf8")) as readonly EffectActionDefinitionInput[]
).map((input) => createEffectActionDefinition(input, "effectAction"));

describe("R-CRT-04 production catalog audit", () => {
  it("IT-AUDIT-CRT-001: exactly the listed production DAMAGE definitions fall under the rule, and every one of them resolves to PREVENTED", () => {
    // 母集合は「規則が掛かる定義」であって「会心不可な定義」ではない。後者には
    // `ACT_SAYA_BUNNY_EX_DAMAGE_EXTRA`（`SKILL_POWER`だが自前で`PREVENTED`を宣言）
    // のような別理由のものが混ざり、規則の範囲を測れない。
    const covered = DEFINITIONS.filter(
      (definition) =>
        definition.kind === "DAMAGE" && referencesTargetCurrentHp(definition.payload.formula),
    );

    expect(covered.map((definition) => String(definition.effectActionDefinitionId)).sort()).toEqual(
      [...CRITICAL_PREVENTED_BY_RULE].sort(),
    );
    for (const definition of covered) {
      if (definition.kind === "DAMAGE") {
        expect(resolveDeclaredCriticalMode(definition.payload)).toBe("PREVENTED");
      }
    }
  });

  it("IT-AUDIT-CRT-002: the non-SKILL_POWER DAMAGE definitions left out of the rule keep rolling for a critical", () => {
    // 自身HP消費型・最大HP消費型・反撃型は実機仕様が未確認のため対象外に置いている
    // （`07_戦闘ルール詳細.md` R-CRT-04）。攻撃力と防御力の差を経由しない点は同じ
    // なので、規則の述語を広げると黙ってこちら側も巻き込む。境界を明示して固定する。
    const stillRolling = DEFINITIONS.filter(
      (definition) =>
        definition.kind === "DAMAGE" &&
        definition.payload.formula.kind !== "SKILL_POWER" &&
        resolveDeclaredCriticalMode(definition.payload) !== "PREVENTED",
    )
      .map((definition) => String(definition.effectActionDefinitionId))
      .sort();

    expect(stillRolling).toEqual([
      "ACT_AOI_GUARDIAN_PS2_COUNTER",
      "ACT_KOKORO_SPORTSDAY_PS1_COUNTER",
      "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP",
      "ACT_LILY_HERO_AS1_DAMAGE_HPCOST",
      "ACT_LILY_SINGER_EX_DAMAGE",
      "ACT_MAO_COMMITTEE_AS1_DAMAGE",
      "ACT_MAO_SUMMER_AS1_HP_DAMAGE",
      "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE",
      "ACT_STELLA_STATUE_PS2_COUNTER",
      "ACT_SUIRAN_CASINO_AS2_DAMAGE",
    ]);
  });
});
