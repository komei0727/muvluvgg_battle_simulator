import { describe, expect, it } from "vitest";
import { applyEffectActionGroups } from "../../../domain/battle/resolution/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../../domain/battle/skill/skill-resolution-service.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  completedTargetIdsOf,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  effectActionGroupContext,
  seedRecorder,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
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
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseCompleted,
  skillUseStarting,
} from "../../../testing/production-unit/trigger-events.js";
import { rideStandInAttack } from "../../../testing/production-unit/follow-up-ride.js";

/**
 * `UNIT_CHIYURU_MAZE`（【博識なメイズの探求者】月ヶ瀬ちゆる）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIYURU_MAZE";

/**
 * EXの総称 `STATUS` 照会は継続ダメージ側（毒）と状態側（気絶）の2系統をまとめて
 * 拾う。ちゆる自身は `APPLY_STATUS` の状態異常を配らないため、状態側の成立を
 * 手組みの`AppliedEffect`ではなく実 production 定義で作れるよう、気絶を配る別ユニット
 * の定義だけを併せて読み込む。`-002`／`-003` はこのユニットのSkill・EffectAction閉包
 * だけを見るため、閉包の判定には影響しない。
 */
const STUN_SOURCE_UNIT_ID = "UNIT_LUCIE_MAID";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  STUN_SOURCE_UNIT_ID,
]);

/** 契機を出す味方の属性・タイプを差し替えた味方配置（PSの発動条件の作り分け）。 */
function alliesWith(overrides: Partial<BoardUnitSpec>): readonly BoardUnitSpec[] {
  return [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, ...overrides },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ];
}

/**
 * 敵前列だけHPを高くした配置（`HP_RATIO >= 0.8`の成立側を作る）。攻撃後にちょうど
 * 9000へ落ちる値にして、現在HP割合で決まる毒の効果量を丸めのない900にする。
 */
const HIGH_HP_FRONT: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 9702 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_EX",
    intent: "敵全体に威力117で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_EX",
    intent:
      "対象が状態異常にある場合、1行動分の気絶を付与し、一度だけ対象の受ける被ダメージを100%増加させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_EX" },
    // 状態異常は実 production の毒定義で作る（AOE内の1体だけが条件を満たす局面）。
    precedingActions: [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_STUN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
          magnitude: 1,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent: "敵前後列に威力140.56で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    expected: {
      // 基準敵は既定順の敵前列で、その前後列＝CENTER列。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
        "enemy:back": -702,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent: "対象が毒状態だった場合一時的に防御力を20%低下させ（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    precedingActions: [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      // 防御力が500→400へ下がった基準敵だけ、同じ威力で被ダメージが増える。
      hpDeltas: {
        "enemy:front": -843,
        "enemy:back": -702,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DEF_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent:
      "対象のHPが80%以上だった場合、対象に3行動の間毒を付与する。毒状態は行動タイミングごとに現在HPの10%のダメージを受ける",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    board: { enemies: HIGH_HP_FRONT },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
        "enemy:back": -702,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON",
          // 攻撃後の現在HP9000の10%。
          magnitude: 900,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS2",
    intent: "敵単体に威力13.26で13ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // 1ヒット66（500×13.26%の切り捨て）×13ヒット。
      hpDeltas: {
        "enemy:front": -858,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
    intent:
      "他のシャイ属性の味方がアクティブスキルで攻撃した後に発動。攻撃された対象に対して威力106で追撃し、2行動分の毒を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ attribute: "SHY" }) },
    expected: {
      // 追撃は既定の対象選択ではなく「攻撃された対象」へ向かう。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_POISON", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -530,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_POISON",
          // 追撃後の現在HP4470の10%。
          magnitude: 447,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
    intent: "(不成立): シャイ属性でない味方のアクティブスキル攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ attribute: "CUTE" }) },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
    intent:
      "(同時発動制限)他の敏捷タイプの味方がアクティブスキルで攻撃する前に発動。当該攻撃に威力38.16のダメージと、3行動分の毒効果を追加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ unitType: "AGILE" }) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_FOLLOW_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_FOLLOW_UP",
          magnitude: 0,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
    intent: "(不成立): 敏捷タイプでない味方のアクティブスキル攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ unitType: "ENERGY" }) },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CHIYURU_MAZE (【博識なメイズの探求者】月ヶ瀬ちゆる)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIYURU-MAZE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIYURU-MAZE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIYURU-MAZE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
        // R-FUP-01: PS2の毒は追撃バフ（`ACT_CHIYURU_MAZE_PS2_FOLLOW_UP`の
        // `onHitEffect`参照）が味方の攻撃に相乗りしたときだけ実行される。表は
        // 「スキル使用1回」単位のためPS発動（バフ付与）までしか表せず、
        // 実行は`IT-UNIT-CHIYURU-MAZE-006`が保持者の実AS経路で検証する。
        ["ACT_CHIYURU_MAZE_PS2_POISON"],
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-CHIYURU-MAZE-004 (R-SKL-06/R-STS-01): EXの `categories: [STATUS]` 照会はAOEの対象ごとに評価され、`APPLY_CONTINUOUS_DAMAGE` の毒でも `APPLY_STATUS` の気絶でも成立し、状態異常ではない単なるデバフでは成立しない。成立した付与は `stateDelta` だけからも独立Reducerが同じ最終状態へ復元する", () => {
    const skillId = "SKL_CHIYURU_MAZE_EX";
    const skill = skillFrom(snapshot, skillId);
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const ALL_ENEMIES = ["enemy:back", "enemy:front", "enemy:left"] as const;

    const useEx = (precedingActions: readonly PrecedingAction[]) => {
      const baseline = applyPrecedingActions(board, precedingActions);
      const actor = baseline.find((unit) => unit.battleUnitId === "ally:subject")!;
      const { recorder, rootEventId } = seedRecorder("B_CHIYURU_EX");
      const result = applyEffectActionGroups(
        resolveSkillOrder(
          skill,
          actor,
          baseline,
          board.definitions.effectActions,
          undefined,
          board.definitions.unitDefinitions,
        ),
        baseline,
        effectActionGroupContext({
          actor,
          skillId,
          definitions: board.definitions,
          recorder,
          rootEventId,
        }),
      );
      return { baseline, recorder, units: result.units };
    };

    // 前提アクションは既定順の最も近い敵（enemy:front）だけへ入る。
    const poisoned = useEx([
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ]);
    // 攻撃自体は敵全体へ入り、条件付きの2効果は状態異常を持つ1体だけへ入る。
    expect(
      [...completedTargetIdsOf(poisoned.recorder, "ACT_CHIYURU_MAZE_EX_DAMAGE")].sort(),
    ).toEqual([...ALL_ENEMIES]);
    for (const actionId of ["ACT_CHIYURU_MAZE_EX_STUN", "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP"]) {
      expect(completedTargetIdsOf(poisoned.recorder, actionId)).toEqual(["enemy:front"]);
    }

    // `APPLY_STATUS` 側の状態異常（気絶）でも同じく成立する。ここが無いと、Catalogの
    // 条件を `continuousDamageKinds: ["POISON"]` へ絞る誤変更を検出できない —
    // R-STS-01が定める2系統（継続ダメージ・状態）を1つの `STATUS` で総称照会する契約は、
    // 両系統を1つのスキルへ通して初めて固定される。
    const stunned = useEx([
      { effectActionDefinitionId: "ACT_LUCIE_MAID_AS1_STUN", target: "ENEMY" },
    ]);
    expect(
      [...completedTargetIdsOf(stunned.recorder, "ACT_CHIYURU_MAZE_EX_DAMAGE")].sort(),
    ).toEqual([...ALL_ENEMIES]);
    for (const actionId of ["ACT_CHIYURU_MAZE_EX_STUN", "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP"]) {
      expect(completedTargetIdsOf(stunned.recorder, actionId)).toEqual(["enemy:front"]);
    }

    // 状態異常ではない単なるデバフ（防御力低下）だけを持つ対象では不成立 —
    // `DEBUFF` への近似ではなく `STATUS` そのものを見ている。
    const debuffed = useEx([
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DEF_DOWN", target: "ENEMY" },
    ]);
    expect(
      [...completedTargetIdsOf(debuffed.recorder, "ACT_CHIYURU_MAZE_EX_DAMAGE")].sort(),
    ).toEqual([...ALL_ENEMIES]);
    for (const actionId of ["ACT_CHIYURU_MAZE_EX_STUN", "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP"]) {
      expect(completedTargetIdsOf(debuffed.recorder, actionId)).toEqual([]);
    }

    // Domain Event（`EffectApplied`）・StateDelta・独立Reducer復元:
    // 使用前を基準線にして `stateDelta` だけから再構成した最終状態が、集約側と一致する。
    const reconstructed = reconstruct(
      initialSnapshotFor(poisoned.baseline, { include: ["effects"] }),
      poisoned.recorder,
    );
    for (const enemyId of ALL_ENEMIES) {
      const aggregate = poisoned.units.find((unit) => unit.battleUnitId === enemyId)!;
      const restored = reconstructed.units[createBattleUnitId(enemyId)];
      expect((restored?.effects ?? []).map((effect) => effect.effectDefinitionId).sort()).toEqual(
        aggregate.appliedEffects.map((effect) => String(effect.effectActionDefinitionId)).sort(),
      );
      expect(restored?.hp).toBe(aggregate.currentHp);
    }
    // 成立した対象にだけ、EXが配る2効果が毒と並んで残る。
    expect(
      poisoned.units
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.map((effect) => String(effect.effectActionDefinitionId))
        .sort(),
    ).toEqual([
      "ACT_CHIYURU_MAZE_AS1_POISON",
      "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
      "ACT_CHIYURU_MAZE_EX_STUN",
    ]);
  });
  it("IT-UNIT-CHIYURU-MAZE-005 (R-DOT-01/R-DOT-04): PS1・PS2が配る毒は、保持者**自身**の行動開始でだけ発生し、発火のたびにその時点の現在HPを読み直す。同じ保持者への毒の再付与はインスタンスを増やさない", () => {
    // `-001` のPS1・PS2行は付与そのもの（付与時点の現在HP×10%のsnapshotと2行動）
    // までを固定する。R-DOT-01「付与対象の行動開始時に発生する」は保持者の以後の
    // 行動に属するため、スキル使用1回の観測には載らない — 他のユニットの行動開始で
    // 発火しないことも、同じ観測の中に対照として置いて初めて固定される。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    // 前提アクションは既定順の最も近い敵（enemy:front、現在HP5000）だけへ入る。
    const poisonedBy = (effectActionDefinitionId: string, battleId: string) =>
      observeContinuousDamage({
        units: applyPrecedingActions(board, [{ effectActionDefinitionId, target: "ENEMY" }]),
        definitions: board.definitions,
        // 保持者ではない敵の行動開始 → 保持者自身の行動開始2回、の順。
        actors: ["enemy:left", "enemy:front", "enemy:front"],
        battleId,
      });
    const tick = (effectActionDefinitionId: string, currentHp: number) => ({
      unitId: "enemy:front",
      effectActionDefinitionId,
      continuousDamageKind: "POISON",
      damageType: "PHYSICAL",
      // R-DOT-04の上限は付与時攻撃力×100%＝1000。10%側はそこへ届かない。
      snapshotAttack: 1000,
      formulaResult: currentHp * 0.1,
      burnStackMultiplier: 1,
      cappedBySnapshotAttack: false,
      calculatedDamage: currentHp * 0.1,
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      subUnitAbsorbed: 0,
      discardedDamage: 0,
      hitPointDamage: currentHp * 0.1,
    });

    // 2つのPSはどちらも同じ形（現在HP×10%、2行動）を配る。実 `catalog/` の
    // `timing` が保持者の `ActionStarted` 以外を指していると、この表の2行目・3行目が
    // 空になって落ちる。
    for (const [effectActionDefinitionId, battleId] of [
      ["ACT_CHIYURU_MAZE_PS1_POISON", "B_CHIYURU_MAZE_PS1_POISON"],
      ["ACT_CHIYURU_MAZE_PS2_POISON", "B_CHIYURU_MAZE_PS2_POISON"],
    ] as const) {
      expect(poisonedBy(effectActionDefinitionId, battleId).steps).toEqual([
        { step: "ACTION_START(enemy:left)", ticks: [], hpDeltas: {} },
        {
          step: "ACTION_START(enemy:front)",
          ticks: [tick(effectActionDefinitionId, 5000)],
          hpDeltas: { "enemy:front": -500 },
        },
        {
          // 2回目は1回目が削った後の4500を読み直す（付与時のsnapshotを使い回さない）。
          step: "ACTION_START(enemy:front)",
          ticks: [tick(effectActionDefinitionId, 4500)],
          hpDeltas: { "enemy:front": -450 },
        },
      ]);
    }

    // R-DOT-04「毒を再度付与された場合、効果量が大きい方に統合する」。PS1の毒を
    // 持つ相手へPS2の毒が入っても、インスタンスは増えず発生も1回のままになる。
    const reGranted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_POISON", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_POISON", target: "ENEMY" },
    ]);
    expect(
      reGranted
        .find((unit) => unit.battleUnitId === "enemy:front")!
        .appliedEffects.filter((effect) => effect.continuousDamage !== undefined),
    ).toHaveLength(1);
    expect(
      observeContinuousDamage({
        units: reGranted,
        definitions: board.definitions,
        actors: ["enemy:front"],
        battleId: "B_CHIYURU_MAZE_POISON_REGRANT",
      }).steps[0]!.ticks,
    ).toEqual([tick("ACT_CHIYURU_MAZE_PS1_POISON", 5000)]);
  });

  it("IT-UNIT-CHIYURU-MAZE-006 (R-FUP-01): PS2の追撃バフを保持した味方が実ASで攻撃すると、当該攻撃の後に威力38.16の追撃が味方のステータスで入り、ヒットした敵へ毒が付与され、バフはその1回で失効する", () => {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    // 付与は実productionの`APPLY_FOLLOW_UP_ATTACK` resolver経由（PS発動から付与までは
    // `-001`表が固定済み。ここは相乗りの解決だけを観測する）。
    const withRider = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_FOLLOW_UP", target: "ALLY" },
    ]);
    const holder = withRider.find((unit) =>
      unit.appliedEffects.some((effect) => effect.isFollowUpAttack === true),
    );
    expect(holder).toBeDefined();

    const { units } = rideStandInAttack({
      attackerUnitId: holder!.battleUnitId,
      units: withRider,
      definitions: board.definitions,
      battleId: "B_CHIYURU_MAZE_PS2_RIDE",
    });

    // AS本体: (1000 - 500) x 1.0 = 500。追撃: (1000 - 500) x 0.3816 = 190（非会心継承）。
    const attacked = units.filter(
      (unit) => unit.side === "ENEMY" && unit.currentHp < unit.combatStats.maximumHp / 2,
    );
    expect(attacked).toHaveLength(1);
    const enemyAfter = attacked[0]!;
    expect(enemyAfter.currentHp).toBe(5000 - 500 - 190);
    // onHitEffect（毒3行動）が追撃ヒット対象へ付与される。効果量は付与時点の現在HPx10%。
    const poison = enemyAfter.appliedEffects.filter(
      (effect) => effect.effectActionDefinitionId === "ACT_CHIYURU_MAZE_PS2_POISON",
    );
    expect(poison).toHaveLength(1);
    expect(poison[0]).toMatchObject({
      magnitude: 431,
      continuousDamage: { continuousDamageKind: "POISON", damageType: "PHYSICAL" },
    });
    // バフは「次の攻撃1回」で消費・失効している。
    const holderAfter = units.find((unit) => unit.battleUnitId === holder!.battleUnitId)!;
    expect(holderAfter.appliedEffects.some((effect) => effect.isFollowUpAttack)).toBe(false);
  });
});
