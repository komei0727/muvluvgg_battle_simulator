import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  observeEffectAction,
  type EffectManifestationCase,
} from "../../../testing/production-unit/effect-manifestation.js";

/**
 * `UNIT_KOTOHA_REBEL`（【世界への反逆者】コトハ）のユニット単位production結合テスト
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

const UNIT_DEFINITION_ID = "UNIT_KOTOHA_REBEL";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, ACT_ID, 期待効果)。行の並びは AS → PS → EX のSkill定義順。 */
const MANIFESTATIONS: readonly EffectManifestationCase[] = [
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS1",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_DAMAGE1",
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
      eventCycles: 2,
      hpDeltas: {
        "enemy:foe": -1014,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS1",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_DAMAGE2",
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
      eventCycles: 2,
      hpDeltas: {
        "enemy:foe": -546,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS1",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS1_MARKER",
    target: "SELF",
    expected: {
      eventTypes: ["MarkerApplied"],
      markers: [
        {
          unitId: "ally:subject",
          markerId: "MARKER_FUNDO",
          stackCount: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_ATK_UP",
          magnitude: 0.05,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_1HIT",
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
        "enemy:foe": -936,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_2HIT",
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
      eventCycles: 2,
      hpDeltas: {
        "enemy:foe": -1248,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_3HIT",
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
      eventCycles: 3,
      hpDeltas: {
        "enemy:foe": -1521,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_DMG_3HIT_BOOSTED",
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
      eventCycles: 3,
      hpDeltas: {
        "enemy:foe": -2280,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_AS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
    target: "ENEMY",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "enemy:foe",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_AS2_TARGET_DMG_DOWN",
          magnitude: -0.1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS1",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS1_ATK_UP",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied", "CombatStatChanged"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS1_ATK_UP",
          magnitude: 0.1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DEATH_SURVIVAL",
          magnitude: 0,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_PS2",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DMG_UP",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_PS2_DMG_UP",
          magnitude: 0.1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_CONTINUOUS_HEAL",
    target: "SELF",
    expected: {
      eventTypes: ["EffectApplied"],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_CONTINUOUS_HEAL",
          magnitude: 0.135,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_DAMAGE",
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
        "enemy:foe": -2332,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_DAMAGE_PIERCE",
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
        "enemy:foe": -2798,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KOTOHA_REBEL_EX",
    effectActionDefinitionId: "ACT_KOTOHA_REBEL_EX_HEAL",
    target: "SELF",
    expected: {
      eventTypes: ["HealApplied"],
      hpDeltas: {
        "ally:subject": 3500,
      },
    },
  },
];

describe("production Catalog UNIT_KOTOHA_REBEL (【世界への反逆者】コトハ)", () => {
  it.each(MANIFESTATIONS)(
    "IT-UNIT-KOTOHA-REBEL-001: $effectActionDefinitionId ($skillDefinitionId) manifests exactly the declared effect on the $target target",
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

  it("IT-UNIT-KOTOHA-REBEL-002: the table's skill column covers exactly the Skills the production UnitDefinition declares", () => {
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
      "SKL_KOTOHA_REBEL_AS1",
      "SKL_KOTOHA_REBEL_AS2",
      "SKL_KOTOHA_REBEL_PS1",
      "SKL_KOTOHA_REBEL_PS2",
      "SKL_KOTOHA_REBEL_EX",
    ]);
    expect([...new Set(MANIFESTATIONS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });
});
