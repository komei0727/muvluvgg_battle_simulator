import { requireUnit } from "./action-resolution-shared.js";
import { applyCooldownManipulationAction } from "./cooldown-manipulation-application-service.js";
import {
  applyDamageAction,
  type DamageEventContext,
} from "../combat/damage-application-service.js";
import { grantEffect } from "../effects/effect-grant-service.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { removeMarkers } from "../effects/marker-removal-service.js";
import { recalculateCombatStats } from "../effects/combat-stat-recalculation-service.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffects,
  type ExpirationSeed,
} from "../effects/duration-expiry-service.js";
import { consumeEffectDurations } from "../model/applied-effect-duration.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import {
  buildEffectStepPerTargetFilter,
  buildTargetSetResolver,
  resolveActionStepApplications,
  type EffectActionApplication,
  type EffectSequencePlan,
  type LastResultTargetContext,
} from "../skill/skill-resolution-service.js";
import {
  conditionReferencesStepTarget,
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
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent, EffectActionResultKind } from "../events/domain-event.js";
import type { SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";
import {
  evaluateFormula,
  lastDamageResultsFor,
  type LastDamageResultRegistry,
} from "../skill/formula-evaluator.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `resolveSkillOrder`/`resolveChargeReleaseOrder`が計画した`EffectSequencePlan`を
 * 解決するために共有される因果関係コンテキスト。`action-skill-use-resolver.ts`
 * （AS/EX使用、チャージ発動）と`passive-activation-service.ts`（PS発動）の両方が
 * 使う。両者の間で循環importを起こさないよう、`applyEffectActionGroups`自体は
 * 独立したこのファイルへ置く。
 */
export interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  readonly actorId: BattleUnitId;
  readonly random: RandomSource;
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** PSがターン開始・終了など行動外のトップレベルイベントから発動した場合は`undefined`。 */
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly actionScope: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly skillDefinitionId: SkillDefinitionId;
  /**
   * Issue #34/#73: FACT/TIMINGイベント確定直後にPS即時連鎖を解決するフック
   * （未指定ならPS解決を行わない）。`applyDamageAction`/`applyCooldownManipulationAction`
   * のヒット単位フックへそのまま素通しされる。step/action単位のイベントに
   * ついては`applyEffectActionGroups`（同期API）だけがこれを使う —
   * `resolveEffectSequencePlan`（PSのEffectSequence自身の解決が`yield*`で
   * 委譲するgenerator）はこのフィールドを無視し、代わりに`resolvePassiveChain`の
   * `driveActivation`が共有stateで即時連鎖を解決する（PR #142レビュー[P1]）。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-SKL-08（レビュー再指摘[P1]、PR #214）: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
   * が参照する「同じ解決スコープ内の直前DAMAGE結果」を保持する共有registry。
   * 呼び出し側（`action-skill-use-resolver.ts`/`action-charge-resolver.ts`）が
   * 1解決スコープ（1行動）ごとに新規生成し、`PassiveActivationRuntime`経由の
   * PS連鎖もこの同じインスタンスを使い回す。未指定ならこのFormulaを持つ
   * EffectActionは`FormulaEvaluator`が明確な例外で拒否する。
   */
  readonly lastDamageResults?: LastDamageResultRegistry;
  /**
   * CAP_TRIGGER_CONTEXT（RES-005、Issue #172）: このPSを発動させた原因イベントの
   * 発生源・対象の`BattleUnitId`。`TargetReference.kind: TRIGGER_SOURCE`/
   * `TRIGGER_TARGET`（DEFERRED stepのJIT解決、`resolveRawStep`）と、
   * `FormulaSourceReference.kind: TRIGGER_SOURCE`/`TRIGGER_TARGET`
   * （`APPLY_STAT_MOD`等のFormula評価）の両方がこれを参照する。AS/EX使用や
   * 行動外トップレベルイベントから解決する場合は原因イベントが存在しないため
   * `undefined`のまま素通しする。
   *
   * PRレビュー指摘[P2]: `BattleUnit`そのものではなくIDだけを保持する — 先行する
   * EffectActionや`EffectActionStarting`起点の子PS連鎖が対象のHP・combatStats
   * を変更した後も、Formula評価やDAMAGE解決の各時点で`box.units`/`working`から
   * 都度引き直すことで、古いスナップショットを読まないようにするため。
   */
  readonly triggerSourceUnitId?: BattleUnitId;
  readonly triggerTargetUnitIds?: readonly BattleUnitId[];
}

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
       * Issue #217設計方針C（案1、厳密値のみを公開）／レビュー指摘[P2]
       * （PR #218 2度目の再レビュー）: 中断が起きた時点で実際に開いていた
       * ACTION適用一覧のうち、未処理のまま残った「効果単位」数の厳密値。
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

/**
 * PR #142レビュー[P1]再発防止: `EffectSequencePlan`の解決中の`units`最新状態を、
 * generatorのyield/resume境界をまたいで共有するための可変箱
 * （`PassiveActivationRuntime.units`と同じ役割）。子PSがこの解決の途中で
 * 発動してunitsを書き換えた場合、次のyield再開時にその変更を反映できる
 * ようにする（generatorの`.next(value)`引数は`resolvePassiveChain`側が使わない
 * ため、closure越しの共有可変状態として持つ）。
 */
export interface UnitsBox {
  units: readonly BattleUnit[];
}

/**
 * PR #142レビュー[P1]: `resolvePassiveChain`が期待する`PassiveActivationStep`
 * （`triggering/resolve-passive-chain.ts`）と同型だが、`TriggerCandidateEvent`
 * ではなく完全な`BattleDomainEvent`を運ぶ。`passive-activation-service.ts`が
 * `toTriggerEvent`で変換しながら`resolvePassiveChain`へそのまま`yield`できる。
 */
export type EffectResolutionStep =
  | { readonly kind: "TIMING_EVENT"; readonly event: BattleDomainEvent }
  | { readonly kind: "EFFECT_RESOLVED"; readonly events: readonly BattleDomainEvent[] };

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

/**
 * レビュー再々指摘[P1]（PR #209）: `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`
 * は「効果ownerが次に攻撃/攻撃対象になった時点」で消費するが（R-EFF-07）、
 * `14_Catalog定義スキーマ.md`「上限に到達した効果は、該当するEffectActionの
 * 解決後に失効する」契約により、実際の除去・CombatStat再計算はその攻撃
 * （EffectAction）自身の解決が終わるまで遅延させる必要がある。即時に除去
 * すると、その効果が本来押し上げるはずの会心率・攻撃力・防御力等が、まさに
 * その効果を消費させた攻撃自身の計算から失われてしまう（実Catalogの
 * `ACT_FEE_ACTOR_PS1_CRIT_UP`/`ACT_LAURA_MOUNTAIN_PS1_ATK_BUFF`等、
 * `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`を持つ`APPLY_STAT_MOD`が該当）。
 * `OUTGOING_HIT`/`INCOMING_HIT`はヒット確定後に消費するため、消費時点で
 * そのヒット自身の計算は既に終わっており、この遅延は不要（即時失効のまま）。
 */
const DEFERRED_EXPIRY_CONSUMPTION_KINDS: ReadonlySet<ConsumptionKind> = new Set([
  "NEXT_OUTGOING_ATTACK",
  "NEXT_INCOMING_ATTACK",
]);

/**
 * R-EFF-07: `damage-application-service.ts`（`combat/`）が`effects/`へ直接
 * 依存できない（Domain層のmodule境界、`onFactEventForPassiveChain`と同じ
 * 理由）ため、`DamageEventContext.consumeEffectDuration`/
 * `finalizeConsumedEffectDurations`として注入する一対のクロージャを組み立てる。
 * `DEFERRED_EXPIRY_CONSUMPTION_KINDS`に属するkindの消費で0になったインスタンス
 * は即座には失効させず、`pendingExpirySeeds`へ貯めておき、
 * `finalizeConsumedEffectDurations`（呼び出し側が1回の`applyDamageAction`＝
 * 1EffectActionの全ヒット解決後に1回だけ呼ぶ）でまとめて失効させる。
 */
function buildConsumeEffectDurationHooks(context: EffectActionGroupContext): {
  readonly consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]>;
  readonly finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  >;
} {
  const pendingExpirySeeds: ExpirationSeed[] = [];
  const eventContext = {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    rootEventId: context.rootEventId,
  };

  const consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]> = (
    ownerUnitId,
    kind,
    units,
    callParentEventId,
  ) => {
    const consumption = consumeEffectDurations(units, ownerUnitId, kind);
    if (consumption.changes.length === 0) {
      return { units, lastEventId: callParentEventId };
    }
    const lastEventId = emitEffectConsumptionChangedEvents(
      eventContext,
      consumption.units,
      consumption.changes,
      callParentEventId,
    );
    const seeds: ExpirationSeed[] = consumption.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        battleUnitId: change.battleUnitId,
        effectInstanceId: change.effectInstanceId,
        reason: "CONSUMPTION",
      }));
    if (seeds.length === 0) {
      return { units: consumption.units, lastEventId };
    }
    if (DEFERRED_EXPIRY_CONSUMPTION_KINDS.has(kind)) {
      pendingExpirySeeds.push(...seeds);
      return { units: consumption.units, lastEventId };
    }
    const expiry = expireEffects(
      eventContext,
      consumption.units,
      seeds,
      context.definitions.effectActions,
      lastEventId,
    );
    return { units: expiry.units, lastEventId: expiry.lastEventId };
  };

  const finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  > = (units, parentEventId) => {
    if (pendingExpirySeeds.length === 0) {
      return { units, lastEventId: parentEventId };
    }
    const seeds = pendingExpirySeeds.splice(0, pendingExpirySeeds.length);
    const expiry = expireEffects(
      eventContext,
      units,
      seeds,
      context.definitions.effectActions,
      parentEventId,
    );
    return { units: expiry.units, lastEventId: expiry.lastEventId };
  };

  return { consumeEffectDuration, finalizeConsumedEffectDurations };
}

/** R-SKL-06 #5: DAMAGE適用結果からEffectActionCompletedのresultKindを導く。 */
function damageResultKind(
  targetAlreadyDefeated: boolean,
  interrupted: boolean,
  anyHitApplied: boolean,
): EffectActionResultKind {
  if (interrupted) {
    return "INTERRUPTED";
  }
  if (targetAlreadyDefeated) {
    return "SKIPPED";
  }
  return anyHitApplied ? "APPLIED" : "MISSED";
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
   */
  readonly lastResult?: LastEffectActionResult;
}

/**
 * R-SKL-06「ACTION step」#3〜#5を対象1件・EffectAction1件単位で適用するgenerator。
 * `EffectActionStarting`を`TIMING_EVENT`として`yield`し、DAMAGE/COOLDOWN_MANIPULATION
 * 適用完了後に`EffectActionCompleted`を`EFFECT_RESOLVED`として`yield`する。
 * `context.onFactEventForPassiveChain`が未指定（PSのEffectSequence自身の解決、
 * `resolveEffectSequencePlan`への`yield*`委譲経路）の場合は、ヒット単位フックが
 * 働かない代わりに、DAMAGE/COOLDOWN_MANIPULATION適用中に記録された内部イベント
 * （`HitConfirmed`〜`DamageApplied`[`/UnitDefeated`]、`CooldownReduced`
 * [`/CooldownCompleted`]）を発生順にこの`EFFECT_RESOLVED.events`へ含める
 * （PR #142再レビュー[P1]: これらのイベントを契機とする子PSが、この関数の
 * 呼び出し元が次のEffectActionへ進む前に完全に解決される）。
 * `onFactEventForPassiveChain`が指定されている経路（AS/EX・チャージ解放）では
 * それらのイベントを既にヒット単位で同期解決済みのため、二重処理を避けて
 * `EffectActionCompleted`だけを`events`に含める。
 * 駆動側はyieldのたびに子PS連鎖を解決してから再開し、`box.units`をその場で
 * 最新化する（`08_ドメインイベント.md`「TIMINGイベント後の再検証」）。
 */
function* resolveOneEffectActionApplication(
  application: EffectActionApplication,
  box: UnitsBox,
  context: EffectActionGroupContext,
  parentEventId: DomainEventId,
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
    sourceUnitId: context.actorId,
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
  if (isDefeated(requireUnit(box.units, context.actorId))) {
    return {
      lastEventId: starting.eventId,
      resolvedCount: 0,
      interruptedCount: application.hits.length,
      interrupted: true,
    };
  }

  let resultKind: EffectActionResultKind;
  let resolvedCount: number;
  let interruptedCount: number;
  // PR #142レビュー[P2]: `EffectActionCompleted.parentEventId`は
  // `EffectActionStarting`固定ではなく、DAMAGE/COOLDOWN_MANIPULATIONが実際に
  // 記録した最後のイベント（`DamageApplied`/`UnitDefeated`/`CooldownCompleted`
  // 等）を指す必要がある。
  let effectLastEventId: DomainEventId;
  // PR #142再レビュー[P1]: PS自身のEffectSequence解決（`context.onFactEventForPassiveChain`
  // 未指定）では、DAMAGE/COOLDOWN_MANIPULATIONのヒット単位フックが働かない
  // ため、ここで発行された内部イベント（`HitConfirmed`〜`DamageApplied`
  // [`/UnitDefeated`]、`CooldownReduced`[`/CooldownCompleted`]）を捕捉し、
  // `EffectActionCompleted`と同じ`EFFECT_RESOLVED`へ含めて発生順にyieldする。
  // これらのイベントを契機とする子PSが、次のEffectActionより前に
  // `resolvePassiveChain`のdriveActivationから解決される。AS/EX・チャージ
  // 解放（`onFactEventForPassiveChain`が指定されている経路）では、ヒット単位
  // フックが既にこれらを同期的に解決済みのため、二重処理を避けてここでは
  // 含めない。
  const innerEventsStart = context.recorder.getEvents().length;

  // R-ACTN-01 #2（RES-002、Issue #174、全Action種別の共通契約、レビュー指摘
  // [P2] PR #215）: 対象が既に戦闘不能であり、戦闘不能者を対象にできる明示指定
  // （`application.includeDefeated`、選択元`TargetSelectorDefinition.
  // includeDefeated`から`skill-resolution-service.ts`が運ぶ）がない場合は
  // 種別を問わず適用しない。DAMAGEはこの分岐を経由せず`applyDamageAction`へ
  // そのまま進む — 同関数がヒット単位（対象が解決の途中で戦闘不能になる場合を
  // 含む）で`includeDefeated`（下で`context.includeDefeated`として引き渡す）を
  // 同じ契約に沿って判定し、`lastDamageResults`への0記録もそちら側の責務のため
  // ここでは対象としない（二重処理防止）。
  if (
    effectAction.kind !== "DAMAGE" &&
    !application.includeDefeated &&
    isDefeated(requireUnit(box.units, application.targetBattleUnitId))
  ) {
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = starting.eventId;
    resultKind = "SKIPPED";
  } else if (effectAction.kind === "DAMAGE") {
    const currentActor = requireUnit(box.units, context.actorId);
    // R-ACTN-01 #2（レビュー再指摘[P2]、PR #215）: `includeDefeated`が明示された
    // 対象は、開始時点で戦闘不能であっても`applyDamageAction`がヒットを適用する
    // ため、resultKind算出上も「既に戦闘不能」として扱わない。
    const targetAlreadyDefeated =
      !application.includeDefeated &&
      isDefeated(requireUnit(box.units, application.targetBattleUnitId));
    const { consumeEffectDuration, finalizeConsumedEffectDurations } =
      buildConsumeEffectDurationHooks(context);
    const damageResult = applyDamageAction(
      currentActor,
      application.hits,
      effectAction,
      box.units,
      context.random,
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: starting.eventId,
        skillDefinitionId: context.skillDefinitionId,
        consumeEffectDuration,
        finalizeConsumedEffectDurations,
        includeDefeated: application.includeDefeated,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
        ...(context.lastDamageResults !== undefined
          ? { lastDamageResults: context.lastDamageResults }
          : {}),
        ...(context.triggerSourceUnitId !== undefined
          ? { triggerSourceUnitId: context.triggerSourceUnitId }
          : {}),
        ...(context.triggerTargetUnitIds !== undefined
          ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
          : {}),
      },
    );
    box.units = damageResult.units;
    resolvedCount = application.hits.length - damageResult.interruptedCount;
    interruptedCount = damageResult.interruptedCount;
    effectLastEventId = damageResult.lastEventId;
    resultKind = damageResultKind(
      targetAlreadyDefeated,
      damageResult.interruptedCount > 0,
      damageResult.hits.some((hit) => hit.applied),
    );
  } else if (effectAction.kind === "COOLDOWN_MANIPULATION") {
    const cooldownResult = applyCooldownManipulationAction(
      application.hits,
      effectAction,
      box.units,
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
        parentEventId: starting.eventId,
        sourceUnitId: context.actorId,
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
    );
    box.units = cooldownResult.units;
    // COOLDOWN_MANIPULATIONは使用者戦闘不能による中断の対象外（Issue #129
    // 時点で自傷を伴わない純粋な状態操作のため）。全件解決済みとして数える。
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = cooldownResult.lastEventId;
    resultKind = cooldownResult.changed ? "APPLIED" : "SKIPPED";
  } else if (effectAction.kind === "APPLY_STAT_MOD") {
    // R-EFF-01: 継続stat補正をAppliedEffectとして個別に付与する（レジストリ
    // 追加・`EffectApplied`・StateDelta・独立Reducer復元まで）。`stacking.mode`は
    // 現状"STACKABLE"しかCatalogスキーマに存在しないため、重複あり
    // (duplicate: true)として扱う（`applied-effect.ts`のコメント参照）。
    // R-EFF-05/R-STA-02〜04: 付与直後にCombatStatを再計算し、実際に変化した
    // statごとに`CombatStatChanged`を、重複なしグループの採用対象が変わった
    // 場合は`EffectiveEffectChanged`も発行する
    // （`combat-stat-recalculation-service.ts`）。EFF-003（Issue #159）で
    // ACTION/TURN期間の減算・消費条件・特殊失効・`EffectExpired`・除去の実
    // ライフサイクル（`action-completion.ts`/`battle.ts`/
    // `damage-application-service.ts`が呼ぶ`duration-expiry-service.ts`）が
    // 完成したため、`CAP_STAT_MOD`は`capabilities.json`で`IMPLEMENTED`に
    // 変わっている — 期間付きStat Modifierも正しく失効・除去される。
    // R-NUM-04: `triggerSource`/`triggerTarget`はRES-005（Issue #172）が
    // `context.triggerSourceUnitId`/`triggerTargetUnitIds`（`TRIGGER_TARGET`は
    // 複数ユニットを指しうるが、Formula側は単一参照のため先頭の1体を使う、
    // R-TGT-10と同じ規約）から配線する。`bindings`はこの呼び出し元では引き続き
    // 用意できない。production CatalogのAPPLY_STAT_MOD Formulaは現時点で
    // SKILL_SOURCE参照のみを使うため、`bindings`を要求するFormulaは
    // `FormulaEvaluator`が明確な例外で拒否する。`lastResults`（R-SKL-08、
    // レビュー再指摘[P1] PR #214）は
    // `context.lastDamageResults`（呼び出し側が1解決スコープごとに新規生成する
    // 共有registry、`damage-application-service.ts`と同じもの）から使用者自身の
    // 直前DAMAGE結果だけを取り出す（`SUM_*`は現時点で参照するproduction定義が
    // ないため未配線のまま、RES-002/RES-003、Issue #174/#173）。
    // PRレビュー指摘[P2]: `triggerSourceUnitId`/`triggerTargetUnitIds`はIDの
    // ままここまで運び、評価するこの瞬間の`box.units`から引き直す — PS開始時に
    // 一度だけ解決した`BattleUnit`を保持すると、先行するEffectActionや子PS連鎖
    // による対象のHP・combatStats変更をこのFormulaが見落としてしまうため。
    const actor = requireUnit(box.units, context.actorId);
    const triggerTargetUnitId = context.triggerTargetUnitIds?.[0];
    const magnitude = evaluateFormula(effectAction.payload.formula, {
      skillSource: actor,
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      lastResults: lastDamageResultsFor(context.lastDamageResults, actor.battleUnitId),
      ...(context.triggerSourceUnitId !== undefined
        ? { triggerSource: requireUnit(box.units, context.triggerSourceUnitId) }
        : {}),
      ...(triggerTargetUnitId !== undefined
        ? { triggerTarget: requireUnit(box.units, triggerTargetUnitId) }
        : {}),
    });
    const beforeGrantUnits = box.units;
    const grantResult = grantEffect(
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
      {
        effectActionDefinitionId: application.effectActionDefinitionId,
        sourceId: context.actorId,
        targetId: application.targetBattleUnitId,
        duplicate: true,
        magnitude,
        durationDefinition: effectAction.payload.duration,
      },
      starting.eventId,
    );
    box.units = grantResult.units;
    const recalculation = recalculateCombatStats(
      {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
      },
      beforeGrantUnits,
      box.units,
      application.targetBattleUnitId,
      context.definitions.effectActions,
      grantResult.lastEventId,
      "EFFECT_APPLIED",
    );
    box.units = recalculation.units;
    // `grantEffect`/`recalculateCombatStats`は`applyDamageAction`/
    // `applyCooldownManipulationAction`と異なりヒット単位のPS連鎖フックを
    // 持たないため、記録した`EffectApplied`/`EffectiveEffectChanged`/
    // `CombatStatChanged`をここで`onFactEventForPassiveChain`へ転送する
    // （AS/EX経路のみ。PS自身のEffectSequence解決経路では`innerEvents`が
    // 同じ役割を果たす）。
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = recalculation.lastEventId;
    resultKind = "APPLIED";
  } else if (effectAction.kind === "APPLY_MARKER") {
    // R-EFF-10: ADD/KEEP_EXISTING/REFRESH/REPLACEのスタック方針を対象1件・
    // Marker1件単位で適用する（`marker-apply-service.ts`）。`APPLY_MARKER`は
    // `APPLY_STAT_MOD`と異なりFormulaを持たない — スタック量は常に1（ADDは
    // 既存スタックへの+1、REPLACE/新規付与は常にスタック1から始まる）。
    const applyResult = applyMarker(
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
      {
        markerId: effectAction.payload.markerId,
        sourceId: context.actorId,
        targetId: application.targetBattleUnitId,
        stackPolicy: effectAction.payload.stack.policy,
        stackMax: effectAction.payload.stack.max,
        durationDefinition: effectAction.payload.duration,
      },
      starting.eventId,
    );
    box.units = applyResult.units;
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = applyResult.lastEventId;
    resultKind = "APPLIED";
  } else if (effectAction.kind === "REMOVE_MARKER") {
    // R-EFF-10「Marker の解除は既存の REMOVE_MARKER（markerId 指定）を使う」
    // （`14_Catalog定義スキーマ.md`）: 対象が指定Markerを所持していない場合は
    // no-op（`COOLDOWN_MANIPULATION`のREADY skillと同じ扱い、resultKind: SKIPPED）。
    const target = requireUnit(box.units, application.targetBattleUnitId);
    const existingMarker = target.markerStates.find(
      (marker) => marker.markerId === effectAction.payload.markerId,
    );
    if (existingMarker === undefined) {
      effectLastEventId = starting.eventId;
      resultKind = "SKIPPED";
    } else {
      const removalResult = removeMarkers(
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
        [
          {
            battleUnitId: application.targetBattleUnitId,
            markerInstanceId: existingMarker.markerInstanceId,
            reason: "REMOVED",
          },
        ],
        starting.eventId,
      );
      box.units = removalResult.units;
      effectLastEventId = removalResult.lastEventId;
      resultKind = "APPLIED";
    }
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    resolvedCount = application.hits.length;
    interruptedCount = 0;
  } else {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `EffectAction kind other than "DAMAGE"/"COOLDOWN_MANIPULATION"/"APPLY_STAT_MOD"/"APPLY_MARKER"/"REMOVE_MARKER" is not supported by this basic turn action resolver (M6/M7/M8 scope)`,
    );
  }

  const innerEvents =
    context.onFactEventForPassiveChain === undefined
      ? context.recorder.getEvents().slice(innerEventsStart)
      : [];

  const completed = context.recorder.record({
    eventType: "EffectActionCompleted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: effectLastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    targetUnitIds: [application.targetBattleUnitId],
    payload: {
      effectActionDefinitionId: application.effectActionDefinitionId,
      effectActionKind: effectAction.kind,
      targetUnitIds: [application.targetBattleUnitId],
      resultKind,
    },
  });
  yield { kind: "EFFECT_RESOLVED", events: [...innerEvents, completed] };

  return {
    lastEventId: completed.eventId,
    resolvedCount,
    interruptedCount,
    interrupted: resultKind === "INTERRUPTED",
    lastResult: {
      resultKind,
      effectActionKind: effectAction.kind,
      effectActionDefinitionId: application.effectActionDefinitionId,
      targetUnitIds: [application.targetBattleUnitId],
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
    sourceUnitId: context.actorId,
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
    sourceUnitId: context.actorId,
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

  const finalizeStepTargets = (): void => {
    lastResultState.lastActionTargetUnitIds = stepActionTargetUnitIds;
    lastResultState.lastDamagedTargetUnitIds = stepDamagedTargetUnitIds;
  };

  for (let index = 0; index < applications.length; index += 1) {
    const application = applications[index]!;
    if (isDefeated(requireUnit(box.units, context.actorId))) {
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
    );
    lastEventId = applied.lastEventId;
    resolvedCount += applied.resolvedCount;

    if (applied.lastResult !== undefined) {
      lastResultState.current = applied.lastResult;
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
 * `resolveAfterTiming`（CAP_EFFECT_STEP_CONDITION、Issue #171 RES-004後半、
 * PRレビュー[P1]）: 対象別条件（自身のtargetを参照するTARGET_STATE/
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

  // TIMINGイベント後の再検証（R-SKL-01）。PRレビュー[P2]（Issue #171、2回目の
  // レビュー）: `resolveAfterTiming`（対象別条件の再評価）より前に行う —
  // `EffectStepStarting`由来の連鎖で使用者が戦闘不能になった場合、
  // `08_ドメインイベント.md`の契約上まだEffectActionが1件も開始していない
  // ため、対象別条件を評価してapplicationsを構築すること自体をせず
  // （`unresolvedEffectCount`へ計上せず）`INTERRUPTED`とする。
  if (isDefeated(requireUnit(box.units, context.actorId))) {
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
      sourceUnitId: context.actorId,
      payload: { stepIndex, conditionKind, result: false },
    });
    return { lastEventId: stepSkipped.eventId, walkResult: walkCompleted(0, 0) };
  }

  if (effectiveApplications.length === 0) {
    // R-SKL-08 / Catalog preflight（`MISSING_PRECEDING_RESULT`）: 対象0件まで
    // 解決へ到達したACTIONも、仕様どおりSKIPPED結果を直前結果として記録する。
    // レビュー指摘[P2]（PR #218）: R-SKL-06 #4は対象ごとにactionsを定義順で
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

  if (isDefeated(requireUnit(box.units, context.actorId))) {
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
      const actor = requireUnit(box.units, context.actorId);
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
          sourceUnitId: context.actorId,
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

        if (isDefeated(requireUnit(box.units, context.actorId))) {
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
        if (isDefeated(requireUnit(box.units, context.actorId))) {
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

        if (isDefeated(requireUnit(box.units, context.actorId))) {
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
        if (isDefeated(requireUnit(box.units, context.actorId))) {
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
      // CAP_EFFECT_STEP_CONDITION（Issue #171 RES-004後半、PRレビュー[P1]）:
      // conditionが自身のtargetを参照するTARGET_STATE/TARGET_HAS_MARKERを
      // 含む場合、その評価はこのstep自身の`EffectStepStarting`（TIMING）が
      // 誘発しうるPS/Memory連鎖がMarker・HP・リソース等を変更した後の最新の
      // `box.units`で行う必要がある。事前に（`EffectStepStarting`発行前に）
      // 評価すると、その連鎖による変更を一切反映できない。そのため対象別
      // 条件を持つACTIONは`satisfied`/`applications`を即座に確定させず、
      // `resolveActionStepBody`へ「TIMINGイベント後に呼び出す再評価関数」を
      // 渡す（`isEagerActionStep`が同じ理由でこの種のstepを常にDeferredへ
      // 回すため、ここへ来るのはJIT解決経路だけ）。
      // CAP_EFFECT_STEP_SET_CONDITION（Issue #227 RES-004集合条件、PRレビュー[P1]）:
      // TARGET_SET_COUNTを含む条件も、対象別条件と同じ理由（このstep自身の
      // `EffectStepStarting`が誘発しうるPS/Memory連鎖後の最新状態を反映する
      // 必要がある）で`resolveAfterTiming`経路へ回す。ここより前に評価して
      // しまうと、`EffectStepStarting`発行→戦闘不能再検証の後で対象集合の
      // 最後の生存者が倒された場合でも、古い`satisfied: true`のままACTIONの
      // actionsが適用されてしまう。
      if (
        conditionReferencesStepTarget(step.condition, step.target) ||
        conditionReferencesTargetSetCount(step.condition)
      ) {
        const resolveAfterTiming = (): {
          readonly satisfied: boolean;
          readonly applications: readonly EffectActionApplication[];
        } => {
          const actor = requireUnit(box.units, context.actorId);
          const triggerContext = {
            ...(context.triggerSourceUnitId !== undefined
              ? { triggerSourceUnitId: context.triggerSourceUnitId }
              : {}),
            ...(context.triggerTargetUnitIds !== undefined
              ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
              : {}),
          };
          const lastResultTargets = lastResultTargetsContext(lastResultState, box.units);

          // PRレビュー[P2]再々々指摘（Issue #227）: 対象別条件（TARGET_STATE/
          // TARGET_HAS_MARKERが自身のtargetを参照する、"対象ごとに真偽が変わる"
          // 評価）と`TARGET_SET_COUNT`（"step全体で1回だけ評価する"評価）は、
          // 評価結果を単一のbooleanへ還元する意味論が本質的に異なる（前者は
          // 対象ごとの適用可否フィルタ、後者はstep自体のskip判定）。両者を
          // 同じconditionツリーにAND/OR/NOTで混在させると、量化の位置
          // （leafごとに`exists`を取るか、複合式を先に評価してから`exists`を
          // 取るか）によって、既存の「対象別条件が全員falseならstep0件成立
          // 扱い」という契約と、新しい「集合条件がfalseならEffectStepSkipped」
          // という契約のどちらを優先すべきか一意に定まらない
          // （`TARGET_SET_COUNT`が恒真の場合と対象別条件単体の場合とで結果が
          // 変わってしまう等）。この2種の条件の混在は`catalog-integrity.ts`の
          // `MIXED_STEP_TARGET_SET_CONDITION`検証がCatalogロード時点で拒否する
          // ため、ここでは両者が同じconditionに同時に現れないという前提の
          // もとで、素朴に2つの独立した経路へ分岐する。
          if (conditionReferencesStepTarget(step.condition, step.target)) {
            const perTargetFilter = buildEffectStepPerTargetFilter(
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
          }

          // TARGET_SET_COUNTのみ（自身のtargetを参照する対象別条件は持たない）:
          // 対象ごとにではなくstep全体を一度だけ、最新状態で評価する。
          const resolveTargetSet = buildTargetSetResolver(
            plan.resolvedBindings,
            actor,
            box.units,
            lastResultTargets,
            triggerContext,
          );
          const satisfied = evaluateEffectStepCondition(
            step.condition,
            lastResultState.current,
            undefined,
            resolveTargetSet,
          );
          const applications = satisfied
            ? resolveActionStepApplications(
                step,
                plan.resolvedBindings,
                actor,
                box.units,
                context.definitions.effectActions,
                lastResultTargets,
                triggerContext,
              )
            : [];
          return { satisfied, applications };
        };
        return yield* resolveActionStepBody(
          stepIndex,
          step.condition.kind,
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

      const actor = requireUnit(box.units, context.actorId);
      const triggerContext = {
        ...(context.triggerSourceUnitId !== undefined
          ? { triggerSourceUnitId: context.triggerSourceUnitId }
          : {}),
        ...(context.triggerTargetUnitIds !== undefined
          ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
          : {}),
      };
      const satisfied = evaluateEffectStepCondition(step.condition, lastResultState.current);
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
        step.condition.kind,
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
    if (isDefeated(requireUnit(box.units, context.actorId))) {
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
 * R-SKL-01〜R-SKL-08を通じた`EffectSequence`解決のトップレベルgenerator。
 * `plan.steps`を定義順に解決し、`ActionStepPlan`（既定計画済みACTION）は
 * `resolveActionStepBody`へ、`DeferredStepPlan`（BRANCH/RANDOM_BRANCH/REPEAT、
 * またはLAST_RESULT/LAST_*_TARGETSに依存するACTION）は`resolveRawStep`へ
 * それぞれ委譲する。戻り値は`EffectSequenceOutcome`（Issue #217設計方針B）—
 * `COMPLETED`/`INTERRUPTED`は解決が実際に最後まで進んだか、使用者戦闘不能で
 * 打ち切ったかという事実だけから決まり、`unresolvedEffectCount`の値からは
 * 決して導出しない。
 *
 * PR #142レビュー[P1]: PSの`EffectSequence`自身の解決（`passive-activation-service.ts`）
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
  context: EffectActionGroupContext,
): Generator<EffectResolutionStep, EffectActionGroupsResult, void> {
  const lastResultState: LastResultState = {
    lastActionTargetUnitIds: [],
    lastDamagedTargetUnitIds: [],
  };
  let lastEventId = context.parentEventId;
  let resolvedCount = 0;

  for (const step of plan.steps) {
    if (isDefeated(requireUnit(box.units, context.actorId))) {
      return {
        units: box.units,
        outcome: {
          status: "INTERRUPTED",
          reason: "ACTOR_DEFEATED",
          resolvedEffectCount: resolvedCount,
          unresolvedEffectCount: 0,
        },
      };
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
      return {
        units: box.units,
        outcome: {
          status: "INTERRUPTED",
          reason: "ACTOR_DEFEATED",
          resolvedEffectCount: resolvedCount,
          unresolvedEffectCount: result.walkResult.unresolvedCount,
        },
      };
    }
  }

  return { units: box.units, outcome: { status: "COMPLETED", resolvedEffectCount: resolvedCount } };
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
