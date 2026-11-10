import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  FormationInput,
  FormationSlotInput,
} from "../../application/simulation/simulate-battle-command.js";
import type { SimulateTotalWarCommand } from "../../application/simulation/simulate-total-war-command.js";
import { SimulateTotalWarUseCase } from "../../application/simulation/simulate-total-war-use-case.js";
import type { SimulateTotalWarResult } from "../../application/simulation/simulation-result-assembler.js";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import type { BattleStateSnapshot } from "../../domain/battle/events/state-delta.js";
import { reduceStateDeltas } from "../../domain/battle/events/state-delta-reducer.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { PROPERTY_ASSERT_CONFIG } from "../../testing/property/index.js";
import { allProductionUnitIds } from "../../testing/scenario/run-production-battle.js";

/**
 * 総力戦（R-TWR-01～06）の基準シナリオ（`12_テスト戦略.md`「基準シナリオ」）。
 * 本番Catalogのユニット・メモリーを、ユースケース（`SimulateTotalWarUseCase`）から
 * 実Formation・Battle・Observationで走らせる。合成定義での分岐網羅は Domain 側の
 * `battle.total-war*.test.ts` が持ち、ここでは実際のスキル・PS・メモリーの上で同じ
 * ルールが成り立つことを固定する。
 *
 * 勝敗の向きはモジュール補正の上書き（R-ENH-08）で決める。HPの割合補正を `-1`・
 * 固定加算を `0` にすると強化後の最大HPは下限の1になり（R-ENH-06）、どの攻撃でも
 * 1回で倒れる。逆に割合補正を大きくすると、相手の攻撃では倒れない。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const BATTLE_ID = "B_TW";
/** 本番Catalogで15ターン走らせるケースは、カバレッジ計測下でVitest既定の5秒を超える。 */
const LONG_BATTLE_TIMEOUT_MS = 60_000;

const catalog = loadCatalogFromDirectory(CATALOG_DIR);

type Row = "FRONT" | "REAR";

function slot(
  unitDefinitionId: string,
  column: 0 | 1 | 2,
  row: Row,
  enhancement?: FormationSlotInput["enhancement"],
): FormationSlotInput {
  return {
    unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
    position: { column, row },
    ...(enhancement !== undefined ? { enhancement } : {}),
  };
}

/** 最大HPが1になる強化指定。どの攻撃・HP消費でも1回で戦闘不能になる。 */
const ONE_HP = { module: { hp: { fixed: 0, ratio: -1 } } } as const;
/** 相手の攻撃を受けても1ターンでは倒れない強化指定。 */
const DURABLE = { module: { hp: { ratio: 10 } } } as const;
/** 15ターン戦っても倒れない強化指定。 */
const UNBREAKABLE = { module: { hp: { ratio: 10_000 } } } as const;
/** 相手の攻撃で倒れず、相手を一撃で倒せる強化指定。 */
const OVERWHELMING = { module: { hp: { ratio: 100 }, attack: { ratio: 100 } } } as const;

function formation(
  slots: readonly FormationSlotInput[],
  memoryDefinitionIds: readonly string[] = [],
): FormationInput {
  return {
    slots,
    memoryDefinitionIds: memoryDefinitionIds.map((id) => createMemoryDefinitionId(id)),
    // R-ENH-01 #3: ユニット単位の強化指定は、編成の強化指定があるときだけ受理される。
    ...(slots.some((s) => s.enhancement !== undefined) ? { enhancement: {} } : {}),
  };
}

/** 後列中央の1体だけの編成。 */
function single(
  unitDefinitionId: string,
  enhancement?: FormationSlotInput["enhancement"],
  memoryDefinitionIds: readonly string[] = [],
): FormationInput {
  return formation([slot(unitDefinitionId, 1, "REAR", enhancement)], memoryDefinitionIds);
}

/** 乱数は常に0.5を返す。会心判定は0.5未満の会心率で必ず外れる。 */
const CONSTANT_RANDOM: RandomSourceFactory = { create: () => ({ next: () => 0.5 }) };

function runTotalWar(
  allyFormations: readonly FormationInput[],
  enemyFormations: readonly FormationInput[],
  randomSourceFactory: RandomSourceFactory = CONSTANT_RANDOM,
): SimulateTotalWarResult {
  const command: SimulateTotalWarCommand = {
    allyFormations,
    enemyFormations,
    logLevel: "DETAILED",
  };
  return new SimulateTotalWarUseCase({
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator([BATTLE_ID]),
    randomSourceFactory,
    clock: new ManualClock(0),
  }).execute(command, {
    requestId: "total-war-scenario",
    deadlineEpochMs: Number.MAX_SAFE_INTEGER,
  });
}

function eventsOfType(result: SimulateTotalWarResult, type: string): readonly BattleLogEvent[] {
  return result.events.filter((event) => event.type === type);
}

function onlyEvent(
  result: SimulateTotalWarResult,
  type: string,
  predicate: (event: BattleLogEvent) => boolean = () => true,
): BattleLogEvent {
  const matched = eventsOfType(result, type).filter(predicate);
  expect(matched, `${type} events`).toHaveLength(1);
  return matched[0]!;
}

function details(event: BattleLogEvent): Record<string, unknown> {
  return event.details as Record<string, unknown>;
}

function turnEvent(
  result: SimulateTotalWarResult,
  type: string,
  turnNumber: number,
): BattleLogEvent {
  return onlyEvent(result, type, (event) => details(event).turnNumber === turnNumber);
}

/** `initialState` に、指定した連番までのイベントが所有する差分を適用した状態。 */
function stateAfter(result: SimulateTotalWarResult, sequence: number): BattleStateSnapshot {
  return reduceStateDeltas(
    result.initialState,
    result.stateTransitions
      .filter((transition) => transition.causedBySequence <= sequence)
      .map((transition) => transition.stateDelta),
  );
}

function unitState(state: BattleStateSnapshot, battleUnitId: string) {
  const unit = state.units[createBattleUnitId(battleUnitId)];
  expect(unit, `${battleUnitId} in the state`).toBeDefined();
  return unit!;
}

function actorsInTurn(result: SimulateTotalWarResult, turnNumber: number): readonly string[] {
  return eventsOfType(result, "ACTION_STARTED")
    .filter((event) => event.turnNumber === turnNumber)
    .map((event) => String(details(event).actorUnitId));
}

/** メモリーの1回の発動: どの `triggeredEffects` が、どのターンに、どの種別のイベントを契機に発動したか。 */
type MemoryActivation = readonly [
  triggeredEffectIndex: number,
  turnNumber: number,
  triggerType: string,
];

/**
 * `MEMORY_TRIGGERED` を、メモリーIDごとに発生順の一覧へまとめる。重複を除かないため、
 * 同じ効果が同じターン・同じ契機で2回発動すれば一覧にも2件現れる。
 */
function memoryActivations(
  result: SimulateTotalWarResult,
): ReadonlyMap<string, readonly MemoryActivation[]> {
  const bySequence = new Map(result.events.map((event) => [event.sequence, event]));
  const activations = new Map<string, MemoryActivation[]>();
  for (const event of eventsOfType(result, "MEMORY_TRIGGERED")) {
    const { memoryDefinitionId, triggeredEffectIndex, triggerEventId } = details(event) as {
      memoryDefinitionId: string;
      triggeredEffectIndex: number;
      triggerEventId: string;
    };
    // 内部のイベントIDは「戦闘ID:連番」で採番される。
    const trigger = bySequence.get(Number(triggerEventId.slice(`${BATTLE_ID}:`.length)));
    const list = activations.get(memoryDefinitionId) ?? [];
    list.push([triggeredEffectIndex, event.turnNumber, trigger?.type ?? "UNKNOWN"]);
    activations.set(memoryDefinitionId, list);
  }
  return activations;
}

describe("total war scenarios (production catalog)", () => {
  it("SCN-BTL-029 [R-TWR-04]: the surviving formation carries HP, cooldowns, effects, markers and EX gauge into the next fight unchanged, and recovers AP/PP at the next turn start", () => {
    // 味方: 速いタリサ（攻撃役）とルナ（PSでかばい・シールド・Marker・ターン単位のCTを持つ）。
    // 敵: 1編成目のヒイロはターン開始時PSで味方を攻撃し、ルナのかばい・反射で倒れる。
    // ターン開始の解決スコープで全滅するため、ターン1の行動フェーズは始まらない。
    const result = runTotalWar(
      [
        formation([
          slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT", DURABLE),
          slot("UNIT_LUNA_HUNGRY", 0, "FRONT", DURABLE),
        ]),
      ],
      [single("UNIT_HIIRO_FREEWOLF", ONE_HP), single("UNIT_MAIA_LAZY", ONE_HP)],
    );

    expect(result.stages[0]).toMatchObject({
      allyFormationNumber: 1,
      enemyFormationNumber: 1,
      defeatedSides: ["ENEMY"],
      endTurn: 1,
    });
    const turn1Completed = turnEvent(result, "TURN_COMPLETED", 1);
    const deployed = turnEvent(result, "FORMATION_DEPLOYED", 2);
    const recovered = onlyEvent(result, "RESOURCES_RECOVERED", (event) => event.turnNumber === 2);
    expect(deployed.sequence).toBeGreaterThan(turn1Completed.sequence);
    expect(recovered.sequence).toBeGreaterThan(deployed.sequence);

    const endOfTurn1 = stateAfter(result, turn1Completed.sequence);
    const afterDeployment = stateAfter(result, deployed.sequence);
    // 回復の状態差分は、RESOURCES_RECOVERED に続く TURN_RECOVERY の RESOURCE_CHANGED が持つ。
    const lastRecoveryChange = Math.max(
      ...eventsOfType(result, "RESOURCE_CHANGED")
        .filter((event) => event.turnNumber === 2 && details(event).reason === "TURN_RECOVERY")
        .map((event) => event.sequence),
    );
    const afterRecovery = stateAfter(result, lastRecoveryChange);
    for (const allyId of ["ally:1", "ally:2"]) {
      // 出撃は勝ち残った編成の状態に触れない（R-TWR-04 #1）。
      expect(unitState(afterDeployment, allyId)).toEqual(unitState(endOfTurn1, allyId));
    }
    // 引き継いだ状態が空でないこと（空どうしの一致で通らないようにする）。
    const luna = unitState(afterDeployment, "ally:2");
    expect(Object.keys(luna.cooldowns ?? {}).length).toBeGreaterThan(0);
    expect(luna.hp).toBeLessThan(luna.combatStats.maximumHp);
    expect(luna.effects?.length ?? 0).toBeGreaterThan(0);
    expect(luna.markers?.length ?? 0).toBeGreaterThan(0);
    expect(luna.extraGauge).toBeGreaterThan(0);

    // AP・PPは次ターンのTURN_STARTINGで、引き継いだ値から通常どおり回復する。
    // HPなどは回復しない。
    const recoveries = details(recovered).units as readonly {
      battleUnitId: string;
      apBefore: number;
      apAfter: number;
      ppBefore: number;
      ppAfter: number;
    }[];
    for (const allyId of ["ally:1", "ally:2"]) {
      const before = unitState(afterDeployment, allyId);
      const after = unitState(afterRecovery, allyId);
      // 回復量が0のユニット（上限に達している）は回復の一覧に載らない。
      const recovery = recoveries.find((entry) => entry.battleUnitId === allyId) ?? {
        apBefore: after.ap,
        apAfter: after.ap,
        ppBefore: after.pp,
        ppAfter: after.pp,
      };
      expect(recovery).toMatchObject({
        apBefore: before.ap,
        apAfter: after.ap,
        ppBefore: before.pp,
        ppAfter: after.pp,
      });
      expect(after.hp).toBe(before.hp);
      expect(after.extraGauge).toBe(before.extraGauge);
    }
    // ルナはターン1にPSでPPを使っており、ターン2の開始時に回復する。
    expect(unitState(afterDeployment, "ally:2").pp).toBeLessThan(
      unitState(afterRecovery, "ally:2").pp,
    );

    // 出撃したユニットは戦闘開始時と同じ開始状態で加わる（R-TWR-04 #4）。
    const newcomer = unitState(afterDeployment, "enemy:2");
    expect(newcomer).toMatchObject({ ap: 0, pp: 0, extraGauge: 0 });
    expect(newcomer.hp).toBe(newcomer.combatStats.maximumHp);
    expect(newcomer.effects).toBeUndefined();
    expect(newcomer.cooldowns).toBeUndefined();
  });

  it("SCN-BTL-030 [R-TWR-03]: a wipe cuts the rest of the action queue, while the turn-end PS and the turn-based cooldown countdown still run", () => {
    // 敵の各編成は最大HP1。タリサ（最速）が倒した時点で、行動順キューに残るルナ
    // （最も遅い）の予約は実行されない。ルナの「ターン終了時」PS（SKL_LUNA_HUNGRY_PS3）と、
    // ターン1開始時に発動したPS（SKL_LUNA_HUNGRY_PS2）のターン単位クールタイムの減算で、
    // 打ち切った後もTURN_ENDINGが通常どおり行われることを確かめる。
    const result = runTotalWar(
      [
        formation([
          slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT"),
          slot("UNIT_LUNA_HUNGRY", 0, "FRONT"),
        ]),
      ],
      [
        single("UNIT_LUCIE_COMPANION", ONE_HP),
        single("UNIT_MAIA_LAZY", ONE_HP),
        single("UNIT_SIENA_OFFSTAGE", ONE_HP),
      ],
    );

    expect(result.stages.map((stage) => [stage.endTurn, stage.defeatedSides])).toEqual([
      [1, ["ENEMY"]],
      [2, ["ENEMY"]],
      [3, ["ENEMY"]],
    ]);

    for (const turnNumber of [1, 2]) {
      const queue = onlyEvent(
        result,
        "ACTION_QUEUE_CREATED",
        (event) => event.turnNumber === turnNumber,
      );
      const reserved = (details(queue).reservations as readonly { battleUnitId: string }[]).map(
        (reservation) => reservation.battleUnitId,
      );
      expect(reserved).toContain("ally:2");
      // 予約はあったが、全滅で行動フェーズが打ち切られた。
      expect(actorsInTurn(result, turnNumber)).toEqual(["ally:1"]);

      const defeated = turnEvent(result, "FORMATION_DEFEATED", turnNumber);
      const completing = turnEvent(result, "TURN_COMPLETING", turnNumber);
      const completed = turnEvent(result, "TURN_COMPLETED", turnNumber);
      expect(defeated.sequence).toBeLessThan(completing.sequence);

      const turnEndPassive = onlyEvent(
        result,
        "PASSIVE_ACTIVATED",
        (event) =>
          event.turnNumber === turnNumber &&
          details(event).skillDefinitionId === "SKL_LUNA_HUNGRY_PS3",
      );
      expect(turnEndPassive.sequence).toBeGreaterThan(completing.sequence);
      expect(turnEndPassive.sequence).toBeLessThan(completed.sequence);
    }

    // ターン1開始時に発動したPSのクールタイム（ターン単位1）は、付与ターンを数えず、
    // 全滅で打ち切られたターン2の終了処理で減算される。
    const reduced = onlyEvent(
      result,
      "COOLDOWN_REDUCED",
      (event) =>
        event.turnNumber === 2 && details(event).skillDefinitionId === "SKL_LUNA_HUNGRY_PS2",
    );
    expect(details(reduced)).toMatchObject({ unit: "TURN", before: 1, after: 0 });
    expect(reduced.sequence).toBeGreaterThan(turnEvent(result, "TURN_COMPLETING", 2).sequence);
    expect(reduced.sequence).toBeLessThan(turnEvent(result, "TURN_COMPLETED", 2).sequence);
  });

  it("SCN-BTL-031 [R-TWR-05]: each formation's battle-start memories activate once at its first deployment, and neither a reserve's nor a wiped formation's memories activate", () => {
    // 戦闘開始時Memory: 味方 MEM_ABSOLUTE_ORDER、敵1編成目 MEM_STRANGERS、2編成目
    // MEM_ENCOUNTER_WITH_GIRLS、3編成目 MEM_HEART_COLOR・MEM_LIKE_FRIENDS（の戦闘開始時分）。
    // ターン開始時Memory: 敵1編成目 MEM_GIDDY_CIRCUMSTANCES（SMARTのルーシーが対象）、
    // 2編成目 MEM_GREATEST_FORTUNE（SHYのタチアナが対象）。
    const result = runTotalWar(
      [formation([slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT")], ["MEM_ABSOLUTE_ORDER"])],
      [
        single("UNIT_LUCIE_COMPANION", ONE_HP, ["MEM_STRANGERS", "MEM_GIDDY_CIRCUMSTANCES"]),
        single("UNIT_TATIANA_SAGE", ONE_HP, ["MEM_ENCOUNTER_WITH_GIRLS", "MEM_GREATEST_FORTUNE"]),
        single("UNIT_SIENA_OFFSTAGE", ONE_HP, ["MEM_HEART_COLOR", "MEM_LIKE_FRIENDS"]),
      ],
    );

    // 敵は1ターンに1編成ずつ全滅し、ターン2・3の冒頭に次の編成が出撃する。
    expect(result.stages.map((stage) => [stage.enemyFormationNumber, stage.startTurn])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    // 発動はメモリーID・`triggeredEffects` の添字ごとに件数まで固定する。1つのメモリーが
    // 複数の効果を持つため、各効果がそれぞれ1回ずつ発動することを確かめる。対象が
    // 盤面にいない効果（例: 味方にPHYSICALがいない MEM_ABSOLUTE_ORDER の添字1）は発動しない。
    expect(Object.fromEntries(memoryActivations(result))).toEqual({
      // 1番目の編成の戦闘開始時Memoryは BattleStarted で1回だけ。勝ち残った味方の分は、
      // 相手の編成が出撃しても再び発動しない（R-TWR-05 #3）。
      MEM_ABSOLUTE_ORDER: [[0, 0, "BATTLE_STARTED"]],
      MEM_STRANGERS: [
        [0, 0, "BATTLE_STARTED"],
        [1, 0, "BATTLE_STARTED"],
      ],
      // ターン開始時Memoryは出撃中の編成のものだけ（R-TWR-05 #1・#6）。1編成目の分は
      // 全滅したターン2以降に発動しない。
      MEM_GIDDY_CIRCUMSTANCES: [[1, 1, "TURN_STARTED"]],
      // 2番目以降の編成の戦闘開始時Memoryは、その編成の出撃で1回だけ（R-TWR-05 #2）。
      // それまで控えだった間（BattleStarted・ターン1）には発動しない。
      MEM_ENCOUNTER_WITH_GIRLS: [
        [0, 2, "FORMATION_DEPLOYED"],
        [1, 2, "FORMATION_DEPLOYED"],
      ],
      // 2編成目のターン開始時Memoryは、控えだったターン1には発動しない。
      MEM_GREATEST_FORTUNE: [[0, 2, "TURN_STARTED"]],
      MEM_HEART_COLOR: [[1, 3, "FORMATION_DEPLOYED"]],
      MEM_LIKE_FRIENDS: [[1, 3, "FORMATION_DEPLOYED"]],
    });
    // 出撃時Memoryの解決は、そのターンのTurnStartedより前に終わる（R-TWR-05 #4）。
    const turn2Started = turnEvent(result, "TURN_STARTED", 2);
    for (const event of eventsOfType(result, "MEMORY_TRIGGERED")) {
      if (details(event).memoryDefinitionId === "MEM_ENCOUNTER_WITH_GIRLS") {
        expect(event.sequence).toBeLessThan(turn2Started.sequence);
      }
    }

    // 勝ち残った味方へ付与したメモリー由来の効果は、相手の編成交代をまたいで残る（R-TWR-05 #5）。
    const absoluteOrderEffect = (state: BattleStateSnapshot) =>
      unitState(state, "ally:1").effects?.filter((effect) =>
        effect.effectDefinitionId.startsWith("ACT_MEM_ABSOLUTE_ORDER_"),
      );
    expect(absoluteOrderEffect(result.finalState!)).toHaveLength(1);
  });

  it("SCN-BTL-032 [R-TWR-02]: a unit's second and third appearances on the same side get 0.01 x HP, attack and defense base values, while the opponent's same unit is not affected", () => {
    // 味方は3編成とも同じマイア。敵の1編成目も同じマイア（相手陣営の登場は数えない）。
    // 敵の2編成目は圧倒的に強く、味方の編成を1ターンに1つずつ全滅させて全編成を出撃させる。
    const maia = () => single("UNIT_MAIA_LAZY");
    const result = runTotalWar(
      [maia(), maia(), maia()],
      [maia(), formation([slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT", OVERWHELMING)])],
    );

    expect(result).toMatchObject({ outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED" });
    expect(
      result.unitRoster.map((entry) => [entry.battleUnitId, entry.reappearance, entry.deployed]),
    ).toEqual([
      ["ally:1", false, true],
      ["ally:2", true, true],
      ["ally:3", true, true],
      ["enemy:1", false, true],
      ["enemy:2", false, true],
    ]);

    const startingStats = (battleUnitId: string) => {
      const deployment = eventsOfType(result, "FORMATION_DEPLOYED").find((event) =>
        (details(event).battleUnitIds as readonly string[]).includes(battleUnitId),
      );
      const state =
        deployment === undefined ? result.initialState : stateAfter(result, deployment.sequence);
      return unitState(state, battleUnitId).baseCombatStats;
    };
    const first = startingStats("ally:1");
    // 編成の構成・配置・メモリーが同じなので、編成補正・適性補正も同じ倍率で重なる。
    for (const reappearing of ["ally:2", "ally:3"]) {
      const stats = startingStats(reappearing);
      // 3回目も0.01のままで、登場回数で累乗しない（R-TWR-02 #2）。
      expect(stats.maximumHp).toBeCloseTo(first.maximumHp * 0.01, 6);
      expect(stats.attack).toBeCloseTo(first.attack * 0.01, 6);
      expect(stats.defense).toBeCloseTo(first.defense * 0.01, 6);
      // 行動速度・会心系は補正しない（R-TWR-02 #5）。
      expect(stats.actionSpeed).toBe(first.actionSpeed);
      expect(stats.criticalRate).toBe(first.criticalRate);
      expect(stats.criticalDamageBonus).toBe(first.criticalDamageBonus);
    }
    // 相手陣営に同じユニットがいても、自陣営で初めてなら補正しない（R-TWR-02 #1）。
    expect(startingStats("enemy:1")).toEqual(first);
    // 補正は効果ではないため、効果として現れない（R-TWR-02 #4）。
    const deployedAlly2 = stateAfter(result, turnEvent(result, "FORMATION_DEPLOYED", 3).sequence);
    expect(unitState(deployedAlly2, "ally:2").effects).toBeUndefined();
  });

  it("SCN-BTL-033 [R-TWR-03, R-TWR-04]: when both formations are wiped together and both sides keep a reserve, both sides deploy in one scope, ally first", () => {
    // UNIT_MAO_COMMITTEE のAS1は敵の列を攻撃してから自身のHPを消費する。最大HP1なら、敵を倒した
    // 同じ行動で自身も倒れ、両陣営の編成が同じ判定タイミングで全滅する。
    const result = runTotalWar(
      [single("UNIT_MAO_COMMITTEE", ONE_HP), single("UNIT_MAIA_LAZY")],
      [single("UNIT_LUCIE_COMPANION", ONE_HP), single("UNIT_MAIA_LAZY")],
    );

    expect(result.stages[0]).toMatchObject({ endTurn: 1, defeatedSides: ["ALLY", "ENEMY"] });
    const wipes = eventsOfType(result, "FORMATION_DEFEATED").filter((e) => e.turnNumber === 1);
    expect(wipes.map((event) => details(event).side)).toEqual(["ALLY", "ENEMY"]);
    // 打ち切り後もTURN_ENDINGを通り、次のターンの冒頭で両陣営が出撃する。
    expect(turnEvent(result, "TURN_COMPLETED", 1).sequence).toBeGreaterThan(wipes[1]!.sequence);
    const deployments = eventsOfType(result, "FORMATION_DEPLOYED").filter(
      (event) => event.turnNumber === 2,
    );
    expect(
      deployments.map((event) => [details(event).side, details(event).formationNumber]),
    ).toEqual([
      ["ALLY", 2],
      ["ENEMY", 2],
    ]);
    // 1つの出撃スコープ: 敵の出撃は味方の出撃と同じ解決スコープに属する。
    expect(deployments[1]!.rootSequence).toBe(deployments[0]!.rootSequence);
    expect(deployments[1]!.sequence).toBeLessThan(turnEvent(result, "TURN_STARTED", 2).sequence);
    expect(result.stages[1]).toMatchObject({
      allyFormationNumber: 2,
      enemyFormationNumber: 2,
      startTurn: 2,
    });
  });

  it("SCN-BTL-034 [R-TWR-06]: the last formations of both sides wiped together end in a draw by SIMULTANEOUS_DEFEAT", () => {
    const result = runTotalWar(
      [single("UNIT_MAO_COMMITTEE", ONE_HP)],
      [single("UNIT_LUCIE_COMPANION", ONE_HP)],
    );

    expect(result).toMatchObject({
      outcome: "DRAW",
      completionReason: "SIMULTANEOUS_DEFEAT",
      completedTurn: 1,
      defeatedFormationCounts: { ally: 1, enemy: 1 },
    });
    expect(eventsOfType(result, "FORMATION_DEFEATED").map((e) => details(e).side)).toEqual([
      "ALLY",
      "ENEMY",
    ]);
    // 戦闘はその判定タイミングで終わり、ターン終了処理へは進まない。
    expect(eventsOfType(result, "TURN_COMPLETING")).toEqual([]);
  });

  it("SCN-BTL-035 [R-TWR-06]: a simultaneous wipe where only one side keeps a reserve is won by that side, and the winner's reserve does not need to deploy", () => {
    // 味方だけが控えを持つ: 敵に戦闘可能な編成が残らないため味方勝利（R-TWR-06 #3）。
    const allyKeepsReserve = runTotalWar(
      [single("UNIT_MAO_COMMITTEE", ONE_HP), single("UNIT_MAIA_LAZY")],
      [single("UNIT_LUCIE_COMPANION", ONE_HP)],
    );
    expect(allyKeepsReserve).toMatchObject({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 1,
      defeatedFormationCounts: { ally: 1, enemy: 1 },
    });
    expect(eventsOfType(allyKeepsReserve, "FORMATION_DEPLOYED")).toEqual([]);

    // 敵だけが控えを持つ: 味方敗北。
    const enemyKeepsReserve = runTotalWar(
      [single("UNIT_MAO_COMMITTEE", ONE_HP)],
      [single("UNIT_LUCIE_COMPANION", ONE_HP), single("UNIT_MAIA_LAZY")],
    );
    expect(enemyKeepsReserve).toMatchObject({
      outcome: "ALLY_LOSE",
      completionReason: "ALLY_DEFEATED",
      completedTurn: 1,
    });
  });

  it(
    "SCN-BTL-036 [R-TWR-01, R-TWR-06]: two sides still fighting at the end of turn 15 draw by TURN_LIMIT_REACHED, regardless of the formations left",
    () => {
      // 敵は控えを1つ残す。残り編成数で勝敗を判定し直さない（R-TWR-06 #2）。
      const result = runTotalWar(
        [formation([slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT", UNBREAKABLE)])],
        [single("UNIT_TATIANA_SAGE", UNBREAKABLE), single("UNIT_MAIA_LAZY")],
      );

      expect(result).toMatchObject({
        outcome: "DRAW",
        completionReason: "TURN_LIMIT_REACHED",
        completedTurn: 15,
        defeatedFormationCounts: { ally: 0, enemy: 0 },
      });
      expect(result.stages).toEqual([
        {
          stageNumber: 1,
          allyFormationNumber: 1,
          enemyFormationNumber: 1,
          startTurn: 1,
          endTurn: 15,
          defeatedSides: [],
        },
      ]);
      expect(turnEvent(result, "TURN_COMPLETED", 15)).toBeDefined();
    },
    LONG_BATTLE_TIMEOUT_MS,
  );

  it(
    "SCN-BTL-037 [R-TWR-04, R-TWR-06]: a formation wiped in turn 15 does not deploy its side's reserve, and the battle ends in a draw",
    () => {
      // 敵1編成目の最大HPは、タリサの攻撃でちょうどターン15に倒れる大きさにしてある
      // （本番Catalogのスキルが変わって決着ターンがずれたら、下の前提の検査で分かる）。
      const result = runTotalWar(
        [formation([slot("UNIT_TARISA_TROUBLEMAKER", 1, "FRONT", UNBREAKABLE)])],
        [
          single("UNIT_TATIANA_SAGE", { module: { hp: { fixed: 2_290_000, ratio: 0 } } }),
          single("UNIT_SIENA_OFFSTAGE"),
        ],
      );

      const wipe = onlyEvent(result, "FORMATION_DEFEATED");
      expect(details(wipe)).toMatchObject({
        side: "ENEMY",
        turnNumber: 15,
        remainingReserveCount: 1,
      });
      expect(result).toMatchObject({
        outcome: "DRAW",
        completionReason: "TURN_LIMIT_REACHED",
        completedTurn: 15,
        defeatedFormationCounts: { ally: 0, enemy: 1 },
      });
      // 最終ターンの全滅では出撃させない（R-TWR-04 #6）。
      expect(eventsOfType(result, "FORMATION_DEPLOYED")).toEqual([]);
      expect(result.unitRoster.find((entry) => entry.battleUnitId === "enemy:2")).toMatchObject({
        deployed: false,
      });
    },
    LONG_BATTLE_TIMEOUT_MS,
  );
});

const PROPERTY_UNIT_IDS = allProductionUnitIds(CATALOG_DIR);
const PROPERTY_MEMORY_IDS = [
  "MEM_ABSOLUTE_ORDER",
  "MEM_STRANGERS",
  "MEM_GIDDY_CIRCUMSTANCES",
  "MEM_GREATEST_FORTUNE",
  "MEM_ENCOUNTER_WITH_GIRLS",
  "MEM_RECLAIMED_SCHOOL_LIFE",
] as const;
const POSITIONS = [
  { column: 0, row: "FRONT" },
  { column: 1, row: "FRONT" },
  { column: 2, row: "FRONT" },
  { column: 0, row: "REAR" },
  { column: 1, row: "REAR" },
  { column: 2, row: "REAR" },
] as const;

/** 1編成: 配置もユニットも重複しない1～3体と、重複しない0～2件のメモリー（R-TWR-01 #2～#4）。 */
const formationArb: fc.Arbitrary<FormationInput> = fc
  .record({
    unitIndexes: fc.uniqueArray(fc.integer({ min: 0, max: PROPERTY_UNIT_IDS.length - 1 }), {
      minLength: 1,
      maxLength: 3,
    }),
    positionIndexes: fc.uniqueArray(fc.integer({ min: 0, max: POSITIONS.length - 1 }), {
      minLength: 3,
      maxLength: 3,
    }),
    memories: fc.subarray([...PROPERTY_MEMORY_IDS], { maxLength: 2 }),
    fragile: fc.boolean(),
  })
  .map(({ unitIndexes, positionIndexes, memories, fragile }) =>
    formation(
      unitIndexes.map((unitIndex, i) => {
        const position = POSITIONS[positionIndexes[i]!]!;
        // 一部の編成を最大HP1にして、全滅と出撃の経路を短いターン数で多く通す。
        return slot(
          PROPERTY_UNIT_IDS[unitIndex]!,
          position.column,
          position.row,
          fragile ? ONE_HP : undefined,
        );
      }),
      memories,
    ),
  );

const sideArb = fc.array(formationArb, { minLength: 1, maxLength: 3 });

describe("total war state restoration properties on the production catalog (R-TWR-04)", () => {
  it(
    "PROP-TWR-04-002 [R-TWR-04]: for any total war of production units and memories, the initial state plus every state transition restores the final state, which holds exactly the deployed units",
    () => {
      fc.assert(
        fc.property(
          sideArb,
          sideArb,
          fc.integer({ min: 0, max: 2 ** 31 - 1 }),
          (ally, enemy, seed) => {
            const result = runTotalWar(
              ally,
              enemy,
              new Mulberry32SeededRandomSourceProvider().forRun(String(seed), 0),
            );

            const restored = reduceStateDeltas(
              result.initialState,
              result.stateTransitions.map((transition) => transition.stateDelta),
            );
            expect(restored).toEqual(result.finalState);
            // 途中で出撃したユニットも含めて、出撃したユニットだけが盤面にいる。
            expect(Object.keys(restored.units).sort()).toEqual(
              result.unitRoster
                .filter((entry) => entry.deployed)
                .map((entry) => String(entry.battleUnitId))
                .sort(),
            );
            // 出撃した編成数と全滅した編成数が、陣営ごとの編成状態と戦闘履歴に一致する。
            for (const side of ["ALLY", "ENEMY"] as const) {
              const formations = restored.formations![side];
              const deployedCount = new Set(
                result.unitRoster
                  .filter((entry) => entry.side === side && entry.deployed)
                  .map((entry) => entry.formationNumber),
              ).size;
              expect(formations.activeFormationNumber).toBe(deployedCount);
              expect(formations.defeatedCount).toBe(
                result.stages.filter((stage) => stage.defeatedSides.includes(side)).length,
              );
            }
            expect(result.completedTurn).toBeLessThanOrEqual(15);
          },
        ),
        { ...PROPERTY_ASSERT_CONFIG, numRuns: 20 },
      );
    },
    LONG_BATTLE_TIMEOUT_MS * 2,
  );
});
