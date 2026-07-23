import type { BattleUnit } from "../model/battle-unit.js";
import type { ResolutionPhase } from "../../catalog/definitions/condition-definition.js";
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
import {
  checkEffectRuntimeCounterDepth,
  checkEffectsResolvedCount,
  checkPassiveDepth,
} from "./passive-chain-limits.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import {
  createEmptyPassiveResolutionStack,
  depthOf,
  peekTop,
  popTop,
  pushCandidateGroups,
  withTopCandidates,
  type PassiveResolutionStack,
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
 * PSの発動処理（#34/#73が実装）が`resolvePassiveChain`へ差し出す、1件分の途中
 * 経過。2種類ある。
 *
 * - `TIMING_EVENT`: `EffectActionStarting`・`UnitBeingAttacked`・
 *   `DamageWillBeApplied`のような、EffectActionが実際に解決する前に発行される
 *   TIMINGイベント（`08_ドメインイベント.md`のイベント分類）。まだ効果は解決して
 *   いない（PSの反応でEffectAction自体が中断・再計算されうる）ため、効果解決数
 *   Guardをカウントしない。`resolvePassiveChain`はイベントを即座に候補解決し、
 *   `.next()`で再開する。
 * - `EFFECT_RESOLVED`: 1つのEffectAction/EffectStepの解決完了と、それが発行した
 *   事後ドメインイベント（`events`、0件以上、発生順、`DamageCalculated`・
 *   `DamageApplied`のようなFACTイベント）をまとめて報告する。効果解決数Guardは、
 *   この`yield`を受け取った時点で直ちに1件としてカウントする — `events`が
 *   新たなPS候補を誘発し、その連鎖をどれだけ深く即時解決することになっても、
 *   このカウントは連鎖の深さに影響されない。
 *
 * 「効果解決」と「その効果が発行した事後イベント」を`EFFECT_RESOLVED`という
 * 1つの`yield`へまとめるのは、もし「イベントを`yield`した後、別の`yield`で
 * 効果解決を報告する」という2段階の契約にすると、最初の`yield`が誘発した子PS
 * 連鎖を解決している間は後段の`yield`へ決して到達できず（子PSもまた同じ
 * パターンで自分の子を誘発し続けるため）、再帰的なPS連鎖では効果解決数Guardが
 * 実質的に機能しなくなるため。`TIMING_EVENT`はこの問題を再発させない —
 * TIMINGイベントに反応したPS自身の効果は、それ自身の`EFFECT_RESOLVED`で
 * カウントされる（未解決のTIMINGイベントの連鎖という形でカウントを回避する
 * ことはできない。カウントされるのは常に「実際に解決した効果」の数）。
 */
export type PassiveActivationStep =
  | { readonly kind: "TIMING_EVENT"; readonly event: TriggerCandidateEvent }
  | { readonly kind: "EFFECT_RESOLVED"; readonly events: readonly TriggerCandidateEvent[] };

/**
 * PSの発動処理は、上記`PassiveActivationStep`を`yield`するジェネレータとして
 * 提供される。`resolvePassiveChain`は`yield`のたびに効果解決数Guardを確認した
 * 直後、その`events`それぞれについて誘発された候補連鎖を（発生順に）完全に
 * 解決してから`.next()`で再開する。つまり親のEffectSequenceは、そこから生じた
 * 子PS連鎖の解決が終わるまで次のstepへ進まない（R-PS-06「親の効果A→子PS→親の
 * 効果B」）。全stepを解決し終えたら`return`で`PassiveActivationCompletion`を返す。
 *
 * `resolvePassiveChain`が実際に呼び出すのは`next()`だけなので、標準の`Generator`
 * 全体ではなく、この最小限のプル型イテレータ形状だけを契約とする。`function*`で
 * 実装したジェネレータはそのままこの形へ構造的に適合する。
 */
export interface PassiveActivation {
  next(): IteratorResult<PassiveActivationStep, PassiveActivationCompletion>;
}

export type DetectPassiveCandidates = (event: TriggerCandidateEvent) => PassiveCandidateGroup;
export type GetCurrentBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit;
/**
 * `POSITION_RELATION`（Issue #144）の対象解決専用の安全なlookup。
 * `GetCurrentBattleUnit`（`getCurrentUnit`、本番実装は`requireUnit`）は未知の
 * `BattleUnitId`に対して例外を送出する契約だが、R-PS-01/Issue #144は「対象不在」を
 * 条件不成立として決定的に候補破棄する契約（`evaluateTriggerCondition`の
 * `POSITION_RELATION`分岐参照）のため、両者を混用してはならない
 * （レビュー指摘[P2]）。
 */
export type FindBattleUnit = (battleUnitId: BattleUnitId) => BattleUnit | undefined;
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
  /**
   * `POSITION_RELATION`（Issue #144）の再確認（R-PS-04）が候補検出時と同じ対象
   * 解決を使うために渡す。未指定時は`reconfirmPassiveCandidate`へ渡さず、
   * `POSITION_RELATION`を参照するtriggerの再確認はcontext不足として例外になる
   * （`evaluateTriggerCondition`の既存契約と同じ）。
   */
  readonly findUnit?: FindBattleUnit;
  readonly activate: ActivatePassiveCandidate;
  readonly limits: PassiveChainLimits;
  /**
   * `RESOLUTION_PHASE`（Issue #144、TRIGGER_EXCLUSION_TIMING）を候補検出時と
   * 同一の値で再確認（R-PS-04）するために`reconfirmPassiveCandidate`へそのまま
   * 渡す。1解決スコープの全体を通じて固定（呼び出し側が決める）。
   */
  readonly resolutionPhase?: ResolutionPhase;
  /**
   * レビュー再指摘[P2]（PR #209）: R-EFF-08（`expiration.conditions`）は
   * 「関連するドメインイベント発行後、PS/Memory候補抽出前に評価する」契約
   * のため、トップレベルの`event`だけでなく、PS連鎖の内部で発行される
   * `TIMING_EVENT`/`EFFECT_RESOLVED`の各イベント（`PassiveActivated`・
   * `EffectActionStarting`・`DamageApplied`等）に対しても同じ契約を満たす
   * 必要がある。呼び出し側（`combat/`/`effects/`へ依存できない`triggering/`の
   * 代わりに`lifecycle/PassiveActivationRuntime`）が注入する。`event`に対して
   * 特殊失効条件が成立した効果があれば失効させ、その結果新たに発行された
   * イベント（`EffectExpired`・`CombatStatChanged`等）を返す。未指定、または
   * 該当なしの場合は空配列を返す契約とする。
   */
  readonly applyExpirationConditions?: (
    event: TriggerCandidateEvent,
  ) => readonly TriggerCandidateEvent[];
  /**
   * PR #211レビュー[P1]: `R-EFF-11`（`AppliedEffect`スコープ、EFF-005/Issue #162）の
   * `counterUpdates`更新も、`applyExpirationConditions`と同じ理由で
   * トップレベルの`event`だけでなくPS連鎖内部の各イベント（PS自身がyieldする
   * `PassiveActivated`・`EffectActionStarting`、PS効果由来の`DamageApplied`等、
   * `onFactEvent`を経由しないイベント）に対しても届ける必要がある。`event`に
   * 一致する`AppliedEffect`スコープの`counterUpdates`を検出し、マッチした
   * 各エントリを1件ずつ更新・記録するたびに`resolveChild`（＝`resolveEvent`
   * 自身への再帰）を呼び出し、その`RuntimeCounterChanged`の候補連鎖を完全に
   * 解決してから次のエントリを適用する（レビュー再指摘[P1]: 複数の
   * `AppliedEffect`が同じイベントへ一致する場合、最初の`RuntimeCounterChanged`が
   * 誘発したPSが後続effectを解除・変更しうるため、全件を先にバッチ更新して
   * から返すと後続の`before`/`after`が候補解決前の古い状態になってしまう —
   * `SkillRuntime`側の`detectAndRecordRuntimeCounterChanges`と同じ「1件ずつ
   * record→候補解決→次へ」の順序をこの経路でも守る）。`resolveChild`が返す
   * violationはそのまま返し、以降のエントリは処理しない。`event`自身の
   * `expiration.conditions`評価・候補抽出より前に呼ぶ（R-EFF-11「原因イベントの
   * 状態変更確定後、PS/Memory候補抽出前にcounter更新を決定する」）。未指定、
   * またはマッチなしの場合は`undefined`を返す契約とする。
   */
  readonly applyEffectRuntimeCounterUpdates?: (
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ) => PassiveChainLimitViolationReason | undefined;
  /**
   * EFF-006/Issue #212: `R-EFF-11`の`EffectSequence`スコープ版。`applyEffectRuntimeCounterUpdates`
   * （`AppliedEffect`スコープ）と同じ理由・同じ契約（`event`に一致する現在進行中の
   * EffectSequence解決のcounterUpdatesを検出・記録し、1件ずつ`resolveChild`で
   * 候補連鎖を完全に解決してから次へ進む）。`state.effectRuntimeCounterDepth`を
   * `applyEffectRuntimeCounterUpdates`と共有する（自己再誘発の上限はスコープを
   * 問わず1つの決定的な上限を設ければ十分なため、`ChainState`を分割しない）。
   */
  readonly applyEffectSequenceRuntimeCounterUpdates?: (
    event: TriggerCandidateEvent,
    resolveChild: (child: TriggerCandidateEvent) => PassiveChainLimitViolationReason | undefined,
  ) => PassiveChainLimitViolationReason | undefined;
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

/** `resolvePassiveChain`の再帰呼び出し全体で共有する可変状態。 */
interface ChainState {
  guard: PassiveActivationGuard;
  effectsResolved: number;
  readonly interruptedCandidates: PassiveCandidate[];
  /** `05_ドメインモデル.md`「PassiveCandidateStack」（本Issueでは「PassiveResolutionStack」）。
   * 制御フロー自体はJSの呼び出しスタックによる再帰で駆動するが、各階層で
   * push/popし、観測可能な状態として保つ。 */
  stack: PassiveResolutionStack;
  /**
   * PR #211レビュー[P1]: `deps.applyEffectRuntimeCounterUpdates`から
   * `resolveChild`（`resolveEvent`自身への再帰）が呼ばれている間、増加させたまま
   * 保つ深さカウンタ。呼び出しが返った直後（`resolveChild`による再帰的候補解決を
   * 待たずに）減算すると、`RuntimeCounterChanged`を自身の`counterUpdates.trigger`
   * に持つ誤ったCatalog定義がPS連鎖内部（`onFactEvent`を経由しない`resolveEvent`
   * 自身の再帰）で無限に自己再生成した場合にこの上限が機能しない（各呼び出しの
   * 深さが常に1へ戻ってしまうため）。`state`（`resolvePassiveChain`の再帰全体で
   * 共有する可変状態）に持たせることで、`resolveEvent`の実際のJS呼び出し
   * スタックの深さと一致させる。
   */
  effectRuntimeCounterDepth: number;
}

/**
 * `event`の候補グループを検出し、スタック先頭へ積んで完全に解決してからpopする。
 * PS深度Guardはpush直後、候補処理を始める前に確認する。
 *
 * PR #211レビュー[P1]: `deps.applyEffectRuntimeCounterUpdates`（R-EFF-11、
 * `AppliedEffect`スコープ）を`deps.applyExpirationConditions`（R-EFF-08）より
 * 先に呼ぶ — counter更新は特殊失効条件評価・候補抽出より前に確定させる
 * （R-EFF-11「原因イベントの状態変更確定後、PS/Memory候補抽出前にcounter
 * 更新を決定する」）。新たに発行された`RuntimeCounterChanged`も、`event`自身の
 * 候補解決より前にこの`resolveEvent`自身へ再帰させて完全に解決する。
 * `deps.applyEffectSequenceRuntimeCounterUpdates`（EFF-006/Issue #212、
 * `EffectSequence`スコープ）も同じ理由・同じ順序（`applyExpirationConditions`
 * より先）で呼ぶ。
 *
 * レビュー再指摘[P2]（PR #209）: 候補検出の直前に`deps.applyExpirationConditions`
 * （R-EFF-08）を呼び、`event`に対して成立した特殊失効条件を先に処理する。
 * 新たに発行された各イベントは、`event`自身の候補解決より前に、この
 * `resolveEvent`自身へ再帰させて完全に解決する（自身の`expiration.conditions`
 * 評価・候補解決を含む）。`resolveEvent`はトップレベルの`onFactEvent`からも
 * PS連鎖内部の`TIMING_EVENT`/`EFFECT_RESOLVED`からも呼ばれる唯一の共通経路
 * のため、ここに置くことで呼び出し元ごとの配線を必要としない。
 */
function resolveEvent(
  event: TriggerCandidateEvent,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  if (deps.applyEffectRuntimeCounterUpdates !== undefined) {
    // PR #211レビュー[P1]: 深さは`resolveChild`が実際に呼ばれた分だけ増減する
    // （`deps.applyEffectRuntimeCounterUpdates`がマッチなしで`undefined`を返す
    // 呼び出しではカウントしない）。ここを`resolveEvent`呼び出しそのものに
    // 巻き付けると、AppliedEffect counterと無関係な通常のPS連鎖の深さも誤って
    // カウントしてしまう。
    const violation = deps.applyEffectRuntimeCounterUpdates(event, (child) => {
      state.effectRuntimeCounterDepth += 1;
      try {
        const depthCheck = checkEffectRuntimeCounterDepth(
          state.effectRuntimeCounterDepth,
          deps.limits,
        );
        if (!depthCheck.ok) {
          return depthCheck.reason;
        }
        return resolveEvent(child, state, deps);
      } finally {
        state.effectRuntimeCounterDepth -= 1;
      }
    });
    if (violation !== undefined) {
      return violation;
    }
  }

  if (deps.applyEffectSequenceRuntimeCounterUpdates !== undefined) {
    // EFF-006/Issue #212: 上の`applyEffectRuntimeCounterUpdates`（`AppliedEffect`
    // スコープ）と同じ深さGuard・同じ理由で`resolveChild`ベースにする。
    const violation = deps.applyEffectSequenceRuntimeCounterUpdates(event, (child) => {
      state.effectRuntimeCounterDepth += 1;
      try {
        const depthCheck = checkEffectRuntimeCounterDepth(
          state.effectRuntimeCounterDepth,
          deps.limits,
        );
        if (!depthCheck.ok) {
          return depthCheck.reason;
        }
        return resolveEvent(child, state, deps);
      } finally {
        state.effectRuntimeCounterDepth -= 1;
      }
    });
    if (violation !== undefined) {
      return violation;
    }
  }

  if (deps.applyExpirationConditions !== undefined) {
    for (const causedEvent of deps.applyExpirationConditions(event)) {
      const violation = resolveEvent(causedEvent, state, deps);
      if (violation !== undefined) {
        return violation;
      }
    }
  }

  const candidates = detectLimitedCandidates(event, deps);
  state.stack = pushCandidateGroups(state.stack, [{ event, candidates }]);

  const depthCheck = checkPassiveDepth(depthOf(state.stack), deps.limits);
  if (!depthCheck.ok) {
    return depthCheck.reason;
  }

  const violation = resolveTopGroup(state, deps);
  state.stack = popTop(state.stack);
  return violation;
}

/**
 * スタック先頭グループの候補を先頭から順に処理する。R-PS-04の再確認は候補を
 * 処理する直前に必ず行うため、ネストした解決から戻った直後の次候補もここを
 * 通り、「TIMINGイベント後に親処理の前提を再検証する」不変条件を満たす。
 */
function resolveTopGroup(
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  const top = peekTop(state.stack);
  if (top === undefined) {
    return undefined;
  }
  const [next, ...restCandidates] = top.candidates;
  if (next === undefined) {
    return undefined;
  }
  state.stack = withTopCandidates(state.stack, restCandidates);

  const currentUnit = deps.getCurrentUnit(next.unit.battleUnitId);
  const reconfirmation = reconfirmPassiveCandidate(
    next,
    currentUnit,
    top.event,
    state.guard,
    deps.findUnit,
    deps.resolutionPhase,
  );
  if (reconfirmation.ok) {
    state.guard = recordActivation(
      state.guard,
      currentUnit.battleUnitId,
      next.skillDefinition.skillDefinitionId,
    );
    const activatedCandidate: PassiveCandidate = { ...next, unit: currentUnit };
    const generator = deps.activate(activatedCandidate, top.event);
    const violation = driveActivation(activatedCandidate, generator, state, deps);
    if (violation !== undefined) {
      return violation;
    }
  }

  return resolveTopGroup(state, deps);
}

/**
 * `generator`を完了まで駆動する。`TIMING_EVENT`はGuardをカウントせずそのまま
 * 候補解決へ回す。`EFFECT_RESOLVED`は受け取った直後に効果解決数Guardを確認して
 * から、`events`を発生順に`resolveEvent`で解決する（各イベントの候補連鎖を
 * 次のイベントへ進む前に完全に解決する）。
 */
function driveActivation(
  candidate: PassiveCandidate,
  generator: PassiveActivation,
  state: ChainState,
  deps: PassiveChainDependencies,
): PassiveChainLimitViolationReason | undefined {
  while (true) {
    const step = generator.next();
    if (step.done) {
      if (step.value.interrupted) {
        state.interruptedCandidates.push(candidate);
      }
      return undefined;
    }

    if (step.value.kind === "TIMING_EVENT") {
      const violation = resolveEvent(step.value.event, state, deps);
      if (violation !== undefined) {
        return violation;
      }
      continue;
    }

    state.effectsResolved += 1;
    const effectsCheck = checkEffectsResolvedCount(state.effectsResolved, deps.limits);
    if (!effectsCheck.ok) {
      return effectsCheck.reason;
    }

    for (const event of step.value.events) {
      const violation = resolveEvent(event, state, deps);
      if (violation !== undefined) {
        return violation;
      }
    }
  }
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
 * - R-PS-06: `activate`が`yield`するイベント（`TIMING_EVENT`単体、または
 *   `EFFECT_RESOLVED`の`events`）ごとに、その候補連鎖を完全に解決してから
 *   `yield`元のジェネレータを再開する。これにより「親の効果A→子PS→親の効果B」
 *   の順序を実際のEffectSequence解決と同じ粒度で保証する。
 * - 効果解決数Guardは`EFFECT_RESOLVED`を受け取るたびに、その`events`を処理する
 *   前に直ちにカウント・判定する。これにより、各PSの効果が次のPSを即座に誘発し
 *   続ける再帰的な連鎖でもGuardが機能する（イベント処理より後にカウントする
 *   設計だと、カウントへ到達する前に連鎖が深くなり続け、深度Guardにしか頼れ
 *   なくなる）。`TIMING_EVENT`（EffectAction解決前のTIMINGイベント、まだ効果が
 *   解決していないためPSの反応でEffectAction自体が中断・再計算されうる）は
 *   カウントしない。TIMINGイベントに反応したPS自身の効果は、そのPS自身の
 *   `EFFECT_RESOLVED`で別途カウントされるため、未解決のTIMINGイベント連鎖で
 *   カウントを回避することはできない。
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
  const state: ChainState = {
    guard: initialGuard,
    effectsResolved: 0,
    interruptedCandidates: [],
    stack: createEmptyPassiveResolutionStack(),
    effectRuntimeCounterDepth: 0,
  };

  const violation = resolveEvent(initialEvent, state, deps);
  if (violation !== undefined) {
    return { ok: false, reason: violation };
  }
  return {
    ok: true,
    activationGuard: state.guard,
    interruptedCandidates: state.interruptedCandidates,
  };
}
