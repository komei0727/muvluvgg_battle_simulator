import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";
import type { EffectActionDefinitionInput } from "../../domain/catalog/definitions/effect-action-definition.js";
import { referencesHitPointRatio } from "../../domain/catalog/definitions/formula-definition.js";

/**
 * R-CRT-04（HP割合ダメージの会心宣言）の分類を、実 Catalog の定義名で固定する。
 *
 * 会心の有無は原文が「HP×N%**分**のダメージ」型か「**消費分**HP×N%のダメージ」型かで
 * 決まり、Formulaの形からは導けない。したがってこの分類は Catalog の宣言にしか現れず、
 * ユニット単位の結合テストは自分のスキルしか見ないため、どちらの群に何が居るかを
 * 通しで見る場所がここ以外に無い。既定値へ黙って倒れる事故はfactoryの宣言必須化が
 * 塞ぐが、「PREVENTEDと書くべき定義にNORMALと書いた」取り違えを止めるのはこの一覧である。
 */
const EFFECTS_PATH = fileURLToPath(new URL("../../../catalog/effects.json", import.meta.url));

/**
 * 会心判定を行わない（`PREVENTED`）: HPの一部をそのままダメージ量にする攻撃。
 * 威力に当たる倍率を持たず、使用者の攻撃力による上限が付くだけである。
 *
 * `ACT_ELENA_MOODMAKER_AS2_DAMAGE`（対象の現在HP×12.5%分）と
 * `ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP`（自身の最大HP×20%）が実機確認済みで、
 * 残りは同じ原文の型からの分類である。`ACT_FLUTE_VAMPIRE_AS1_HP_COST` だけは攻撃では
 * なく自身のHP消費を`DAMAGE`で表した定義で、規則の導入前から`PREVENTED`だった。
 */
const PREVENTED: readonly string[] = [
  "ACT_AOI_ELEGANT_AS2_BONUS_DAMAGE",
  "ACT_ELENA_MOODMAKER_AS2_DAMAGE",
  "ACT_FLUTE_VAMPIRE_AS1_HP_COST",
  "ACT_LAYLA_ENTREPRENEUR_PS2_DAMAGE_MAXHP",
  "ACT_LILY_SINGER_EX_DAMAGE",
  "ACT_MERU_FLATSPIN_EX_DAMAGE_EXTRA",
  "ACT_SHOUKA_BEACH_EX_DAMAGE",
  "ACT_SHOUKA_BEACH_TEX_EX_DAMAGE",
  "ACT_STELLA_STATUE_PS1_DAMAGE",
];

/**
 * 会心判定を行う（`NORMAL`）: HPを消費し、その消費分へ100%超の倍率を掛ける攻撃。
 * 基礎が攻撃力でないだけで通常の威力攻撃と同格である。
 * `ACT_LILY_HERO_AS1_DAMAGE_HPCOST`（消費した最大HP10%×319.8%）が実機確認済み。
 */
const ROLLING: readonly string[] = [
  "ACT_LILY_HERO_AS1_DAMAGE_HPCOST",
  "ACT_MAO_COMMITTEE_AS1_DAMAGE",
  "ACT_MAO_SUMMER_AS1_HP_DAMAGE",
  "ACT_MAO_SUMMER_TEX_AS1_HP_DAMAGE",
  "ACT_SUIRAN_CASINO_AS2_DAMAGE",
];

const DEFINITIONS = (
  JSON.parse(readFileSync(EFFECTS_PATH, "utf8")) as readonly EffectActionDefinitionInput[]
).map((input) => createEffectActionDefinition(input, "effectAction"));

const HIT_POINT_RATIO_DAMAGE = DEFINITIONS.filter(
  (definition) =>
    definition.kind === "DAMAGE" && referencesHitPointRatio(definition.payload.formula),
);

function idsWithMode(mode: string): readonly string[] {
  return HIT_POINT_RATIO_DAMAGE.filter(
    (definition) => definition.kind === "DAMAGE" && definition.payload.critical.mode === mode,
  )
    .map((definition) => String(definition.effectActionDefinitionId))
    .sort();
}

describe("R-CRT-04 production catalog audit", () => {
  it("IT-AUDIT-CRT-001: the production hit point ratio DAMAGE definitions split exactly into the PREVENTED and NORMAL lists", () => {
    expect(idsWithMode("PREVENTED")).toEqual([...PREVENTED].sort());
    expect(idsWithMode("NORMAL")).toEqual([...ROLLING].sort());
    // GUARANTEED はこの族に1件も無い。両リストの和が族の全件であることを固定する。
    expect(HIT_POINT_RATIO_DAMAGE).toHaveLength(PREVENTED.length + ROLLING.length);
  });

  it("IT-AUDIT-CRT-002: the non-SKILL_POWER DAMAGE definitions outside the rule are the counters, and they keep rolling for a critical", () => {
    // 反撃（`DAMAGE_RECEIVED_RATIO`）はHP由来の量ではないため宣言必須の族に入らない。
    // 実機での会心可否は未確認で、`NORMAL` を明示したまま据え置いている。R-CRT-04を
    // この3件へ広げるとしたら、まず境界がここで動く。
    const outside = DEFINITIONS.filter(
      (definition) =>
        definition.kind === "DAMAGE" &&
        definition.payload.formula.kind !== "SKILL_POWER" &&
        !referencesHitPointRatio(definition.payload.formula),
    );

    expect(outside.map((definition) => String(definition.effectActionDefinitionId)).sort()).toEqual(
      [
        "ACT_AOI_GUARDIAN_PS2_COUNTER",
        "ACT_KOKORO_SPORTSDAY_PS1_COUNTER",
        "ACT_STELLA_STATUE_PS2_COUNTER",
      ],
    );
    for (const definition of outside) {
      if (definition.kind === "DAMAGE") {
        expect(definition.payload.critical.mode).toBe("NORMAL");
      }
    }
  });
});
