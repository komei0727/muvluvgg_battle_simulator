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
} from "./passive-resolution-stack.js";
import { applySimultaneousActivationLimit } from "./passive-simultaneous-activation-limit.js";
import { reconfirmPassiveCandidate } from "./reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

/** 1件のPS発動処理が完了した時点の結果。 */
export interface PassiveActivationCompletion {
  /** R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」がこのPS自身の
   * EffectSequenceに適用され、中断したかどうか。中断してもチェーン全体は継続する
   * （Skill中断接続: 呼び出し側が`PassiveInterrupted`等へ変換できるよう、中断した
   * candidateを結果へ集約するだけに留める）。 */
  readonly interrupted: boolean;
}

/**
 * PSの発動処理（PP消費・EffectSequence解決など、#34/#73が実装）は、1つの
 * EffectAction/EffectStepを解決するたびにそこで発生したドメインイベントを
 * `yield`するジェネレータとして提供される。R-SKL-01系「1つのEffectAction適用後に
 * 発生したイベントからPSまたはMemory triggeredEffectsが候補になった場合、直ちに
 * 解決してから次のactionへ進む」を満たすため、`resolvePassiveChain`は`yield`の
 * たびにそのイベントの候補連鎖を完全に解決してから`.next()`で再開する。つまり
 * 親のEffectSequenceは、そこから生じた子PS連鎖の解決が終わるまで次のstepへ
 * 進まない。全stepを解決し終えたら`return`で`PassiveActivationCompletion`を返す。
 *
 * `resolvePassiveChain`が実際に呼び出すのは`next()`だけなので、標準の`Generator`
 * 全体ではなく、この最小限のプル型イテレータ形状だけを契約とする。`function*`で
 * 実装したジェネレータはそのままこの形へ構造的に適合する。
 */
export interface PassiveActivation {
  next(): IteratorResult<TriggerCandidateEvent, PassiveActivationCompletion>;
}

export type DetectPassiveCandidates = (event: TriggerCandidateEvent) => PassiveCandidateGroup;
export type GetCurrentBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit;
export type ActivatePassiveCandidate = (
  candidate: PassiveCandidate,
  event: TriggerCandidateEvent,
) => PassiveActivation;

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
 * - R-PS-06: `activate`が`yield`するたびに、そのイベントの候補連鎖をスタック先頭に
 *   積んで完全に解決してから、`yield`元のジェネレータを`.next()`で再開する。これにより
 *   「親の効果A→子PS→親の効果B」の順序（子PSが親の残り効果より先に解決される）を
 *   実際のEffectSequence解決と同じ粒度で保証する。
 * - 効果解決数Guardは`activate`の`yield`ごとに1件としてスコープ全体で累積カウントする
 *   （1件のPSが多数のEffectStepを解決しても、その数だけカウントされる）。
 *
 * イベント因果関係について: `TriggerCandidateEvent`は照合専用の最小形であり、
 * `DomainEventId`・`sequence`・`parentEventId`・`rootEventId`を持たない
 * （`trigger-event.ts`参照）。それらの採番は`EventRecorder`（`battle/events`）の
 * 責務であり、実際のEffectSequence解決からイベントを発行する#73が配線する。
 * 本関数が保証するのは、どのイベントを「直近の原因」として各階層の
 * `reconfirmPassiveCandidate`/`activate`へ渡すか（ネストした候補には常に
 * それを生んだ具体的なイベントを渡し、rootイベントへ遡らせない）という
 * 呼び出しの原因追跡だけである。#73が`EventRecorder.record`へ`parentEventId`を
 * 渡す際は、その階層で本関数が渡したイベントの`eventId`を使えばよい。
 */
export function resolvePassiveChain(
  initialEvent: TriggerCandidateEvent,
  initialGuard: PassiveActivationGuard = createEmptyPassiveActivationGuard(),
  deps: PassiveChainDependencies,
): PassiveChainResult {
  let guard = initialGuard;
  let effectsResolved = 0;
  const interruptedCandidates: PassiveCandidate[] = [];
  const resumptions = new Map<
    number,
    { readonly candidate: PassiveCandidate; readonly generator: PassiveActivation }
  >();

  let stack = pushCandidateGroups(createEmptyPassiveResolutionStack(), [
    { event: initialEvent, candidates: detectLimitedCandidates(initialEvent, deps) },
  ]);

  /**
   * `generator`を、次の`yield`（候補が1件以上検出できるものに限る）か`return`まで
   * 駆動する。`yield`ごとに効果解決数Guardをインクリメント・判定する。
   */
  function advanceGenerator(
    candidate: PassiveCandidate,
    generator: PassiveActivation,
  ): PassiveChainLimitViolationReason | undefined {
    while (true) {
      const step = generator.next();
      if (step.done) {
        if (step.value.interrupted) {
          interruptedCandidates.push(candidate);
        }
        return undefined;
      }

      effectsResolved += 1;
      const effectsCheck = checkEffectsResolvedCount(effectsResolved, deps.limits);
      if (!effectsCheck.ok) {
        return effectsCheck.reason;
      }

      const candidates = detectLimitedCandidates(step.value, deps);
      if (candidates.length === 0) {
        continue;
      }

      const barrierDepth = depthOf(stack);
      stack = pushCandidateGroups(stack, [{ event: step.value, candidates }]);
      const depthCheck = checkPassiveDepth(depthOf(stack), deps.limits);
      if (!depthCheck.ok) {
        return depthCheck.reason;
      }
      resumptions.set(barrierDepth, { candidate, generator });
      return undefined;
    }
  }

  const initialDepthCheck = checkPassiveDepth(depthOf(stack), deps.limits);
  if (!initialDepthCheck.ok) {
    return { ok: false, reason: initialDepthCheck.reason };
  }

  while (depthOf(stack) > 0) {
    const top = peekTop(stack);
    if (top === undefined) {
      break;
    }
    const [next, ...restCandidates] = top.candidates;
    if (next === undefined) {
      stack = popTop(stack);
      const newDepth = depthOf(stack);
      const resumption = resumptions.get(newDepth);
      if (resumption !== undefined) {
        resumptions.delete(newDepth);
        const violation = advanceGenerator(resumption.candidate, resumption.generator);
        if (violation !== undefined) {
          return { ok: false, reason: violation };
        }
      }
      continue;
    }
    stack = withTopCandidates(stack, restCandidates);

    const currentUnit = deps.getCurrentUnit(next.unit.battleUnitId);
    const reconfirmation = reconfirmPassiveCandidate(next, currentUnit, top.event, guard);
    if (!reconfirmation.ok) {
      continue;
    }

    guard = recordActivation(
      guard,
      currentUnit.battleUnitId,
      next.skillDefinition.skillDefinitionId,
    );

    const activatedCandidate: PassiveCandidate = { ...next, unit: currentUnit };
    const generator = deps.activate(activatedCandidate, top.event);
    const violation = advanceGenerator(activatedCandidate, generator);
    if (violation !== undefined) {
      return { ok: false, reason: violation };
    }
  }

  return { ok: true, activationGuard: guard, interruptedCandidates };
}
