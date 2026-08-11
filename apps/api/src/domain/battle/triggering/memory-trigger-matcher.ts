import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";
import type { MemoryDefinition } from "../../catalog/definitions/memory-definition.js";
import type { TriggerDefinition } from "../../catalog/definitions/trigger-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { MemoryCandidate, MemoryCandidateGroup } from "./memory-candidate.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import {
  evaluateMemorySourceSelector,
  evaluateMemoryTargetSelector,
} from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { matchesTriggerEventType } from "./trigger-event-matching.js";

/**
 * R-MEM-02 #1「APIリクエストで指定された Memory の順序」を保つため、両陣営の
 * Memoryを陣営ごとに指定順の配列で受け取る。両陣営がMemoryを指定した場合の
 * 陣営間の順序は、APIリクエスト自身の並び（`allyFormation` → `enemyFormation`、
 * `10_API設計.md`）と同じくALLY→ENEMYで一意にする（R-MEM-02はMemory候補順に
 * PS候補のような速度・配置の比較を持ち込まない）。
 */
export const MEMORY_SIDE_ORDER: readonly Side[] = ["ALLY", "ENEMY"];

export interface MemoryTriggerMatchInput {
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly memoriesBySide: Readonly<Record<Side, readonly MemoryDefinition[]>>;
  /** PS側（`detectPassiveCandidates`）と同じく1解決スコープにつき1回だけ決まる値。 */
  readonly resolutionPhase?: ResolutionPhase;
  readonly turnNumber?: number;
}

export interface MemoryTriggerMatchOneInput {
  readonly trigger: TriggerDefinition;
  /** そのMemoryを編成に指定した陣営（R-MEM-04のsource side）。 */
  readonly side: Side;
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly resolutionPhase?: ResolutionPhase;
  readonly turnNumber?: number;
}

/**
 * R-MEM-01 #3「`TriggerDefinition.eventType` と `ConditionDefinition` を評価する」の
 * 1件分。`detectMemoryCandidates`（候補化）と、`08_ドメインイベント.md`「発動直前の
 * 再確認」Memory候補「trigger conditionが現在も成立」（`PassiveActivationRuntime`）の
 * 両方が同じ判定を共有するため独立した関数にする。
 */
export function matchesMemoryTrigger(input: MemoryTriggerMatchOneInput): boolean {
  const { trigger, side, event, units, resolutionPhase, turnNumber } = input;
  const unitsById: ReadonlyMap<BattleUnitId, BattleUnit> = new Map(
    units.map((unit) => [unit.battleUnitId, unit] as const),
  );
  return matchesMemoryTriggerWith(
    trigger,
    side,
    event,
    units,
    unitsById,
    resolutionPhase,
    turnNumber,
  );
}

function matchesMemoryTriggerWith(
  trigger: TriggerDefinition,
  side: Side,
  event: TriggerCandidateEvent,
  units: readonly BattleUnit[],
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
  resolutionPhase: ResolutionPhase | undefined,
  turnNumber: number | undefined,
): boolean {
  if (
    !matchesTriggerEventType(trigger.eventType, event.eventType) ||
    trigger.category !== event.category
  ) {
    return false;
  }
  if (!evaluateMemorySourceSelector(trigger.sourceSelector, side, event, unitsById)) {
    return false;
  }
  if (!evaluateMemoryTargetSelector(trigger.targetSelector, side, event, unitsById)) {
    return false;
  }
  return evaluateTriggerCondition(trigger.condition, event, {
    // R-MEM-04: Memoryは所有ユニットを持たないため、相対陣営の基準だけを渡す。
    ownerSide: side,
    getUnit: (id) => unitsById.get(id),
    units,
    ...(resolutionPhase !== undefined ? { resolutionPhase } : {}),
    ...(turnNumber !== undefined ? { turnNumber } : {}),
  });
}

/**
 * R-MEM-01「triggeredEffects 候補化」:
 *
 * 1. Battle Engineが発行したドメインイベント（`event`）を、
 * 2. 編成に指定された Memory の `triggeredEffects` へAPI指定順に走査し、
 * 3. `TriggerDefinition.eventType`/`category`/selector と `ConditionDefinition` を評価し、
 * 4. 条件を満たしたものを同じイベントのMemory候補グループにする。
 *
 * PS（`detectPassiveCandidates`）と異なり、PP・クールタイム・先制攻撃・
 * 1解決スコープ1回制限を持たないため、発動済み集合（`PassiveActivationGuard`）を
 * 引数に取らない。返り値は既にR-MEM-02順（陣営→API指定順→同一Memory内定義順）で
 * 並んでいる。
 */
export function detectMemoryCandidates(input: MemoryTriggerMatchInput): MemoryCandidateGroup {
  const { event, units, memoriesBySide, resolutionPhase, turnNumber } = input;
  const unitsById: ReadonlyMap<BattleUnitId, BattleUnit> = new Map(
    units.map((unit) => [unit.battleUnitId, unit] as const),
  );
  const candidates: MemoryCandidate[] = [];

  for (const side of MEMORY_SIDE_ORDER) {
    // R-MEM-02 #1: 配列の並びがそのままAPI指定順であり、ここで並べ替えない。
    memoriesBySide[side].forEach((memory, memoryIndex) => {
      // R-MEM-02 #2: 同一Memory内は`triggeredEffects`の定義順。
      memory.triggeredEffects.forEach((triggeredEffect, triggeredEffectIndex) => {
        if (
          !matchesMemoryTriggerWith(
            triggeredEffect.trigger,
            side,
            event,
            units,
            unitsById,
            resolutionPhase,
            turnNumber,
          )
        ) {
          return;
        }
        candidates.push({
          side,
          memoryDefinitionId: memory.memoryDefinitionId,
          memoryIndex,
          triggeredEffectIndex,
          triggeredEffect,
        });
      });
    });
  }

  return candidates;
}
