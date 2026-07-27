import type { BattleUnit } from "../model/battle-unit.js";
import { applyOneHeal, type HealEventContext } from "./heal-application-service.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DomainEventId } from "../../shared/event-ids.js";

/**
 * R-HEAL-03（M7-005、Issue #184）が実装対象とする`APPLY_CONTINUOUS_HEAL`の
 * `timing`。production Catalogの継続回復13件はすべてこの組み合わせだけを使う
 * （「2行動の間、行動時に最大HP×10%分のHPが回復する」）。それ以外の組み合わせは
 * `catalog-integrity.ts`がCatalogロード時点で拒否するため、この関数は到達しない。
 */
export const SUPPORTED_CONTINUOUS_HEAL_TIMING = {
  eventType: "ActionStarted",
  targetSelector: "EFFECT_OWNER",
} as const;

export interface FireContinuousHealsResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-HEAL-03 継続回復（M7-005、Issue #184）: 保持者の`ActionStarted`を契機に、
 * その保持者が持つ`APPLY_CONTINUOUS_HEAL`由来の`AppliedEffect`を定義順（付与順）に
 * 発火させ、R-HEAL-01と同じ手順（`applyOneHeal`）で回復する。
 *
 * 回復量Formulaは付与時点の`magnitude`スナップショットではなく発火のたびに
 * 評価し直す — production定義の`MAX_HP_RATIO`/`MISSING_HP_RATIO`は発火時点の
 * 対象HPを参照する必要があり、`SKILL_POWER`も回復元の現在の攻撃力を基礎にする
 * （R-HEAL-03「`R-HEAL-01`と同じ手順で回復する」）。
 *
 * `sourceUnitId`（回復元）はその`AppliedEffect`の付与者とし、`SKILL_POWER`が
 * 参照する攻撃力もこの付与者から引く。付与者が盤面から引けない場合（防御的
 * fallback、現行モデルでは戦闘不能ユニットも配列に残るため通常起きない）は
 * 保持者自身を回復元として扱う。
 *
 * Durationの減算・失効はR-EFF-01/04の共通ライフサイクル
 * （`duration-expiry-service.ts`）が扱い、この関数は関与しない。
 */
export function fireContinuousHealsOnActionStart(
  units: readonly BattleUnit[],
  ownerId: BattleUnitId,
  context: Omit<HealEventContext, "parentEventId" | "sourceUnitId">,
  parentEventId: DomainEventId,
  onFactEvent?: (event: BattleDomainEvent, units: readonly BattleUnit[]) => readonly BattleUnit[],
): FireContinuousHealsResult {
  let working = units;
  let lastEventId = parentEventId;

  const owner = working.find((u) => u.battleUnitId === ownerId);
  if (owner === undefined) {
    return { units: working, lastEventId };
  }

  // 発火中の連鎖で保持者のappliedEffectsが変化しうるため、発火対象は
  // 開始時点のインスタンスID列で固定する（R-TGT-10と同じ「定義順評価」規約）。
  const firingInstanceIds = owner.appliedEffects
    .filter((effect) => {
      const definition = context.effectActions.get(effect.effectActionDefinitionId);
      return (
        definition !== undefined &&
        definition.kind === "APPLY_CONTINUOUS_HEAL" &&
        definition.payload.timing.eventType === SUPPORTED_CONTINUOUS_HEAL_TIMING.eventType &&
        definition.payload.timing.targetSelector === SUPPORTED_CONTINUOUS_HEAL_TIMING.targetSelector
      );
    })
    .map((effect) => effect.effectInstanceId);

  for (const effectInstanceId of firingInstanceIds) {
    const currentOwner = working.find((u) => u.battleUnitId === ownerId);
    if (currentOwner === undefined) {
      break;
    }
    // 連鎖の途中でこのインスタンスが失効・除去された場合は発火しない。
    const effect = currentOwner.appliedEffects.find(
      (candidate) => candidate.effectInstanceId === effectInstanceId,
    );
    if (effect === undefined) {
      continue;
    }
    const definition = context.effectActions.get(effect.effectActionDefinitionId);
    if (definition === undefined || definition.kind !== "APPLY_CONTINUOUS_HEAL") {
      continue;
    }
    const healer = working.find((u) => u.battleUnitId === effect.sourceId) ?? currentOwner;

    const applied = applyOneHeal(
      {
        effectActionDefinitionId: effect.effectActionDefinitionId,
        formula: definition.payload.formula,
      },
      healer,
      currentOwner,
      working,
      { ...context, parentEventId: lastEventId, sourceUnitId: effect.sourceId },
      lastEventId,
    );
    if (applied === undefined) {
      continue;
    }
    working = applied.units;
    lastEventId = applied.lastEventId;
    if (onFactEvent !== undefined) {
      working = onFactEvent(applied.healApplied, working);
    }
  }

  return { units: working, lastEventId };
}
