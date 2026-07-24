import { requireUnit, type ActionResolutionResult } from "./action-resolution-shared.js";
import { resolveWait } from "./action-wait-resolver.js";
import { resolveSkillUse } from "./action-skill-use-resolver.js";
import { resolveChargeStart, resolveChargeRelease } from "./action-charge-resolver.js";
import {
  createActionQueue,
  reorderRemainingQueue,
  type ReservedActionKind,
} from "../action/action-queue.js";
import { isExUsable, selectAsCandidate } from "../action/action-selection-policy.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import { resolveVictory, type VictoryResult } from "../outcome/victory-policy.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ActionPhaseResult {
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  /** `undefined` means the phase drained naturally without a victory being resolved. */
  readonly result: VictoryResult | undefined;
}

function splitBySide(units: readonly BattleUnit[]): {
  ally: readonly BattleUnit[];
  enemy: readonly BattleUnit[];
} {
  return {
    ally: units.filter((unit) => unit.side === "ALLY"),
    enemy: units.filter((unit) => unit.side === "ENEMY"),
  };
}

/**
 * `06_戦闘状態遷移.md` のDECIDING〜COMPLETINGの基本形。R-ACT-01の優先順のうち
 * 気絶・凍結(M7)を除いた「発動待ちのチャージ効果があれば予約より優先して発動する
 * ／EX予約ならEXスキルを使用する／AS予約なら使用可能なASを選ぶ／なければ待機
 * する」を実装する。R-ACT-03の一部（AS/EXのコスト消費、通常の待機によるAP1消費、
 * `Q-BTL-06`のEXゲージ全量消費による待機、チャージ開始・発動の無消費）だけを
 * 実装する。EXゲージ増加(R-ACT-04)、気絶・凍結(M7)、PS/Memory連鎖(M6)はこの関数の
 * 対象外。`ActionStarted`が自身の解決スコープを開き（`08_ドメインイベント.md`
 * 「resolutionScopeId」はActionIdと対応する）、`ActionCompleted`までの全イベント
 * がそのrootEventIdを共有する。
 */
function resolveOneAction(
  actorId: BattleUnitId,
  reservedActionType: ReservedActionKind,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  cycleNumber: number,
): ActionResolutionResult {
  const actor = requireUnit(units, actorId);
  const actionId = recorder.nextActionId();
  const actionScope = recorder.nextResolutionScopeId();

  // R-ACT-01 #3（気絶・凍結による阻害はM7）: 発動待ちのチャージ効果は予約
  // されたAS/EXより優先して発動する。
  if (actor.charge !== undefined) {
    return resolveChargeRelease(
      actor,
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (reservedActionType === "EX") {
    const exSkill = definitions.exSkillByUnit.get(actor.unitDefinitionId);
    if (exSkill === undefined) {
      throw new DomainValidationError(
        "unitDefinitionId",
        `references a UnitDefinitionId absent from the given exSkillByUnit: "${actor.unitDefinitionId}"`,
      );
    }
    // R-ACT-01 #5 / Q-BTL-06: 対象候補がなければEXは使用不能とし、EXゲージ全量を
    // 消費して待機する。
    if (!isExUsable(exSkill, actor, units, definitions.unitDefinitions)) {
      return resolveWait(
        actor,
        reservedActionType,
        "EX_UNUSABLE",
        "EX_GAUGE",
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    if (exSkill.resolution.kind === "CHARGE") {
      return resolveChargeStart(
        actor,
        exSkill,
        "EX",
        reservedActionType,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
        actionId,
        actionScope,
      );
    }
    return resolveSkillUse(
      actor,
      exSkill,
      "EX",
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  const activeSkills = definitions.activeSkillsByUnit.get(actor.unitDefinitionId) ?? [];
  const selection = selectAsCandidate(activeSkills, actor, units, definitions.unitDefinitions);

  if (selection.kind === "WAIT") {
    return resolveWait(
      actor,
      reservedActionType,
      "NO_USABLE_ACTIVE_SKILL",
      "AP",
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  if (selection.skill.resolution.kind === "CHARGE") {
    return resolveChargeStart(
      actor,
      selection.skill,
      "AS",
      reservedActionType,
      units,
      definitions,
      random,
      recorder,
      turnNumber,
      cycleNumber,
      actionId,
      actionScope,
    );
  }

  return resolveSkillUse(
    actor,
    selection.skill,
    "AS",
    reservedActionType,
    units,
    definitions,
    random,
    recorder,
    turnNumber,
    cycleNumber,
    actionId,
    actionScope,
  );
}

/**
 * `06_戦闘状態遷移.md` のQUEUE_BUILDING〜ACTION_RESOLUTIONを、使用可能な行動が
 * 無くなるまで繰り返す（`createActionQueue` が空を返した時点で終了）。各1行動
 * 完了後にR-END-01タイミング#1（ユニットの1行動完了後）の勝敗判定を行い、
 * 確定した時点で残りの行動を打ち切る。PS/Memory連鎖(M6)は行わない。
 * `ActionQueueCreated`は周回ごとに発行し、ターンの解決スコープ（`turnRootEventId`）
 * を共有する。行動自体（`ActionStarted`以降）は自分自身の解決スコープを新しく開く。
 */
export function resolveActionPhase(
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
  recorder: EventRecorder,
  turnNumber: number,
  turnRootEventId: DomainEventId,
  turnScopeParentEventId: DomainEventId,
): ActionPhaseResult {
  let units: readonly BattleUnit[] = [...allyUnits, ...enemyUnits];
  let cycleNumber = 0;
  let turnScopeParent = turnScopeParentEventId;

  // R-ACT-03: AS・PS・EXのコストは1以上であり、Catalog検証（`createCost`/
  // JSON Schema）がコスト0の定義を生成前に拒否する。このガードは、それでも
  // コスト0相当のASが紛れ込んだ場合(不正データ、将来のバグ)への多層防御。
  // costが0だと`consumeAp`が no-op になり、そのユニットのAPはキュー適格判定
  // (`isQueueEligible`)を通過し続け、周回を再生成するたびに再度選ばれてしまう。
  // 通常規則(cost>=1、WAITは必ずAP 1を消費)ではターン内の総周回数は開始時APの
  // 合計を超えないため、それを上回った時点で無限周回と判断し、規定ターン上限を
  // 経由せずこのターン内で即座に検出する(`resolveActionPhase`はターンをまたがない)。
  // R-SKL-05: チャージ効果発動はAP・EXゲージを消費しないため、チャージ開始の
  // AP消費1回につき最大2周回（開始+発動）を要する。安全上限を2倍にして、
  // 正当なチャージ多用を誤検知しないようにする。
  const maxCyclesPerTurn = units.reduce((sum, unit) => sum + unit.maximumAp, 0) * 2 + 1;

  for (;;) {
    const queue = createActionQueue(units);
    if (queue.entries.length === 0) {
      break;
    }
    cycleNumber += 1;
    if (cycleNumber > maxCyclesPerTurn) {
      throw new DomainValidationError(
        "resolveActionPhase.cycleNumber",
        `exceeded the maximum possible cycles for this turn (${maxCyclesPerTurn}, derived from the total starting AP across all units); a 0-cost action is preventing forward progress`,
      );
    }

    const queueCreated = recorder.record({
      eventType: "ActionQueueCreated",
      category: "FACT",
      turnNumber,
      cycleNumber,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      parentEventId: turnScopeParent,
      rootEventId: turnRootEventId,
      payload: {
        cycleNumber,
        reservations: queue.entries.map((entry) => ({
          battleUnitId: entry.battleUnitId,
          reservedActionKind: entry.reservedActionKind,
          actionSpeed: requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
        })),
      },
    });
    turnScopeParent = queueCreated.eventId;

    // `remaining`は「まだ処理していないこの周回の予約」。`06_戦闘状態遷移.md`
    // 「戦闘不能者の除去」: 行動完了ごとにここから戦闘不能者を即時除去する
    // （dequeue時の`isDefeated`判定は本来届かないはずの防御的判定として残す）。
    let remaining = queue.entries;

    while (remaining.length > 0) {
      const reservation = remaining[0]!;
      remaining = remaining.slice(1);

      if (isDefeated(requireUnit(units, reservation.battleUnitId))) {
        continue;
      }

      const beforeActionUnits = units;
      const resolution = resolveOneAction(
        reservation.battleUnitId,
        reservation.reservedActionKind,
        units,
        definitions,
        random,
        recorder,
        turnNumber,
        cycleNumber,
      );
      units = resolution.units;

      const newlyDefeated = remaining.filter((entry) =>
        isDefeated(requireUnit(units, entry.battleUnitId)),
      );
      if (newlyDefeated.length > 0) {
        for (const removed of newlyDefeated) {
          recorder.record({
            eventType: "ActionReservationRemoved",
            category: "FACT",
            turnNumber,
            cycleNumber,
            resolutionScopeId: resolution.actionScope,
            parentEventId: resolution.completedEventId,
            rootEventId: resolution.rootEventId,
            sourceUnitId: removed.battleUnitId,
            payload: { battleUnitId: removed.battleUnitId, reason: "DEFEATED" },
          });
        }
        const removedIds = new Set(newlyDefeated.map((entry) => entry.battleUnitId));
        remaining = remaining.filter((entry) => !removedIds.has(entry.battleUnitId));
      }

      // R-ORD-04: 現在の1行動(とPS/Memory連鎖)完了・戦闘不能者除去の後、未行動者の
      // 行動速度が実際に変わっていた場合だけ並べ直す。予約種別(AS/EX)は
      // `reorderRemainingQueue`が維持する。
      if (remaining.length > 0) {
        const speedChanged = remaining.some(
          (entry) =>
            requireUnit(beforeActionUnits, entry.battleUnitId).combatStats.actionSpeed !==
            requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
        );
        if (speedChanged) {
          const before = remaining.map((entry) => ({
            battleUnitId: entry.battleUnitId,
            actionSpeed: requireUnit(beforeActionUnits, entry.battleUnitId).combatStats.actionSpeed,
          }));
          const reordered = reorderRemainingQueue(remaining, units);
          const after = reordered.map((entry) => ({
            battleUnitId: entry.battleUnitId,
            actionSpeed: requireUnit(units, entry.battleUnitId).combatStats.actionSpeed,
          }));
          recorder.record({
            eventType: "ActionQueueReordered",
            category: "FACT",
            turnNumber,
            cycleNumber,
            resolutionScopeId: resolution.actionScope,
            parentEventId: resolution.completedEventId,
            rootEventId: resolution.rootEventId,
            payload: { before, after },
          });
          remaining = reordered;
        }
      }

      const { ally, enemy } = splitBySide(units);
      const victory = resolveVictory({
        allAlliesDefeated: ally.every(isDefeated),
        allEnemiesDefeated: enemy.every(isDefeated),
        turnLimitReached: false,
      });
      if (victory !== undefined) {
        return { allyUnits: ally, enemyUnits: enemy, result: victory };
      }
    }
  }

  const { ally, enemy } = splitBySide(units);
  return { allyUnits: ally, enemyUnits: enemy, result: undefined };
}
