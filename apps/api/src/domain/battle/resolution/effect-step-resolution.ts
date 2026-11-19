import { requireUnit } from "./action-resolution-shared.js";
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
  type TriggerSkillUseDamage,
} from "../skill/effect-step-condition-evaluator.js";
import { damageResultsFor } from "../skill/formula-evaluator.js";
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
import { resolveEffectActionByKind } from "./effect-action/effect-action-dispatch.js";
import { settleUnfinishedAttackDeathSurvivalsSteps } from "./effect-action/damage-effect-action.js";
import {
  createEffectActionEventCursor,
  driveRemovalSteps,
  type EffectActionApplicationInput,
  type EffectActionOutcome,
} from "./effect-action/effect-action-handler.js";
import {
  buildConsumeEffectDurationHooks,
  createAttackConsumptionScope,
  holdDeathSurvivalsForSubUnitAdditions,
  type AttackConsumptionScope,
} from "./effect-action/effect-duration-consumption.js";
import {
  isActorDefeated,
  resolutionSourceOf,
  sourceEnvelopeOf,
  type EffectActionGroupContext,
  type EffectResolutionStep,
  type UnitsBox,
} from "./effect-action/effect-action-group-context.js";

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
export interface LastResultState {
  current?: LastEffectActionResult;
  lastActionTargetUnitIds: readonly BattleUnitId[];
  lastDamagedTargetUnitIds: readonly BattleUnitId[];
  /**
   * R-SKL-06 #4a: このEffectSequence解決で、DAMAGE定義ごとに1ヒット以上命中を受けた
   * 対象。`lastDamagedTargetUnitIds`と違い直前stepで上書きせず解決全体で積み上げる —
   * `hitCondition`は列内の別対象や後続stepを挟んでも、その対象自身の命中を参照する
   * ためである。MISS（全ヒット回避）と対象不在の`SKIPPED`は記録しない。シールド全吸収や
   * ダメージ無効で0になったヒットも命中であり、`APPLIED`として記録される。
   *
   * 値は「攻撃した元の対象 → そのヒットを実際に受けたユニット」。引き寄せ・肩代わり
   * （R-INT-01/02）が成立すると両者が異なり、命中条件付きの後続効果は後者へ付く。
   */
  readonly hitTargetsByDamageAction: Map<
    EffectActionDefinitionId,
    Map<BattleUnitId, readonly BattleUnitId[]>
  >;
}

/**
 * R-SKL-06 #4a／R-INT-02第2項: 命中条件付きの適用を、実際に適用する対象ごとの適用へ
 * 展開する。条件なしならそのまま、参照先DAMAGEのいずれも元の対象に命中していなければ
 * 空（適用を開始しない）。命中していれば、そのヒットを最終的に受けたユニットへ向け直す
 * — 肩代わりされた攻撃の後続効果は肩代わり者に付く。
 */
function applicationsForHitCondition(
  application: EffectActionApplication,
  lastResultState: LastResultState,
  context: EffectActionGroupContext,
): readonly EffectActionApplication[] {
  if (application.hitCondition === undefined) {
    return [application];
  }
  if ("scope" in application.hitCondition) {
    // 攻撃の後に発動するPSは、肩代わり者ではなく攻撃した元の対象（`TRIGGER_TARGET`と
    // 同じ単位）へ向かう。DAMAGE参照の命中条件と違い、付与先を向け直さない。
    return context.triggerSkillUseHitUnitIds?.has(application.targetUnitId) === true
      ? [application]
      : [];
  }
  const defenders = new Set<BattleUnitId>();
  for (const damageId of application.hitCondition.effectActionDefinitionIds) {
    for (const defender of lastResultState.hitTargetsByDamageAction
      .get(damageId)
      ?.get(application.targetUnitId) ?? []) {
      defenders.add(defender);
    }
  }
  return [...defenders].map((defender) =>
    defender === application.targetUnitId
      ? application
      : {
          ...application,
          targetUnitId: defender,
          hits: application.hits.map((hit) => ({ ...hit, targetUnitId: defender })),
        },
  );
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
export interface StepWalkResult {
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
export interface OneApplicationResult {
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
  /** DAMAGEで命中したヒットを実際に受けたユニット（`EffectActionOutcome`と同じ）。 */
  readonly hitDefenderUnitIds?: readonly BattleUnitId[];
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
 *
 * REF-064／#609: kind別ハンドラ（`effect-action/`）を対象・EffectAction1件単位で
 * 直接exerciseする薄い入口。単体では`EffectActionStarting`/`EffectActionCompleted`
 * だけを発行し、それを包むACTION stepの`EffectStepStarting`/`EffectStepCompleted`は
 * 発行しない（step全体を組み立てず1件のkind適用だけを検証したいテスト向け。
 * step全体の契約を検証するテストは引き続き`applyEffectActionGroups`を使う）。
 * 同期的に駆動するラッパーは`applyOneEffectAction`。
 */
export function* resolveOneEffectActionApplication(
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
  /** R-EFF-07: DAMAGEが属する1回の攻撃の消費状態（{@link EffectActionApplicationInput}）。 */
  attack?: EffectActionApplicationInput["attack"],
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
    targetUnitIds: [application.targetUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      kind: effectAction.kind,
      targetUnitIds: [application.targetUnitId],
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
    isDefeated(requireUnit(box.units, application.targetUnitId))
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
      ...(attack !== undefined ? { attack } : {}),
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
    targetUnitIds: [application.targetUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      effectActionKind: effectAction.kind,
      targetUnitIds: [application.targetUnitId],
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
    ...(outcome.hitDefenderUnitIds !== undefined
      ? { hitDefenderUnitIds: outcome.hitDefenderUnitIds }
      : {}),
    lastResult: {
      resultKind: outcome.resultKind,
      effectActionKind: effectAction.kind,
      effectActionDefinitionId: application.effectActionDefinitionId,
      targetUnitIds: [application.targetUnitId],
      // step全体の合計は`resolveActionApplications`が積み上げて上書きする。
      criticalHitCount: outcome.criticalHitCount,
    },
  };
}

/**
 * REF-064／#609: `resolveOneEffectActionApplication`を同期的に駆動する薄い
 * エントリポイント。`applyEffectActionGroups`と同じ駆動パターン（yieldのたびに
 * `context.onFactEventForPassiveChain`があれば呼ぶ）だが、スコープは
 * ACTION1件・対象1件・EffectAction1件だけ。kind別ハンドラ（`effect-action/`）の
 * 挙動だけを検証したいテストが、`EffectSequencePlan`全体やACTION stepの
 * 組み立てなしに直接呼び出せるようにする。
 */
export function applyOneEffectAction(
  application: EffectActionApplication,
  units: readonly BattleUnit[],
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
  distributionShareCount = 1,
): { readonly units: readonly BattleUnit[]; readonly result: OneApplicationResult } {
  const box: UnitsBox = { units };
  const generator = resolveOneEffectActionApplication(
    application,
    box,
    context,
    parentEventId,
    distributionShareCount,
  );
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
  return { units: box.units, result: step.value };
}

export type StepResolution = Generator<
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
  /**
   * R-SKL-06 #4a／R-INT-02: `deferredTargetCondition`の適用について、実際の付与先が
   * そのstepの`targetCondition`を満たすかを、呼び出し時点の最新`box.units`で判定する。
   */
  recipientFilter?: (recipient: BattleUnit) => boolean,
): StepResolution {
  let lastEventId = startEventId;
  let resolvedCount = 0;
  let resolvedActionCount = 0;
  // 先送りした`targetCondition`の判定結果を「元の対象×実際の付与先」ごとに保持する。
  // 同じ対象への`actions`（マーカーと対応する付随デバフ等）は1つの付与分であり、先行
  // actionの付与が条件の成否を変えても、後続actionだけが欠落してはならない
  // （`SKL_NINA_ZINA_FRONTRUNNER_AS2`: 刻痕3→4個でも今回の刻痕と2つの低下は揃って付く）。
  // 別の元の対象から向け直された付与は別の付与分として改めて判定する。
  const recipientJudgements = new Map<string, boolean>();
  const passesDeferredTargetCondition = (
    original: EffectActionApplication,
    candidate: EffectActionApplication,
    remember: boolean,
  ): boolean => {
    if (candidate.deferredTargetCondition !== true || recipientFilter === undefined) {
      return true;
    }
    const key = `${original.targetUnitId}->${candidate.targetUnitId}`;
    const judged = recipientJudgements.get(key);
    if (judged !== undefined) {
      return judged;
    }
    const passes = recipientFilter(requireUnit(box.units, candidate.targetUnitId));
    if (remember) {
      recipientJudgements.set(key, passes);
    }
    return passes;
  };
  // 命中条件で除外・付与先へ展開し、先送りした`targetCondition`を付与先で評価した、
  // 実際に開始する適用の一覧。`remember`は解決時と、総量を分け合う適用の分母を
  // 決めるときだけ真にする（それ以外の先読みで、まだその対象の順番が来ていない
  // 判定を確定させないため）。
  const recipientsOf = (
    application: EffectActionApplication,
    remember: boolean,
  ): readonly EffectActionApplication[] =>
    applicationsForHitCondition(application, lastResultState, context).filter((candidate) =>
      passesDeferredTargetCondition(application, candidate, remember),
    );
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
      if (application.targetUnitId !== currentTargetId) {
        currentTargetId = application.targetUnitId;
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
    // R-SKL-06 #4a: 命中条件で除外される対象は受け取らず、肩代わり・引き寄せで向け直した
    // 付与先が受け取るため、展開後の実際の付与先を数える。同じACTION内の後続対象の命中は
    // まだ確定していないため、命中条件と分配を同じstepで組み合わせる定義はCatalogロード
    // 時点で拒否する（`UNSUPPORTED_HIT_CONDITION_DISTRIBUTION`）。
    //
    // 総量を分け合う適用は、分母を決めたこの時点で付与先の判定も確定させる。先に配った
    // 分が`targetCondition`の成否を変えても（回復でHP割合の条件が外れる等）、残りの
    // 付与先が欠けて総量が分母より少なく配られることがないようにするためである。分配
    // しない適用では確定させない — 付与分ごとにその対象の順番で判定する規則を保つ。
    const definition = context.definitions.effectActions.get(definitionId);
    const distributes =
      (definition?.kind === "HEAL" && definition.payload.distribution === "EVEN") ||
      (definition?.kind === "MODIFY_RESOURCE" && definition.payload.operation === "DISTRIBUTE");
    const count = applications
      .filter((_, candidateIndex) => shareGroupKeys[candidateIndex] === groupKey)
      .flatMap((candidate) => recipientsOf(candidate, distributes))
      .filter(
        (candidate) =>
          (distributesToDefeatedTargets && candidate.includeDefeated) ||
          !isDefeated(requireUnit(box.units, candidate.targetUnitId)),
      ).length;
    // 呼び出し元は「今まさに適用しようとしている application」の解決直前にだけ
    // これを呼ぶため、その対象自身が数に含まれ`count >= 1`が成り立つ。0での
    // 除算を構造的に防ぐため、それでも0になった場合は1へ丸める。
    const shareCount = Math.max(1, count);
    shareCountByGroup.set(groupKey, shareCount);
    return shareCount;
  };

  // R-EFF-07: 同じDAMAGE参照の適用（対象ごと）は全体で1回の攻撃。分配グループと同じ
  // 参照単位のキーで消費状態を共有し、その参照の最後の適用で遅延させた失効を確定する。
  const attackScopes = new Map<string, AttackConsumptionScope>();
  const stepAttacks: AttackConsumptionScope[] = [];
  const lastIndexByGroup = new Map<string, number>();
  shareGroupKeys.forEach((groupKey, index) => lastIndexByGroup.set(groupKey, index));
  const attackOf = (
    index: number,
    isLastRecipient: boolean,
  ): EffectActionApplicationInput["attack"] => {
    const groupKey = shareGroupKeys[index]!;
    const scope =
      attackScopes.get(groupKey) ?? createAttackConsumptionScope(stepAttacks, box.units);
    attackScopes.set(groupKey, scope);
    return { scope, final: isLastRecipient && lastIndexByGroup.get(groupKey) === index };
  };
  // 攻撃の最後の適用が開始されなかった場合（命中条件で除外・使用者の戦闘不能で中断）も、
  // 0になった効果を次の攻撃へ持ち越さないよう、stepの終わりで失効させる。stepが終われば
  // どの攻撃も続かないため、先に全攻撃を終了扱いにして失効の引き継ぎ先を無くす。
  const flushAttackScopes = function* (): Generator<EffectResolutionStep, void, void> {
    for (const scope of stepAttacks) {
      scope.finished = true;
    }
    for (const scope of stepAttacks) {
      if (
        [...scope.deathSurvivals.values()].some((entry) => !entry.settled) &&
        !holdDeathSurvivalsForSubUnitAdditions(context, scope.deathSurvivals)
      ) {
        const settled = yield* driveRemovalSteps(
          { context, box, cursor: createEffectActionEventCursor(context, box) },
          settleUnfinishedAttackDeathSurvivalsSteps(context, box.units, scope, lastEventId),
        );
        lastEventId = settled.lastEventId;
      }
      if (scope.pendingExpirySeeds.length === 0) {
        continue;
      }
      const { finalizeConsumedEffectDurations } = buildConsumeEffectDurationHooks(context, scope);
      const finalized = yield* driveRemovalSteps(
        { context, box, cursor: createEffectActionEventCursor(context, box) },
        finalizeConsumedEffectDurations(box.units, lastEventId),
      );
      lastEventId = finalized.lastEventId;
    }
  };

  for (let index = 0; index < applications.length; index += 1) {
    // R-SKL-06 #4a: 命中条件を満たさない適用は`targetCondition`で除外された対象と同じく
    // 一切開始しない（イベント・直前結果・解決数のいずれにも現れない）。判定は直前の
    // 適用まで反映した命中履歴で行うため、同じACTION内の先行DAMAGEの結果も見える。
    // R-INT-02第2項: 肩代わり・引き寄せされた攻撃の後続効果は、実際にヒットを受けた
    // ユニットへ向け直す（1つの定義上の適用が、受けたユニットごとの適用になる）。
    const effective = recipientsOf(applications[index]!, true);
    for (let effectiveIndex = 0; effectiveIndex < effective.length; effectiveIndex += 1) {
      const application = effective[effectiveIndex]!;
      const unstartedHits = (): number =>
        countHits(effective.slice(effectiveIndex + 1)) + countHits(applications.slice(index + 1));
      if (isActorDefeated(context, box)) {
        yield* flushAttackScopes();
        finalizeStepTargets();
        return {
          lastEventId,
          walkResult: walkInterrupted(
            resolvedCount,
            resolvedActionCount,
            countHits([application]) + unstartedHits(),
          ),
        };
      }

      const applied = yield* resolveOneEffectActionApplication(
        application,
        box,
        context,
        lastEventId,
        resolveShareCount(index),
        attackOf(index, effectiveIndex === effective.length - 1),
      );
      lastEventId = applied.lastEventId;
      resolvedCount += applied.resolvedCount;

      stepCriticalHitCount += applied.criticalHitCount;

      if (applied.lastResult !== undefined) {
        lastResultState.current = {
          ...applied.lastResult,
          criticalHitCount: stepCriticalHitCount,
        };
        if (!seenActionTargetUnitIds.has(application.targetUnitId)) {
          seenActionTargetUnitIds.add(application.targetUnitId);
          stepActionTargetUnitIds.push(application.targetUnitId);
        }
        if (
          applied.lastResult.resultKind === "APPLIED" &&
          applied.lastResult.effectActionKind === "DAMAGE" &&
          !seenDamagedTargetUnitIds.has(application.targetUnitId)
        ) {
          seenDamagedTargetUnitIds.add(application.targetUnitId);
          stepDamagedTargetUnitIds.push(application.targetUnitId);
        }
        if (
          applied.lastResult.resultKind === "APPLIED" &&
          applied.lastResult.effectActionKind === "DAMAGE"
        ) {
          const hitTargets =
            lastResultState.hitTargetsByDamageAction.get(application.effectActionDefinitionId) ??
            new Map<BattleUnitId, readonly BattleUnitId[]>();
          const defenders = new Set(hitTargets.get(application.targetUnitId) ?? []);
          for (const defender of applied.hitDefenderUnitIds ?? [application.targetUnitId]) {
            defenders.add(defender);
          }
          hitTargets.set(application.targetUnitId, [...defenders]);
          lastResultState.hitTargetsByDamageAction.set(
            application.effectActionDefinitionId,
            hitTargets,
          );
        }
      }

      if (applied.interrupted) {
        yield* flushAttackScopes();
        finalizeStepTargets();
        return {
          lastEventId,
          walkResult: walkInterrupted(
            resolvedCount,
            resolvedActionCount,
            applied.interruptedCount + unstartedHits(),
          ),
        };
      }
      resolvedActionCount += 1;
    }
  }

  yield* flushAttackScopes();
  finalizeStepTargets();
  return { lastEventId, walkResult: walkCompleted(resolvedCount, resolvedActionCount) };
}

/**
 * R-SKL-08 / Catalog preflight（`MISSING_PRECEDING_RESULT`）: 適用を1件も開始せずに
 * 解決を終えたACTION（対象0件、または全適用が命中条件で除外）も、SKIPPED結果を直前結果
 * として記録する。R-SKL-06 #4は対象ごとにactionsを定義順で適用する（対象があれば最後に
 * 処理されるのは定義順で最後のaction）ため、「代表結果」は定義順で最後のaction
 * （`actions[0]`ではなく`actions[actions.length - 1]`）を採用し、対象がいた場合の
 * 処理順と一貫させる。
 */
function recordSkippedStepResult(
  actions: readonly EffectActionReference[],
  context: EffectActionGroupContext,
  lastResultState: LastResultState,
): void {
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
      // ヒットを1つも解決していないため会心も0件（`POST_DAMAGE_CRITICAL_BRANCH`、
      // DMG-003、Issue #196）。
      criticalHitCount: 0,
    };
  }
  lastResultState.lastActionTargetUnitIds = [];
  lastResultState.lastDamagedTargetUnitIds = [];
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
export function* resolveActionStepBody(
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
    readonly recipientFilter?: (recipient: BattleUnit) => boolean;
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
    recordSkippedStepResult(actions, context, lastResultState);
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
    resolved?.recipientFilter,
  );
  if (applied.walkResult.interrupted) {
    return applied;
  }
  // R-SKL-06 #4a: 対象はいたが全ての適用が命中条件（と付与先の`targetCondition`）で
  // 除外された場合も、対象0件と同じくSKIPPEDを直前結果として記録する。
  if (applied.walkResult.resolvedActionCount === 0) {
    recordSkippedStepResult(actions, context, lastResultState);
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
        ...(context.triggerProcessedTargetUnitIds !== undefined
          ? { triggerProcessedTargetUnitIds: context.triggerProcessedTargetUnitIds }
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
        triggerSkillUseDamageOf(context),
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
export function* resolveRawStep(
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
          readonly recipientFilter?: (recipient: BattleUnit) => boolean;
        } => {
          const actor = resolutionSourceOf(context, box);
          const triggerContext = {
            ...(context.triggerSourceUnitId !== undefined
              ? { triggerSourceUnitId: context.triggerSourceUnitId }
              : {}),
            ...(context.triggerTargetUnitIds !== undefined
              ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
              : {}),
            ...(context.triggerProcessedTargetUnitIds !== undefined
              ? { triggerProcessedTargetUnitIds: context.triggerProcessedTargetUnitIds }
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
            triggerSkillUseDamageOf(context),
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
          // R-SKL-06 #4a／R-INT-02: 先送りした`targetCondition`は、適用直前の最新状態で
          // 実際の付与先について評価する（先行する付与が条件の成否を変え得るため）。
          const lastResultAtStart = lastResultState.current;
          const recipientFilter =
            step.targetCondition.kind === "TRUE"
              ? undefined
              : (recipient: BattleUnit): boolean =>
                  buildEffectStepPerTargetFilter(
                    step,
                    plan.resolvedBindings,
                    actor,
                    box.units,
                    context.definitions.unitDefinitions,
                    lastResultAtStart,
                    lastResultTargets,
                    triggerContext,
                  )(recipient);
          return {
            satisfied: true,
            applications,
            ...(recipientFilter !== undefined ? { recipientFilter } : {}),
          };
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
        ...(context.triggerProcessedTargetUnitIds !== undefined
          ? { triggerProcessedTargetUnitIds: context.triggerProcessedTargetUnitIds }
          : {}),
      };
      const satisfied = evaluateEffectStepCondition(
        step.stepCondition,
        lastResultState.current,
        undefined,
        undefined,
        undefined,
        context.triggerEventPayload,
        triggerSkillUseDamageOf(context),
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
 * R-SUB-02（Issue #836）: そのstep定義がDAMAGEを解決しうるか。分岐の腕・繰り返しの中も含め、
 * 定義の中に現れるEffectAction参照のどれかがDAMAGEなら真（通りうるものは含める）。
 */
export function stepDefinitionMayContainDamage(
  node: unknown,
  context: EffectActionGroupContext,
): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => stepDefinitionMayContainDamage(child, context));
  }
  if (node === null || typeof node !== "object") {
    return false;
  }
  return Object.entries(node).some(([key, value]) =>
    key === "effectActionDefinitionId"
      ? typeof value === "string" &&
        context.definitions.effectActions.get(value as EffectActionDefinitionId)?.kind === "DAMAGE"
      : stepDefinitionMayContainDamage(value, context),
  );
}

/**
 * R-SKL-08（`TRIGGER_SKILL_USE_DAMAGE`）: PS所有者が契機のスキル使用全体で与えた・受けた
 * 計算ダメージの合計。契機がスキル使用に属さない解決（AS/EX・Memory等）では`undefined`。
 */
function triggerSkillUseDamageOf(
  context: EffectActionGroupContext,
): TriggerSkillUseDamage | undefined {
  if (context.actorUnitId === undefined || context.triggerSkillUseId === undefined) {
    return undefined;
  }
  const totals = damageResultsFor(
    context.damageResults ?? new Map(),
    context.actorUnitId,
    undefined,
    context.triggerSkillUseId,
  );
  return {
    DEALT: totals.TRIGGER_SKILL_USE_DAMAGE_DEALT ?? 0,
    RECEIVED: totals.TRIGGER_SKILL_USE_DAMAGE_RECEIVED ?? 0,
  };
}
