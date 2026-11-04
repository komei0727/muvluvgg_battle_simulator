import { resolveActionPhase } from "../resolution/action-phase-resolver.js";
import { PassiveActivationRuntime } from "../resolution/passive-activation-service.js";
import { recordResourceChangeIfAny } from "../resolution/action-resolution-shared.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattleStatus } from "../model/battle-status.js";
import {
  EXERCISE_TURN_LIMIT,
  ExerciseRuntime,
  type BattleMode,
} from "../model/exercise-runtime.js";
import { recoverTurnResources, type BattleUnit } from "../model/battle-unit.js";
import { decrementTurnCooldowns } from "../model/cooldown-state.js";
import { decrementTurnEffectDurations } from "../model/applied-effect-duration.js";
import { decrementTurnMarkerDurations } from "../model/marker-duration.js";
import {
  emitEffectDurationReducedEvents,
  expireEffects,
  type ExpirationSeed,
} from "../effects/duration-expiry-service.js";
import {
  emitMarkerDurationChangedEvents,
  removeMarkers,
  type MarkerRemovalSeed,
} from "../effects/marker-removal-service.js";
import type { DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent, ResourceRecoveryEntry } from "../events/domain-event.js";
import { beginNextTurn, createTurnState, isFinalTurn, type TurnState } from "./turn-state.js";
import type { TurnLimit } from "../model/turn-limit.js";
import type {
  CompletionCheckpointMode,
  CompletionCheckResult,
} from "../outcome/completion-checkpoint.js";
import { passCompletionCheckpoint } from "../resolution/completion-checkpoint-recorder.js";
import type { BattleResultSnapshot } from "../events/state-delta.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import {
  activeMemoriesBySide,
  isAwaitingDeployment,
  TOTAL_WAR_SIDE_ORDER,
  type TotalWarFormations,
} from "../model/total-war-formations.js";
import type { MemoryDefinition } from "../../catalog/definitions/memory-definition.js";

export type { BattleStatus } from "../model/battle-status.js";

/**
 * 通常戦闘は勝敗と終了理由（R-END-02）、戦術演習は勝敗を持たない演習結果（R-TEX-10 #1）。
 * 型の正本は`events/state-delta.js`にある（`StateDelta.result`が同じ形を運ぶため）。
 */
export type BattleResult = BattleResultSnapshot;

/**
 * `05_ドメインモデル.md` の Battle集約。マイルストーンM3「最小戦闘縦切り」を扱う。
 * `advanceBattle` 1回はTURN_STARTING〜TURN_ENDINGの1ターン全体に相当し、内部で
 * QUEUE_BUILDING〜ACTION_RESOLUTION（`resolveActionPhase`）を使用可能な行動が
 * 無くなるまで繰り返す。
 */
export interface Battle {
  readonly battleId: BattleId;
  readonly status: BattleStatus;
  /** `05_ドメインモデル.md`「集約が所有する状態」の戦闘モード（R-TEX-01）。 */
  readonly mode: BattleMode;
  readonly turnState: TurnState;
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
  readonly result?: BattleResult;
  /**
   * 戦術演習だけが持つ演習状態（累計スコア、ブレイク回数）。可変オブジェクトを
   * 参照で保持する — スコアはダメージ適用の最深部で積み上がる一方、集約状態としては
   * Battleが所有するため、両者が同じ実体を指す必要がある（`ExerciseRuntime`の説明）。
   */
  readonly exercise?: ExerciseRuntime;
  /**
   * 総力戦だけが持つ編成状態（`05_ドメインモデル.md`「編成状態（総力戦のみ）」）。
   * 控えの編成のユニットはここにだけ置き、出撃するまで`allyUnits`／`enemyUnits`へ加えない
   * （R-TWR-03 #2）。
   */
  readonly formations?: TotalWarFormations;
}

/** Battle集約の主要操作: create（05_ドメインモデル.md）。 */
export function createBattle(
  battleId: BattleId,
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  turnLimit: TurnLimit,
  definitions: BattleDefinitions,
  mode: BattleMode = "NORMAL",
): Battle {
  if (allyUnits.length === 0) {
    throw new DomainValidationError("battle.allyUnits", "must contain at least one BattleUnit");
  }
  if (enemyUnits.length === 0) {
    throw new DomainValidationError("battle.enemyUnits", "must contain at least one BattleUnit");
  }
  if (mode === "TACTICAL_EXERCISE") {
    assertExerciseInvariants(enemyUnits, turnLimit, definitions);
  }
  return {
    battleId,
    status: "READY",
    mode,
    turnState: createTurnState(turnLimit),
    allyUnits,
    enemyUnits,
    definitions,
    ...(mode === "TACTICAL_EXERCISE"
      ? { exercise: new ExerciseRuntime(enemyUnits[0]!.baseCombatStats) }
      : {}),
  };
}

/** 総力戦の陣営1つ分の編成。出撃順（編成番号1→3）に並べる。 */
export type TotalWarSideFormationUnits = readonly (readonly BattleUnit[])[];

/** 総力戦の陣営1つ分の編成ごとのメモリー。添字は`TotalWarSideFormationUnits`と揃える。 */
export type TotalWarSideFormationMemories = readonly (readonly MemoryDefinition[])[];

/**
 * 総力戦（`TOTAL_WAR`）のBattleを生成する（R-TWR-01・R-TWR-03 #1）。各陣営の1番目の編成を
 * 出撃中の編成として盤面へ置き、2番目以降は控えとして`formations`にだけ持つ。
 * 各ユニットへ所属する編成番号を写す — 全滅した編成のユニットは盤面に残り続けるため、
 * 出撃中の編成の全滅判定はこの番号で絞り込む（R-TWR-03 #8）。
 *
 * メモリーは編成に属するため（R-TWR-05 #1）、陣営単位の`definitions.memoriesBySide`では
 * 受け取らず`memoriesBySide`で編成ごとに受け取る。省略した編成はメモリーなしとする。
 */
export function createTotalWarBattle(
  battleId: BattleId,
  formationsBySide: Readonly<Record<Side, TotalWarSideFormationUnits>>,
  turnLimit: TurnLimit,
  definitions: BattleDefinitions,
  memoriesBySide: Readonly<Record<Side, TotalWarSideFormationMemories>> = { ALLY: [], ENEMY: [] },
): Battle {
  const numbered = {
    ALLY: numberFormations(formationsBySide.ALLY, "battle.formations.ALLY"),
    ENEMY: numberFormations(formationsBySide.ENEMY, "battle.formations.ENEMY"),
  };
  assertUniqueBattleUnitIds([...numbered.ALLY.flat(), ...numbered.ENEMY.flat()]);
  assertNoSideMemories(definitions);
  const battle = createBattle(
    battleId,
    numbered.ALLY[0] ?? [],
    numbered.ENEMY[0] ?? [],
    turnLimit,
    definitions,
    "TOTAL_WAR",
  );
  const sideFormations = (
    formations: readonly (readonly BattleUnit[])[],
    memories: TotalWarSideFormationMemories,
    path: string,
  ) => {
    if (memories.length > formations.length) {
      throw new DomainValidationError(
        path,
        `declares memories for ${memories.length} formations, but the side has only ${formations.length}`,
      );
    }
    return {
      formationCount: formations.length,
      activeFormationNumber: 1,
      defeatedCount: 0,
      reserves: formations.slice(1).map((units, index) => ({ formationNumber: index + 2, units })),
      memoriesByFormation: formations.map((_, index) => memories[index] ?? []),
    };
  };
  return {
    ...battle,
    formations: {
      ALLY: sideFormations(numbered.ALLY, memoriesBySide.ALLY, "battle.memories.ALLY"),
      ENEMY: sideFormations(numbered.ENEMY, memoriesBySide.ENEMY, "battle.memories.ENEMY"),
    },
  };
}

/**
 * 総力戦では`definitions.memoriesBySide`を出撃中の編成のメモリーで置き換えて使うため
 * （`definitionsOf`）、呼び出し側が陣営単位で渡したメモリーは黙って捨てられてしまう。
 * 2つの経路を併存させず、生成時に拒否する。
 */
function assertNoSideMemories(definitions: BattleDefinitions): void {
  const sideMemories = definitions.memoriesBySide;
  if (
    sideMemories !== undefined &&
    (sideMemories.ALLY.length > 0 || sideMemories.ENEMY.length > 0)
  ) {
    throw new DomainValidationError(
      "battle.definitions.memoriesBySide",
      "must be empty in a total war; pass memories per formation instead",
    );
  }
}

/**
 * PS/Memoryの解決へ渡す定義。総力戦では`memoriesBySide`を出撃中の編成のメモリーへ
 * 差し替える（R-TWR-05 #1・#6）。編成状態は出撃と全滅の検出で変わるため、解決スコープを
 * 開くたびにその時点の編成状態から作る。
 */
function definitionsOf(battle: Battle): BattleDefinitions {
  if (battle.formations === undefined) {
    return battle.definitions;
  }
  return { ...battle.definitions, memoriesBySide: activeMemoriesBySide(battle.formations) };
}

function numberFormations(
  formations: TotalWarSideFormationUnits,
  path: string,
): readonly (readonly BattleUnit[])[] {
  if (formations.length === 0) {
    throw new DomainValidationError(path, "must contain at least one formation");
  }
  return formations.map((units, index) => {
    if (units.length === 0) {
      throw new DomainValidationError(`${path}[${index}]`, "must contain at least one BattleUnit");
    }
    return units.map((unit) => ({ ...unit, formationNumber: index + 1 }));
  });
}

/** 控え・全滅済みを含めて同じ集約に最大30体が並ぶため、編成をまたいでも`BattleUnitId`を重複させない。 */
function assertUniqueBattleUnitIds(units: readonly BattleUnit[]): void {
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.battleUnitId)) {
      throw new DomainValidationError(
        "battle.formations",
        `duplicates a BattleUnitId across formations: "${unit.battleUnitId}"`,
      );
    }
    seen.add(unit.battleUnitId);
  }
}

/**
 * `05_ドメインモデル.md`「不変条件 > 戦術演習」/ R-TEX-01: 演習の編成条件と規定
 * ターン数を集約の生成時点で拒否する。リクエスト不備としての検出（422）は
 * アプリケーション層が別途行うが（R-TEX-01 #3）、集約側でも成立させることで、
 * 経路を問わず「敵ちょうど1体・敵メモリーなし・5ターン」を満たさない演習Battleを
 * 存在させない。
 */
function assertExerciseInvariants(
  enemyUnits: readonly BattleUnit[],
  turnLimit: TurnLimit,
  definitions: BattleDefinitions,
): void {
  if (enemyUnits.length !== 1) {
    throw new DomainValidationError(
      "battle.enemyUnits",
      `must contain exactly one BattleUnit in a tactical exercise (received ${enemyUnits.length})`,
    );
  }
  const enemyMemories = definitions.memoriesBySide?.ENEMY ?? [];
  if (enemyMemories.length > 0) {
    throw new DomainValidationError(
      "battle.definitions.memoriesBySide.ENEMY",
      `must be empty in a tactical exercise (received ${enemyMemories.length})`,
    );
  }
  if (turnLimit !== EXERCISE_TURN_LIMIT) {
    throw new DomainValidationError(
      "battle.turnLimit",
      `must be ${EXERCISE_TURN_LIMIT} in a tactical exercise (received ${turnLimit})`,
    );
  }
}

/**
 * Battle集約の主要操作: start（06_戦闘状態遷移.md READY→RUNNING）。BattleStartedを
 * 発行し、対応するPSを解決する（Issue #144 follow-up:
 * `resolutionPhase: "BATTLE_START"`を渡し、`RESOLUTION_PHASE`条件を実際に評価
 * 可能にする）。READY→RUNNINGはTURN_STARTINGと異なりAP/PP回復を行わない。
 */
export function startBattle(battle: Battle, random: RandomSource, recorder: EventRecorder): Battle {
  if (battle.status !== "READY") {
    throw new DomainValidationError(
      "battle.status",
      `cannot start a battle in status "${battle.status}"`,
    );
  }
  const battleScope = recorder.nextResolutionScopeId();
  const battleStarted = recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: battleScope,
    payload: {
      turnLimit: battle.turnState.turnLimit,
      allySlotCount: battle.allyUnits.length,
      enemySlotCount: battle.enemyUnits.length,
    },
    stateDelta: { battleStatus: { before: battle.status, after: "RUNNING" } },
  });

  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions: definitionsOf(battle),
      random,
      recorder,
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: battleScope,
      rootEventId: battleStarted.eventId,
      resolutionPhase: "BATTLE_START",
      ...(battle.exercise !== undefined ? { exercise: battle.exercise } : {}),
    },
    [...battle.allyUnits, ...battle.enemyUnits],
  );
  passiveRuntime.onFactEvent(battleStarted, [...battle.allyUnits, ...battle.enemyUnits]);
  const { units: afterPassives } = passiveRuntime.finalizeResolutionScope(battleStarted.eventId);
  const allyUnits = afterPassives.filter((unit) => unit.side === "ALLY");
  const enemyUnits = afterPassives.filter((unit) => unit.side === "ENEMY");

  return { ...battle, status: "RUNNING", allyUnits, enemyUnits };
}

function checkpointModeOf(battle: Battle): CompletionCheckpointMode {
  return {
    ...(battle.exercise !== undefined ? { exercise: battle.exercise } : {}),
    ...(battle.formations !== undefined ? { totalWarFormations: battle.formations } : {}),
  };
}

function withFormations(battle: Battle, formations: TotalWarFormations | undefined): Battle {
  return formations !== undefined ? { ...battle, formations } : battle;
}

/**
 * R-TWR-04 #2・#3・#5: 編成が全滅した陣営ごとに、控えのうち最も前の編成を盤面へ加えて
 * `FormationDeployed`を発行する。次ターンの`TurnStarted`より前に、両陣営をまとめて
 * 1つの行動外トップレベル解決スコープ（出撃スコープ）として行う。2件目（敵）は1件目（味方）の
 * 子とし、ルートを共有する（`08_ドメインイベント.md`「総力戦イベント」）。
 *
 * 出撃したユニットは戦闘開始時と同じ開始状態のまま加わり、AP・PPは続くTURN_STARTINGで
 * 勝ち残った編成のユニットと一緒に回復する（R-TWR-04 #4、`06_戦闘状態遷移.md`「編成の交代」#5）。
 *
 * 全陣営の盤面への追加を終えてから、同じスコープで出撃した編成の戦闘開始時Memoryを
 * 味方、敵の順に解決する（R-TWR-04 #3・R-TWR-05 #2）。
 *
 * スコープ完了後にR-END-01の判定タイミングを通す（R-TWR-04 #5）。Memory自身はダメージを
 * 与えられなくても、その付与に反応したPSの連鎖で出撃した編成が全滅し得るため、`TurnStarted`
 * より前に全滅と終了を確定させる — 確定させないと、全滅した編成のターン開始時Memoryが
 * 候補化されてしまう（R-TWR-05 #1）。
 */
function deployPendingFormations(
  battle: Battle,
  turnNumber: number,
  random: RandomSource,
  recorder: EventRecorder,
): DeploymentOutcome {
  const formations = battle.formations;
  if (formations === undefined) {
    return { battle };
  }
  let next = battle;
  let nextFormations = formations;
  let scope:
    | { readonly resolutionScopeId: ResolutionScopeId; readonly rootEventId: DomainEventId }
    | undefined;
  const deployedEvents: BattleDomainEvent[] = [];
  for (const side of TOTAL_WAR_SIDE_ORDER) {
    const current = nextFormations[side];
    const reserve = current.reserves[0];
    if (!isAwaitingDeployment(current) || reserve === undefined) {
      continue;
    }
    const resolutionScopeId = scope?.resolutionScopeId ?? recorder.nextResolutionScopeId();
    const deployed = recorder.record({
      eventType: "FormationDeployed",
      category: "FACT",
      turnNumber,
      cycleNumber: 0,
      resolutionScopeId,
      ...(scope !== undefined
        ? { parentEventId: scope.rootEventId, rootEventId: scope.rootEventId }
        : {}),
      payload: {
        side,
        formationNumber: reserve.formationNumber,
        turnNumber,
        battleUnitIds: reserve.units.map((unit) => unit.battleUnitId),
      },
    });
    deployedEvents.push(deployed);
    scope ??= { resolutionScopeId, rootEventId: deployed.eventId };
    nextFormations = {
      ...nextFormations,
      [side]: {
        ...current,
        activeFormationNumber: reserve.formationNumber,
        reserves: current.reserves.slice(1),
      },
    };
    next =
      side === "ALLY"
        ? { ...next, allyUnits: [...next.allyUnits, ...reserve.units] }
        : { ...next, enemyUnits: [...next.enemyUnits, ...reserve.units] };
  }
  const placed: Battle = { ...next, formations: nextFormations };
  if (scope === undefined) {
    return { battle: placed };
  }
  const resolved = resolveDeployedFormationMemories(
    placed,
    deployedEvents,
    scope,
    turnNumber,
    random,
    recorder,
  );
  const checkpoint = passCompletionCheckpoint(
    checkpointModeOf(resolved),
    [...resolved.allyUnits, ...resolved.enemyUnits],
    false,
    {
      recorder,
      turnNumber,
      cycleNumber: 0,
      resolutionScopeId: scope.resolutionScopeId,
      rootEventId: scope.rootEventId,
      parentEventId: scope.rootEventId,
    },
  );
  return {
    battle: withFormations(resolved, checkpoint.totalWarFormations),
    ...(checkpoint.completion !== undefined ? { completion: checkpoint.completion } : {}),
  };
}

interface DeploymentOutcome {
  readonly battle: Battle;
  /** 出撃スコープ完了後の判定タイミングで確定した結果。`undefined`は戦闘継続。 */
  readonly completion?: CompletionCheckResult;
}

/**
 * R-TWR-05 #2・#4: 出撃した編成の戦闘開始時Memoryを、各`FormationDeployed`へ照合して解決する
 * （`matchesMemoryTriggerEventType`）。R-MEM-03と同じ解決フェーズ（`BATTLE_START`）として扱い、
 * `TurnStarted`の発行前に終える。
 */
function resolveDeployedFormationMemories(
  battle: Battle,
  deployedEvents: readonly BattleDomainEvent[],
  scope: { readonly resolutionScopeId: ResolutionScopeId; readonly rootEventId: DomainEventId },
  turnNumber: number,
  random: RandomSource,
  recorder: EventRecorder,
): Battle {
  const runtime = new PassiveActivationRuntime(
    {
      definitions: definitionsOf(battle),
      random,
      recorder,
      turnNumber,
      cycleNumber: 0,
      resolutionScopeId: scope.resolutionScopeId,
      rootEventId: scope.rootEventId,
      resolutionPhase: "BATTLE_START",
      ...(battle.exercise !== undefined ? { exercise: battle.exercise } : {}),
    },
    [...battle.allyUnits, ...battle.enemyUnits],
  );
  let units: readonly BattleUnit[] = [...battle.allyUnits, ...battle.enemyUnits];
  let cursor = scope.rootEventId;
  for (const deployed of deployedEvents) {
    const resolved = runtime.onFactEvent(deployed, units);
    units = resolved.units;
    cursor = resolved.lastEventId;
  }
  const { units: afterScope } = runtime.finalizeResolutionScope(cursor, units);
  return {
    ...battle,
    allyUnits: afterScope.filter((unit) => unit.side === "ALLY"),
    enemyUnits: afterScope.filter((unit) => unit.side === "ENEMY"),
  };
}

/**
 * TURN_STARTING #2のAP/PP回復のうち、実際に値が変わったユニットだけを
 * `ResourcesRecovered`のpayloadへ含める。R-ACT-04によりstateDelta自体は
 * `ResourcesRecovered`が所有せず、`ResourceChanged`（reason: TURN_RECOVERY）が
 * リソースごとに個別に所有する。
 */
function buildResourceRecovery(
  before: readonly BattleUnit[],
  after: readonly BattleUnit[],
): { entries: readonly ResourceRecoveryEntry[] } {
  const entries: ResourceRecoveryEntry[] = [];
  for (let i = 0; i < before.length; i++) {
    const previous = before[i]!;
    const recovered = after[i]!;
    if (previous.currentAp === recovered.currentAp && previous.currentPp === recovered.currentPp) {
      continue;
    }
    entries.push({
      battleUnitId: previous.battleUnitId,
      apBefore: previous.currentAp,
      apAfter: recovered.currentAp,
      ppBefore: previous.currentPp,
      ppAfter: recovered.currentPp,
    });
  }
  return { entries };
}

/**
 * `06_戦闘状態遷移.md` TURN_ENDING #2-4: PS連鎖完了後（M6未実装のため`TurnCompleting`
 * 直後）に、現在のターンより前に設定されたターン単位クールタイムを全ユニットで
 * 1減らす。現在のターンで設定されたものは対象外（`decrementTurnCooldowns`が判定）。
 */
function applyTurnCooldownDecrements(
  units: readonly BattleUnit[],
  currentTurnNumber: number,
  recorder: EventRecorder,
  turnNumber: number,
  resolutionScopeId: ResolutionScopeId,
  rootEventId: DomainEventId,
  parentEventId: DomainEventId,
): { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId } {
  let working = units;
  let lastEventId = parentEventId;
  for (const unit of units) {
    const decrement = decrementTurnCooldowns(unit.cooldowns, currentTurnNumber);
    if (decrement.changes.length === 0) {
      continue;
    }
    working = working.map((u) =>
      u.battleUnitId === unit.battleUnitId ? { ...u, cooldowns: decrement.cooldowns } : u,
    );
    for (const change of decrement.changes) {
      const reduced = recorder.record({
        eventType: "CooldownReduced",
        category: "FACT",
        turnNumber,
        cycleNumber: 0,
        resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId,
        sourceUnitId: unit.battleUnitId,
        payload: {
          actorUnitId: unit.battleUnitId,
          skillDefinitionId: change.skillDefinitionId,
          unit: change.unit,
          before: change.before,
          after: change.after,
        },
        stateDelta: {
          units: {
            [unit.battleUnitId]: {
              cooldowns: {
                [change.skillDefinitionId]: {
                  unit: change.unit,
                  before: change.before,
                  after: change.after,
                },
              },
            },
          },
        },
      });
      lastEventId = reduced.eventId;
      if (change.after === 0) {
        const completed = recorder.record({
          eventType: "CooldownCompleted",
          category: "FACT",
          turnNumber,
          cycleNumber: 0,
          resolutionScopeId,
          parentEventId: lastEventId,
          rootEventId,
          sourceUnitId: unit.battleUnitId,
          payload: {
            actorUnitId: unit.battleUnitId,
            skillDefinitionId: change.skillDefinitionId,
            unit: change.unit,
          },
        });
        lastEventId = completed.eventId;
      }
    }
  }
  return { units: working, lastEventId };
}

/**
 * Battle集約の主要操作: advance。1回の呼び出しでTURN_STARTING〜TURN_ENDINGを
 * 進め、R-END-01の2つの判定タイミング区分（行動外のトップレベル解決スコープ
 * 完了後＝ターン開始・終了／ユニットの1行動完了後＝`resolveActionPhase`内部）を
 * 順に評価する。勝敗が確定した時点で以後の処理を打ち切る
 * （05_ドメインモデル.md「結果が確定した後は、未処理の...を処理しない」）。
 */
export function advanceBattle(
  current: Battle,
  random: RandomSource,
  recorder: EventRecorder,
): Battle {
  if (current.status !== "RUNNING") {
    throw new DomainValidationError(
      "battle.status",
      `cannot advance a battle in status "${current.status}"`,
    );
  }

  const nextTurnNumber = current.turnState.currentTurn + 1;
  const deployment = deployPendingFormations(current, nextTurnNumber, random, recorder);
  const battle = deployment.battle;
  if (deployment.completion !== undefined) {
    // 出撃スコープは次ターンの番号で記録しているため、終了ターンもその番号に揃える
    // （`BattleCompleted`がそれより前のターン番号で後に並ばないようにする）。
    return complete(battle, deployment.completion, recorder, nextTurnNumber);
  }
  const turnScope = recorder.nextResolutionScopeId();
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    payload: { turnNumber: nextTurnNumber },
    stateDelta: { turnNumber: { before: battle.turnState.currentTurn, after: nextTurnNumber } },
  });

  const turnState = beginNextTurn(battle.turnState);
  const recoveredAllyUnits = battle.allyUnits.map(recoverTurnResources);
  const recoveredEnemyUnits = battle.enemyUnits.map(recoverTurnResources);
  const recovery = buildResourceRecovery(
    [...battle.allyUnits, ...battle.enemyUnits],
    [...recoveredAllyUnits, ...recoveredEnemyUnits],
  );
  const resourcesRecovered = recorder.record({
    eventType: "ResourcesRecovered",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    parentEventId: turnStarted.eventId,
    rootEventId: turnStarted.eventId,
    payload: { units: recovery.entries },
  });

  // R-ACT-04: 回復で変化した各リソースを`ResourceChanged`(reason: TURN_RECOVERY)
  // として個別に所有・観測できるようにする。
  const recoveryResourceChangeContext = {
    recorder,
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    rootEventId: turnStarted.eventId,
  };
  let lastRecoveryEventId = resourcesRecovered.eventId;
  for (const entry of recovery.entries) {
    lastRecoveryEventId = recordResourceChangeIfAny(
      recoveryResourceChangeContext,
      entry.battleUnitId,
      "AP",
      entry.apBefore,
      entry.apAfter,
      entry.apAfter - entry.apBefore,
      "TURN_RECOVERY",
      lastRecoveryEventId,
      resourcesRecovered.eventId,
    );
    lastRecoveryEventId = recordResourceChangeIfAny(
      recoveryResourceChangeContext,
      entry.battleUnitId,
      "PP",
      entry.ppBefore,
      entry.ppAfter,
      entry.ppAfter - entry.ppBefore,
      "TURN_RECOVERY",
      lastRecoveryEventId,
      resourcesRecovered.eventId,
    );
  }

  // `06_戦闘状態遷移.md` TURN_STARTING #5: `TurnStarted`をイベントとして持つPSを
  // 解決する（回復適用後）。Issue #34 (R-PS-07): PS発動済み集合はこのトップ
  // レベルイベント専用に1つだけ生成する。行動外のため`actionId`は持たない。
  // Issue #144 (TRIGGER_EXCLUSION_TIMING): このトップレベルイベントのroot自体が
  // `TurnStarted`のため、`resolutionPhase: "TURN_START"`を渡す。
  const passiveRuntime = new PassiveActivationRuntime(
    {
      definitions: definitionsOf(battle),
      random,
      recorder,
      turnNumber: nextTurnNumber,
      cycleNumber: 0,
      resolutionScopeId: turnScope,
      rootEventId: turnStarted.eventId,
      resolutionPhase: "TURN_START",
      ...(battle.exercise !== undefined ? { exercise: battle.exercise } : {}),
    },
    [...recoveredAllyUnits, ...recoveredEnemyUnits],
  );
  passiveRuntime.onFactEvent(turnStarted, [...recoveredAllyUnits, ...recoveredEnemyUnits]);
  // このトップレベルイベント専用の解決スコープが終わるたびに、
  // `resetScope: "RESOLUTION_SCOPE"`のcounterを破棄・`RuntimeCounterReset`発行する。
  const { units: afterPassives } = passiveRuntime.finalizeResolutionScope(turnStarted.eventId);
  const allyUnits = afterPassives.filter((unit) => unit.side === "ALLY");
  const enemyUnits = afterPassives.filter((unit) => unit.side === "ENEMY");
  // R-END-01／R-TEX-09 #1 判定タイミング区分「ターン開始・終了など、行動外のトップレベル解決スコープ完了後」その1: TURN_STARTING完了後。
  const afterTurnStart = passCompletionCheckpoint(checkpointModeOf(battle), afterPassives, false, {
    recorder,
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnScope,
    rootEventId: turnStarted.eventId,
    parentEventId: turnStarted.eventId,
  });
  const started: Battle = withFormations(
    { ...battle, turnState, allyUnits, enemyUnits },
    afterTurnStart.totalWarFormations,
  );
  if (afterTurnStart.completion !== undefined) {
    return complete(started, afterTurnStart.completion, recorder);
  }

  // QUEUE_BUILDING〜ACTION_RESOLUTION: R-END-01「ユニットの1行動完了後」の判定は
  // `resolveActionPhase` 内部で各行動ごとに行う。R-TWR-03 #4: ターン開始の判定タイミングで
  // 編成の全滅を検出した場合は、行動フェーズを開始せずにTURN_ENDINGへ進む。
  const actionPhase = afterTurnStart.awaitingDeployment
    ? { allyUnits, enemyUnits, result: undefined, totalWarFormations: started.formations }
    : resolveActionPhase(
        allyUnits,
        enemyUnits,
        definitionsOf(started),
        random,
        recorder,
        nextTurnNumber,
        turnStarted.eventId,
        resourcesRecovered.eventId,
        battle.exercise,
        started.formations,
      );
  const progressed: Battle = withFormations(
    { ...started, allyUnits: actionPhase.allyUnits, enemyUnits: actionPhase.enemyUnits },
    actionPhase.totalWarFormations,
  );
  if (actionPhase.result !== undefined) {
    return complete(progressed, actionPhase.result, recorder);
  }

  // R-END-01 判定タイミング区分「ターン開始・終了など、行動外のトップレベル解決スコープ完了後」その2: TURN_ENDING完了後。
  const turnEndScope = recorder.nextResolutionScopeId();
  const turnCompleting = recorder.record({
    eventType: "TurnCompleting",
    category: "TIMING",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnEndScope,
    payload: { turnNumber: nextTurnNumber },
  });

  // `06_戦闘状態遷移.md` TURN_ENDING #1: `TurnCompleting`をイベントとして持つPSを
  // 解決する（Issue #144 follow-up:
  // `resolutionPhase: "TURN_END"`を渡す）。行動外のため`actionId`は持たない。
  const turnEndPassiveRuntime = new PassiveActivationRuntime(
    {
      definitions: definitionsOf(progressed),
      random,
      recorder,
      turnNumber: nextTurnNumber,
      cycleNumber: 0,
      resolutionScopeId: turnEndScope,
      rootEventId: turnCompleting.eventId,
      resolutionPhase: "TURN_END",
      ...(battle.exercise !== undefined ? { exercise: battle.exercise } : {}),
    },
    [...actionPhase.allyUnits, ...actionPhase.enemyUnits],
  );
  let turnEndUnits: readonly BattleUnit[] = turnEndPassiveRuntime.onFactEvent(turnCompleting, [
    ...actionPhase.allyUnits,
    ...actionPhase.enemyUnits,
  ]).units;

  // TURN_ENDINGで発生する期間イベント
  // （`CooldownReduced`／`EffectDurationReduced`／`EffectExpired`／`MarkerUpdated`／
  // `MarkerRemoved`）も、`08_ドメインイベント.md`「各イベントに対応するPS/Memory
  // 候補を直ちに解決する」に従い発生順に同じ`turnEndPassiveRuntime`へ通知する。
  // 以前は`TurnCompleting`のPS連鎖だけを解決して即`finalizeResolutionScope`して
  // おり、その後の期間イベントはPS/Memory候補が一度も解決されないまま最終state
  // だけが観測されていた（R-EFF-09の4入口のうちTURN期間満了が抜けていた）。
  // `finalizeResolutionScope`（`RuntimeCounterReset`）は、これら全ての連鎖が
  // 終わった後（`06_戦闘状態遷移.md` TURN_ENDING #9「解決スコープ完了」）へ移す。
  const notifyTurnEndEvents = (
    units: readonly BattleUnit[],
    eventsStart: number,
  ): readonly BattleUnit[] => {
    let working = units;
    for (const event of recorder.getEvents().slice(eventsStart)) {
      working = turnEndPassiveRuntime.onFactEvent(event, working).units;
    }
    return working;
  };
  /** 除去1件ごとの通知（R-EFF-09カスケードの各ステップ）用。 */
  const turnEndPassiveChain = (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ): readonly BattleUnit[] => turnEndPassiveRuntime.onFactEvent(event, units).units;

  // R-SKL-04 TURN_ENDING #2-4: PS連鎖完了後の現在状態から対象を再取得し、
  // ターン単位クールタイムを全ユニットで1減らす（現在のターンで設定された
  // ものを除く）。
  const cooldownEventsStart = recorder.getEvents().length;
  const cooldownDecrement = applyTurnCooldownDecrements(
    turnEndUnits,
    nextTurnNumber,
    recorder,
    nextTurnNumber,
    turnEndScope,
    turnCompleting.eventId,
    turnCompleting.eventId,
  );
  let lastTurnEndEventId = cooldownDecrement.lastEventId;
  turnEndUnits = notifyTurnEndEvents(cooldownDecrement.units, cooldownEventsStart);

  // `06_戦闘状態遷移.md` TURN_ENDING #5-7 / R-EFF-06: クールタイム減算後、ターン
  // 単位効果の残り回数を全ユニットで1減らし、0になったインスタンスを即時に
  // 失効させる（重複なし最強効果の次点繰上げは`expireEffects`が
  // `recalculateCombatStats`経由で自然に反映する）。
  const turnDurationDecrement = decrementTurnEffectDurations(turnEndUnits, nextTurnNumber);
  turnEndUnits = turnDurationDecrement.units;
  if (turnDurationDecrement.changes.length > 0) {
    const reducedEventsStart = recorder.getEvents().length;
    lastTurnEndEventId = emitEffectDurationReducedEvents(
      {
        recorder,
        turnNumber: nextTurnNumber,
        cycleNumber: 0,
        resolutionScopeId: turnEndScope,
        rootEventId: turnCompleting.eventId,
      },
      turnEndUnits,
      turnDurationDecrement.changes,
      lastTurnEndEventId,
    );
    turnEndUnits = notifyTurnEndEvents(turnEndUnits, reducedEventsStart);

    const seeds: ExpirationSeed[] = turnDurationDecrement.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        battleUnitId: change.battleUnitId,
        effectInstanceId: change.effectInstanceId,
        reason: "TIME_LIMIT",
      }));
    if (seeds.length > 0) {
      const expiry = expireEffects(
        {
          recorder,
          turnNumber: nextTurnNumber,
          cycleNumber: 0,
          resolutionScopeId: turnEndScope,
          rootEventId: turnCompleting.eventId,
          onFactEventForPassiveChain: turnEndPassiveChain,
        },
        turnEndUnits,
        seeds,
        battle.definitions.effectActions,
        lastTurnEndEventId,
      );
      turnEndUnits = expiry.units;
      lastTurnEndEventId = expiry.lastEventId;
    }
  }

  // R-EFF-10: `MarkerState`も同じ`DurationDefinition`を再利用するため、
  // ターン単位effect減算の直後、同じ`turnEndScope`でターン単位Markerも
  // 全ユニットで1減らす。
  const turnMarkerDurationDecrement = decrementTurnMarkerDurations(turnEndUnits, nextTurnNumber);
  turnEndUnits = turnMarkerDurationDecrement.units;
  if (turnMarkerDurationDecrement.changes.length > 0) {
    const markerUpdatedEventsStart = recorder.getEvents().length;
    lastTurnEndEventId = emitMarkerDurationChangedEvents(
      {
        recorder,
        turnNumber: nextTurnNumber,
        cycleNumber: 0,
        resolutionScopeId: turnEndScope,
        rootEventId: turnCompleting.eventId,
      },
      turnEndUnits,
      turnMarkerDurationDecrement.changes,
      lastTurnEndEventId,
    );
    turnEndUnits = notifyTurnEndEvents(turnEndUnits, markerUpdatedEventsStart);

    const markerSeeds: MarkerRemovalSeed[] = turnMarkerDurationDecrement.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        battleUnitId: change.battleUnitId,
        markerInstanceId: change.markerInstanceId,
        reason: "TIME_LIMIT",
      }));
    if (markerSeeds.length > 0) {
      const markerRemoval = removeMarkers(
        {
          recorder,
          turnNumber: nextTurnNumber,
          cycleNumber: 0,
          resolutionScopeId: turnEndScope,
          rootEventId: turnCompleting.eventId,
          onFactEventForPassiveChain: turnEndPassiveChain,
        },
        turnEndUnits,
        markerSeeds,
        battle.definitions.effectActions,
        lastTurnEndEventId,
      );
      turnEndUnits = markerRemoval.units;
      lastTurnEndEventId = markerRemoval.lastEventId;
    }
  }

  // `06_戦闘状態遷移.md` TURN_ENDING #8: `TurnCompleted`を発行し、対応するPSを
  // 解決する。発行するだけで`onFactEvent`へ渡さないと、`TurnCompleted`を
  // triggerにするPS/Memoryが発動しない
  // （「ターン終了PSによって敵が全滅した場合はターン上限敗北より先に勝利判定」の
  // 契約も満たせなかった）。減算だけでイベントを伴わない変化はruntimeへ届いて
  // いないため、`turnEndUnits`を明示的に渡す。
  const turnCompleted = recorder.record({
    eventType: "TurnCompleted",
    category: "FACT",
    turnNumber: nextTurnNumber,
    cycleNumber: 0,
    resolutionScopeId: turnEndScope,
    parentEventId: lastTurnEndEventId,
    rootEventId: turnCompleting.eventId,
    payload: { turnNumber: nextTurnNumber },
  });
  const afterTurnCompleted = turnEndPassiveRuntime.onFactEvent(turnCompleted, turnEndUnits);

  // `06_戦闘状態遷移.md` TURN_ENDING #9「解決スコープ完了」: 期間イベントと
  // `TurnCompleted`のPS/Memory連鎖まで解決し終えてからスコープを終了する
  // （`RuntimeCounterReset`）。
  const { units: afterTurnEndScope } = turnEndPassiveRuntime.finalizeResolutionScope(
    afterTurnCompleted.lastEventId,
    afterTurnCompleted.units,
  );

  const progressedWithMarkerDuration: Battle = {
    ...progressed,
    allyUnits: afterTurnEndScope.filter((unit) => unit.side === "ALLY"),
    enemyUnits: afterTurnEndScope.filter((unit) => unit.side === "ENEMY"),
  };

  // 演習ではこの`turnLimitReached`が「5ターン目の終了」に一致する
  // （規定ターン数は5固定のため、R-TEX-01 #4／R-TEX-09 #1）。
  // R-TWR-03 #6: 総力戦ではここで別の陣営の全滅を検出しても、同じターンの全滅として扱う。
  const afterTurnEnd = passCompletionCheckpoint(
    checkpointModeOf(progressedWithMarkerDuration),
    afterTurnEndScope,
    isFinalTurn(turnState),
    {
      recorder,
      turnNumber: nextTurnNumber,
      cycleNumber: 0,
      resolutionScopeId: turnEndScope,
      rootEventId: turnCompleting.eventId,
      parentEventId: turnCompleted.eventId,
    },
  );
  const turnEnded = withFormations(progressedWithMarkerDuration, afterTurnEnd.totalWarFormations);
  if (afterTurnEnd.completion !== undefined) {
    return complete(turnEnded, afterTurnEnd.completion, recorder);
  }

  return turnEnded;
}

/**
 * 判定結果へ終了ターンを加えて確定形にする。戦術演習ではさらに、その時点の累計スコアと
 * ブレイク回数を写す（R-TEX-10 #1／#3）。ブレイク履歴は集約に持たせず、`UnitBroken`の
 * 投影として出力する（同 #2）。
 */
function buildResult(
  battle: Battle,
  result: CompletionCheckResult,
  completedTurn: number,
): BattleResult {
  if ("outcome" in result) {
    return { ...result, completedTurn };
  }
  const exercise = battle.exercise;
  if (exercise === undefined) {
    throw new DomainValidationError(
      "battle.exercise",
      "an exercise end reason was resolved for a battle that owns no exercise state; the completion checkpoint and the battle mode disagree",
    );
  }
  return { ...result, completedTurn, ...exercise.snapshot() };
}

/** BattleCompletedを発行する。結果確定契機が複数あるため、単一の親イベントには紐付けずルート化する。 */
function complete(
  battle: Battle,
  result: CompletionCheckResult,
  recorder: EventRecorder,
  completedTurn: number = battle.turnState.currentTurn,
): Battle {
  const fullResult: BattleResult = buildResult(battle, result, completedTurn);
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: completedTurn,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    // 確定した結果そのものがpayloadの形（`08_ドメインイベント.md`「BattleCompleted」）。
    // 演習では勝敗を持たず、総スコアとブレイク回数を持つ（R-TEX-10 #1）。
    payload: fullResult,
    stateDelta: {
      battleStatus: { before: battle.status, after: "COMPLETED" },
      result: { before: battle.result, after: fullResult },
    },
  });
  return {
    ...battle,
    status: "COMPLETED",
    result: fullResult,
  };
}
