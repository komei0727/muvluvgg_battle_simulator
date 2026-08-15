import { describe, expect, it } from "vitest";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { reduceStateDeltas } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  skillFrom,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { observeClassificationTrigger } from "../../../testing/production-unit/effect-application.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { effectApplied } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_KATE_PALADIN`（【人見知りの聖騎士】ケイト・フルニエ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_KATE_PALADIN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * `RANDOM_BRANCH` の抽選値を先頭から順に固定する列。`selectWeightedBranch` は
 * `random.next() * totalWeight` を累積weightへ対応づけるため、先行するDAMAGEの
 * 会心判定（会心率0で1ヒットにつき1回消費する）を 0.99 で埋めてから腕の値を置く。
 * 余りは命中・会心を外れ側へ倒す 0.99 で埋める。
 */
function rolls(...draws: readonly number[]): () => SequenceRandomSource {
  return () => new SequenceRandomSource([...draws, ...new Array<number>(64).fill(0.99)]);
}

/** 4ヒット攻撃 → 抽選 → 4ヒット攻撃 → 抽選、という`SKL_KATE_PALADIN_AS1`の消費順。 */
function as1Rolls(first: number, second: number): () => SequenceRandomSource {
  return rolls(0.99, 0.99, 0.99, 0.99, first, 0.99, 0.99, 0.99, 0.99, second);
}

/** EXゲージを持つ敵。0のままでは「EXゲージを1削る」が下限で消えて観測に載らない。 */
const ENEMY_WITH_EX_GAUGE: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentExtraGauge: 3 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 攻撃力が1体だけ高い敵陣。`HIGHEST_ATTACK` が誰を選ぶかを判別できるようにする。 */
const ENEMY_WITH_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 後列の味方だけHP割合を下げた配置（`LOWEST_HP_RATIO`が自身以外を選ぶ）。 */
const LOW_HP_BACK_ALLY: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KATE_PALADIN_EX",
    intent: "同確率で抽選を行い、以下のいずれかを繰り出す。・敵単体に威力38.16で5ヒットEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_EX" },
    random: rolls(0.1),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_DAMAGE5", targets: ["enemy:front"] },
      ],
      // 1ヒット190（切り捨て）×5。
      hpDeltas: { "enemy:front": -950 },
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_EX",
    intent:
      "・敵全体に3行動の凍結を付与する。凍結状態中は全ての行動を行うことができない。ダメージを受けると凍結状態は解除されるが、その際の被ダメージが150%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_EX" },
    random: rolls(0.5),
    expected: {
      // 1体目の凍結が自身のPS1（「敵に凍結が付与された際」）の候補を生む。R-ATM-01に
      // より発動はEXの効果処理（3体分の凍結付与）が終わった後になり、その攻撃が
      // 1体目の凍結を解除する。PS1は`R-PS-07`（1解決スコープ1回）で1度しか走らない
      // ため、2体目以降の凍結は残る。PS1のダメージは795だが、凍結解除時の被ダメージ
      // 150%増加が乗って1987（切り捨て）になる。
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_FREEZE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_FREEZE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_FREEZE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_PS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -1987 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KATE_PALADIN_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KATE_PALADIN_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_EX",
    intent:
      "・味方全体のHPを最大HPの45%回復する。さらに最もHP割合の低い味方に対して、威力74.5で追加回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_EX" },
    board: { allies: LOW_HP_BACK_ALLY },
    random: rolls(0.9),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_HEAL_ALL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_HEAL_ALL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_HEAL_ALL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_EX_HEAL_EXTRA", targets: ["ally:back"] },
      ],
      // 全体回復は各自の最大HP10000の45%。追加回復は攻撃力1000×威力74.5%
      // （R-HEAL-01は防御力を差し引かない）で、回復後もHP割合が最も低い後列へ入る。
      hpDeltas: {
        "ally:subject": 4500,
        "ally:front": 4500,
        "ally:back": 5245,
      },
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS1",
    intent:
      "敵単体に威力23.4の4ヒットEN攻撃を行う。この攻撃には以下の内容から1つが同確率で抽選され、攻撃と同時に発生する。・対象のEXゲージを1削るさらに敵単体に威力12.48の4ヒットEN攻撃を行う。（略）・1行動の間、対象の与ダメージを15%減少させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS1" },
    board: { enemies: ENEMY_WITH_EX_GAUGE },
    random: as1Rolls(0.1, 0.3),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE2", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DMG_DOWN", targets: ["enemy:front"] },
      ],
      // 117×4 + 62×4。
      hpDeltas: { "enemy:front": -716 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KATE_PALADIN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS1",
    intent:
      "・与えたダメージの100%分、自身のHPを回復する（1回目の抽選）／・威力20で自身のHPを回復する（2回目の抽選）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS1" },
    random: as1Rolls(0.6, 0.6),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE1", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_SELF_HEAL_100",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE2", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_SELF_HEAL_20",
          targets: ["ally:subject"],
        },
      ],
      // 回復量は「与えたダメージ」＝1回目の4ヒット合計468（最終ヒットの117ではない）
      // に、威力20%の200を足したもの。
      hpDeltas: { "enemy:front": -716, "ally:subject": 668 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KATE_PALADIN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS1",
    intent: "・追加効果は発生しない（両方の抽選で「なし」の腕が選ばれた場合）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS1" },
    random: as1Rolls(0.9, 0.9),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS1_DAMAGE2", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -716 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KATE_PALADIN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS2",
    intent: "・75%の確率で、最も攻撃力の高い敵単体に威力93.6でEN攻撃し、1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS2" },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    random: rolls(0.5),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_STUN_TARGET", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -468 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_STUN_TARGET",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KATE_PALADIN_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS2",
    intent:
      "・25%の確率で、自身の1行動の間被ダメージを75%減少させる効果、および2ヒットの回避を付与した後、自身に1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS2" },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    random: rolls(0.8),
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_DMG_DOWN",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_EVASION",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_STUN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_DMG_DOWN",
          magnitude: -0.75,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_EVASION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          statusKind: "EVASION",
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KATE_PALADIN_AS2_SELF_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KATE_PALADIN_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_AS3",
    intent: "自身に最も近い位置にいる敵単体、および対象に隣接する敵に対して威力74.2でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KATE_PALADIN_AS3" },
    expected: {
      // 最も近い敵は敵前列中央。隣接（上下左右）は enemy:left と enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS3_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS3_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KATE_PALADIN_AS3_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -371,
        "enemy:left": -371,
        "enemy:back": -371,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_PS1",
    intent: "敵に凍結が付与された際に発動。付与された敵単体に威力159でEN攻撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KATE_PALADIN_PS1",
      trigger: effectApplied({
        source: "ally:front",
        target: "enemy:front",
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "FREEZE",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KATE_PALADIN_PS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -795 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_PS1",
    intent: "(不成立): 凍結以外の状態異常が付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KATE_PALADIN_PS1",
      trigger: effectApplied({
        source: "ally:front",
        target: "enemy:front",
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "STUN",
      }),
      triggeredBy: "ally:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KATE_PALADIN_PS1",
    intent: "(不成立): 味方が凍結した場合は発動しない（「敵に」凍結が付与された場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KATE_PALADIN_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:front",
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "FREEZE",
      }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_KATE_PALADIN (【人見知りの聖騎士】ケイト・フルニエ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KATE-PALADIN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KATE-PALADIN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KATE-PALADIN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-KATE-PALADIN-004 (R-SKL-07, WEIGHTED_ONE): `SKL_KATE_PALADIN_EX` の実 RANDOM_BRANCH は定義順の累積weightへ乱数を1回だけ対応づけて腕を選び、選択結果を `RandomBranchSelected` へ記録する。公開差分だけからも同じ盤面へ復元できる", () => {
    // `-001` の表は「腕ごとに何が起きたか」を見る。ここは選択そのものが
    // FACTイベントとして残り、StateDeltaが実状態と一致することを見る。
    const selections = [0.1, 0.5, 0.9].map((roll) => {
      const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
      const recorder = new EventRecorder(createBattleId("B_KATE_BRANCH"));
      const result = resolveSkillUse(
        board.subject,
        skillFrom(snapshot, "SKL_KATE_PALADIN_EX"),
        "EX",
        "EX",
        board.units,
        board.definitions,
        rolls(roll)(),
        recorder,
        1,
        0,
        createActionId("B_KATE_BRANCH:action:1"),
        recorder.nextResolutionScopeId(),
      );
      return { board, recorder, result };
    });

    expect(
      selections.map(
        ({ recorder }) =>
          recorder
            .getEvents()
            .find(
              (event): event is Extract<BattleDomainEvent, { eventType: "RandomBranchSelected" }> =>
                event.eventType === "RandomBranchSelected",
            )!.payload,
      ),
    ).toMatchObject([
      { stepIndex: 0, mode: "WEIGHTED_ONE", branchIndex: 0, label: "HIT5" },
      { stepIndex: 0, mode: "WEIGHTED_ONE", branchIndex: 1, label: "FREEZE" },
      { stepIndex: 0, mode: "WEIGHTED_ONE", branchIndex: 2, label: "HEAL" },
    ]);

    // 選ばれた腕の結果が公開差分だけで再構成できる（HIT5の5ヒット分）。
    const hit5 = selections[0]!;
    const restored = reduceStateDeltas(
      initialSnapshotFor(hit5.board.units, { include: ["effects", "markers"] }),
      hit5.recorder
        .getEvents()
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );
    for (const unit of hit5.result.units) {
      expect(restored.units[unit.battleUnitId]!.hp).toBe(unit.currentHp);
    }
  });

  it("IT-UNIT-KATE-PALADIN-005 (R-PS-01/R-STS-01): PS1の「敵に凍結が付与された際」は、実 resolver が `EffectApplied` へ載せた `statusKind` で判定される — 気絶でも有利な `APPLY_STATUS` でも発動しない", () => {
    // `-001` のPS1行が使う契機イベントはハーネスが組み立てたもので、payload の
    // `statusKind` はテスト側の宣言でしかない。**実装がその欄を載せているか**は
    // 実 resolver に発行させたイベントにしか現れない（この trigger は M7-011 以前、
    // payload に存在しない欄を参照していて一度も成立しなかった）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const trigger = (effectActionDefinitionId: string, from: string, to: string) =>
      observeClassificationTrigger({
        definitions: board.definitions,
        units: board.units,
        effectActionDefinitionId,
        from,
        to,
        battleId: `B_KATE_CLASSIFY_${effectActionDefinitionId}`,
      });

    expect(trigger("ACT_KATE_PALADIN_EX_FREEZE", "ally:subject", "enemy:front")).toEqual({
      classification: {
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "FREEZE",
      },
      activated: ["SKL_KATE_PALADIN_PS1"],
    });
    // 同じ状態異常カテゴリでも種別が違えば発動しない。
    expect(trigger("ACT_KATE_PALADIN_AS2_STUN_TARGET", "ally:subject", "enemy:front")).toEqual({
      classification: {
        effectKind: "APPLY_STATUS",
        categories: ["DEBUFF", "STATUS"],
        statusKind: "STUN",
      },
      activated: [],
    });
    // 回避は `APPLY_STATUS` だが保持者に有利なので状態異常ではない。
    expect(trigger("ACT_KATE_PALADIN_AS2_SELF_EVASION", "enemy:front", "enemy:front")).toEqual({
      classification: {
        effectKind: "APPLY_STATUS",
        categories: ["BUFF"],
        statusKind: "EVASION",
      },
      activated: [],
    });
  });
});
