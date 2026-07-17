import type { BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";
import {
  createEmptyPassiveActivationGuard,
  recordActivation,
  type PassiveActivationGuard,
} from "./passive-activation-guard.js";
import type {
  PassiveChainLimits,
  PassiveChainLimitViolationReason,
} from "./passive-chain-limits.js";
import { checkEffectsResolvedCount, checkPassiveDepth } from "./passive-chain-limits.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import {
  createEmptyPassiveResolutionStack,
  depthOf,
  peekTop,
  popTop,
  pushCandidateGroups,
  withTopCandidates,
  type PassiveResolutionStackEntry,
} from "./passive-resolution-stack.js";
import { applySimultaneousActivationLimit } from "./passive-simultaneous-activation-limit.js";
import { reconfirmPassiveCandidate } from "./reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/** 1件のPS発動処理（PP消費・EffectSequence解決など、#34/#73が実装）の結果。 */
export interface PassiveActivationOutcome {
  /** この発動中に発生したドメインイベント。発生順で渡す（R-PS-06の即時解決対象）。 */
  readonly generatedEvents: readonly TriggerCandidateEvent[];
  /** R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」がこのPS自身の
   * EffectSequenceに適用され、中断したかどうか。中断してもチェーン全体は継続する
   * （Skill中断接続: 呼び出し側が`PassiveInterrupted`等へ変換できるよう、中断した
   * candidateを結果へ集約するだけに留める）。 */
  readonly interrupted: boolean;
}

export type DetectPassiveCandidates = (event: TriggerCandidateEvent) => PassiveCandidateGroup;
export type GetCurrentBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit;
export type ActivatePassiveCandidate = (
  candidate: PassiveCandidate,
  event: TriggerCandidateEvent,
) => PassiveActivationOutcome;

export interface PassiveChainDependencies {
  /** 呼び出し側が`detectPassiveCandidates`（#19）等具体的な検出処理を閉じ込める。
   * 返り値はR-PS-02/R-PS-08順にソート済みであることを期待する（`sortPassiveCandidates`
   * の契約と同じ）。同時発動制限（R-PS-03）は本関数が適用するため、呼び出し側では
   * 適用不要。 */
  readonly detectCandidates: DetectPassiveCandidates;
  readonly getCurrentUnit: GetCurrentBattleUnit;
  readonly activate: ActivatePassiveCandidate;
  readonly limits: PassiveChainLimits;
}

export type PassiveChainResult =
  | {
      readonly ok: true;
      readonly activationGuard: PassiveActivationGuard;
      readonly interruptedCandidates: readonly PassiveCandidate[];
    }
  | {
      readonly ok: false;
      readonly reason: PassiveChainLimitViolationReason;
    };

function detectLimitedCandidates(
  event: TriggerCandidateEvent,
  deps: PassiveChainDependencies,
): PassiveCandidateGroup {
  return applySimultaneousActivationLimit(deps.detectCandidates(event)).kept;
}

/**
 * `05_ドメインモデル.md`「PassiveCandidateStack」（本Issueでは「PassiveResolutionStack」）
 * が表す、PS即時連鎖の解決アルゴリズム本体。
 *
 * - R-PS-03: 各候補グループ検出直後に`applySimultaneousActivationLimit`で1件へ絞る。
 * - R-PS-04: 候補を処理する直前に必ず`reconfirmPassiveCandidate`で再確認する。
 *   ネストした解決から親グループへ戻った直後の次候補も同じ経路を通るため、
 *   「TIMINGイベント後に親処理の前提を再検証する」不変条件を満たす。
 * - R-PS-05 #1 / R-PS-07: 発動直前に`recordActivation`でguardへ記録し、再入を防ぐ。
 * - R-PS-06: 発動が生成したイベントを`detectLimitedCandidates`で即座に候補化し、
 *   スタックの先頭へ積んでから元のグループへ戻る。
 * - PS深度・効果解決数のGuard超過は構造化された`{ ok: false, reason }`で停止する。
 */
export function resolvePassiveChain(
  initialEvent: TriggerCandidateEvent,
  initialGuard: PassiveActivationGuard = createEmptyPassiveActivationGuard(),
  deps: PassiveChainDependencies,
): PassiveChainResult {
  let guard = initialGuard;
  let stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
    { event: initialEvent, candidates: detectLimitedCandidates(initialEvent, deps) },
  ]);
  let effectsResolved = 0;
  const interruptedCandidates: PassiveCandidate[] = [];

  while (depthOf(stack) > 0) {
    const depthCheck = checkPassiveDepth(depthOf(stack), deps.limits);
    if (!depthCheck.ok) {
      return { ok: false, reason: depthCheck.reason };
    }

    const top: PassiveResolutionStackEntry | undefined = peekTop(stack);
    if (top === undefined) {
      break;
    }
    const [next, ...restCandidates] = top.candidates;
    if (next === undefined) {
      stack = popTop(stack);
      continue;
    }
    stack = withTopCandidates(stack, restCandidates);

    const currentUnit = deps.getCurrentUnit(next.unit.battleUnitId);
    const reconfirmation = reconfirmPassiveCandidate(next, currentUnit, top.event, guard);
    if (!reconfirmation.ok) {
      continue;
    }

    effectsResolved += 1;
    const effectsCheck = checkEffectsResolvedCount(effectsResolved, deps.limits);
    if (!effectsCheck.ok) {
      return { ok: false, reason: effectsCheck.reason };
    }

    guard = recordActivation(
      guard,
      currentUnit.battleUnitId,
      next.skillDefinition.skillDefinitionId,
    );

    const activatedCandidate: PassiveCandidate = { ...next, unit: currentUnit };
    const outcome = deps.activate(activatedCandidate, top.event);
    if (outcome.interrupted) {
      interruptedCandidates.push(activatedCandidate);
    }

    if (outcome.generatedEvents.length > 0) {
      const followUps = outcome.generatedEvents
        .map((generatedEvent) => ({
          event: generatedEvent,
          candidates: detectLimitedCandidates(generatedEvent, deps),
        }))
        .filter((entry) => entry.candidates.length > 0);
      if (followUps.length > 0) {
        stack = pushCandidateGroups(stack, followUps);
      }
    }
  }

  return { ok: true, activationGuard: guard, interruptedCandidates };
}
