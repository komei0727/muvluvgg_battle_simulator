import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { SkillUseId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { applyUpdate } from "./runtime-counter-matcher.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/**
 * `R-EFF-11`「`EffectSequence`スコープ」（EFF-006/Issue #212）: `EffectSequence`
 * 自身は状態を持たないため、`AppliedEffect`スコープ（`units[].appliedEffects[]`）や
 * `SkillRuntime`スコープ（`SkillDefinition.counterUpdates`）と異なり、`units`だけ
 * からcounterUpdates定義を再発見できない。呼び出し側（`PassiveActivationRuntime`）
 * が「現在進行中の解決」を`SkillUseId`ごとに登録した一時レジストリを渡す。
 */
export interface ActiveEffectSequenceResolution {
  readonly actorId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counterUpdates: readonly RuntimeCounterUpdateDefinition[];
}

export interface EffectSequenceRuntimeCounterUpdateResult {
  readonly actorId: BattleUnitId;
  readonly skillUseId: SkillUseId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
  readonly carry: number;
  readonly carryBefore: number;
  readonly valueChanged: boolean;
}

/** `matchEffectSequenceRuntimeCounterUpdates`が1件マッチしたとして報告する、更新前の組。 */
export interface MatchedEffectSequenceRuntimeCounterUpdate {
  readonly skillUseId: SkillUseId;
  readonly actorId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly update: RuntimeCounterUpdateDefinition;
}

/**
 * `runtime-counter-effect-matcher.ts`の`matchEffectRuntimeCounterUpdates`
 * （`APPLIED_EFFECT`スコープ）と同じ「マッチングだけを行い、値は適用しない」
 * 決定論的な列挙だが、対象は`units`ではなく`activeResolutions`（呼び出し側が
 * 維持する現在進行中のEffectSequence解決の集合）を`SkillUseId`の登録順に辿る。
 * `owner`（`sourceSelector`/`targetSelector`のSELF、`RUNTIME_COUNTER`条件が読む
 * counter map）はその解決のactorとする。actorが戦闘不能または`units`から消えて
 * いる場合はスキップする（解決自体は`PassiveActivationRuntime`が別途終了させる）。
 */
export function matchEffectSequenceRuntimeCounterUpdates(
  activeResolutions: ReadonlyMap<SkillUseId, ActiveEffectSequenceResolution>,
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): readonly MatchedEffectSequenceRuntimeCounterUpdate[] {
  const unitsById = new Map(units.map((u) => [u.battleUnitId, u] as const));
  const matched: MatchedEffectSequenceRuntimeCounterUpdate[] = [];

  for (const [skillUseId, resolution] of activeResolutions) {
    const actor = unitsById.get(resolution.actorId);
    if (actor === undefined || isDefeated(actor)) {
      continue;
    }
    for (const update of resolution.counterUpdates) {
      if (update.scope !== "EFFECT_SEQUENCE") {
        throw new DomainValidationError(
          "counterUpdates.scope",
          `scope "${update.scope}" is not supported here (EffectSequence.counterUpdates only supports EFFECT_SEQUENCE scope, EFF-006/Issue #212)`,
        );
      }
      const trigger = update.trigger;
      const matches =
        trigger.eventType === event.eventType &&
        trigger.category === event.category &&
        evaluateSourceSelector(trigger.sourceSelector, actor, event, unitsById) &&
        evaluateTargetSelector(trigger.targetSelector, actor, event, unitsById) &&
        evaluateTriggerCondition(trigger.condition, event, {
          owner: actor,
          effectCounters: actor.effectSequenceCounters?.[skillUseId] ?? {},
        });
      if (!matches) {
        continue;
      }
      matched.push({
        skillUseId,
        actorId: resolution.actorId,
        skillDefinitionId: resolution.skillDefinitionId,
        update,
      });
    }
  }

  return matched;
}

/**
 * `matchEffectSequenceRuntimeCounterUpdates`が確定した1件を、呼び出し時点の`units`
 * （先行`RuntimeCounterChanged`の候補解決を経た最新状態でありうる）に対して適用する。
 * actorが同じバッチの先行ステップで既に戦闘不能等でユニットとして消えている
 * 異常系は`runtime-counter-matcher.ts`の`applyMatchedRuntimeCounterUpdate`と同じく
 * 例外にする（`EffectSequence`のactorはユニットが消えることはない前提のため、
 * `applyMatchedEffectRuntimeCounterUpdate`の「効果インスタンス消失はno-op」とは
 * 異なる）。
 */
export function applyMatchedEffectSequenceRuntimeCounterUpdate(
  matched: MatchedEffectSequenceRuntimeCounterUpdate,
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): {
  readonly units: readonly BattleUnit[];
  readonly change: EffectSequenceRuntimeCounterUpdateResult | undefined;
} {
  const actor = units.find((u) => u.battleUnitId === matched.actorId);
  if (actor === undefined) {
    throw new DomainValidationError(
      "units",
      `battleUnitId "${matched.actorId}" disappeared while applying EffectSequence counterUpdates`,
    );
  }
  const { skillUseId, update } = matched;
  const existingCounters = actor.effectSequenceCounters?.[skillUseId] ?? {};
  const carryBefore = existingCounters[update.counter]?.carry ?? 0;
  const applied = applyUpdate(update, existingCounters, actor, event);

  const updatedActor: BattleUnit = {
    ...actor,
    effectSequenceCounters: { ...actor.effectSequenceCounters, [skillUseId]: applied.counters },
  };
  const nextUnits = units.map((u) =>
    u.battleUnitId === updatedActor.battleUnitId ? updatedActor : u,
  );

  const valueChanged = applied.before !== applied.after;
  if (!valueChanged && applied.carry === carryBefore) {
    return { units: nextUnits, change: undefined };
  }
  return {
    units: nextUnits,
    change: {
      actorId: matched.actorId,
      skillUseId,
      skillDefinitionId: matched.skillDefinitionId,
      counter: update.counter,
      before: applied.before,
      after: applied.after,
      carry: applied.carry,
      carryBefore,
      valueChanged,
    },
  };
}
