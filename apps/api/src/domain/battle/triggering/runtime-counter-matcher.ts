import type {
  RuntimeCounterId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  applyCumulativeDamageThreshold,
  incrementRuntimeCounter,
  type RuntimeCounterMap,
} from "../model/runtime-counter-state.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export interface RuntimeCounterUpdateResult {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
  /** `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（更新後、`INCREMENT`では常に0）。観測用。 */
  readonly carry: number;
  /** この更新の直前の繰り越し端数（`carry`との差分でcarry自体の変化を判定する）。 */
  readonly carryBefore: number;
  /**
   * `before !== after`（公開値が実際に変化した＝閾値を跨いだ）かどうか。
   * レビュー再々レビュー[P1]: `RuntimeCounterChanged`はcarryのみの変化でも
   * 発行するため（追跡性のため）、閾値到達時だけ発動すべきPS
   * （`CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`）はこのフィールドで絞り込む
   * 契約とする（Catalog側の条件は`docs/ddd/14_Catalog定義スキーマ.md`参照）。
   */
  readonly valueChanged: boolean;
}

export interface RuntimeCounterMatchInput {
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
}

function matchesUpdateTrigger(
  update: RuntimeCounterUpdateDefinition,
  owner: BattleUnit,
  skillDefinitionId: SkillDefinitionId,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  const trigger = update.trigger;
  return (
    trigger.eventType === event.eventType &&
    trigger.category === event.category &&
    evaluateSourceSelector(trigger.sourceSelector, owner, event, unitsById) &&
    evaluateTargetSelector(trigger.targetSelector, owner, event, unitsById) &&
    evaluateTriggerCondition(trigger.condition, event, { owner, skillDefinitionId })
  );
}

function readNumberPayloadField(event: TriggerCandidateEvent, field: string): number {
  const value = event.payload[field];
  if (typeof value !== "number") {
    throw new DomainValidationError(
      "event.payload",
      `CUMULATIVE_DAMAGE_THRESHOLD requires a numeric "${field}" field on eventType "${event.eventType}", got ${typeof value}`,
    );
  }
  return value;
}

function applyUpdate(
  update: RuntimeCounterUpdateDefinition,
  counters: RuntimeCounterMap,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
): {
  readonly counters: RuntimeCounterMap;
  readonly before: number;
  readonly after: number;
  readonly carry: number;
} {
  if (update.kind === "INCREMENT") {
    const result = incrementRuntimeCounter(counters, update.counter, update.amount);
    return {
      counters: result.counters,
      before: result.change.before,
      after: result.change.after,
      carry: 0,
    };
  }
  const damageAmount = readNumberPayloadField(event, "hitPointDamage");
  const result = applyCumulativeDamageThreshold(
    counters,
    update.counter,
    damageAmount,
    owner.combatStats.maximumHp,
    update.maxHpRatio,
  );
  return {
    counters: result.counters,
    before: result.change.before,
    after: result.change.after,
    carry: result.counters[update.counter]?.carry ?? 0,
  };
}

/**
 * `R-EFF-11`/`08_ドメインイベント.md`「イベント発行と処理」#3: 対象イベントに
 * 対応する`counterUpdates`（M6最小実装、`SKILL_RUNTIME`スコープ、Issue #143）を
 * 検出し、決定的に更新する。呼び出し側はPS/Memory候補抽出より前に呼び出し、
 * 変化があった件数分だけ`RuntimeCounterChanged`を発行する。
 *
 * `Battle`／`BattleUnit`スコープは`createRuntimeCounterUpdateDefinition`
 * （Catalogロード時点）が既に拒否するため、ここへ到達するのは`SKILL_RUNTIME`
 * だけのはずである。それでも到達した場合（Catalogを経由しない直接構築など）に
 * 未対応のまま実行を続けないよう、防御的にも明示的に拒否する（レビュー指摘[P2]）。
 */
export function detectRuntimeCounterUpdates(input: RuntimeCounterMatchInput): {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly RuntimeCounterUpdateResult[];
} {
  const { event, unitDefinitions, skillDefinitions } = input;
  const unitsById = new Map(input.units.map((u) => [u.battleUnitId, u] as const));
  const changes: RuntimeCounterUpdateResult[] = [];
  let workingUnits = input.units;

  for (const originalOwner of input.units) {
    if (isDefeated(originalOwner)) {
      continue;
    }
    const unitDefinition = unitDefinitions.get(originalOwner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${originalOwner.unitDefinitionId}" (battleUnitId "${originalOwner.battleUnitId}")`,
      );
    }
    for (const skillId of unitDefinition.passiveSkillDefinitionIds) {
      const skill = skillDefinitions.get(skillId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillId}"`,
        );
      }
      for (const update of skill.counterUpdates) {
        if (update.scope !== "SKILL_RUNTIME") {
          throw new DomainValidationError(
            "counterUpdates.scope",
            `scope "${update.scope}" is not supported yet (Issue #143 only implements SKILL_RUNTIME scope)`,
          );
        }
        if (!matchesUpdateTrigger(update, originalOwner, skillId, event, unitsById)) {
          continue;
        }
        const currentOwner = workingUnits.find(
          (u) => u.battleUnitId === originalOwner.battleUnitId,
        );
        if (currentOwner === undefined) {
          throw new DomainValidationError(
            "units",
            `battleUnitId "${originalOwner.battleUnitId}" disappeared while applying counterUpdates`,
          );
        }
        const existingCounters = currentOwner.skillCounters?.[skillId] ?? {};
        const carryBefore = existingCounters[update.counter]?.carry ?? 0;
        const applied = applyUpdate(update, existingCounters, currentOwner, event);
        // レビュー指摘[P1]: 閾値未到達（value不変）でも`applied.counters`の`carry`
        // （繰り越し端数）は必ず`workingUnits`へ反映する。ここで`continue`すると
        // 次回の更新が繰り越し前のcarryから再計算され、複数回に分けて閾値へ
        // 到達する累計ダメージが正しく積み上がらない。
        const updatedOwner: BattleUnit = {
          ...currentOwner,
          skillCounters: { ...currentOwner.skillCounters, [skillId]: applied.counters },
        };
        workingUnits = workingUnits.map((u) =>
          u.battleUnitId === updatedOwner.battleUnitId ? updatedOwner : u,
        );
        // レビュー指摘[P2]: `value`(公開値)が変わらなくても`carry`(内部端数)が
        // 変化した場合は`RuntimeCounterChanged`を発行する。ここで完全に
        // skipすると、可変状態(carry)が変化したこと自体がイベント列から
        // 追跡できなくなる（対象3スキルでは閾値未到達ヒットの方が通常経路）。
        // `valueChanged`をpayloadへ含めるのは、この関数の呼び出し側
        // （Catalog側の閾値到達PS）が「carryだけの変化」と「実際の閾値到達」を
        // 区別できるようにするため（レビュー再々レビュー[P1]）。
        const valueChanged = applied.before !== applied.after;
        if (!valueChanged && applied.carry === carryBefore) {
          continue;
        }
        changes.push({
          ownerUnitId: originalOwner.battleUnitId,
          skillDefinitionId: skillId,
          counter: update.counter,
          before: applied.before,
          after: applied.after,
          carry: applied.carry,
          carryBefore,
          valueChanged,
        });
      }
    }
  }

  return { units: workingUnits, changes };
}

export interface RuntimeCounterResetTarget {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
}

export interface RuntimeCounterResetScanInput {
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
}

/**
 * `R-EFF-11`「解決スコープ終了時にリセットするcounter」（レビュー指摘[P2]、
 * Issue #143）: `resetScope: "RESOLUTION_SCOPE"`を宣言するcounterのうち、現在値を
 * 持つものを列挙する。呼び出し側（`PassiveActivationRuntime.finalizeResolutionScope`）
 * が、この結果を使ってcounterを破棄し`RuntimeCounterReset`を発行する。
 */
export function collectResolutionScopeResets(
  input: RuntimeCounterResetScanInput,
): readonly RuntimeCounterResetTarget[] {
  const { units, unitDefinitions, skillDefinitions } = input;
  const targets: RuntimeCounterResetTarget[] = [];

  for (const owner of units) {
    const unitDefinition = unitDefinitions.get(owner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${owner.unitDefinitionId}" (battleUnitId "${owner.battleUnitId}")`,
      );
    }
    for (const skillId of unitDefinition.passiveSkillDefinitionIds) {
      const skill = skillDefinitions.get(skillId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillId}"`,
        );
      }
      for (const update of skill.counterUpdates) {
        if (update.resetScope !== "RESOLUTION_SCOPE") {
          continue;
        }
        if (owner.skillCounters?.[skillId]?.[update.counter] === undefined) {
          continue;
        }
        targets.push({
          ownerUnitId: owner.battleUnitId,
          skillDefinitionId: skillId,
          counter: update.counter,
        });
      }
    }
  }

  return targets;
}
