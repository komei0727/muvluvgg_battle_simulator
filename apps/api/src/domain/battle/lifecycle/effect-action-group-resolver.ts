import { requireUnit } from "./action-resolution-shared.js";
import { expireEffects, expireEffectsSteps } from "../effects/duration-expiry-service.js";
import {
  buildEffectStepPerTargetFilter,
  buildTargetSetResolver,
  resolveActionStepApplications,
  type EffectActionApplication,
  type EffectSequencePlan,
  type LastResultTargetContext,
} from "../skill/skill-resolution-service.js";
import {
  conditionReferencesTargetSetCount,
  evaluateEffectStepCondition,
} from "../skill/effect-step-condition-evaluator.js";
import { selectWeightedBranch } from "../skill/random-branch-selection.js";
import type { LastEffectActionResult } from "../skill/last-effect-action-result.js";
import type {
  EffectActionReference,
  EffectStepDefinition,
} from "../../catalog/definitions/effect-sequence.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { resolveDarkness } from "../combat/hit-policy.js";
import { resolveEffectActionByKind } from "./effect-action/effect-action-dispatch.js";
import {
  createEffectActionEventCursor,
  type EffectActionOutcome,
} from "./effect-action/effect-action-handler.js";
import {
  findActorUnit,
  isActorDefeated,
  requireSkillDefinitionId,
  resolutionSourceOf,
  sourceEnvelopeOf,
  type EffectActionGroupContext,
  type EffectResolutionStep,
  type UnitsBox,
} from "./effect-action/effect-action-group-context.js";

export type {
  EffectActionGroupContext,
  EffectResolutionStep,
  UnitsBox,
} from "./effect-action/effect-action-group-context.js";

/**
 * Issue #217設計方針B: resolverの終了状態を判別可能unionにする。`COMPLETED`/
 * `INTERRUPTED`は、実際に解決が最後まで進んだか、使用者戦闘不能で解決を
 * 打ち切ったかという事実だけから決まり、`unresolvedEffectCount`の値からは
 * 決して導出しない（`INTERRUPTED`かつ`unresolvedEffectCount: 0`の組合せを
 * 正当な結果として許容する — 例えば`EffectStepStarting`自身が誘発した
 * PS/Memory連鎖で使用者が戦闘不能になり、そのstepのACTIONが1件も開始
 * されなかった場合）。
 */
export type EffectSequenceOutcome =
  | {
      readonly status: "COMPLETED";
      /** 実際に処理したヒット・適用の総数。 */
      readonly resolvedEffectCount: number;
    }
  | {
      readonly status: "INTERRUPTED";
      readonly reason: "ACTOR_DEFEATED";
      /** 使用者が戦闘不能になる前に到達し、実際に処理したヒット・適用の総数。 */
      readonly resolvedEffectCount: number;
      /**
       * Issue #217設計方針C（案1、厳密値のみを公開）: 中断が起きた時点で実際に
       * 開いていたACTION適用一覧のうち、未処理のまま残った「効果単位」数の厳密値。
       * `countHits`（`application.hits.length`の合計）と同じ計数単位 —
       * DAMAGEは残りヒットごとに1、非DAMAGEは残りapplication（対象1件×
       * EffectAction1件、常にhits.length === 1）ごとに1として数える。
       * まだ開始していないstep・branch・iterationは、その内容を静的に
       * 見積もらず常に0として扱う（実行状態を二重に解釈する見積もり器を
       * 持たないための唯一の情報源）。
       */
      readonly unresolvedEffectCount: number;
    };

export interface EffectActionGroupsResult {
  readonly units: readonly BattleUnit[];
  readonly outcome: EffectSequenceOutcome;
}

function countHits(applications: readonly EffectActionApplication[]): number {
  return applications.reduce((sum, application) => sum + application.hits.length, 0);
}

/**
 * R-SKL-08「直前結果」: 同じ解決スコープ内で実際に確定したEffectAction結果だけを
 * 保持する可変箱（Issue #217設計方針D）。`resolveEffectSequencePlan`の
 * generator呼び出し全体（ACTION・BRANCH・RANDOM_BRANCH・REPEATの再帰呼び出し
 * すべて）を通じて同じインスタンスを共有し、実際に実行が到達した箇所でのみ
 * 更新する。「もし実行していたら」の結果を書き込む経路は存在しない。
 * `lastActionTargetUnitIds`/`lastDamagedTargetUnitIds`は、直前に完了した
 * ACTION step全体（複数対象を含みうる）が対象にした/実際に損傷させたunit id
 * の集合を表し、`current`（単一EffectAction結果、`LAST_RESULT`のfield比較に使う）
 * とは独立に更新する。
 */
interface LastResultState {
  current?: LastEffectActionResult;
  lastActionTargetUnitIds: readonly BattleUnitId[];
  lastDamagedTargetUnitIds: readonly BattleUnitId[];
}

function lastResultTargetsContext(
  lastResultState: LastResultState,
  allUnits: readonly BattleUnit[],
): LastResultTargetContext {
  return {
    allUnits,
    lastActionTargetUnitIds: lastResultState.lastActionTargetUnitIds,
    lastDamagedTargetUnitIds: lastResultState.lastDamagedTargetUnitIds,
  };
}

/**
 * Issue #217設計方針D3: 再帰呼び出しの各段（ACTION適用ループ、step一覧、
 * BRANCH、RANDOM_BRANCH、REPEAT）が返す共通の中間結果。呼び出し元は
 * `interrupted`を見た瞬間、自分の残りの一覧・分岐・iterationへは一切進まず
 * （追加のEffectAction・乱数消費・PS/Memory連鎖を発生させず）、同じ
 * `resolvedCount`/`unresolvedCount`をそのまま呼び出し元へ伝播する。
 * 「まだ開始していない」部分の`unresolvedCount`への寄与は常に0。
 */
interface StepWalkResult {
  readonly resolvedCount: number;
  /** `EffectStepCompleted.resolvedActionCount`用: 解決したEffectAction適用（target×action）数。 */
  readonly resolvedActionCount: number;
  readonly interrupted: boolean;
  readonly unresolvedCount: number;
}

function walkCompleted(resolvedCount: number, resolvedActionCount: number): StepWalkResult {
  return { resolvedCount, resolvedActionCount, interrupted: false, unresolvedCount: 0 };
}

function walkInterrupted(
  resolvedCount: number,
  resolvedActionCount: number,
  unresolvedCount: number,
): StepWalkResult {
  return { resolvedCount, resolvedActionCount, interrupted: true, unresolvedCount };
}
interface OneApplicationResult {
  readonly lastEventId: DomainEventId;
  readonly resolvedCount: number;
  readonly interruptedCount: number;
  readonly interrupted: boolean;
  /**
   * R-SKL-08/Issue #217設計方針D: このapplicationが実際に確定した結果。
   * TIMINGイベント後の再検証で使用者が既に戦闘不能だった場合（このapplication
   * 自体は一度も開始されていない）は`undefined`— 「もし実行していたら」の
   * 結果を`LastResultState`へ書き戻さないための境界。
   *
   * `criticalHitCount`はこのapplication単体の件数で、step全体の合計は
   * `resolveActionApplications`が積み上げる（`LastEffectActionResult.
   * criticalHitCount`のスコープはstep全体、`POST_DAMAGE_CRITICAL_BRANCH`、
   * DMG-003、Issue #196）。
   */
  readonly lastResult?: LastEffectActionResult;
  /** このapplicationで実際に適用された会心ヒット数（DAMAGE以外は常に0）。 */
  readonly criticalHitCount: number;
}

/**
 * R-SKL-06「ACTION step」#3〜#5を対象1件・EffectAction1件単位で適用するgenerator。
 * `EffectActionStarting`を`TIMING_EVENT`として`yield`し、kind別ハンドラ
 * （`effect-action/`）の適用完了後に`EffectActionCompleted`を`EFFECT_RESOLVED`として
 * `yield`する。kindごとの適用そのものは一切知らず、共通のライフサイクル
 * （開始イベント・戦闘不能再検証・完了イベント・結果の集計）だけを担う。
 *
 * 駆動側はyieldのたびに子PS連鎖を解決してから再開し、`box.units`をその場で最新化する
 * （`08_ドメインイベント.md`「TIMINGイベント後の再検証」）。
 */
function* resolveOneEffectActionApplication(
  application: EffectActionApplication,
  box: UnitsBox,
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
  /**
   * HEAL_DISTRIBUTE（M7-005）: 同じEffectStep内でこの`effectActionDefinitionId`が
   * 適用される対象数。`HEAL`の`payload.distribution: "EVEN"`と`MODIFY_RESOURCE`の
   * `operation: DISTRIBUTE`だけがこれを使い、総量を等分する。
   */
  distributionShareCount = 1,
): Generator<EffectResolutionStep, OneApplicationResult, void> {
  const effectAction = context.definitions.effectActions.get(application.effectActionDefinitionId);
  if (effectAction === undefined) {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `effectActionDefinitionId "${application.effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
    );
  }

  const starting = context.recorder.record({
    eventType: "EffectActionStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId,
    rootEventId: context.rootEventId,
    ...sourceEnvelopeOf(context),
    targetUnitIds: [application.targetBattleUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      kind: effectAction.kind,
      targetUnitIds: [application.targetBattleUnitId],
    },
  });
  yield { kind: "TIMING_EVENT", event: starting };

  // TIMINGイベント後の再検証: 使用者がPS/Memory連鎖で戦闘不能になった場合、
  // このEffectActionへは進まず中断として計上する（R-SKL-01）。`box.units`は
  // 直前のyieldで駆動側が解決した子PS連鎖の結果を反映済み。
  if (isActorDefeated(context, box)) {
    return {
      lastEventId: starting.eventId,
      resolvedCount: 0,
      interruptedCount: application.hits.length,
      interrupted: true,
      criticalHitCount: 0,
    };
  }

  // ハンドラより後に記録されるイベントを捕捉する起点。`EffectActionStarting`は
  // 直前のyieldで駆動側へ既に渡っているため含めない。
  const cursor = createEffectActionEventCursor(context, box);

  let outcome: EffectActionOutcome;
  // R-ACTN-01 #2（RES-002、全Action種別の共通契約）: 対象が既に戦闘不能であり、
  // 戦闘不能者を対象にできる明示指定（`application.includeDefeated`、選択元
  // `TargetSelectorDefinition.includeDefeated`から`skill-resolution-service.ts`が運ぶ）が
  // ない場合は種別を問わず適用しない。DAMAGEはこの分岐を経由せずハンドラへそのまま
  // 進む — `applyDamageAction`がヒット単位（対象が解決の途中で戦闘不能になる場合を
  // 含む）で`includeDefeated`を同じ契約に沿って判定し、`damageResults`への0記録も
  // そちら側の責務のためここでは対象としない（二重処理防止）。
  if (
    effectAction.kind !== "DAMAGE" &&
    !application.includeDefeated &&
    isDefeated(requireUnit(box.units, application.targetBattleUnitId))
  ) {
    outcome = {
      resultKind: "SKIPPED",
      resolvedCount: application.hits.length,
      interruptedCount: 0,
      criticalHitCount: 0,
      lastEventId: starting.eventId,
    };
  } else {
    outcome = yield* resolveEffectActionByKind({
      effectAction,
      application,
      box,
      context,
      startingEventId: starting.eventId,
      distributionShareCount,
      cursor,
    });
  }

  const innerEvents = cursor.innerEvents();
  const completed = context.recorder.record({
    eventType: "EffectActionCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: outcome.lastEventId,
    rootEventId: context.rootEventId,
    ...sourceEnvelopeOf(context),
    targetUnitIds: [application.targetBattleUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      effectActionKind: effectAction.kind,
      targetUnitIds: [application.targetBattleUnitId],
      resultKind: outcome.resultKind,
    },
  });
  yield { kind: "EFFECT_RESOLVED", events: [...innerEvents, completed] };

  return {
    lastEventId: completed.eventId,
    resolvedCount: outcome.resolvedCount,
    interruptedCount: outcome.interruptedCount,
    interrupted: outcome.resultKind === "INTERRUPTED",
    criticalHitCount: outcome.criticalHitCount,
    lastResult: {
      resultKind: outcome.resultKind,
      effectActionKind: effectAction.kind,
      effectActionDefinitionId: application.effectActionDefinitionId,
      targetUnitIds: [application.targetBattleUnitId],
      // step全体の合計は`resolveActionApplications`が積み上げて上書きする。
      criticalHitCount: outcome.criticalHitCount,
    },
  };
}

type StepResolution = Generator<
  EffectResolutionStep,
  { readonly lastEventId: DomainEventId; readonly walkResult: StepWalkResult },
  void
>;

function emitEffectStepStarting(
  stepIndex: number,
  stepKind: EffectStepDefinition["kind"],
  conditionKind: ConditionDefinition["kind"],
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
): BattleDomainEvent {
  return context.recorder.record({
    eventType: "EffectStepStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId,
    rootEventId: context.rootEventId,
    ...sourceEnvelopeOf(context),
    payload: { stepIndex, stepKind, conditionKind },
  });
}

function emitEffectStepCompleted(
  stepIndex: number,
  resolvedActionCount: number,
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
): BattleDomainEvent {
  return context.recorder.record({
    eventType: "EffectStepCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId,
    rootEventId: context.rootEventId,
    ...sourceEnvelopeOf(context),
    payload: { stepIndex, resolvedActionCount },
  });
}

/**
 * R-SKL-06「ACTION step」#3〜#5・R-SKL-08: 1つのACTION stepの`applications`を
 * 対象・action定義順に適用する。使用者の戦闘不能を各適用の直前に再確認し、
 * 検出した時点でこのstepの中でまだ開始していないapplicationsの正確な
 * ヒット数を`unresolvedCount`として報告し、それ以上は一切処理しない
 * （Issue #217設計方針D2〜D3）。実際に確定した結果は`lastResultState`へ
 * 書き戻す（R-SKL-08、D4: 未実行の結果は書き込まない）。
 */
function* resolveActionApplications(
  applications: readonly EffectActionApplication[],
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultState: LastResultState,
  startEventId: DomainEventId,
): StepResolution {
  let lastEventId = startEventId;
  let resolvedCount = 0;
  let resolvedActionCount = 0;
  const stepActionTargetUnitIds: BattleUnitId[] = [];
  const seenActionTargetUnitIds = new Set<BattleUnitId>();
  const stepDamagedTargetUnitIds: BattleUnitId[] = [];
  const seenDamagedTargetUnitIds = new Set<BattleUnitId>();
  /**
   * `POST_DAMAGE_CRITICAL_BRANCH`（DMG-003、Issue #196）: このACTION step全体で
   * 実際に適用された会心ヒットの累計。`LastEffectActionResult.criticalHitCount`は
   * step全体スコープのため、application 1件ごとの値ではなくこの累計を書き戻す。
   * 後続stepが`LAST_RESULT`を読むのはこのstepが終わった後だけなので、途中の
   * 累計値が観測されることはない。
   */
  let stepCriticalHitCount = 0;

  const finalizeStepTargets = (): void => {
    lastResultState.lastActionTargetUnitIds = stepActionTargetUnitIds;
    lastResultState.lastDamagedTargetUnitIds = stepDamagedTargetUnitIds;
  };

  // HEAL_DISTRIBUTE（M7-005、Issue #184）: `HEAL`の`payload.distribution: "EVEN"`は
  // 「総回復量を対象数で等分する」ため、同じEffectActionが適用される対象数を
  // 分母にする。applicationは対象1体につき1件のため件数がそのまま分配数になる。
  // M7-017（Issue #271）: `MODIFY_RESOURCE`の`operation: DISTRIBUTE`も同じ分母を使う。
  //
  // 事前計画されたapplication件数をそのまま使うと、
  // `EffectStepStarting`起点のPS連鎖で戦闘不能になった対象（`resolveOneEffect
  // ApplicationApplication`が`SKIPPED`にする、`applyHealAction`も回復しない）まで
  // 分母に残り、生存対象へ配られる総量が「実際に適用される対象数で等分した値」
  // より少なくなる。そのため分母は事前に固定せず、そのEffectActionの最初の
  // applicationを解決する直前に、その時点の`box.units`から実際に適用される対象
  // （戦闘不能でない、または`includeDefeated`が明示されている）だけを数えて確定
  // する。一度確定した分母はその分配グループの残りのapplicationでも再利用する
  // — 分配は「1つの総量を分け合う」意味であり、application ごとに分母が変わると
  // 合計が総量と一致しなくなるため。
  //
  // 分配グループはEffectActionDefinition IDでは
  // なく`step.actions`内の**参照ごと**に分ける。R-SKL-06 #4は同じEffectAction
  // Definitionを1つのACTION stepから複数回参照でき、各参照が定義順に独立して
  // 適用されることを認めている（production例: `SKL_OLGA_VETERAN_PS1`/`PS2`が
  // SUBUNIT actionを3回参照する）。ID単位でまとめると、参照2回×対象2体の
  // 4 applicationが1つの総量を分け合うことになり、参照ごとに総量を配る本来の
  // 意味より各対象の受取量が少なくなる。
  //
  // `buildApplications`（`skill-resolution-service.ts`）は対象ごとに
  // `step.actions`を定義順で並べるため、同一対象ブロック内での同一IDの出現順が
  // そのまま`actions`内の参照番号になる。これを分配グループのキーにする。
  const shareGroupKeys = ((): readonly string[] => {
    const keys: string[] = [];
    let currentTargetId: BattleUnitId | undefined;
    let ordinals = new Map<EffectActionDefinitionId, number>();
    for (const application of applications) {
      if (application.targetBattleUnitId !== currentTargetId) {
        currentTargetId = application.targetBattleUnitId;
        ordinals = new Map();
      }
      const ordinal = ordinals.get(application.effectActionDefinitionId) ?? 0;
      ordinals.set(application.effectActionDefinitionId, ordinal + 1);
      keys.push(`${application.effectActionDefinitionId}#${ordinal}`);
    }
    return keys;
  })();
  const shareCountByGroup = new Map<string, number>();
  const resolveShareCount = (applicationIndex: number): number => {
    const groupKey = shareGroupKeys[applicationIndex]!;
    const cached = shareCountByGroup.get(groupKey);
    if (cached !== undefined) {
      return cached;
    }
    const definitionId = applications[applicationIndex]!.effectActionDefinitionId;
    // `includeDefeated`は戦闘不能者を選択集合へ
    // 含める指定だが、R-HEAL-01は蘇生規則を持たず`applyOneHeal`は戦闘不能の対象へ
    // 一切回復しない（`undefined`を返し`HealApplied`も発行しない）。分配の分母は
    // 「実際に効果を受け取る対象数」でなければならないため、`HEAL`は
    // `includeDefeated`の有無にかかわらず戦闘不能者を除外する。
    //
    // M7-017（Issue #271）: `MODIFY_RESOURCE`はこれと異なり、`includeDefeated`が
    // 明示された戦闘不能の対象へも実際に適用される（R-ACTN-01 #2の共通契約に従い、
    // `resolveOneEffectActionApplication`が`SKIPPED`にするのは明示指定が**ない**
    // 場合だけ）。同じ「実際に受け取る対象数」という定義から、こちらでは
    // `includeDefeated`の対象を分母に残す。
    const distributesToDefeatedTargets =
      context.definitions.effectActions.get(definitionId)?.kind === "MODIFY_RESOURCE";
    const count = applications.filter(
      (candidate, candidateIndex) =>
        shareGroupKeys[candidateIndex] === groupKey &&
        ((distributesToDefeatedTargets && candidate.includeDefeated) ||
          !isDefeated(requireUnit(box.units, candidate.targetBattleUnitId))),
    ).length;
    // 呼び出し元は「今まさに適用しようとしている application」の解決直前にだけ
    // これを呼ぶため、その対象自身が数に含まれ`count >= 1`が成り立つ。0での
    // 除算を構造的に防ぐため、それでも0になった場合は1へ丸める。
    const shareCount = Math.max(1, count);
    shareCountByGroup.set(groupKey, shareCount);
    return shareCount;
  };

  for (let index = 0; index < applications.length; index += 1) {
    const application = applications[index]!;
    if (isActorDefeated(context, box)) {
      finalizeStepTargets();
      return {
        lastEventId,
        walkResult: walkInterrupted(
          resolvedCount,
          resolvedActionCount,
          countHits(applications.slice(index)),
        ),
      };
    }

    const applied = yield* resolveOneEffectActionApplication(
      application,
      box,
      context,
      lastEventId,
      resolveShareCount(index),
    );
    lastEventId = applied.lastEventId;
    resolvedCount += applied.resolvedCount;

    stepCriticalHitCount += applied.criticalHitCount;

    if (applied.lastResult !== undefined) {
      lastResultState.current = { ...applied.lastResult, criticalHitCount: stepCriticalHitCount };
      if (!seenActionTargetUnitIds.has(application.targetBattleUnitId)) {
        seenActionTargetUnitIds.add(application.targetBattleUnitId);
        stepActionTargetUnitIds.push(application.targetBattleUnitId);
      }
      if (
        applied.lastResult.resultKind === "APPLIED" &&
        applied.lastResult.effectActionKind === "DAMAGE" &&
        !seenDamagedTargetUnitIds.has(application.targetBattleUnitId)
      ) {
        seenDamagedTargetUnitIds.add(application.targetBattleUnitId);
        stepDamagedTargetUnitIds.push(application.targetBattleUnitId);
      }
    }

    if (applied.interrupted) {
      finalizeStepTargets();
      return {
        lastEventId,
        walkResult: walkInterrupted(
          resolvedCount,
          resolvedActionCount,
          applied.interruptedCount + countHits(applications.slice(index + 1)),
        ),
      };
    }
    resolvedActionCount += 1;
  }

  finalizeStepTargets();
  return { lastEventId, walkResult: walkCompleted(resolvedCount, resolvedActionCount) };
}

/**
 * R-SKL-06「ACTION step」全体を解決する。`EffectStepStarting`(`TIMING_EVENT`)/
 * `EffectStepSkipped`(DIAGNOSTIC、PSの発動契機になり得ないため`yield`しない)/
 * `EffectStepCompleted`(`EFFECT_RESOLVED`)を、`resolveActionApplications`へ
 * 委譲しながら発行する。中断された場合は`EffectStepStarting`が既に発行済み
 * でも`EffectStepCompleted`は発行しない（step自体が完了していないため）。
 * `applications`が既定計画済み（`ActionStepPlan`）・JIT解決済み
 * （`DeferredStepPlan`のACTION）のどちらから来たかは区別しない。
 *
 * `resolveAfterTiming`（CAP_EFFECT_STEP_CONDITION、Issue #171 RES-004後半）:
 * 対象別条件（自身のtargetを参照するTARGET_STATE/
 * TARGET_HAS_MARKER）を持つACTIONだけが渡す。`EffectStepStarting`発行・その
 * TIMINGイベントが誘発しうるPS/Memory連鎖の解決が終わった直後に呼び出し、
 * その時点の最新`box.units`で対象別条件を評価し直す — 渡された`satisfied`/
 * `applications`は、それまでの間だけ使う一時的なプレースホルダ（`true`/`[]`）。
 */
function* resolveActionStepBody(
  stepIndex: number,
  conditionKind: ConditionDefinition["kind"],
  satisfied: boolean,
  actions: readonly EffectActionReference[],
  applications: readonly EffectActionApplication[],
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
  resolveAfterTiming?: () => {
    readonly satisfied: boolean;
    readonly applications: readonly EffectActionApplication[];
  },
): StepResolution {
  const stepStarting = emitEffectStepStarting(
    stepIndex,
    "ACTION",
    conditionKind,
    context,
    lastEventId,
  );
  yield { kind: "TIMING_EVENT", event: stepStarting };

  // TIMINGイベント後の再検証（R-SKL-01）。`resolveAfterTiming`
  // （対象別条件の再評価）より前に行う —
  // `EffectStepStarting`由来の連鎖で使用者が戦闘不能になった場合、
  // `08_ドメインイベント.md`の契約上まだEffectActionが1件も開始していない
  // ため、対象別条件を評価してapplicationsを構築すること自体をせず
  // （`unresolvedEffectCount`へ計上せず）`INTERRUPTED`とする。
  if (isActorDefeated(context, box)) {
    return {
      lastEventId: stepStarting.eventId,
      walkResult: walkInterrupted(0, 0, countHits(applications)),
    };
  }

  const resolved = resolveAfterTiming?.();
  const effectiveSatisfied = resolved?.satisfied ?? satisfied;
  const effectiveApplications = resolved?.applications ?? applications;

  if (!effectiveSatisfied) {
    const stepSkipped = context.recorder.record({
      eventType: "EffectStepSkipped",
      category: "DIAGNOSTIC",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: stepStarting.eventId,
      rootEventId: context.rootEventId,
      ...sourceEnvelopeOf(context),
      payload: { stepIndex, conditionKind, result: false },
    });
    return { lastEventId: stepSkipped.eventId, walkResult: walkCompleted(0, 0) };
  }

  if (effectiveApplications.length === 0) {
    // R-SKL-08 / Catalog preflight（`MISSING_PRECEDING_RESULT`）: 対象0件まで
    // 解決へ到達したACTIONも、仕様どおりSKIPPED結果を直前結果として記録する。
    // R-SKL-06 #4は対象ごとにactionsを定義順で
    // 適用する（対象があれば最後に処理されるのは定義順で最後のaction）ため、
    // 対象0件でも「代表結果」は定義順で最後のaction（`actions[0]`ではなく
    // `actions[actions.length - 1]`）を採用し、対象がいた場合の処理順と
    // 一貫させる。
    const last = actions[actions.length - 1];
    const effectAction =
      last !== undefined
        ? context.definitions.effectActions.get(last.effectActionDefinitionId)
        : undefined;
    if (last !== undefined && effectAction !== undefined) {
      lastResultState.current = {
        resultKind: "SKIPPED",
        effectActionKind: effectAction.kind,
        effectActionDefinitionId: last.effectActionDefinitionId,
        targetUnitIds: [],
        // 対象0件のstepはヒットを1つも解決していないため会心も0件
        // （`POST_DAMAGE_CRITICAL_BRANCH`、DMG-003、Issue #196）。
        criticalHitCount: 0,
      };
    }
    lastResultState.lastActionTargetUnitIds = [];
    lastResultState.lastDamagedTargetUnitIds = [];
    const stepCompleted = emitEffectStepCompleted(stepIndex, 0, context, stepStarting.eventId);
    yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
    return { lastEventId: stepCompleted.eventId, walkResult: walkCompleted(0, 0) };
  }

  const applied = yield* resolveActionApplications(
    effectiveApplications,
    box,
    context,
    lastResultState,
    stepStarting.eventId,
  );
  if (applied.walkResult.interrupted) {
    return applied;
  }

  const stepCompleted = emitEffectStepCompleted(
    stepIndex,
    applied.walkResult.resolvedActionCount,
    context,
    applied.lastEventId,
  );
  yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
  return { lastEventId: stepCompleted.eventId, walkResult: applied.walkResult };
}

/**
 * BRANCH/RANDOM_BRANCH/REPEAT（R-SKL-07）共通のstepライフサイクル:
 * `EffectStepStarting`発行→戦闘不能再検証→`body`（各stepの実体）→
 * （中断していなければ）`EffectStepCompleted`発行。これらのstep種別は
 * ACTIONと異なり自身のconditionでstep全体をスキップすることがないため
 * （BRANCHは常にthen/elseどちらかを解決する）、`EffectStepSkipped`に相当する
 * 分岐は持たない。
 */
function* wrapStepLifecycle(
  stepIndex: number,
  stepKind: EffectStepDefinition["kind"],
  conditionKind: ConditionDefinition["kind"],
  context: EffectActionGroupContext,
  box: UnitsBox,
  lastEventId: DomainEventId,
  body: (currentEventId: DomainEventId) => StepResolution,
): StepResolution {
  const stepStarting = emitEffectStepStarting(
    stepIndex,
    stepKind,
    conditionKind,
    context,
    lastEventId,
  );
  yield { kind: "TIMING_EVENT", event: stepStarting };

  if (isActorDefeated(context, box)) {
    return { lastEventId: stepStarting.eventId, walkResult: walkInterrupted(0, 0, 0) };
  }

  const result = yield* body(stepStarting.eventId);
  if (result.walkResult.interrupted) {
    return result;
  }

  const stepCompleted = emitEffectStepCompleted(
    stepIndex,
    result.walkResult.resolvedActionCount,
    context,
    result.lastEventId,
  );
  yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
  return { lastEventId: stepCompleted.eventId, walkResult: result.walkResult };
}

/** R-SKL-07 BRANCH: conditionがtrueならthenSteps、falseならelseStepsを定義順に解決する。 */
function* resolveBranchStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "BRANCH" }>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  plan: EffectSequencePlan,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
): StepResolution {
  return yield* wrapStepLifecycle(
    stepIndex,
    "BRANCH",
    definition.condition.kind,
    context,
    box,
    lastEventId,
    function* (currentEventId) {
      // CAP_EFFECT_STEP_SET_CONDITION（Issue #227 RES-004集合条件）: BRANCHの
      // conditionは対象ごとの評価対象を持たないため`EffectStepTargetContext`は
      // 渡さないが、`TARGET_SET_COUNT`はAND/OR経由で組み合わさりうるため、
      // 常に最新の`box.units`から解決する`TargetSetResolver`を渡す。
      // Issue #230: `TARGET_STATE`/`TARGET_HAS_MARKER`も
      // 同じ`resolveTargetSet`経由で（`BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE`
      // preflightが高々1体にしか解決されないことを保証する参照に限り）評価
      // できるため、`UNIT_TYPE`フィールド解決に要る`unitDefinitions`も渡す。
      const actor = resolutionSourceOf(context, box);
      const triggerContext = {
        ...(context.triggerSourceUnitId !== undefined
          ? { triggerSourceUnitId: context.triggerSourceUnitId }
          : {}),
        ...(context.triggerTargetUnitIds !== undefined
          ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
          : {}),
      };
      const resolveTargetSet = buildTargetSetResolver(
        plan.resolvedBindings,
        actor,
        box.units,
        lastResultTargetsContext(lastResultState, box.units),
        triggerContext,
      );
      const satisfied = evaluateEffectStepCondition(
        definition.condition,
        lastResultState.current,
        undefined,
        resolveTargetSet,
        context.definitions.unitDefinitions,
        context.triggerEventPayload,
      );
      const chosenSteps = satisfied ? definition.thenSteps : definition.elseSteps;
      return yield* resolveStepDefinitionList(
        chosenSteps,
        box,
        context,
        plan,
        lastResultState,
        currentEventId,
      );
    },
  );
}

/**
 * R-SKL-07 RANDOM_BRANCH: `WEIGHTED_ONE`はweightに応じて1分岐だけを選び
 * （`selectWeightedBranch`でRNGを1回だけ消費）、`INDEPENDENT`はbranch定義順に
 * 確率判定を行い、成功したbranchのstepsを定義順に解決する。乱数消費順は
 * Catalog定義順（`weight`/`probability`が0の到達不能branchはRNGを消費しない）。
 * 選択結果は`RandomBranchSelected`(`EFFECT_RESOLVED`)としてPS/Memory即時連鎖に
 * 参加させる。
 */
function* resolveRandomBranchStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "RANDOM_BRANCH" }>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  plan: EffectSequencePlan,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
): StepResolution {
  return yield* wrapStepLifecycle(
    stepIndex,
    "RANDOM_BRANCH",
    "TRUE",
    context,
    box,
    lastEventId,
    function* (currentEventId) {
      const recordSelected = (
        branchIndex: number,
        label: string | undefined,
        parentEventId: DomainEventId,
      ) =>
        context.recorder.record({
          eventType: "RandomBranchSelected",
          category: "FACT",
          turnNumber: context.turnNumber,
          cycleNumber: context.cycleNumber,
          ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
          skillUseId: context.skillUseId,
          resolutionScopeId: context.actionScope,
          parentEventId,
          rootEventId: context.rootEventId,
          ...sourceEnvelopeOf(context),
          payload: {
            stepIndex,
            mode: definition.mode,
            branchIndex,
            ...(label !== undefined ? { label } : {}),
          },
        });

      if (definition.mode === "WEIGHTED_ONE") {
        const selected = selectWeightedBranch(definition.branches, context.random);
        const selectedEvent = recordSelected(
          selected.branchIndex,
          selected.branch.label,
          currentEventId,
        );
        yield { kind: "EFFECT_RESOLVED", events: [selectedEvent] };

        if (isActorDefeated(context, box)) {
          return { lastEventId: selectedEvent.eventId, walkResult: walkInterrupted(0, 0, 0) };
        }

        return yield* resolveStepDefinitionList(
          selected.branch.steps,
          box,
          context,
          plan,
          lastResultState,
          selectedEvent.eventId,
        );
      }

      // INDEPENDENT: 各branchの確率判定をCatalog定義順に独立して行う。0件成立
      // 経路も正当（design point E参照）。
      let eventId = currentEventId;
      let resolvedCount = 0;
      let resolvedActionCount = 0;
      for (const [branchIndex, branch] of definition.branches.entries()) {
        if (isActorDefeated(context, box)) {
          return {
            lastEventId: eventId,
            walkResult: walkInterrupted(resolvedCount, resolvedActionCount, 0),
          };
        }
        const probability = branch.probability ?? 0;
        const succeeded = probability > 0 && context.random.next() < probability;
        if (!succeeded) {
          continue;
        }

        const selectedEvent = recordSelected(branchIndex, branch.label, eventId);
        yield { kind: "EFFECT_RESOLVED", events: [selectedEvent] };
        eventId = selectedEvent.eventId;

        if (isActorDefeated(context, box)) {
          return {
            lastEventId: eventId,
            walkResult: walkInterrupted(resolvedCount, resolvedActionCount, 0),
          };
        }

        const result = yield* resolveStepDefinitionList(
          branch.steps,
          box,
          context,
          plan,
          lastResultState,
          eventId,
        );
        eventId = result.lastEventId;
        resolvedCount += result.walkResult.resolvedCount;
        resolvedActionCount += result.walkResult.resolvedActionCount;
        if (result.walkResult.interrupted) {
          return {
            lastEventId: eventId,
            walkResult: walkInterrupted(
              resolvedCount,
              resolvedActionCount,
              result.walkResult.unresolvedCount,
            ),
          };
        }
      }
      return {
        lastEventId: eventId,
        walkResult: walkCompleted(resolvedCount, resolvedActionCount),
      };
    },
  );
}

/**
 * R-SKL-07 REPEAT: 指定回数だけstepsを繰り返す。繰り返し途中で使用者が
 * 戦闘不能になった場合、残りの繰り返しを中断する（同じ`lastResultState`を
 * iteration間で共有し、あるiterationのLAST_RESULTが次のiterationから見える）。
 */
function* resolveRepeatStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "REPEAT" }>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  plan: EffectSequencePlan,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
): StepResolution {
  return yield* wrapStepLifecycle(
    stepIndex,
    "REPEAT",
    "TRUE",
    context,
    box,
    lastEventId,
    function* (currentEventId) {
      let eventId = currentEventId;
      let resolvedCount = 0;
      let resolvedActionCount = 0;
      for (let iteration = 0; iteration < definition.count; iteration += 1) {
        if (isActorDefeated(context, box)) {
          return {
            lastEventId: eventId,
            walkResult: walkInterrupted(resolvedCount, resolvedActionCount, 0),
          };
        }
        const result = yield* resolveStepDefinitionList(
          definition.steps,
          box,
          context,
          plan,
          lastResultState,
          eventId,
        );
        eventId = result.lastEventId;
        resolvedCount += result.walkResult.resolvedCount;
        resolvedActionCount += result.walkResult.resolvedActionCount;
        if (result.walkResult.interrupted) {
          return {
            lastEventId: eventId,
            walkResult: walkInterrupted(
              resolvedCount,
              resolvedActionCount,
              result.walkResult.unresolvedCount,
            ),
          };
        }
      }
      return {
        lastEventId: eventId,
        walkResult: walkCompleted(resolvedCount, resolvedActionCount),
      };
    },
  );
}

/**
 * 生の`EffectStepDefinition`1件をkindに応じて解決する（Issue #217: pending
 * execution stateを実行のsingle source of truthにする — トップレベルの
 * `DeferredStepPlan`、BRANCH/RANDOM_BRANCH/REPEATが持つ生のネストされた
 * step一覧のどちらから来ても同じ関数を使う）。`ACTION`はJITで対象・conditionを
 * 解決する（`LAST_RESULT`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`を含み
 * うるため、`resolveEffectSequencePlan`は最初から解決できない）。
 */
function* resolveRawStep(
  stepIndex: number,
  step: EffectStepDefinition,
  box: UnitsBox,
  context: EffectActionGroupContext,
  plan: EffectSequencePlan,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
): StepResolution {
  switch (step.kind) {
    case "ACTION": {
      // CAP_EFFECT_STEP_CONDITION_SCOPE（Issue #230、旧Issue #171/#227の
      // CAP_EFFECT_STEP_CONDITION/CAP_EFFECT_STEP_SET_CONDITION）:
      // `targetCondition`（自身のtargetを参照するTARGET_STATE/
      // TARGET_HAS_MARKER）や`stepCondition`のTARGET_SET_COUNTは、その評価を
      // このstep自身の`EffectStepStarting`（TIMING）が誘発しうるPS/Memory連鎖が
      // Marker・HP・リソース等を変更した後の最新の`box.units`で行う必要が
      // ある。事前に（`EffectStepStarting`発行前に）評価すると、その連鎖に
      // よる変更を一切反映できない。そのためどちらかを持つACTIONは
      // `satisfied`/`applications`を即座に確定させず、`resolveActionStepBody`へ
      // 「TIMINGイベント後に呼び出す再評価関数」を渡す（`isEagerActionStep`が
      // 同じ理由でこの種のstepを常にDeferredへ回すため、ここへ来るのはJIT
      // 解決経路だけ）。
      //
      // `stepCondition`（step全体のgate）と`targetCondition`（対象ごとの
      // filter）はスキーマ上独立したフィールドのため（Issue #230）、
      // 以前のように「両者が同じconditionツリーに同時に現れない」という
      // Catalog preflightの前提に頼る必要がなく、常に両方を独立に評価する
      // 単一の経路へ統一できる: まず`stepCondition`を1回だけ評価し、falseなら
      // step全体をスキップする。trueなら`targetCondition`から対象ごとの
      // filterを組み立て（`targetCondition`がTRUEなら絞り込みなし）、
      // 対象を解決する。
      if (
        conditionReferencesTargetSetCount(step.stepCondition) ||
        step.targetCondition.kind !== "TRUE"
      ) {
        const resolveAfterTiming = (): {
          readonly satisfied: boolean;
          readonly applications: readonly EffectActionApplication[];
        } => {
          const actor = resolutionSourceOf(context, box);
          const triggerContext = {
            ...(context.triggerSourceUnitId !== undefined
              ? { triggerSourceUnitId: context.triggerSourceUnitId }
              : {}),
            ...(context.triggerTargetUnitIds !== undefined
              ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
              : {}),
            ...(context.triggerEventPayload !== undefined
              ? { triggerEventPayload: context.triggerEventPayload }
              : {}),
          };
          const lastResultTargets = lastResultTargetsContext(lastResultState, box.units);
          const resolveTargetSet = buildTargetSetResolver(
            plan.resolvedBindings,
            actor,
            box.units,
            lastResultTargets,
            triggerContext,
          );
          const satisfied = evaluateEffectStepCondition(
            step.stepCondition,
            lastResultState.current,
            undefined,
            resolveTargetSet,
            undefined,
            context.triggerEventPayload,
          );
          if (!satisfied) {
            return { satisfied: false, applications: [] };
          }

          const perTargetFilter =
            step.targetCondition.kind === "TRUE"
              ? undefined
              : buildEffectStepPerTargetFilter(
                  step,
                  plan.resolvedBindings,
                  actor,
                  box.units,
                  context.definitions.unitDefinitions,
                  lastResultState.current,
                  lastResultTargets,
                  triggerContext,
                );
          const applications = resolveActionStepApplications(
            step,
            plan.resolvedBindings,
            actor,
            box.units,
            context.definitions.effectActions,
            lastResultTargets,
            triggerContext,
            perTargetFilter,
          );
          return { satisfied: true, applications };
        };
        return yield* resolveActionStepBody(
          stepIndex,
          step.stepCondition.kind,
          true,
          step.actions,
          [],
          box,
          context,
          lastResultState,
          lastEventId,
          resolveAfterTiming,
        );
      }

      const actor = resolutionSourceOf(context, box);
      const triggerContext = {
        ...(context.triggerSourceUnitId !== undefined
          ? { triggerSourceUnitId: context.triggerSourceUnitId }
          : {}),
        ...(context.triggerTargetUnitIds !== undefined
          ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
          : {}),
      };
      const satisfied = evaluateEffectStepCondition(
        step.stepCondition,
        lastResultState.current,
        undefined,
        undefined,
        undefined,
        context.triggerEventPayload,
      );
      const applications = satisfied
        ? resolveActionStepApplications(
            step,
            plan.resolvedBindings,
            actor,
            box.units,
            context.definitions.effectActions,
            lastResultTargetsContext(lastResultState, box.units),
            triggerContext,
          )
        : [];
      return yield* resolveActionStepBody(
        stepIndex,
        step.stepCondition.kind,
        satisfied,
        step.actions,
        applications,
        box,
        context,
        lastResultState,
        lastEventId,
      );
    }
    case "BRANCH":
      return yield* resolveBranchStep(
        stepIndex,
        step,
        box,
        context,
        plan,
        lastResultState,
        lastEventId,
      );
    case "RANDOM_BRANCH":
      return yield* resolveRandomBranchStep(
        stepIndex,
        step,
        box,
        context,
        plan,
        lastResultState,
        lastEventId,
      );
    case "REPEAT":
      return yield* resolveRepeatStep(
        stepIndex,
        step,
        box,
        context,
        plan,
        lastResultState,
        lastEventId,
      );
  }
}

/**
 * 生の`EffectStepDefinition[]`（BRANCHの`thenSteps`/`elseSteps`、RANDOM_BRANCHの
 * 選択済み`branch.steps`、REPEATの`steps`）を定義順に解決する。子が中断を
 * 報告した瞬間、残りの一覧へは一切進まない（Issue #217設計方針D3）。
 */
function* resolveStepDefinitionList(
  steps: readonly EffectStepDefinition[],
  box: UnitsBox,
  context: EffectActionGroupContext,
  plan: EffectSequencePlan,
  lastResultState: LastResultState,
  lastEventId: DomainEventId,
): StepResolution {
  let currentEventId = lastEventId;
  let resolvedCount = 0;
  let resolvedActionCount = 0;

  for (const [index, step] of steps.entries()) {
    if (isActorDefeated(context, box)) {
      return {
        lastEventId: currentEventId,
        walkResult: walkInterrupted(resolvedCount, resolvedActionCount, 0),
      };
    }

    const result = yield* resolveRawStep(
      index,
      step,
      box,
      context,
      plan,
      lastResultState,
      currentEventId,
    );
    currentEventId = result.lastEventId;
    resolvedCount += result.walkResult.resolvedCount;
    resolvedActionCount += result.walkResult.resolvedActionCount;

    if (result.walkResult.interrupted) {
      return {
        lastEventId: currentEventId,
        walkResult: walkInterrupted(
          resolvedCount,
          resolvedActionCount,
          result.walkResult.unresolvedCount,
        ),
      };
    }
  }

  return {
    lastEventId: currentEventId,
    walkResult: walkCompleted(resolvedCount, resolvedActionCount),
  };
}

/**
 * R-SHD-01第3項（DMG-004、Issue #194）: このEffectSequence
 * 解決で残量0のまま残ったシールドを、解決の最後に`SHIELD_DEPLETED`として失効させる。
 *
 * 対象になるのは付与時点で既に0だったシールド（Formula結果が負値・0、または
 * R-NUM-02の切り捨てで0）だけである — 吸収で枯渇した分は
 * `damage-application-service.ts`がプールごとにその場で失効させ、漸減で枯渇した分は
 * `action-completion.ts`が同じくその場で失効させるため、ここへは到達しない。
 *
 * 付与直後ではなく解決の最後に行うのは次の2点による。
 *
 * - R-EFF-09のカスケードは「その時点で存在するメンバー」しか収集できない。
 *   production例`SKL_LILY_SINGER_PS2`は同じACTION stepで`SHIELD`(PARENT)→
 *   `ATK_UP`(CHILD)の順に付与するため、付与直後に親を失効させるとCHILDがまだ
 *   存在せず、後から付与されたCHILDだけが親を失って残ってしまう
 * - PS/Memory自身のEffectSequence解決（`onFactEventForPassiveChain`未指定）では、
 *   `EffectApplied`はEffectAction完了時に`EFFECT_RESOLVED`としてdriverへ渡る。
 *   付与と同じEffectAction内で同期失効まで進めると、`EffectApplied`を契機とする
 *   PS/Memoryが「付与直後（シールドが存在する）」状態を一度も観測できない
 *
 * `stealthConsumptions`の失効（この関数の少し上）と同じ2経路の規約を持つ:
 * callbackがあればそれが除去1件ごとに通知し、無ければイベント列を
 * `EFFECT_RESOLVED`としてyieldしてdriverへ委ねる。
 */
function* sweepDepletedShields(
  box: UnitsBox,
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
): Generator<EffectResolutionStep, DomainEventId, void> {
  // R-SUB-01（DMG-005、Issue #190）: 耐久力0で付与されたサブユニットもまったく
  // 同じ理由でここへ含める（吸収で枯渇した分は`damage-application-service.ts`が
  // その場で失効させるため到達しない）。
  const seeds = box.units.flatMap((unit) =>
    unit.appliedEffects
      .filter(
        (effect) =>
          (effect.shield !== undefined && effect.shield.remaining <= 0) ||
          (effect.subUnit !== undefined && effect.subUnit.durability <= 0),
      )
      .map((effect) => ({
        battleUnitId: unit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        reason:
          effect.shield !== undefined
            ? ("SHIELD_DEPLETED" as const)
            : ("SUBUNIT_DEPLETED" as const),
      })),
  );
  if (seeds.length === 0) {
    return parentEventId;
  }
  // 除去1件ごとに`EFFECT_RESOLVED`として`yield`し、driver
  // （AS/EX・チャージ解放は`applyEffectActionGroups`、PS/Memory自身の解決は
  // `passive-activation-service.ts`の`driveActivation`）に即時連鎖の解決を委ねる。
  // `expireEffects`（同期wrapper）はステップを読み捨てるだけで通知しないため、
  // ここでcallbackを渡しても連鎖は起きず、driverの`units`も更新されない。
  const steps = expireEffectsSteps(
    {
      recorder: context.recorder,
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      rootEventId: context.rootEventId,
    },
    box.units,
    seeds,
    context.definitions.effectActions,
    parentEventId,
  );
  let step = steps.next();
  while (!step.done) {
    // driverが`box.units`を書き換える前に、このステップ時点の状態を反映しておく。
    box.units = step.value.units;
    yield { kind: "EFFECT_RESOLVED", events: step.value.events };
    step = steps.next(box.units);
  }
  box.units = step.value.units;
  return step.value.lastEventId;
}

/**
 * R-SKL-01〜R-SKL-08を通じた`EffectSequence`解決のトップレベルgenerator。
 * `plan.steps`を定義順に解決し、`ActionStepPlan`（既定計画済みACTION）は
 * `resolveActionStepBody`へ、`DeferredStepPlan`（BRANCH/RANDOM_BRANCH/REPEAT、
 * またはLAST_RESULT/LAST_*_TARGETSに依存するACTION）は`resolveRawStep`へ
 * それぞれ委譲する。戻り値は`EffectSequenceOutcome`（Issue #217設計方針B）—
 * `COMPLETED`/`INTERRUPTED`は解決が実際に最後まで進んだか、使用者戦闘不能で
 * 打ち切ったかという事実だけから決まり、`unresolvedEffectCount`の値からは
 * 決して導出しない。
 *
 * PSの`EffectSequence`自身の解決（`passive-activation-service.ts`）
 * はこのgeneratorへ`yield*`委譲することで、`resolvePassiveChain`の
 * `driveActivation`が管理する共有state（PassiveResolutionStack・深度Guard・
 * 効果解決数Guard・`interruptedCandidates`）へ正しく参加する。「親A→子PS→親B」
 * の順序（R-PS-06）と、深度/効果解決数Guardのnesting全体での一貫性の両方を
 * 満たすには、PSの`EffectSequence`自身の解決を`resolvePassiveChain`と切り離した
 * 別経路（同期callbackや、独立した`resolvePassiveChain`の再帰呼び出し）で
 * 行ってはならない — 後者は各呼び出しがstack/depth/effectsResolvedを
 * ゼロから開始してしまい、Guardが実効的にnesting全体を見なくなる。
 */
export function* resolveEffectSequencePlan(
  plan: EffectSequencePlan,
  box: UnitsBox,
  incomingContext: EffectActionGroupContext,
): Generator<EffectResolutionStep, EffectActionGroupsResult, void> {
  // R-LNK-01/02（DMG-007、Issue #187）: `APPLY_DAMAGE_LINK.linkTo`の`BINDING`は
  // 付与時点でリンク先ユニットへ解決する必要があるが、EffectAction単位の解決
  // （`resolveOneEffectActionApplication`）は`EffectSequencePlan`を受け取らない。
  // 呼び出し側すべてに解決済みbindingの引き回しを強いる代わりに、この入口で
  // contextへ載せ替えて以降の全経路へ届ける。
  const context: EffectActionGroupContext = {
    ...incomingContext,
    resolvedBindings: plan.resolvedBindings,
  };
  const lastResultState: LastResultState = {
    lastActionTargetUnitIds: [],
    lastDamagedTargetUnitIds: [],
  };
  let lastEventId = context.parentEventId;
  let resolvedCount = 0;

  // R-HIT-03/R-STS-04（M7-004、Issue #183）: スキル使用ごとに1回、使用者
  // （`context.actorId`、AS/EXの実行者・PSの所有者どちらも同じ`SkillUseId`単位）
  // に付与された暗闇を判定する。命中判定より前、対象選択・step解決より前で
  // 一括判定する — いずれか一つでもMISSになれば、このEffectSequence全体の
  // step解決を一切開始しない（「MISSの場合、対象へのダメージと効果を適用
  // しない」、DAMAGE以外のEffectActionも含む）。必中を持つスキルにも適用する
  // （`accuracyMode`を一切参照しない — 呼び出し元のACTION step条件によらず
  // 一律に適用する）。
  // R-MEM-04（Issue #179）: Memory由来の解決には暗闇を持ちうる使用者が存在しない
  // （暗闇は使用者へ付与された`AppliedEffect`から判定するため、判定対象そのものが
  // 無い）。判定自体を行わず、常に命中として扱う。
  const actorForDarkness = findActorUnit(context, box);
  const darkness =
    actorForDarkness === undefined
      ? { checks: [] as const, missed: false }
      : resolveDarkness(actorForDarkness, context.random);
  if (darkness.checks.length > 0) {
    const innerEventsStart = context.recorder.getEvents().length;
    for (const check of darkness.checks) {
      const blindnessCheckResolved = context.recorder.record({
        eventType: "BlindnessCheckResolved",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        ...sourceEnvelopeOf(context),
        payload: {
          effectActionDefinitionId: check.effectActionDefinitionId,
          effectInstanceId: check.effectInstanceId,
          probability: check.probability,
          missed: check.missed,
        },
      });
      lastEventId = blindnessCheckResolved.eventId;
    }
    if (darkness.missed) {
      const skillMissed = context.recorder.record({
        eventType: "SkillMissed",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        ...sourceEnvelopeOf(context),
        payload: {
          skillDefinitionId: requireSkillDefinitionId(context),
          missedByEffectInstanceIds: darkness.checks
            .filter((check) => check.missed)
            .map((check) => check.effectInstanceId),
        },
      });
      lastEventId = skillMissed.eventId;
    }
    // ステルス消費と同じ理由（`onFactEventForPassiveChain`未指定 =
    // PS自身のEffectSequenceが`yield*`委譲されている経路）:
    // `BlindnessCheckResolved`/`SkillMissed`もFACTイベントとしてPS/Memory即時
    // 連鎖の契機になり得るため、同じ二分岐でdriverへ委ねる。
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    } else {
      const innerEvents = context.recorder.getEvents().slice(innerEventsStart);
      yield { kind: "EFFECT_RESOLVED", events: innerEvents };
    }
    if (darkness.missed) {
      return { units: box.units, outcome: { status: "COMPLETED", resolvedEffectCount: 0 } };
    }
  }

  // R-TGT-08「ステルス」（TGT-004、Issue #167）: targetBindings解決時に第一優先
  // 対象として選ばれ候補順の末尾へ移動されたStealth所持者（`AppliedEffect.
  // statusKind === "STEALTH"`）を、実際のstep解決を始める前に一括で消費する
  // （`EffectExpired`/reason:"CONSUMPTION"）。フェーズ2でMarkerState＋
  // `removeMarkers`からAppliedEffect＋`expireEffects`へ移行 — 後者は
  // `linkedEffectGroupId`カスケード・CombatStat再計算も自動で扱うため、
  // production Catalogが将来Stealthをlinked groupの一員として付与する場合も
  // 追加配線なしでR-EFF-09のカスケードが働く。
  // `context.onFactEventForPassiveChain`が未指定の場合
  // （PS自身のEffectSequenceが`passive-activation-service.ts`から`yield*`で
  // 委譲されている経路）は、同期callbackで子PS連鎖を駆動できないため、
  // 消費で発生したイベント列を他のEffectAction内部イベントと同様
  // `EFFECT_RESOLVED`としてyieldし、`resolvePassiveChain`/`driveActivation`側の
  // driverに子PS連鎖の処理を委ねる。`box`は共有可変オブジェクトのため、
  // yieldで一時停止している間にdriverが`box.units`を書き換えれば、
  // resume後の後続処理は自然に最新の`units`を参照する。
  // callbackを持つ経路では、通知は`expireEffects`が
  // 1インスタンスの失効ごとに行う（R-EFF-09カスケードで巻き込まれた
  // 子効果・子Markerを含む）。callback未指定の経路は上記のとおりdriverへ委ねる。
  if (plan.stealthConsumptions.length > 0) {
    const innerEventsStart = context.recorder.getEvents().length;
    const expiry = expireEffects(
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
      box.units,
      plan.stealthConsumptions.map((consumption) => ({
        battleUnitId: consumption.battleUnitId,
        effectInstanceId: consumption.effectInstanceId,
        reason: "CONSUMPTION",
      })),
      context.definitions.effectActions,
      lastEventId,
    );
    box.units = expiry.units;
    lastEventId = expiry.lastEventId;
    if (context.onFactEventForPassiveChain === undefined) {
      const innerEvents = context.recorder.getEvents().slice(innerEventsStart);
      if (innerEvents.length > 0) {
        yield { kind: "EFFECT_RESOLVED", events: innerEvents };
      }
    }
  }

  // 中断で抜けた場合の未解決数。`undefined`なら最後まで解決し切ったことを表す。
  // 中断の`return`を分岐ごとに書くと、step間で中断した
  // 経路（前のstepの最後のEffectActionで使用者が戦闘不能になり、後続stepが
  // 残っている場合）だけ`sweepDepletedShields`を通らず、残量0シールドが
  // `EffectExpired`なしで永続していた。全ての終了経路が必ず掃除を通るよう、
  // ループからは`break`だけで抜けて後始末と`return`を1か所に集約する。
  let interruptedUnresolvedCount: number | undefined;

  for (const step of plan.steps) {
    if (isActorDefeated(context, box)) {
      interruptedUnresolvedCount = 0;
      break;
    }

    const result: { readonly lastEventId: DomainEventId; readonly walkResult: StepWalkResult } =
      step.planKind === "ACTION_PLAN"
        ? yield* resolveActionStepBody(
            step.stepIndex,
            step.conditionKind,
            step.satisfied,
            step.actions,
            step.applications,
            box,
            context,
            lastResultState,
            lastEventId,
          )
        : yield* resolveRawStep(
            step.stepIndex,
            step.definition,
            box,
            context,
            plan,
            lastResultState,
            lastEventId,
          );

    lastEventId = result.lastEventId;
    resolvedCount += result.walkResult.resolvedCount;

    if (result.walkResult.interrupted) {
      interruptedUnresolvedCount = result.walkResult.unresolvedCount;
      break;
    }
  }

  // 正常終了・中断のどちらでも掃除する。付与自体は確定済みの状態変更であり、
  // 残量0のまま残せば期間満了まで居座る（R-SKL-01「解決済みの効果を巻き戻さない」
  // には反しない — 巻き戻しではなく、成立済みの個別消滅条件の実行である）。
  yield* sweepDepletedShields(box, context, lastEventId);

  return interruptedUnresolvedCount !== undefined
    ? {
        units: box.units,
        outcome: {
          status: "INTERRUPTED",
          reason: "ACTOR_DEFEATED",
          resolvedEffectCount: resolvedCount,
          unresolvedEffectCount: interruptedUnresolvedCount,
        },
      }
    : { units: box.units, outcome: { status: "COMPLETED", resolvedEffectCount: resolvedCount } };
}

/**
 * AS/EX使用（`resolveSkillUse`）とチャージ発動（`resolveChargeRelease`）が使う
 * 同期API。`resolveEffectSequencePlan`を駆動し、yieldのたびに
 * `context.onFactEventForPassiveChain`（提供されていれば）を呼んでPS即時連鎖を
 * 同期的に解決する。これらの呼び出し元は`resolvePassiveChain`の`driveActivation`
 * に自身がnestingされることはない（PS発動の起点であり、候補ではない）ため、
 * 各yieldごとに独立した`resolvePassiveChain`呼び出し（`PassiveActivationRuntime.onFactEvent`）
 * で解決してよい。PSの`EffectSequence`自身の解決は`resolveEffectSequencePlan`へ
 * `yield*`委譲する別経路を使う（`passive-activation-service.ts`）。
 */
export function applyEffectActionGroups(
  plan: EffectSequencePlan,
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
): EffectActionGroupsResult {
  const box: UnitsBox = { units };
  const generator = resolveEffectSequencePlan(plan, box, context);
  let step = generator.next();
  while (!step.done) {
    if (context.onFactEventForPassiveChain !== undefined) {
      const events = step.value.kind === "TIMING_EVENT" ? [step.value.event] : step.value.events;
      for (const event of events) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    step = generator.next();
  }
  return step.value;
}
