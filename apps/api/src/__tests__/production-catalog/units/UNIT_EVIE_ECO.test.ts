import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_EVIE_ECO`（【省エネ主義の天才ハッカー】エヴィ・レーナルト）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_EVIE_ECO";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_EVIE_ECO_EX",
    intent: "敵単体に威力301.2で攻撃し、対象に2行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_ECO_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_ECO_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_EX_STUN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -1506,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_EVIE_ECO_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          statusKind: "STUN",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_AS1",
    intent:
      "敵単体に威力156で攻撃し、次の攻撃の与ダメージを60%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_ECO_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_ECO_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_AS1_DEBUFF", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -780,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_EVIE_ECO_AS1_DEBUFF",
          magnitude: -0.6,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_EVIE_ECO_AS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_EVIE_ECO_AS2" },
    expected: {
      actions: [{ effectActionDefinitionId: "ACT_EVIE_ECO_AS2_DAMAGE", targets: ["enemy:front"] }],
      hpDeltas: {
        "enemy:front": -1060,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_EVIE_ECO_AS2", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_PS1",
    intent:
      "他の味方が攻撃される前に発動。その行動が終了するまでの間攻撃を自身に引き寄せ、50%をガードし肩代わりする",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_ECO_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
    },
    expected: {
      // 引き寄せ・肩代わりは**攻撃してきた敵**が持つ効果として表現される
      // （`TRIGGER_SOURCE` へ付与し、`redirectTo`/`coverer` が付与者エヴィを指す）。
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS1_REDIRECT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS1_COVER", targets: ["enemy:front"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_EVIE_ECO_PS1_REDIRECT",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_EVIE_ECO_PS1_COVER",
          // `damageShareRate: 1`（肩代わり者が防御側そのものになる）が magnitude に載る。
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_PS1",
    intent: "(不成立): 味方が味方を攻撃する契機では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_ECO_PS1",
      trigger: unitBeingAttacked({ source: "ally:back", target: "ally:front" }),
      triggeredBy: "ally:back",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_PS2",
    intent:
      "自身のHPが40%以下になった際に発動。威力75でHPを回復し、2行動の間自身の防御力を20%上昇させる（重複可）が、戦闘終了まで攻撃力が20%低下する（重複可）。さらに自身が含まれる横一列の他の味方に対し、防御力を10%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_ECO_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: { subject: { state: { currentHp: 4000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS2_DEF_UP_SELF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS2_ATK_DOWN_SELF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_EVIE_ECO_PS2_DEF_UP_ROW", targets: ["ally:front"] },
      ],
      hpDeltas: {
        "ally:subject": 750,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_EVIE_ECO_PS2_DEF_UP_SELF",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_EVIE_ECO_PS2_ATK_DOWN_SELF",
          magnitude: -0.2,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_EVIE_ECO_PS2_DEF_UP_ROW",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_PS2",
    intent: "(不成立): HPが40%より多く残っていれば発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_ECO_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_EVIE_ECO_PS2",
    intent: "(不成立): このスキルは戦闘中に一度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_EVIE_ECO_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: {
      subject: {
        state: {
          currentHp: 4000,
          skillCounters: {
            [createSkillDefinitionId("SKL_EVIE_ECO_PS2")]: {
              [createRuntimeCounterId("SKL_EVIE_ECO_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_EVIE_ECO (【省エネ主義の天才ハッカー】エヴィ・レーナルト)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-EVIE-ECO-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-EVIE-ECO-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-EVIE-ECO-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-EVIE-ECO-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_EVIE_ECO_PS2",
          counter: "SKL_EVIE_ECO_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_EVIE_ECO_PS2: [
          {
            skillDefinitionId: "SKL_EVIE_ECO_PS2",
            counter: "SKL_EVIE_ECO_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });
});
