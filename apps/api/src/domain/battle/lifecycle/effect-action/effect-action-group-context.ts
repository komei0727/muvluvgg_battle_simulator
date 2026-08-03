import type { BattleDefinitions } from "../../model/battle-definitions.js";
import type { ResolvedBinding } from "../../skill/skill-resolution-service.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../../shared/event-ids.js";
import type { EventRecorder } from "../../events/event-recorder.js";
import type { BattleDomainEvent } from "../../events/domain-event.js";
import type {
  SkillDefinitionId,
  TargetBindingId,
} from "../../../catalog/definitions/catalog-ids.js";
import type { SkillType } from "../../../catalog/definitions/catalog-enums.js";
import type { DamageResultRegistry } from "../../skill/formula-evaluator.js";
import type { RandomSource } from "../../../ports/random-source.js";
import { DomainValidationError } from "../../../shared/errors.js";
import type { MarkerSource } from "../../model/marker-state.js";
import { isDefeated, type BattleUnit } from "../../model/battle-unit.js";
import type { BattleUnitId } from "../../../shared/ids.js";
import type { Side } from "../../../shared/side.js";
import {
  createMemoryResolutionSource,
  type ResolutionSource,
} from "../../targeting/target-selection-policy.js";
import { requireUnit } from "../action-resolution-shared.js";

/**
 * `resolveSkillOrder`/`resolveChargeReleaseOrder`が計画した`EffectSequencePlan`を
 * 解決するために共有される因果関係コンテキスト。`action-skill-use-resolver.ts`
 * （AS/EX使用、チャージ発動）と`passive-activation-service.ts`（PS発動）の両方が
 * 使う。両者の間で循環importを起こさないよう、`applyEffectActionGroups`自体は
 * 独立した`effect-action-group-resolver.ts`へ置く。
 */
export interface EffectActionGroupContext {
  readonly definitions: BattleDefinitions;
  /**
   * 使用者（AS/EXの実行者、PSの所有者）。R-MEM-04: Memory の
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
   * R-MEM-04: Memory の `triggeredEffects` はSkillに属さないため
   * `undefined`。参照するのはDAMAGE経路（`DamageEventContext`・`SkillMissed`）
   * だけであり、その経路は使用者BattleUnitも必要とするため
   * （`requireActorUnit`）Memoryからは到達しない。
   */
  readonly skillDefinitionId?: SkillDefinitionId;
  /**
   * FACT/TIMINGイベント確定直後にPS即時連鎖を解決するフック
   * （未指定ならPS解決を行わない）。`applyDamageAction`/`applyCooldownManipulationAction`
   * のヒット単位フックへそのまま素通しされる。step/action単位のイベントに
   * ついては`applyEffectActionGroups`（同期API）だけがこれを使う —
   * `resolveEffectSequencePlan`（PSのEffectSequence自身の解決が`yield*`で
   * 委譲するgenerator）はこのフィールドを無視し、代わりに`resolvePassiveChain`の
   * `driveActivation`が共有stateで即時連鎖を解決する。
   */
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
  /**
   * R-SKL-08: `DAMAGE_DEALT_RATIO`/`DAMAGE_RECEIVED_RATIO`
   * が参照する「同じ解決スコープ内の直前DAMAGE結果」を保持する共有registry。
   * 呼び出し側（`action-skill-use-resolver.ts`/`action-charge-resolver.ts`）が
   * 1解決スコープ（1行動）ごとに新規生成し、`PassiveActivationRuntime`経由の
   * PS連鎖もこの同じインスタンスを使い回す。未指定ならこのFormulaを持つ
   * EffectActionは`FormulaEvaluator`が明確な例外で拒否する。
   */
  readonly damageResults?: DamageResultRegistry;
  /**
   * R-LNK-01/02（DMG-007）: このEffectSequenceが解決済みの
   * TargetBinding。`APPLY_DAMAGE_LINK.linkTo`の`BINDING`をリンク先ユニットへ
   * 解決するためだけに使う（`resolveEffectSequencePlan`が`plan.resolvedBindings`
   * から必ず設定するため、実resolverでは常に存在する）。EffectAction単位の解決へ
   * bindingを届ける唯一の経路である — EffectActionハンドラは
   * `EffectSequencePlan`を受け取らないためである。
   */
  readonly resolvedBindings?: ReadonlyMap<TargetBindingId, ResolvedBinding>;
  /**
   * CAP_TRIGGER_CONTEXT（RES-005）: このPSを発動させた原因イベントの
   * 発生源・対象の`BattleUnitId`。`TargetReference.kind: TRIGGER_SOURCE`/
   * `TRIGGER_TARGET`（DEFERRED stepのJIT解決、`resolveRawStep`）と、
   * `FormulaSourceReference.kind: TRIGGER_SOURCE`/`TRIGGER_TARGET`
   * （`APPLY_STAT_MOD`等のFormula評価）の両方がこれを参照する。AS/EX使用や
   * 行動外トップレベルイベントから解決する場合は原因イベントが存在しないため
   * `undefined`のまま素通しする。
   *
   * `BattleUnit`そのものではなくIDだけを保持する — 先行する
   * EffectActionや`EffectActionStarting`起点の子PS連鎖が対象のHP・combatStats
   * を変更した後も、Formula評価やDAMAGE解決の各時点で`box.units`/`working`から
   * 都度引き直すことで、古いスナップショットを読まないようにするため。
   */
  readonly triggerSourceUnitId?: BattleUnitId;
  readonly triggerTargetUnitIds?: readonly BattleUnitId[];
  /**
   * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（M7-001D）: このPSを発動
   * させた原因イベント自身の`payload`。`ACTION.stepCondition`/`BRANCH.condition`
   * の`EVENT_PAYLOAD`（`evaluateEffectStepCondition`）だけが参照する。
   * `triggerSourceUnitId`/`triggerTargetUnitIds`と同じ理由でAS/EX使用や
   * 行動外トップレベルイベントからの解決では`undefined`のまま素通しする。
   */
  readonly triggerEventPayload?: Readonly<Record<string, unknown>>;
}

/**
 * `EffectSequencePlan`の解決中の`units`最新状態を、
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
 * `resolvePassiveChain`が期待する`PassiveActivationStep`
 * （`triggering/resolve-passive-chain.ts`）と同型だが、`TriggerCandidateEvent`
 * ではなく完全な`BattleDomainEvent`を運ぶ。`passive-activation-service.ts`が
 * `toTriggerEvent`で変換しながら`resolvePassiveChain`へそのまま`yield`できる。
 */
export type EffectResolutionStep =
  | { readonly kind: "TIMING_EVENT"; readonly event: BattleDomainEvent }
  | { readonly kind: "EFFECT_RESOLVED"; readonly events: readonly BattleDomainEvent[] };

/**
 * `effects/`・`combat/`の各サービスが共通で要求するイベント因果context。
 * `parentEventId`はサービスごとに引数で受けるものと、この形へ含めるものが
 * あるため、必要な呼び出し側だけがスプレッドで重ねる。
 */
export interface EffectResolutionEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/** PSがターン開始・終了など行動外から発動した場合は`actionId`自体を持たない。 */
export function eventContextOf(context: EffectActionGroupContext): EffectResolutionEventContext {
  return {
    recorder: context.recorder,
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    rootEventId: context.rootEventId,
  };
}

/**
 * R-MEM-04: 使用者BattleUnitを持たないMemory由来の解決
 * （`context.actorId === undefined`）と、通常のSkill/PS解決の差を1か所へ閉じ込める
 * ためのアクセサ群。
 */
export function findActorUnit(
  context: EffectActionGroupContext,
  box: UnitsBox,
): BattleUnit | undefined {
  return context.actorId === undefined ? undefined : requireUnit(box.units, context.actorId);
}

/**
 * 使用者BattleUnitを必要とするEffectAction（DAMAGE、`SKILL_SOURCE`を参照する
 * Formula、回復転送先など）から呼ぶ。Memory由来の解決では黙って別のユニットへ
 * すり替えず、`14_Catalog定義スキーマ.md`/R-MEM-04が要求する「Catalog検証または
 * preflightで拒否する」と同じ理由の明確なエラーにする。
 */
export function requireActorUnit(context: EffectActionGroupContext, box: UnitsBox): BattleUnit {
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
export function isActorDefeated(context: EffectActionGroupContext, box: UnitsBox): boolean {
  const actor = findActorUnit(context, box);
  return actor !== undefined && isDefeated(actor);
}

/**
 * 対象解決（`skill-resolution-service.ts`/`target-selection-policy.ts`）へ渡す
 * 発生源。通常は使用者BattleUnit、Memory由来（R-MEM-04）ではsource sideだけを
 * 持つ{@link MemoryResolutionSource}。
 */
export function resolutionSourceOf(
  context: EffectActionGroupContext,
  box: UnitsBox,
): ResolutionSource {
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
export function requireSkillDefinitionId(context: EffectActionGroupContext): SkillDefinitionId {
  if (context.skillDefinitionId === undefined) {
    throw new DomainValidationError(
      "effectAction",
      "this EffectAction requires an owning SkillDefinition, which Memory triggeredEffects do not have (R-MEM-04)",
    );
  }
  return context.skillDefinitionId;
}

/**
 * R-CFS-02（DMG-009）: このEffectActionを解決しているスキルの種別。
 * 混乱は「アクティブスキルで攻撃する際」だけに働くため、`combat/`が読む
 * `DamageEventContext.skillType`をここで解決して渡す（`combat/`はCatalogの
 * `skillDefinitions`マップへ到達できない、module境界）。Memory由来の解決
 * （`skillDefinitionId`を持たない）と、Catalogに載っていない合成スキルでは
 * `undefined`になり、その場合は混乱を適用しない。
 */
export function skillTypeOf(context: EffectActionGroupContext): SkillType | undefined {
  if (context.skillDefinitionId === undefined) {
    return undefined;
  }
  return context.definitions.skillDefinitions.get(context.skillDefinitionId)?.skillType;
}

/** イベントエンベロープ／payloadの発生源（`08_ドメインイベント.md`「Memory由来イベントは`sourceSide`を持つ」）。 */
export function sourceEnvelopeOf(
  context: EffectActionGroupContext,
): { readonly sourceUnitId: BattleUnitId } | { readonly sourceSide: Side } | Record<string, never> {
  if (context.actorId !== undefined) {
    return { sourceUnitId: context.actorId };
  }
  return context.sourceSide !== undefined ? { sourceSide: context.sourceSide } : {};
}

/** `AppliedEffect`/`MarkerState`の付与元（`GrantEffectRequest.sourceId`/`sourceSide`）。 */
export function grantSourceOf(
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
 * Markerを黙って作らないよう、この境界で明確に拒否する。
 */
export function requireMarkerSource(context: EffectActionGroupContext): MarkerSource {
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
