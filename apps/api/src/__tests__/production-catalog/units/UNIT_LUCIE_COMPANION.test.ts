import { describe, expect, it } from "vitest";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { resolveSkillUse } from "../../../domain/battle/resolution/action-skill-use-resolver.js";
import {
  applyStateDelta,
  reduceStateDeltas,
} from "../../../domain/battle/events/state-delta-reducer.js";
import { createSkillDefinitionId } from "../../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  noMissNoCrit,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { openPassiveChain } from "../../../testing/production-unit/passive-activation.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeContinuousDamage } from "../../../testing/production-unit/continuous-damage.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LUCIE_COMPANION`（【連れ添い歩む傍らの友】リュシー・ムーアクロフト）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * AS3行が「自身のAS使用後」のPS1（`SKL_LUCIE_COMPANION_PS1`）を巻き込むのは
 * 実戦闘どおりで、AS1・AS2の行はPS1をクールタイム中に置いて回復の効果量だけを
 * 切り出している。
 */

const UNIT_DEFINITION_ID = "UNIT_LUCIE_COMPANION";

/**
 * 毒はシールドで受けない（R-DOT-04第2項・R-SUB-01）。シールドが1枚も無い盤面では
 * この主張が空振りするため、リュシー自身が配らないシールドを実 production 定義で
 * 用意できるよう、供給元のユニットだけを併せて読み込む。`-002`／`-003` はこの
 * ユニットのSkill・EffectAction閉包だけを見るため、閉包の判定には影響しない。
 */
const SHIELD_SOURCE_UNIT_ID = "UNIT_AOI_GUARDIAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  SHIELD_SOURCE_UNIT_ID,
]);

/** 後列の味方だけHP割合を下げた配置（`LOWEST_HP_RATIO`が自身以外を選ぶ）。 */
const LOW_HP_BACK_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
  ],
};

/**
 * PS1をクールタイム中に置き、ASそのものの効果だけを観測へ残す。単位をTURNにするのは
 * 行動完了時のACTION単位減算に巻き込まれず、クールタイム残数の変化が観測へ漏れないため。
 */
const PS1_ON_COOLDOWN: BoardOverrides = {
  subject: {
    state: {
      cooldowns: {
        [createSkillDefinitionId("SKL_LUCIE_COMPANION_PS1")]: { unit: "TURN", remaining: 1 },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_EX",
    intent:
      "最もHP割合が低い味方単体に対し、1行動の間敵から受ける攻撃のダメージを無効にする効果を付与する。さらに1行動の間攻撃力を35%上昇させるが、同時に1行動の毒を付与する。毒状態は行動タイミングごとに現在HPの20%のダメージを受ける",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_COMPANION_EX" },
    board: LOW_HP_BACK_ALLY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_DAMAGE_IMMUNITY",
          targets: ["ally:back"],
        },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_ATK_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_POISON", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_DAMAGE_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_ATK_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          // 毒は発火のたびに現在HPを参照し直すため、付与時の値は監査用のsnapshot
          // （現在HP2000の20%）。
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_POISON",
          magnitude: 400,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_AS1",
    intent:
      "敵単体に威力85.8でEN攻撃し、最もHP割合が低い味方単体に対して与えたダメージの35%分と、最大HP×10%分のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_COMPANION_AS1" },
    board: { ...LOW_HP_BACK_ALLY, ...PS1_ON_COOLDOWN },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS1_HEAL_FROM_DAMAGE",
          targets: ["ally:back"],
        },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS1_HEAL_MAXHP", targets: ["ally:back"] },
      ],
      // 与えたダメージ429の35%＝150（切り捨て）と、最大HP10000の10%＝1000。
      hpDeltas: { "enemy:front": -429, "ally:back": 1150 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_COMPANION_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_AS2",
    intent: "最もHP割合の低い味方単体のHPを威力55で回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_COMPANION_AS2" },
    board: { ...LOW_HP_BACK_ALLY, ...PS1_ON_COOLDOWN },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS2_HEAL", targets: ["ally:back"] },
      ],
      hpDeltas: { "ally:back": 550 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_COMPANION_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_AS3",
    intent:
      "味方全体に対し、威力65分のHP回復量を均等に配分して回復し、HP回復量を15%増加させるバフを付与する（重複可）。さらに敵全体に対し、HP回復量を15%減少させるデバフを付与する。（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUCIE_COMPANION_AS3" },
    board: PS1_ON_COOLDOWN,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN", targets: ["enemy:back"] },
      ],
      // 攻撃力1000×威力65%＝650を味方3体へ均等配分。
      hpDeltas: {
        "ally:subject": 216,
        "ally:front": 216,
        "ally:back": 216,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP",
          magnitude: 0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP",
          magnitude: 0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_UP",
          magnitude: 0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
    intent:
      "自身がアクティブスキルを使用した後に発動。自身に隣接する味方に対し、2行動の間、行動時に最大HP×10%分のHPを回復する効果を付与する。さらに敵前衛に対し、1行動の間、行動時に攻撃力×10%のENダメージを受けるデバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:back"],
        skillType: "AS",
        skillDefinitionId: "SKL_LUCIE_COMPANION_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 前列中央の自身に隣接する味方は ally:front（左隣）と ally:back（後ろ）。
      // 敵前衛は enemy:front と enemy:left。
      actions: [
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_DAMAGE",
          targets: ["enemy:left"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_DAMAGE",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_DAMAGE",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUCIE_COMPANION_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
    intent:
      "(不成立): 自身のEXスキル使用では発動しない（「アクティブスキルを」使用した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:back"],
        skillType: "EX",
        skillDefinitionId: "SKL_LUCIE_COMPANION_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
    intent: "(不成立): 他の味方のAS使用では発動しない（「自身が」使用した場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUCIE_COMPANION_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_LUCIE_COMPANION (【連れ添い歩む傍らの友】リュシー・ムーアクロフト)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LUCIE-COMPANION-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LUCIE-COMPANION-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LUCIE-COMPANION-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-LUCIE-COMPANION-004 (R-HEAL-01, HEAL_DISTRIBUTE): `ACT_LUCIE_COMPANION_AS3_HEAL` は威力65の回復量**1つ**を味方全員へ均等配分する（各自が満額を受け取るのではない）", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, PS1_ON_COOLDOWN);
    const recorder = new EventRecorder(createBattleId("B_LUCIE_HEAL"));
    resolveSkillUse(
      board.subject,
      skillFrom(snapshot, "SKL_LUCIE_COMPANION_AS3"),
      "AS",
      "AS",
      board.units,
      board.definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId("B_LUCIE_HEAL:action:1"),
      recorder.nextResolutionScopeId(),
    );

    const healEvents = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "HealApplied" }> =>
          event.eventType === "HealApplied",
      );
    expect(healEvents).toHaveLength(3);
    for (const event of healEvents) {
      expect(event.payload).toMatchObject({
        effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS3_HEAL",
        // 攻撃力1000×威力65%の650が「配分元の総量」で、3人で割った216が実回復量。
        formulaResult: 650,
        distributionShareCount: 3,
        healAmount: 216,
        appliedAmount: 216,
      });
    }
  });

  it("IT-UNIT-LUCIE-COMPANION-005 (R-HEAL-03): `ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL` は付与時点では回復せず、production の ACTION(2) 期間を持つ効果として載る。その `EffectApplied` の StateDelta だけからも独立Reducerが同じ効果を復元する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const chain = openPassiveChain({
      definitions: board.definitions,
      actorUnitId: "ally:subject",
      battleId: "B_LUCIE_HOT",
    });
    const after = chain.fire(
      skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:back"],
        skillType: "AS",
        skillDefinitionId: "SKL_LUCIE_COMPANION_AS2",
      }),
      board.units,
    );

    const holder = after.find((unit) => unit.battleUnitId === "ally:front")!;
    // 継続回復は保持者の次の`ActionStarted`で発火するため、付与時点ではHPが動かない。
    expect(holder.currentHp).toBe(
      board.units.find((u) => u.battleUnitId === "ally:front")!.currentHp,
    );
    expect(chain.recorder.getEvents().some((event) => event.eventType === "HealApplied")).toBe(
      false,
    );

    const applied = chain.recorder
      .getEvents()
      .find(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplied" }> =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL" &&
          event.payload.targetUnitId === "ally:front",
      )!;
    expect(applied.payload).toMatchObject({ durationUnit: "ACTION", initialRemaining: 2 });

    const reduced = applyStateDelta(
      initialSnapshotFor(board.units, { status: "READY" }),
      applied.stateDelta!,
    );
    expect(reduced.units[createBattleUnitId("ally:front")]!.effects).toHaveLength(1);
    expect(reduced.units[createBattleUnitId("ally:front")]!.effects![0]).toMatchObject({
      effectDefinitionId: "ACT_LUCIE_COMPANION_PS1_CONTINUOUS_HEAL",
      duration: { unit: "ACTION", remaining: 2 },
    });
  });
  it("IT-UNIT-LUCIE-COMPANION-006 (R-DOT-04): EXが配る毒は発火のたびに保持者の**現在**HPを読み直し、付与時攻撃力×100%で頭打ちになる。シールドが張ってあっても吸われない", () => {
    // `-001` のEX行は付与そのもの（付与時点の現在HP×20%＝400のsnapshotと1行動）
    // までを固定する。R-DOT-04の本体——発火時点のHPで評価し直すこと・上限で
    // 頭打ちになること・シールドを素通りすること——は保持者の以後の行動に属し、
    // スキル使用1回の観測には載らない。
    const poisonedEnemy = (currentHp: number, battleId: string) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID, {
        enemies: [
          { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp } },
          { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
          { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
        ],
      });
      // 前提アクションは既定順の最も近い敵（enemy:front）だけへ入る。毒 → 実AS1の
      // 一撃（429）→ シールド の順に並べ、**付与後・発火前にHPが動いた**状態と、
      // 毒が素通りするシールド（攻撃力×120%＝1200）を同時に用意する。
      const baseline = applyPrecedingActions(board, [
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_POISON", target: "ENEMY" },
        { effectActionDefinitionId: "ACT_LUCIE_COMPANION_AS1_DAMAGE", target: "ENEMY" },
        { effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD", target: "ENEMY" },
      ]);
      return {
        baseline,
        observation: observeContinuousDamage({
          units: baseline,
          definitions: board.definitions,
          actors: ["enemy:front"],
          battleId,
        }),
      };
    };

    // 上限に届かない側: 付与時は3000の20%＝600をsnapshotするが、発火時点のHPは
    // 一撃ぶん減った2571なので、実際に発生するのはその20%＝514（切り捨て）。
    const belowCap = poisonedEnemy(3000, "B_LUCIE_POISON_BELOW");
    expect(
      belowCap.baseline
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.find(
          (effect) => effect.effectActionDefinitionId === "ACT_LUCIE_COMPANION_EX_POISON",
        )!.magnitude,
    ).toBe(600);
    expect(belowCap.observation.steps).toEqual([
      {
        step: "ACTION_START(enemy:front)",
        ticks: [
          {
            unitId: "enemy:front",
            effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_POISON",
            continuousDamageKind: "POISON",
            damageType: "PHYSICAL",
            // R-DOT-04の上限＝付与時攻撃力×100%。リュシーの攻撃力1000。
            snapshotAttack: 1000,
            formulaResult: 514.2,
            burnStackMultiplier: 1,
            cappedBySnapshotAttack: false,
            calculatedDamage: 514,
            // R-DOT-04第2項／R-SUB-01: 1200のシールドが張ってあっても毒は素通りする。
            typedShieldAbsorbed: 0,
            untypedShieldAbsorbed: 0,
            subUnitAbsorbed: 0,
            discardedDamage: 0,
            hitPointDamage: 514,
          },
        ],
        hpDeltas: { "enemy:front": -514 },
      },
    ]);
    // 公開差分だけを当て直した状態を、スナップショット全体で突き合わせる。
    // 発生量が合っていても、`ContinuousDamageApplied` のStateDeltaが欠ければここで落ちる。
    expect(
      reduceStateDeltas(
        initialSnapshotFor(belowCap.baseline, { include: ["effects"] }),
        belowCap.observation.recorder
          .getEvents()
          .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
      ),
    ).toEqual(initialSnapshotFor(belowCap.observation.units, { include: ["effects"] }));

    // 上限側: 満HP10000から一撃ぶん減った9571の20%＝1914.2は上限1000を超えるため、
    // 発生するのは1000で頭打ちになる。
    const capped = poisonedEnemy(10000, "B_LUCIE_POISON_CAPPED");
    expect(capped.observation.steps[0]!.ticks).toEqual([
      {
        unitId: "enemy:front",
        effectActionDefinitionId: "ACT_LUCIE_COMPANION_EX_POISON",
        continuousDamageKind: "POISON",
        damageType: "PHYSICAL",
        snapshotAttack: 1000,
        formulaResult: 1914.2,
        burnStackMultiplier: 1,
        cappedBySnapshotAttack: true,
        calculatedDamage: 1000,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 0,
        discardedDamage: 0,
        hitPointDamage: 1000,
      },
    ]);
  });
});
