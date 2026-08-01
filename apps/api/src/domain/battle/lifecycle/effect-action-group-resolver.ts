import { requireUnit } from "./action-resolution-shared.js";
import { applyCooldownManipulationAction } from "./cooldown-manipulation-application-service.js";
import { applyModifyResourceAction } from "./resource-modification-service.js";
import { applyHealActionSteps } from "./heal-application-service.js";
import {
  applyDamageActionSteps,
  type DamageEventContext,
} from "../combat/damage-application-service.js";
import { grantEffect, isStackLimitReached } from "../effects/effect-grant-service.js";
import { grantStunStatus } from "../effects/stun-grant-service.js";
import { grantFreezeStatus } from "../effects/freeze-grant-service.js";
import { removeFreezeEffectSteps } from "../effects/freeze-removal-service.js";
import { truncateFraction } from "../model/resource-gauge.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { removeMarkers, reduceMarkerStack } from "../effects/marker-removal-service.js";
import { removeEffects } from "../effects/effect-removal-service.js";
import {
  findBlockingImmunity,
  rejectEffectApplication,
} from "../effects/effect-immunity-service.js";
import { recalculateCombatStats } from "../effects/combat-stat-recalculation-service.js";
import {
  emitEffectConsumptionChangedEvents,
  expireEffects,
  expireEffectsSteps,
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
import type {
  EffectActionDefinitionId,
  SkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";
import {
  evaluateFormula,
  damageResultsFor,
  type DamageResultRegistry,
} from "../skill/formula-evaluator.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { MarkerSource } from "../model/marker-state.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { Side } from "../../shared/side.js";
import { resolveDarkness } from "../combat/hit-policy.js";
import {
  createMemoryResolutionSource,
  type ResolutionSource,
} from "../targeting/target-selection-policy.js";

/**
 * `resolveSkillOrder`/`resolveChargeReleaseOrder`が計画した`EffectSequencePlan`を
 * 解決するために共有される因果関係コンテキスト。`action-skill-use-resolver.ts`
 * （AS/EX使用、チャージ発動）と`passive-activation-service.ts`（PS発動）の両方が
 * 使う。両者の間で循環importを起こさないよう、`applyEffectActionGroups`自体は
 * 独立したこのファイルへ置く。
 */
export interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  /**
   * 使用者（AS/EXの実行者、PSの所有者）。R-MEM-04（Issue #179）: Memory の
   * `triggeredEffects` 解決だけは使用者BattleUnitを持たないため`undefined`に
   * なり、代わりに`sourceSide`（Memoryを指定した陣営）を持つ。使用者を必要と
   * するEffectAction（DAMAGE・`SKILL_SOURCE`を参照するFormula・回復転送先など）は
   * `requireActorUnit`が明確に拒否する（Catalog整合性検証／preflightが本来
   * ここへ到達させない）。
   */
  readonly actorId?: BattleUnitId;
  /** R-MEM-04: Memory由来の解決だけが持つ発生源陣営（`08_ドメインイベント.md`「Memoryイベントは`sourceUnitId`を持たず、`sourceSide`を持つ」）。 */
  readonly sourceSide?: Side;
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
  /**
   * R-MEM-04（Issue #179）: Memory の `triggeredEffects` はSkillに属さないため
   * `undefined`。参照するのはDAMAGE経路（`DamageEventContext`・`SkillMissed`）
   * だけであり、その経路は使用者BattleUnitも必要とするため
   * （`requireActorUnit`）Memoryからは到達しない。
   */
  readonly skillDefinitionId?: SkillDefinitionId;
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
  readonly damageResults?: DamageResultRegistry;
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
  /**
   * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: このPSを発動
   * させた原因イベント自身の`payload`。`ACTION.stepCondition`/`BRANCH.condition`
   * の`EVENT_PAYLOAD`（`evaluateEffectStepCondition`）だけが参照する。
   * `triggerSourceUnitId`/`triggerTargetUnitIds`と同じ理由でAS/EX使用や
   * 行動外トップレベルイベントからの解決では`undefined`のまま素通しする。
   */
  readonly triggerEventPayload?: Readonly<Record<string, unknown>>;
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
 * R-MEM-04（Issue #179）: 使用者BattleUnitを持たないMemory由来の解決
 * （`context.actorId === undefined`）と、通常のSkill/PS解決の差を1か所へ閉じ込める
 * ためのアクセサ群。
 */
function findActorUnit(context: EffectActionGroupContext, box: UnitsBox): BattleUnit | undefined {
  return context.actorId === undefined ? undefined : requireUnit(box.units, context.actorId);
}

/**
 * 使用者BattleUnitを必要とするEffectAction（DAMAGE、`SKILL_SOURCE`を参照する
 * Formula、回復転送先など）から呼ぶ。Memory由来の解決では黙って別のユニットへ
 * すり替えず、`14_Catalog定義スキーマ.md`/R-MEM-04が要求する「Catalog検証または
 * preflightで拒否する」と同じ理由の明確なエラーにする。
 */
function requireActorUnit(context: EffectActionGroupContext, box: UnitsBox): BattleUnit {
  const actor = findActorUnit(context, box);
  if (actor === undefined) {
    throw new DomainValidationError(
      "effectAction",
      "this EffectAction requires a source BattleUnit, which Memory triggeredEffects do not have (R-MEM-04; Catalog integrity/preflight should reject such a Memory definition)",
    );
  }
  return actor;
}

/**
 * R-SKL-01「使用者が戦闘不能になった場合、未解決効果を中断する」の判定。Memory
 * 由来の解決には中断契機になる使用者が存在しない（R-MEM-01「Memory
 * triggeredEffects はPP、クールタイム、先制攻撃、1解決スコープ1回制限を持たない」
 * と同じく、使用者不在に由来する差分）ため常に`false`を返す。
 */
function isActorDefeated(context: EffectActionGroupContext, box: UnitsBox): boolean {
  const actor = findActorUnit(context, box);
  return actor !== undefined && isDefeated(actor);
}

/**
 * 対象解決（`skill-resolution-service.ts`/`target-selection-policy.ts`）へ渡す
 * 発生源。通常は使用者BattleUnit、Memory由来（R-MEM-04）ではsource sideだけを
 * 持つ{@link MemoryResolutionSource}。
 */
function resolutionSourceOf(context: EffectActionGroupContext, box: UnitsBox): ResolutionSource {
  const actor = findActorUnit(context, box);
  if (actor !== undefined) {
    return actor;
  }
  if (context.sourceSide === undefined) {
    throw new DomainValidationError(
      "effectAction",
      "resolving targets requires either an actor BattleUnit or a Memory source side (R-MEM-04)",
    );
  }
  return createMemoryResolutionSource(context.sourceSide);
}

/** DAMAGE経路が要求する所属Skill。Memory由来の解決には存在しない（R-MEM-04）。 */
function requireSkillDefinitionId(context: EffectActionGroupContext): SkillDefinitionId {
  if (context.skillDefinitionId === undefined) {
    throw new DomainValidationError(
      "effectAction",
      "this EffectAction requires an owning SkillDefinition, which Memory triggeredEffects do not have (R-MEM-04)",
    );
  }
  return context.skillDefinitionId;
}

/** イベントエンベロープ／payloadの発生源（`08_ドメインイベント.md`「Memory由来イベントは`sourceSide`を持つ」）。 */
function sourceEnvelopeOf(
  context: EffectActionGroupContext,
): { readonly sourceUnitId: BattleUnitId } | { readonly sourceSide: Side } | Record<string, never> {
  if (context.actorId !== undefined) {
    return { sourceUnitId: context.actorId };
  }
  return context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {};
}

/** `AppliedEffect`/`MarkerState`の付与元（`GrantEffectRequest.sourceId`/`sourceSide`）。 */
function grantSourceOf(
  context: EffectActionGroupContext,
): { readonly sourceId: BattleUnitId } | { readonly sourceSide: Side } | Record<string, never> {
  if (context.actorId !== undefined) {
    return { sourceId: context.actorId };
  }
  return context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {};
}

/**
 * `MarkerState`はR-EFF-10「直近の付与者」を必ず1つ持つ（`MarkerSource`のexactly-one
 * union）。スキル解決は`actorId`を、Memory解決（R-MEM-04）は`sourceSide`を必ず持つ
 * ため実際には両方欠落しないが、`grantSourceOf`の型はそれを保証しない。付与元不明の
 * Markerを黙って作らないよう、この境界で明確に拒否する（PR #262レビュー[P2]）。
 */
function requireMarkerSource(context: EffectActionGroupContext): MarkerSource {
  if (context.actorId !== undefined) {
    return { sourceId: context.actorId };
  }
  if (context.sourceSide !== undefined) {
    return { sourceSide: context.sourceSide };
  }
  throw new DomainValidationError(
    "effectActionGroupContext",
    "APPLY_MARKER requires either an actor BattleUnit or a Memory source side (R-EFF-10 MarkerState always records its latest granter)",
  );
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
  // PR #280再レビュー[P1]: 失効はステップを`yield`する`expireEffectsSteps`へ委譲し、
  // 通知（またはyield）の粒度は`damage-application-service.ts`の
  // `driveRemovalSteps`が決める。`onFactEventForPassiveChain`をこの`eventContext`
  // へ渡すと、そのstep通知とDAMAGE側のstep駆動が二重になるため渡さない。
  const eventContext = {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    rootEventId: context.rootEventId,
  };

  const consumeEffectDuration: NonNullable<DamageEventContext["consumeEffectDuration"]> =
    function* (ownerUnitId, kind, units, callParentEventId, effectInstanceId) {
      // PR #280再々レビュー[P1]／再々々レビュー[P1]: 消費対象の「決定」と「適用」を
      // 分ける。`consumeEffectDurations`は一致する全インスタンスを一括で減算した
      // `units`を返すため、それを起点にしてイベントだけ1件ずつ発行すると、最初の
      // `EffectConsumptionChanged`を観測するPS/Memoryが未発行分まで減算済みの状態を
      // 見てしまう（state変更がstep単位になっていない）。ここでは対象インスタンスの
      // 決定にだけ使い、実際の減算・イベント発行・`yield`は最新の`workingUnits`へ
      // 1インスタンスずつ行う（`consumeEffectDurations`の第4引数で対象を1件へ限定
      // できる — R-HIT-04のNヒット回避自己消費と同じ機構）。
      const planned = consumeEffectDurations(units, ownerUnitId, kind, effectInstanceId);
      if (planned.changes.length === 0) {
        return { units, lastEventId: callParentEventId };
      }
      let workingUnits = units;
      let lastEventId = callParentEventId;
      const seeds: ExpirationSeed[] = [];
      for (const plannedChange of planned.changes) {
        // 先行stepのPS/Memory連鎖が後続の対象を解除・失効させている場合があるため、
        // 最新の`workingUnits`に対して都度再評価する。既に消えていれば
        // （`changes`が空）このインスタンスの消費自体を行わない。
        const applied = consumeEffectDurations(
          workingUnits,
          ownerUnitId,
          kind,
          plannedChange.effectInstanceId,
        );
        const change = applied.changes[0];
        if (change === undefined) {
          continue;
        }
        workingUnits = applied.units;
        const stepEventsStart = eventContext.recorder.getEvents().length;
        lastEventId = emitEffectConsumptionChangedEvents(
          eventContext,
          workingUnits,
          [change],
          lastEventId,
        );
        const injected = yield {
          events: eventContext.recorder.getEvents().slice(stepEventsStart),
          units: workingUnits,
        };
        if (injected !== undefined) {
          workingUnits = injected;
        }
        if (change.after === 0) {
          seeds.push({
            battleUnitId: change.battleUnitId,
            effectInstanceId: change.effectInstanceId,
            reason: "CONSUMPTION",
          });
        }
      }
      if (seeds.length === 0) {
        return { units: workingUnits, lastEventId };
      }
      if (DEFERRED_EXPIRY_CONSUMPTION_KINDS.has(kind)) {
        pendingExpirySeeds.push(...seeds);
        return { units: workingUnits, lastEventId };
      }
      const expiry = yield* expireEffectsSteps(
        eventContext,
        workingUnits,
        seeds,
        context.definitions.effectActions,
        lastEventId,
      );
      return { units: expiry.units, lastEventId: expiry.lastEventId };
    };

  const finalizeConsumedEffectDurations: NonNullable<
    DamageEventContext["finalizeConsumedEffectDurations"]
  > = function* (units, parentEventId) {
    if (pendingExpirySeeds.length === 0) {
      return { units, lastEventId: parentEventId };
    }
    const seeds = pendingExpirySeeds.splice(0, pendingExpirySeeds.length);
    const expiry = yield* expireEffectsSteps(
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
  /**
   * HEAL_DISTRIBUTE（M7-005、Issue #184）: 同じEffectStep内でこの
   * `effectActionDefinitionId`が適用される対象数。`HEAL`の
   * `payload.distribution: "EVEN"`だけがこれを使い、総回復量を等分する。
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
  // レビュー再々指摘[P2]（Issue #183）: DAMAGEブランチが凍結カスケードの
  // ステップを個別に`yield`した場合、この変数を前進させてそのイベントが
  // 下の`innerEvents`へ二重に含まれないようにする（`let`）。
  let innerEventsStart = context.recorder.getEvents().length;

  // R-ACTN-01 #2（RES-002、Issue #174、全Action種別の共通契約、レビュー指摘
  // [P2] PR #215）: 対象が既に戦闘不能であり、戦闘不能者を対象にできる明示指定
  // （`application.includeDefeated`、選択元`TargetSelectorDefinition.
  // includeDefeated`から`skill-resolution-service.ts`が運ぶ）がない場合は
  // 種別を問わず適用しない。DAMAGEはこの分岐を経由せず`applyDamageAction`へ
  // そのまま進む — 同関数がヒット単位（対象が解決の途中で戦闘不能になる場合を
  // 含む）で`includeDefeated`（下で`context.includeDefeated`として引き渡す）を
  // 同じ契約に沿って判定し、`damageResults`への0記録もそちら側の責務のため
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
    const currentActor = requireActorUnit(context, box);
    // R-ACTN-01 #2（レビュー再指摘[P2]、PR #215）: `includeDefeated`が明示された
    // 対象は、開始時点で戦闘不能であっても`applyDamageAction`がヒットを適用する
    // ため、resultKind算出上も「既に戦闘不能」として扱わない。
    const targetAlreadyDefeated =
      !application.includeDefeated &&
      isDefeated(requireUnit(box.units, application.targetBattleUnitId));
    const { consumeEffectDuration, finalizeConsumedEffectDurations } =
      buildConsumeEffectDurationHooks(context);
    const damageGen = applyDamageActionSteps(
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
        skillDefinitionId: requireSkillDefinitionId(context),
        consumeEffectDuration,
        finalizeConsumedEffectDurations,
        includeDefeated: application.includeDefeated,
        // R-STS-03＋R-EFF-09（レビュー指摘[P2]）: `combat/`は`effects/`へ依存
        // できないため、凍結解除のlinkedEffectGroupカスケード（`duration-
        // expiry-service.ts`と同じ`collectLinkedGroupCascade`）とCombatStat
        // 再計算をここから注入する。
        // レビュー再々指摘[P2]（Issue #183）: `removeFreezeEffectSteps`
        // （generator）をそのまま返す — `applyDamageActionSteps`が
        // `context.onFactEventForPassiveChain`の有無に応じて同期駆動/`yield`の
        // どちらでも正しく駆動できる。
        removeFreezeEffect: (
          targetUnitId,
          freezeEffectInstanceId,
          triggeringDamage,
          units,
          parentEventId,
        ) =>
          removeFreezeEffectSteps(
            {
              recorder: context.recorder,
              turnNumber: context.turnNumber,
              cycleNumber: context.cycleNumber,
              ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
              skillUseId: context.skillUseId,
              resolutionScopeId: context.actionScope,
              rootEventId: context.rootEventId,
            },
            units,
            targetUnitId,
            freezeEffectInstanceId,
            triggeringDamage,
            context.definitions.effectActions,
            parentEventId,
          ),
        // R-SHD-01第3項＋R-EFF-09（DMG-004、Issue #194）: 枯渇したシールドの失効も
        // `removeFreezeEffect`とまったく同じ理由でここから注入する。`expireEffectsSteps`
        // をそのまま使うため、`linkedEffectGroupId`カスケード（production例:
        // `LILY_SINGER_PS2_LINK`「シールドの消滅と共に攻撃力バフも消滅する」）と
        // CombatStat再計算は他の失効契機と完全に同じ経路をたどる。
        expireDepletedShields: (targetUnitId, depletedEffectInstanceIds, units, parentEventId) =>
          expireEffectsSteps(
            {
              recorder: context.recorder,
              turnNumber: context.turnNumber,
              cycleNumber: context.cycleNumber,
              ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
              skillUseId: context.skillUseId,
              resolutionScopeId: context.actionScope,
              rootEventId: context.rootEventId,
            },
            units,
            depletedEffectInstanceIds.map((effectInstanceId) => ({
              battleUnitId: targetUnitId,
              effectInstanceId,
              reason: "SHIELD_DEPLETED" as const,
            })),
            context.definitions.effectActions,
            parentEventId,
          ),
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
        ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
        ...(context.triggerSourceUnitId !== undefined
          ? { triggerSourceUnitId: context.triggerSourceUnitId }
          : {}),
        ...(context.triggerTargetUnitIds !== undefined
          ? { triggerTargetUnitIds: context.triggerTargetUnitIds }
          : {}),
      },
    );
    // レビュー再々指摘[P2]（Issue #183）: `applyDamageActionSteps`は凍結解除の
    // linkedEffectGroupカスケードのステップだけを`yield`しうる
    // （`context.onFactEventForPassiveChain`未指定 = PS自身のEffectSequence
    // 解決の場合のみ）。そのステップをこの関数自身の`EFFECT_RESOLVED`として
    // そのまま`yield`し、`driveActivation`の共有stateへ正しく参加させる —
    // ここで消費した分だけ`innerEventsStart`を前進させ、下の`innerEvents`
    // 捕捉との二重処理を防ぐ。
    // レビュー再々々指摘[P2]（Issue #183）: `damageStep.value.events`
    // （カスケード自身のイベントだけ）ではなく`context.recorder.getEvents().
    // slice(innerEventsStart)`を`yield`する — カスケードが始まる前に記録済みの
    // `HitConfirmed`/`CriticalCheckResolved`/`DamageCalculated`（他の分岐と同じ
    // 「先行FACTイベントも同じEFFECT_RESOLVEDへ含める」慣例、darkness/stealth
    // ブロックと同じ形）も、この最初のyieldで一緒に即時連鎖へ届ける。これが
    // 無いと、これらのイベントは`damageStep.value.events`にも下の`innerEvents`
    // （`innerEventsStart`を前進済みのため）にも含まれず、対応するPS/Memory/
    // RuntimeCounterが発動しなくなる。
    let damageStep = damageGen.next();
    while (!damageStep.done) {
      // このカスケードステップの`units`を`box.units`へ反映してから`yield`する
      // （`passive-activation-service.ts`の`this.units = box.units`と同じ
      // sync-out）。これにより、この`yield`を処理する`driveActivation`側の
      // 子PS候補検出・発動がこの時点の正しい中間状態を参照できる。
      box.units = damageStep.value.units;
      yield {
        kind: "EFFECT_RESOLVED",
        events: context.recorder.getEvents().slice(innerEventsStart),
      };
      innerEventsStart = context.recorder.getEvents().length;
      // 子PS連鎖（あれば）が`box.units`を書き換えている可能性があるため、
      // 一時停止していたgeneratorを再開する前に取り込む（sync-in）。
      damageStep = damageGen.next(box.units);
    }
    const damageResult = damageStep.value;
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
        // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
        // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
        // Memory由来の解決はR-MEM-04に従って拒否する。
        sourceUnitId: requireActorUnit(context, box).battleUnitId,
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
  } else if (
    effectAction.kind === "APPLY_STAT_MOD" &&
    isStackLimitReached(
      requireUnit(box.units, application.targetBattleUnitId),
      effectAction.effectActionDefinitionId,
      effectAction.payload.stacking.max,
    )
  ) {
    // R-EFF-05「重複上限」（`STACK_LIMIT_ON_STAT_MOD`、M7-012、Issue #266）:
    // 対象が同じ`EffectKindKey`のインスタンスを`stacking.max`件保持している
    // 場合、新規インスタンスを追加しない（`EffectApplied`もCombatStat再計算も
    // 行わず、`EffectActionCompleted.resultKind: SKIPPED`だけを記録する）。
    //
    // 免疫判定（R-EFF-03）より前に評価する — `rejectEffectApplication`は
    // `EFFECT_IMMUNITY`の`blockedCount`を1消費するため、そもそも1件も追加
    // できない付与でその有限な回数を使わせてはならない。Formula評価も同じ理由で
    // ここでは行わない（付与しない値を計算しても捨てるだけ）。
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = starting.eventId;
    resultKind = "SKIPPED";
  } else if (effectAction.kind === "APPLY_STAT_MOD") {
    // R-EFF-01: 継続stat補正をAppliedEffectとして個別に付与する（レジストリ
    // 追加・`EffectApplied`・StateDelta・独立Reducer復元まで）。重複あり・
    // 重複なしは`stacking.mode`（M7-012、Issue #266でCatalogスキーマへ
    // `NON_STACKABLE`を追加）から`duplicate`へそのまま写す。
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
    // `context.damageResults`（呼び出し側が1解決スコープごとに新規生成する
    // 共有registry、`damage-application-service.ts`と同じもの）から使用者自身の
    // 直前DAMAGE結果と、`context.skillUseId`が識別するEffectSequence解決の
    // 累計DAMAGE結果（`SUM_*`、G-10／RES-003A、Issue #257）を取り出す。
    // PRレビュー指摘[P2]: `triggerSourceUnitId`/`triggerTargetUnitIds`はIDの
    // ままここまで運び、評価するこの瞬間の`box.units`から引き直す — PS開始時に
    // 一度だけ解決した`BattleUnit`を保持すると、先行するEffectActionや子PS連鎖
    // による対象のHP・combatStats変更をこのFormulaが見落としてしまうため。
    // R-MEM-04（Issue #179）: Memory由来の解決は使用者を持たない。`SKILL_SOURCE`を
    // 参照するFormulaは`FormulaEvaluator`が明確に拒否し、`CONSTANT`のように
    // 使用者を必要としないFormula（production Memoryの静的補正）はそのまま
    // 評価できる。`lastResults`（使用者自身の直前DAMAGE結果）も同じ理由で持たない。
    const actor = findActorUnit(context, box);
    const triggerTargetUnitId = context.triggerTargetUnitIds?.[0];
    const magnitude = evaluateFormula(effectAction.payload.formula, {
      ...(actor !== undefined ? { skillSource: actor } : {}),
      ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      ...(actor !== undefined
        ? {
            lastResults: damageResultsFor(
              context.damageResults,
              actor.battleUnitId,
              context.skillUseId,
            ),
          }
        : {}),
      ...(context.triggerSourceUnitId !== undefined
        ? { triggerSource: requireUnit(box.units, context.triggerSourceUnitId) }
        : {}),
      ...(triggerTargetUnitId !== undefined
        ? { triggerTarget: requireUnit(box.units, triggerTargetUnitId) }
        : {}),
    });
    // R-EFF-03（M7-001B、Issue #243）: 対象が有効な`EFFECT_IMMUNITY`（BUFF/DEBUFF
    // カテゴリ）を保持している場合、この新規付与を拒否し`EffectApplicationRejected`
    // を発行する（`EffectApplied`/CombatStat再計算は行わない）。
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: effectAction.payload.stacking.mode === "STACKABLE",
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
    }
  } else if (effectAction.kind === "APPLY_STATUS") {
    // TGT-004フェーズ3再レビュー[P1]（Issue #167、R-ACTN-03）: `AppliedEffect.
    // statusKind`を付与するresolverだが、無条件付与を実際に持つのは
    // `status: "STEALTH"`（R-TGT-08）と`status: "STUN"`（R-STS-01/02、Issue #180
    // M7-003、`probability`は`undefined`または`1`のみ受理——production定義は
    // いずれもこの形）だけ。他のstatus種別（FREEZE/BLIND/EVASION/
    // DAMAGE_IMMUNITY等、R-STS-03/04）は行動不能化・ダメージ無効化といった
    // 実効処理が別途必要で、それらは未実装のまま。`probability`/`appliesTo`/
    // `damageThreshold`等の追加fieldの有無だけで判定すると、
    // `ACT_CHIZURU_DOMESTIC_AS1_STUN`のように追加fieldを持たないSTUN定義が
    // 実効なしのままgrantEffectまで進んでしまい、「未対応として明確に失敗する」
    // から「EffectAppliedとして成功するが実際の
    // 効果はない」というsilent partial implementationへ退行する
    // （PR #238再レビュー[P1]で指摘）。そのため`status`自体で許可リストを取り、
    // `STEALTH`/`STUN`以外は無条件で拒否する。
    //
    // R-EFF-03（M7-001B、Issue #243）: 免疫拒否は「未対応status種別」の拒否より
    // 優先する — 対象が有効な免疫を持つなら、そのstatus種別がまだ実効処理を
    // 持つかどうかに関係なく`EffectApplicationRejected`が正しい結果になる。
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      {
        effectActionDefinitionId: application.effectActionDefinitionId,
        magnitude: 0,
        statusKind: effectAction.payload.status,
      },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
          statusKind: effectAction.payload.status,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      // R-EFF-07「STATUS_BLOCKED は、効果ownerへの状態付与が無効化された時点で
      // 消費する」: 状態付与（APPLY_STATUS）が免疫でブロックされた場合だけ、
      // 対象が保持するSTATUS_BLOCKED消費条件付き効果を消費する
      // （`duration-expiry-service.ts`と同じ「消費0で即時失効」規約）。
      const { consumeEffectDuration } = buildConsumeEffectDurationHooks(context);
      // PR #280再レビュー[P1]: 消費失効はステップ単位のgeneratorになったため、
      // ここでも1ステップずつ駆動する — callbackがあればそのステップのイベントを
      // その場で通知し、無ければ`EFFECT_RESOLVED`としてyieldしてdriverへ委ねる。
      const consumptionGen = consumeEffectDuration(
        application.targetBattleUnitId,
        "STATUS_BLOCKED",
        box.units,
        rejection.lastEventId,
      );
      // 消費より前に記録済みのイベント（`EffectActionStarting`/
      // `EffectApplicationRejected`）は状態変更前に通知しておく。
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
        innerEventsStart = context.recorder.getEvents().length;
      }
      let consumptionStep = consumptionGen.next();
      while (!consumptionStep.done) {
        box.units = consumptionStep.value.units;
        if (context.onFactEventForPassiveChain !== undefined) {
          for (const event of consumptionStep.value.events) {
            box.units = context.onFactEventForPassiveChain(event, box.units);
          }
          innerEventsStart = context.recorder.getEvents().length;
        } else {
          yield {
            kind: "EFFECT_RESOLVED",
            events: context.recorder.getEvents().slice(innerEventsStart),
          };
          innerEventsStart = context.recorder.getEvents().length;
        }
        consumptionStep = consumptionGen.next(box.units);
      }
      const consumption = consumptionStep.value;
      box.units = consumption.units;
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = consumption.lastEventId;
      resultKind = "REJECTED";
    } else {
      const status = effectAction.payload.status;
      if (
        status !== "STEALTH" &&
        status !== "STUN" &&
        status !== "EVASION" &&
        status !== "BLIND" &&
        status !== "DAMAGE_IMMUNITY" &&
        status !== "FREEZE" &&
        status !== "HIT_EVASION" &&
        status !== "GUARANTEED_HIT"
      ) {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_STATUS status "${status}" is not yet supported by this resolver (only "STEALTH"/"STUN"/"EVASION"/"BLIND"/"DAMAGE_IMMUNITY"/"FREEZE"/"HIT_EVASION"/"GUARANTEED_HIT" are; other status kinds require their own runtime behavior, tracked separately — CRITICAL_GUARANTEE/CRITICAL_PREVENTION are CAP_CRITICAL_CONTROL / DMG-003 / Issue #196)`,
        );
      }
      // R-HIT-05（M7-018、Issue #272）: 必中付与は使用者側（OUTGOING）の効果で
      // あり、`appliesTo.incomingActionKinds`（被効果の絞り込み）・
      // `damageThreshold`・`damageAmplificationOnBreak`（いずれも被ダメージ側の
      // 概念）を解釈する余地がない。production定義
      // （`ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT`）はどれも持たないため、
      // STUNと同じ理由で「未対応として明確に失敗する」ままにし、silent partial
      // implementationへ退行させない。
      if (
        status === "GUARANTEED_HIT" &&
        (effectAction.payload.appliesTo !== undefined ||
          effectAction.payload.damageThreshold !== undefined ||
          effectAction.payload.damageAmplificationOnBreak !== undefined)
      ) {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          'APPLY_STATUS status "GUARANTEED_HIT" with appliesTo/damageThreshold/damageAmplificationOnBreak is not supported (R-HIT-05 applies to the holder\'s outgoing attacks; production GUARANTEED_HIT definitions declare none of them)',
        );
      }
      if (
        status === "STUN" &&
        (effectAction.payload.appliesTo !== undefined ||
          effectAction.payload.damageThreshold !== undefined ||
          effectAction.payload.damageAmplificationOnBreak !== undefined ||
          (effectAction.payload.probability !== undefined && effectAction.payload.probability < 1))
      ) {
        throw new DomainValidationError(
          "effectActionDefinitionId",
          `APPLY_STATUS status "STUN" with appliesTo/damageThreshold/damageAmplificationOnBreak or probability < 1 is not yet supported (R-STS-03/04 scope; production STUN definitions only use an omitted or 1 probability)`,
        );
      }
      // Stealth/Stunを含む現行production定義は`stacking`相当の設定を持たないため
      // （`ApplyStatusPayload`自体に`stacking`フィールドが無い）、`APPLY_STAT_MOD`と
      // 同じ理由でduplicate: trueに固定する（Q-EFF-10「重複あり・重複なしの
      // どちらも、効果インスタンスと効果期間を個別に保持する」）。R-STS-02の
      // 再付与規則（残り回数が長い方を一つだけ残す）を持つSTUNだけ
      // `grantStunStatus`（`stun-grant-service.ts`）へ分岐する。
      const grantContext = {
        recorder: context.recorder,
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        skillUseId: context.skillUseId,
        resolutionScopeId: context.actionScope,
        rootEventId: context.rootEventId,
      };
      // R-HIT-02（M7-004、Issue #183）: EVASIONは判定時（`hit-policy.ts`の
      // `resolveEvasion`）に`probability`/`appliesTo`を参照するため、Catalog
      // payloadの残りfieldを`AppliedEffect.statusDetails`として保持する。
      const statusDetails =
        effectAction.payload.probability !== undefined ||
        effectAction.payload.appliesTo !== undefined ||
        effectAction.payload.damageAmplificationOnBreak !== undefined ||
        effectAction.payload.damageThreshold !== undefined
          ? {
              ...(effectAction.payload.probability !== undefined
                ? { probability: effectAction.payload.probability }
                : {}),
              ...(effectAction.payload.appliesTo !== undefined
                ? { appliesTo: effectAction.payload.appliesTo }
                : {}),
              ...(effectAction.payload.damageAmplificationOnBreak !== undefined
                ? { damageAmplificationOnBreak: effectAction.payload.damageAmplificationOnBreak }
                : {}),
              ...(effectAction.payload.damageThreshold !== undefined
                ? { damageThreshold: effectAction.payload.damageThreshold }
                : {}),
            }
          : undefined;
      const grantRequest = {
        definition: effectAction,
        ...grantSourceOf(context),
        targetId: application.targetBattleUnitId,
        duplicate: true,
        magnitude: 0,
        statusKind: status,
        ...(statusDetails !== undefined ? { statusDetails } : {}),
        durationDefinition: effectAction.payload.duration,
      };
      const grantResult =
        status === "STUN"
          ? grantStunStatus(grantContext, box.units, grantRequest, starting.eventId)
          : status === "FREEZE"
            ? grantFreezeStatus(grantContext, box.units, grantRequest, starting.eventId)
            : grantEffect(grantContext, box.units, grantRequest, starting.eventId);
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      let lastEventId = grantResult.lastEventId;
      // R-STS-02/R-SKL-05「付与時にチャージをキャンセルする」: STUN付与が
      // 実際に成立した（新規付与、またはより長い残り回数への差し替え）対象が
      // 発動待ちのチャージを持つ場合、その場でキャンセルする。既存STUNが
      // 新しい付与以上の残り回数で維持された場合（`grantStunStatus`が
      // `existing`をそのまま返す、実質no-op）はチャージへ触れない。
      if (status === "STUN") {
        const stunnedTarget = requireUnit(box.units, application.targetBattleUnitId);
        if (stunnedTarget.charge !== undefined) {
          const cancelled = context.recorder.record({
            eventType: "ChargeCancelled",
            category: "FACT",
            turnNumber: context.turnNumber,
            cycleNumber: context.cycleNumber,
            ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
            skillUseId: context.skillUseId,
            resolutionScopeId: context.actionScope,
            parentEventId: lastEventId,
            rootEventId: context.rootEventId,
            sourceUnitId: stunnedTarget.battleUnitId,
            targetUnitIds: [stunnedTarget.battleUnitId],
            payload: {
              actorUnitId: stunnedTarget.battleUnitId,
              skillDefinitionId: stunnedTarget.charge.skill.skillDefinitionId,
              startedActionId: stunnedTarget.charge.startedActionId,
              reason: "STUN",
            },
            stateDelta: {
              units: {
                [stunnedTarget.battleUnitId]: {
                  charge: {
                    before: {
                      skillDefinitionId: stunnedTarget.charge.skill.skillDefinitionId,
                      startedActionId: stunnedTarget.charge.startedActionId,
                    },
                    after: undefined,
                  },
                },
              },
            },
          });
          box.units = box.units.map((unit) => {
            if (unit.battleUnitId !== stunnedTarget.battleUnitId) {
              return unit;
            }
            const { charge: _charge, ...withoutCharge } = unit;
            return withoutCharge;
          });
          lastEventId = cancelled.eventId;
          if (context.onFactEventForPassiveChain !== undefined) {
            box.units = context.onFactEventForPassiveChain(cancelled, box.units);
          }
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = lastEventId;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "APPLY_MARKER") {
    // R-EFF-03（M7-001B、Issue #243）: 対象が有効な`EFFECT_IMMUNITY`（MARKER
    // カテゴリ）を保持している場合、この新規付与を拒否する。
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude: 0 },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          // R-MEM-04（M7-008、Issue #176）: Memory由来の`APPLY_MARKER`は付与者
          // ユニットを持たないため、`AppliedEffect`と同じく`sourceSide`
          // （そのMemoryを指定した陣営）を渡す。
          ...requireMarkerSource(context),
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
    }
  } else if (effectAction.kind === "REMOVE_MARKER") {
    // R-EFF-10「Marker の解除は既存の REMOVE_MARKER（markerId 指定）を使う」
    // （`14_Catalog定義スキーマ.md`）: 対象が指定Markerを所持していない場合は
    // no-op（`COOLDOWN_MANIPULATION`のREADY skillと同じ扱い、resultKind: SKIPPED）。
    // PR #280レビュー[P1]: R-EFF-09のカスケードは1インスタンスの除去ごとに
    // PS/Memory連鎖へ通知する必要がある（子の`EffectExpired`をtriggerにするPSが
    // 親Markerを既に除去済みとして観測しないように）。`removeMarkers`/
    // `reduceMarkerStack`へcallbackを渡し、そこで通知済みになった分は
    // `innerEventsStart`を前進させて下の一括通知から除く（`applyDamageActionSteps`
    // の凍結カスケードと同じ二重処理防止）。callback未指定（PS自身の
    // EffectSequence解決）の経路では従来どおり呼び出し側の`innerEvents`が
    // driverへ一括で渡す。
    const removalContext = {
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
    };
    // callbackを渡す場合、除去より前に記録済みのイベント（`EffectActionStarting`）は
    // 状態を書き換える前に通知しておく — 除去内部の通知より後にすると、
    // 発行順（starting → 除去）と連鎖解決順が食い違う。
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
      innerEventsStart = context.recorder.getEvents().length;
    }
    // 所持判定は先行イベントのPS連鎖を反映した`box.units`から取る — 上の通知で
    // 対象のMarkerが既に解除されていた場合、この解除はno-op（SKIPPED）になる。
    const target = requireUnit(box.units, application.targetBattleUnitId);
    const existingMarker = target.markerStates.find(
      (marker) => marker.markerId === effectAction.payload.markerId,
    );
    if (existingMarker === undefined) {
      effectLastEventId = starting.eventId;
      resultKind = "SKIPPED";
    } else if (effectAction.payload.count !== undefined) {
      // M7-001（Issue #181、REMOVE_EFFECTS_COUNT_LIMIT）: 指定スタック数だけ部分解除。
      const reduction = reduceMarkerStack(
        removalContext,
        box.units,
        application.targetBattleUnitId,
        effectAction.payload.markerId,
        effectAction.payload.count,
        context.definitions.effectActions,
        starting.eventId,
      );
      box.units = reduction.units;
      effectLastEventId = reduction.lastEventId;
      resultKind = reduction.changed ? "APPLIED" : "SKIPPED";
      if (context.onFactEventForPassiveChain !== undefined) {
        innerEventsStart = context.recorder.getEvents().length;
      }
    } else {
      const removalResult = removeMarkers(
        removalContext,
        box.units,
        [
          {
            battleUnitId: application.targetBattleUnitId,
            markerInstanceId: existingMarker.markerInstanceId,
            reason: "REMOVED",
          },
        ],
        context.definitions.effectActions,
        starting.eventId,
      );
      box.units = removalResult.units;
      effectLastEventId = removalResult.lastEventId;
      resultKind = "APPLIED";
      if (context.onFactEventForPassiveChain !== undefined) {
        innerEventsStart = context.recorder.getEvents().length;
      }
    }
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
    }
    resolvedCount = application.hits.length;
    interruptedCount = 0;
  } else if (effectAction.kind === "REMOVE_EFFECTS") {
    // R-EFF-02（M7-001、Issue #181）: 対象カテゴリに一致する`AppliedEffect`を
    // 即時解除する（`effect-removal-service.ts`）。`REMOVE_EFFECTS_CATEGORY_GAP`の
    // SHIELD/SUBUNITはシールド・サブユニットの実行時状態がまだモデル化されて
    // いない（`CAP_SHIELD`=DMG-004、`CAP_SUBUNIT`=DMG-005、いずれも`PLANNED`、#242）。
    // schema自体はSHIELD/SUBUNITを有効な値として受理する（Catalog全体のロードを
    // 失敗させないため）が、`catalog-integrity.ts`が対応するCapability宣言を必須にし、
    // 実際に選択されたUnit/Memoryグラフに対してだけ`SimulationPreflightValidator`が
    // `UNSUPPORTED_RULE`として拒否する（`UT-PREFLIGHT-012`）ため、通常の
    // Catalog駆動battle生成経路ではここへ到達しない。以下はpreflightを迂回した
    // 直接構築（テスト等）に対する防御的ガード（defense-in-depth）で、
    // silent no-opへの退行を防ぐ。
    const unsupportedCategories = effectAction.payload.categories.filter(
      (category) => category === "SHIELD" || category === "SUBUNIT",
    );
    if (unsupportedCategories.length > 0) {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `REMOVE_EFFECTS categories ${unsupportedCategories.join("/")} are not yet supported by this resolver — shield/subunit runtime state is owned by DMG-004/DMG-005 (still open, #242). M7-001 wires BUFF/DEBUFF/STATUS/DAMAGE_MOD/SPECIFIC_EFFECT removal only`,
      );
    }
    // PR #280レビュー[P1]: REMOVE_MARKER分岐と同じ理由で、除去より前に記録済みの
    // `EffectActionStarting`を先に通知し、以降のインスタンス単位の通知は
    // `removeEffects`内部（R-EFF-09カスケード分＋seed分）へ委ねる。
    if (context.onFactEventForPassiveChain !== undefined) {
      for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
        box.units = context.onFactEventForPassiveChain(event, box.units);
      }
      innerEventsStart = context.recorder.getEvents().length;
    }
    const removal = removeEffects(
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
      application.targetBattleUnitId,
      {
        categories: effectAction.payload.categories,
        ...(effectAction.payload.effectActionDefinitionIds !== undefined
          ? { effectActionDefinitionIds: effectAction.payload.effectActionDefinitionIds }
          : {}),
        ...(effectAction.payload.maxRemovals !== undefined
          ? { maxRemovals: effectAction.payload.maxRemovals }
          : {}),
      },
      context.definitions.effectActions,
      starting.eventId,
    );
    box.units = removal.units;
    if (context.onFactEventForPassiveChain !== undefined) {
      innerEventsStart = context.recorder.getEvents().length;
    }
    resolvedCount = application.hits.length;
    interruptedCount = 0;
    effectLastEventId = removal.lastEventId;
    resultKind = removal.removedCount > 0 ? "APPLIED" : "SKIPPED";
  } else if (effectAction.kind === "EFFECT_IMMUNITY") {
    // R-EFF-03（M7-001B、Issue #243、PR #245レビュー[P2]修正）: 免疫効果自身の
    // 付与も「新規付与」であり免疫の対象になり得る — Catalogは`SPECIFIC_EFFECT`
    // の`effectActionDefinitionIds`で他の`EFFECT_IMMUNITY`定義IDを指定できるため
    // （例: 「免疫封印」で対象の特定免疫効果自体の再付与を防ぐ）、他のkindと
    // 同じく`findBlockingImmunity`を通す。
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude: 0 },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
      // R-EFF-03（M7-001B、Issue #243）: 免疫効果自体を`AppliedEffect`として付与
      // する（`categories`/`statusKinds`（`EFFECT_IMMUNITY_STATUS_GRANULARITY`）/
      // `effectActionDefinitionIds`/`maxBlocks`をそのまま保持し、実行時カウンタ
      // `blockedCount`は0から始める）。`stacking`相当の設定を持たないため、
      // `APPLY_STAT_MOD`/`APPLY_STATUS`と同じ理由でduplicate: trueに固定する。
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude: 0,
          durationDefinition: effectAction.payload.duration,
          immunity: {
            categories: effectAction.payload.categories,
            ...(effectAction.payload.statusKinds !== undefined
              ? { statusKinds: effectAction.payload.statusKinds }
              : {}),
            ...(effectAction.payload.effectActionDefinitionIds !== undefined
              ? { effectActionDefinitionIds: effectAction.payload.effectActionDefinitionIds }
              : {}),
            maxBlocks: effectAction.payload.maxBlocks,
            blockedCount: 0,
          },
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = grantResult.lastEventId;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "APPLY_ATTACK_DAMAGE_BONUS") {
    // ON_ATTACK_BONUS_DAMAGE_BUFF（M7-004、Issue #183、production例:
    // SKL_ELENA_MOODMAKER_EXの「攻撃時に攻撃力×15%のダメージを追加するバフ」）:
    // `APPLY_STAT_MOD`と同じ評価規約で`formula`を付与時点に一度だけ評価し、結果を
    // `magnitude`（`AppliedEffect.isAttackDamageBonus: true`）として保持する。
    // 動的な毎ヒット再評価ではなく付与時snapshot — `damage-application-
    // service.ts`はCatalogを引けないため、判定に必要な値はすべて付与時点で
    // `AppliedEffect`自身へ焼き込む（`resolveDamageImmunity`/`resolveDarkness`と
    // 同じ理由）。CombatStatsを変更しないため`combat-stat-recalculation-
    // service.ts`は呼ばない。
    // R-MEM-04（Issue #179）: Memory由来の解決は使用者を持たないため、
    // `SKILL_SOURCE`/`lastResults`を要求しないFormulaだけが評価できる。
    const actor = findActorUnit(context, box);
    const magnitude = evaluateFormula(effectAction.payload.formula, {
      ...(actor !== undefined ? { skillSource: actor } : {}),
      ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      ...(actor !== undefined
        ? {
            lastResults: damageResultsFor(
              context.damageResults,
              actor.battleUnitId,
              context.skillUseId,
            ),
          }
        : {}),
    });
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude,
          isAttackDamageBonus: true,
          durationDefinition: effectAction.payload.duration,
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = grantResult.lastEventId;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "APPLY_RESOURCE_GAIN_MOD") {
    // G-05（`14_Catalog定義スキーマ.md`、M7-002/Issue #185）: `APPLY_STAT_MOD`と
    // 同じ評価規約で`rateDelta`を付与時点に一度だけ評価し、結果を符号付き倍率
    // として`magnitude`へ保持する。EXゲージ増加量への実際の適用は
    // `action-resolution-shared.ts`の`increaseExGauge`呼び出し側
    // （`resource-gain-mod-composition.ts`が対象の有効なAppliedEffectを合成）が
    // 行うため、ここではCombatStatsと同様の再計算は不要
    // （`APPLY_ATTACK_DAMAGE_BONUS`と同じ理由）。
    // R-MEM-04（Issue #179）: Memory由来の解決は使用者を持たないため、
    // `SKILL_SOURCE`/`lastResults`を要求しないFormulaだけが評価できる。
    const actor = findActorUnit(context, box);
    const magnitude = evaluateFormula(effectAction.payload.rateDelta, {
      ...(actor !== undefined ? { skillSource: actor } : {}),
      ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      ...(actor !== undefined
        ? {
            lastResults: damageResultsFor(
              context.damageResults,
              actor.battleUnitId,
              context.skillUseId,
            ),
          }
        : {}),
    });
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude,
          durationDefinition: effectAction.payload.duration,
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = grantResult.lastEventId;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "MODIFY_RESOURCE") {
    // R-ACTN-02＋M7-002（Issue #185、HP_DIRECT_COST）: AP/PP/EX_GAUGEの一回限りの
    // 加減算に加え、`resource: HP`で防御力・会心などの通常ダメージ処理を経由せず
    // HPを直接増減する（`UNIT_SUIRAN_CASINO`等の自己コスト）。
    // M7-017（Issue #271、`CAP_RESOURCE_DISTRIBUTE`）: `operation: DISTRIBUTE`は
    // `HEAL`の`distribution: "EVEN"`と同じ`distributionShareCount`（同一EffectStep
    // 内でこのEffectActionが実際に適用される対象数、呼び出し元の
    // `resolveActionApplications`が算出）で総量を等分する。
    const modifyResult = applyModifyResourceAction(
      application.hits,
      requireActorUnit(context, box),
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
        // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
        // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
        // Memory由来の解決はR-MEM-04に従って拒否する。
        sourceUnitId: requireActorUnit(context, box).battleUnitId,
        ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
      distributionShareCount,
    );
    box.units = modifyResult.units;
    resolvedCount = modifyResult.resolvedCount;
    interruptedCount = 0;
    effectLastEventId = modifyResult.lastEventId;
    resultKind = modifyResult.changed ? "APPLIED" : "SKIPPED";
  } else if (effectAction.kind === "HEAL") {
    // R-HEAL-01（M7-005、Issue #184）: 即時回復。HEAL_DISTRIBUTEは
    // `distributionShareCount`（同一EffectStep内でこのEffectActionが適用される
    // 対象数、呼び出し元の`resolveActionApplications`が算出）で総量を等分する。
    const healGen = applyHealActionSteps(
      application.hits,
      requireActorUnit(context, box),
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
        // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
        // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
        // Memory由来の解決はR-MEM-04に従って拒否する。
        sourceUnitId: requireActorUnit(context, box).battleUnitId,
        effectActions: context.definitions.effectActions,
        ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
      distributionShareCount,
    );
    // PR #259再レビュー[P2]（R-HEAL-04 #4/#6）: `applyHealActionSteps`は
    // `context.onFactEventForPassiveChain`未指定（＝PS自身のEffectSequence解決）の
    // 場合だけ、`HealApplied`／各`HealingTransferred`の直後に連鎖境界を`yield`する。
    // DAMAGEの凍結カスケードと同じ形でそれを`EFFECT_RESOLVED`として中継し、
    // `driveActivation`が子PS連鎖をその場で解決してから転送へ進めるようにする —
    // これが無いと、HEAL EffectAction全体（転送を含む）を適用し終えてからまとめて
    // yieldすることになり、`HealApplied`起点の子PSが転送後のHPを観測してしまう。
    // 消費した分だけ`innerEventsStart`を前進させ、下の`innerEvents`捕捉との
    // 二重処理を防ぐ。
    let healStep = healGen.next();
    while (!healStep.done) {
      box.units = healStep.value.units;
      yield {
        kind: "EFFECT_RESOLVED",
        events: context.recorder.getEvents().slice(innerEventsStart),
      };
      innerEventsStart = context.recorder.getEvents().length;
      // 子PS連鎖（あれば）が`box.units`を書き換えている可能性があるため、
      // 一時停止していたgeneratorを再開する前に取り込む（sync-in）。
      healStep = healGen.next(box.units);
    }
    const healResult = healStep.value;
    box.units = healResult.units;
    resolvedCount = healResult.resolvedCount;
    // R-SKL-01/R-SKL-02（PR #259再々レビュー[P2]）: 使用者が`HealApplied`／
    // `HealingTransferred`起点の連鎖で戦闘不能になった場合、`applyHealActionSteps`は
    // 未解決の転送・対象を適用せず`interruptedCount`として返す。DAMAGEと同じく
    // `INTERRUPTED`として報告し、同じEffectStepの残りの対象と後続stepを止める
    // （`resolveActionApplications`が`walkInterrupted`へ落とす）。
    interruptedCount = healResult.interruptedCount;
    effectLastEventId = healResult.lastEventId;
    resultKind = healResult.interrupted
      ? "INTERRUPTED"
      : healResult.changed
        ? "APPLIED"
        : "SKIPPED";
  } else if (
    effectAction.kind === "APPLY_HEALING_MOD" ||
    effectAction.kind === "APPLY_DAMAGE_MOD" ||
    effectAction.kind === "APPLY_CONTINUOUS_HEAL"
  ) {
    // R-HEAL-02/R-HEAL-03（M7-005、Issue #184）／R-DMG-04（DMG-002、Issue #192）:
    // いずれも`AppliedEffect`として
    // 保持する継続効果（R-ACTN-03）。`APPLY_STAT_MOD`と同じ評価規約で`formula`を
    // 付与時点に一度だけ評価し、結果を`magnitude`へ保持する。
    // - `APPLY_HEALING_MOD`: 符号付き割合の回復量補正。実際の適用は
    //   `heal-application-service.ts`が`composeHealingRate`で合成する。
    // - `APPLY_DAMAGE_MOD`: 符号付き割合の与/被ダメージ補正。向き・対象
    //   ダメージタイプ・動的条件（`DYNAMIC_DAMAGE_MOD_CONDITION`）は
    //   `AppliedEffect.damageModifier`へ焼き込み、実際の集計は
    //   `combat/damage-modifier-policy.ts`がヒットごとに行う（条件は付与時では
    //   なくヒット時点の状態で評価する必要があるため、`magnitude`と違って
    //   snapshotにできない）。
    // - `APPLY_CONTINUOUS_HEAL`: 付与時点では回復せず、`timing.eventType`が
    //   発生した時点で`continuous-heal-service.ts`がR-HEAL-01と同じ手順で
    //   回復する。回復量Formulaは発火のたびに評価し直す必要がある
    //   （`MAX_HP_RATIO`/`MISSING_HP_RATIO`が発火時点の対象HPを参照するため）
    //   ので、ここで評価した`magnitude`は監査用の付与時snapshotに留める。
    // CombatStatsには影響しないため再計算は不要（`APPLY_ATTACK_DAMAGE_BONUS`/
    // `APPLY_RESOURCE_GAIN_MOD`と同じ理由）。
    // R-MEM-04（Issue #179）: Memory由来の解決は使用者を持たないため、
    // `SKILL_SOURCE`/`lastResults`を要求しないFormulaだけが評価できる。
    const actor = findActorUnit(context, box);
    const magnitude = evaluateFormula(effectAction.payload.formula, {
      ...(actor !== undefined ? { skillSource: actor } : {}),
      ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      ...(actor !== undefined
        ? {
            lastResults: damageResultsFor(
              context.damageResults,
              actor.battleUnitId,
              context.skillUseId,
            ),
          }
        : {}),
    });
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude,
          ...(effectAction.kind === "APPLY_DAMAGE_MOD"
            ? {
                damageModifier: {
                  direction: effectAction.payload.direction,
                  damageType: effectAction.payload.damageType,
                  ...(effectAction.payload.condition !== undefined
                    ? { condition: effectAction.payload.condition }
                    : {}),
                },
              }
            : {}),
          durationDefinition: effectAction.payload.duration,
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = grantResult.lastEventId;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "APPLY_SHIELD") {
    // R-SHD-01（DMG-004、Issue #194）: HPとは別枠の吸収プールを`AppliedEffect`として
    // 付与する（R-ACTN-03）。`APPLY_STAT_MOD`と同じ評価規約で`formula`を付与時点に
    // 一度だけ評価し、R-NUM-02「シールド付与量は適用直前に小数部分を切り捨てる」に
    // 従って整数化した値を最大値（`magnitude`）と初期残量（`shield.remaining`）の
    // 両方に置く。負のFormula結果は吸収プールとして意味を持たないため0へ丸める
    // （`heal-application-service.ts`のR-HEAL-01 #5と同じ規約）。
    // 重複規則はR-EFF-01の一般規則どおり常に新規インスタンス（`duplicate: true`）—
    // R-SHD-01「同じタイプのシールド付与値を加算する」はプール合計側の規則であり、
    // インスタンスの統合ではない。CombatStatsには影響しないため再計算は呼ばない。
    const actor = findActorUnit(context, box);
    const magnitude = Math.max(
      0,
      truncateFraction(
        evaluateFormula(effectAction.payload.formula, {
          ...(actor !== undefined ? { skillSource: actor } : {}),
          ...(context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {}),
          target: requireUnit(box.units, application.targetBattleUnitId),
          allUnits: box.units,
          ...(actor !== undefined
            ? {
                lastResults: damageResultsFor(
                  context.damageResults,
                  actor.battleUnitId,
                  context.skillUseId,
                ),
              }
            : {}),
        }),
      ),
    );
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude,
          shield: {
            shieldType: effectAction.payload.shieldType ?? null,
            remaining: magnitude,
            ...(effectAction.payload.decay !== undefined
              ? { decay: effectAction.payload.decay }
              : {}),
          },
          durationDefinition: effectAction.payload.duration,
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
        // 下の`expireEffects`が自身で除去1件ごとに通知するため、ここまでで
        // 通知済みの分を捕捉範囲から外して二重通知を避ける。
        innerEventsStart = context.recorder.getEvents().length;
      }
      effectLastEventId = grantResult.lastEventId;
      // R-SHD-01第3項（PRレビュー[P2]）: Formula結果が負値・0、または切り捨てで0に
      // なった付与は、残量0のインスタンスとして永続してしまう（吸収も漸減も
      // `remaining <= 0`を対象外にするため、期間満了まで枯渇契機が訪れない）。
      // 「残量が0になったインスタンスは即時失効させる」に従い、付与直後に
      // `SHIELD_DEPLETED`として失効させる — `EffectApplied`自体は監査証跡として
      // 発行し、linked group（`LILY_SINGER_PS2_LINK`等）も同じ経路でカスケードする。
      if (magnitude <= 0) {
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
          [
            {
              battleUnitId: application.targetBattleUnitId,
              effectInstanceId: grantResult.appliedEffect.effectInstanceId,
              reason: "SHIELD_DEPLETED",
            },
          ],
          context.definitions.effectActions,
          effectLastEventId,
        );
        box.units = expiry.units;
        effectLastEventId = expiry.lastEventId;
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      resultKind = "APPLIED";
    }
  } else if (effectAction.kind === "APPLY_HEALING_LINK") {
    // R-HEAL-04（M7-005-HEAL-LINK、Issue #229、production例:
    // `SKL_ELENA_MOODMAKER_AS1`「対象が得られる回復効果を100%自身に転送する」）:
    // 転送先を付与時点で解決し、転送率とともに`AppliedEffect.healingLink`へ
    // 焼き込む（`APPLY_ATTACK_DAMAGE_BONUS`と同じ「付与時snapshot」規約 — 回復
    // 適用時点にはTargetBindingもトリガーcontextも残っていない）。`transferTo`が
    // `SELF`以外の定義はCatalogロード時点で
    // `UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET`として拒否済みだが、Catalogを
    // 経由しない合成定義に対する実行時backstopも残す。`magnitude`は監査用に
    // 転送率をそのまま持つ（`APPLY_RESOURCE_GAIN_MOD`と同じ「符号付き割合を
    // magnitudeへ」の規約）。CombatStatsは変えないため再計算は呼ばない。
    if (effectAction.payload.transferTo.kind !== "SELF") {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `APPLY_HEALING_LINK payload.transferTo.kind "${effectAction.payload.transferTo.kind}" is not supported (R-HEAL-04 implements "SELF" only)`,
      );
    }
    const magnitude = effectAction.payload.transferRate;
    const blockingImmunity = findBlockingImmunity(
      requireUnit(box.units, application.targetBattleUnitId),
      { effectActionDefinitionId: application.effectActionDefinitionId, magnitude },
      effectAction,
    );
    if (blockingImmunity !== undefined) {
      const rejection = rejectEffectApplication(
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
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          blockingEffect: blockingImmunity,
        },
        starting.eventId,
      );
      box.units = rejection.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = rejection.lastEventId;
      resultKind = "REJECTED";
    } else {
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
          definition: effectAction,
          ...grantSourceOf(context),
          targetId: application.targetBattleUnitId,
          duplicate: true,
          magnitude,
          healingLink: {
            transferToUnitId: requireActorUnit(context, box).battleUnitId,
            transferRate: effectAction.payload.transferRate,
          },
          durationDefinition: effectAction.payload.duration,
        },
        starting.eventId,
      );
      box.units = grantResult.units;
      if (context.onFactEventForPassiveChain !== undefined) {
        for (const event of context.recorder.getEvents().slice(innerEventsStart)) {
          box.units = context.onFactEventForPassiveChain(event, box.units);
        }
      }
      resolvedCount = application.hits.length;
      interruptedCount = 0;
      effectLastEventId = grantResult.lastEventId;
      resultKind = "APPLIED";
    }
  } else {
    throw new DomainValidationError(
      "effectActionDefinitionId",
      `EffectAction kind other than "DAMAGE"/"COOLDOWN_MANIPULATION"/"APPLY_STAT_MOD"/"APPLY_STATUS"/"APPLY_MARKER"/"REMOVE_MARKER"/"REMOVE_EFFECTS"/"EFFECT_IMMUNITY"/"APPLY_ATTACK_DAMAGE_BONUS"/"APPLY_RESOURCE_GAIN_MOD"/"MODIFY_RESOURCE"/"HEAL"/"APPLY_HEALING_MOD"/"APPLY_DAMAGE_MOD"/"APPLY_CONTINUOUS_HEAL"/"APPLY_HEALING_LINK"/"APPLY_SHIELD" is not supported by this basic turn action resolver (M6/M7/M8 scope)`,
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
    ...sourceEnvelopeOf(context),
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

  const finalizeStepTargets = (): void => {
    lastResultState.lastActionTargetUnitIds = stepActionTargetUnitIds;
    lastResultState.lastDamagedTargetUnitIds = stepDamagedTargetUnitIds;
  };

  // HEAL_DISTRIBUTE（M7-005、Issue #184）: `HEAL`の`payload.distribution: "EVEN"`は
  // 「総回復量を対象数で等分する」ため、同じEffectActionが適用される対象数を
  // 分母にする。applicationは対象1体につき1件のため件数がそのまま分配数になる。
  // M7-017（Issue #271）: `MODIFY_RESOURCE`の`operation: DISTRIBUTE`も同じ分母を使う。
  //
  // PRレビュー指摘[P2]（PR #256）: 事前計画されたapplication件数をそのまま使うと、
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
  // PRレビュー指摘[P2]（PR #282）: 分配グループはEffectActionDefinition IDでは
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
    // 再レビュー指摘[P2]（PR #256）: `includeDefeated`は戦闘不能者を選択集合へ
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
      // PRレビュー[P1]（Issue #230）: `TARGET_STATE`/`TARGET_HAS_MARKER`も
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
    // PR #237再レビュー[P1]と同じ理由（`onFactEventForPassiveChain`未指定 =
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
  // PR #237再レビュー[P1]: `context.onFactEventForPassiveChain`が未指定の場合
  // （PS自身のEffectSequenceが`passive-activation-service.ts`から`yield*`で
  // 委譲されている経路）は、同期callbackで子PS連鎖を駆動できないため、
  // 消費で発生したイベント列を他のEffectAction内部イベントと同様
  // `EFFECT_RESOLVED`としてyieldし、`resolvePassiveChain`/`driveActivation`側の
  // driverに子PS連鎖の処理を委ねる。`box`は共有可変オブジェクトのため、
  // yieldで一時停止している間にdriverが`box.units`を書き換えれば、
  // resume後の後続処理は自然に最新の`units`を参照する。
  // PR #280レビュー[P1]: callbackを持つ経路では、通知は`expireEffects`が
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

  for (const step of plan.steps) {
    if (isActorDefeated(context, box)) {
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
