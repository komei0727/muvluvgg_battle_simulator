import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeEffectAction,
  type EffectManifestationCase,
} from "../../../testing/production-unit/effect-manifestation.js";

/**
 * `UNIT_JUNKA_CHILDHOOD`（【唯一無二の幼なじみ】鑑純夏）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 下の表が、このユニットの全Skillから到達できる全EffectActionを1件ずつ、
 * 実`catalog/`の未改変定義のまま実解決経路（`resolveSkillOrder`→
 * `applyEffectActionGroups`）へ通したときの観測結果を宣言する。イベント列・HP変動・
 * 効果付与・リソース変動・マーカー・クールタイムのうち**実際に動いた項目だけ**が
 * 観測に現れるため、`toEqual`の完全一致は「宣言した効果が出ること」と
 * 「余計な副作用を出さないこと」を同時に固定する。
 *
 * 表は全Skill ID・全EffectAction IDを文字列リテラルで持つため、production全ID
 * 網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。スキル側の対象選択・発動
 * 条件・PSトリガ・step分岐は表の対象外で、`-002`以降が機構ごとに検証する。
 */

const UNIT_DEFINITION_ID = "UNIT_JUNKA_CHILDHOOD";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, ACT_ID, 期待効果)。行の並びは AS → PS → EX のSkill定義順。 */
const MANIFESTATIONS: readonly EffectManifestationCase[] = [
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      hpDeltas: {
        "enemy:foe": -742,
      },
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DAMAGE_EXTRA",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      hpDeltas: {
        "enemy:foe": -234,
      },
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DEBUFF",
    target: "ENEMY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "enemy:foe",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS1_DEBUFF",
          magnitude: -0.2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS2_AP_UP",
    target: "SELF",
    expected: {
      eventTypes: ["ResourceChanged"],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_AS2",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_AS2_DAMAGE",
    target: "ENEMY",
    expected: {
      eventTypes: [
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageWillBeApplied",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
      ],
      eventCycles: 4,
      hpDeltas: {
        "enemy:foe": -1060,
      },
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_OTHERS",
          magnitude: 0.025,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_SELF",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_ATK_UP_SELF",
          magnitude: 0.05,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_OTHERS",
          magnitude: 0.025,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS1",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_SELF",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS1_DEF_UP_SELF",
          magnitude: 0.05,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
    target: "ALLY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:peer",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_CONTINUOUS_HEAL",
          magnitude: 0.15,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_PS2",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_PS2_HEAL",
    target: "SELF",
    expected: {
      eventTypes: ["HealApplied"],
      hpDeltas: {
        "ally:subject": 250,
      },
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_EX",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_DMG_UP",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_DMG_UP",
          magnitude: 0.6,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_JUNKA_CHILDHOOD_EX",
    effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_SHIELD",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_JUNKA_CHILDHOOD_EX_SHIELD",
          magnitude: 1000,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_JUNKA_CHILDHOOD (【唯一無二の幼なじみ】鑑純夏)", () => {
  it.each(MANIFESTATIONS)(
    "IT-UNIT-JUNKA-CHILDHOOD-001: $effectActionDefinitionId ($skillDefinitionId) manifests exactly the declared effect on the $target target",
    ({ effectActionDefinitionId, target, board, precedingSteps, expected }) => {
      expect(
        observeEffectAction({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          effectActionDefinitionId,
          target,
          ...(board === undefined ? {} : { board }),
          ...(precedingSteps === undefined ? {} : { precedingSteps }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-JUNKA-CHILDHOOD-002: the table's skill column covers exactly the Skills the production UnitDefinition declares", () => {
    // 表の網羅は`UT-AUDIT-UNITCOV-001`がEffectAction側から機械検証するが、
    // 「Skillが1つ丸ごと表から漏れている」ことは、そのSkill専用のEffectActionが
    // 他Skillからも到達できる場合に検出できない。Skill集合そのものをここで固定する。
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect(declared).toEqual([
      "SKL_JUNKA_CHILDHOOD_AS1",
      "SKL_JUNKA_CHILDHOOD_AS2",
      "SKL_JUNKA_CHILDHOOD_PS1",
      "SKL_JUNKA_CHILDHOOD_PS2",
      "SKL_JUNKA_CHILDHOOD_EX",
    ]);
    expect([...new Set(MANIFESTATIONS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });
});
