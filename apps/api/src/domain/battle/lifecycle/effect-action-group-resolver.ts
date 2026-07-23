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
  resolveActionStepApplications,
  type EffectActionApplication,
  type EffectSequencePlan,
  type LastResultTargetContext,
  type ResolvedBinding,
} from "../skill/skill-resolution-service.js";
import { evaluateEffectStepCondition } from "../skill/effect-step-condition-evaluator.js";
import type {
  LastEffectActionResult,
  LastEffectActionResultKind,
} from "../skill/last-effect-action-result.js";
import { selectWeightedBranch } from "../skill/random-branch-selection.js";
import { resolveProbability } from "../../shared/percentage.js";
import type {
  EffectActionReference,
  EffectStepDefinition,
  RandomBranch,
} from "../../catalog/definitions/effect-sequence.js";
import type {
  EffectActionDefinitionId,
  TargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { ConditionKind } from "../../catalog/definitions/condition-definition.js";
import { createPercentage } from "../../shared/percentage.js";
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
}

export interface EffectActionGroupsResult {
  readonly units: readonly BattleUnit[];
  /** 使用者が戦闘不能になる前に到達し、実際に処理したヒット・適用の総数。 */
  readonly resolvedCount: number;
  /**
   * PR #216再々々々々々レビュー: 「中断が実際に発生したか」の判定に
   * 使う正式なフラグ。`SkillUseInterrupted`/`SkillUseCompleted`のどちらを
   * 発行するかは、この`sequenceInterrupted`だけで判定する。
   *
   * PR #216再々々々々々々レビュー[P1]再修正: 単に「戦闘不能を観測した」
   * だけでは真にしない — resolverが中断を検出した各分岐で、その時点の
   * 未解決pending work見積もり（`countHits`/`countCandidateHits`系）が
   * 1件以上ある場合だけ真にする。false conditionのみのbranch等、実際には
   * 何も失われていない場合に`sequenceInterrupted`が誤って真になる
   * （＝`unresolvedEffectCount: 0`のまま`SkillUseInterrupted`を発行して
   * しまう）ことを防ぐ。この結果、`sequenceInterrupted`は依然
   * `interruptedCount`の見積もり計算そのものに依存するため、見積もりの
   * 精度（下記`interruptedCount`のコメント）がこのフラグの精度の上限になる
   * — ただし見積もりが誤る方向は「未着手subtreeを実際より多く候補に含める」
   * （過大側）のみであり、過大側の誤りは`sequenceInterrupted`を誤ってfalseに
   * することはない（falseになるのは見積もりが0の時だけであり、0という見積もり
   * 自体は`evaluateEffectStepCondition`によるcondition評価のように厳密な
   * 判定で導出されるケースが大半）。
   */
  readonly sequenceInterrupted: boolean;
  /**
   * PR #141再レビュー[P2]、PR #216再々〜再々々々々レビューで累次修正:
   * 使用者が戦闘不能になったことで未処理のまま残ったヒット・適用の
   * "見積もり"総数（`SkillUseInterrupted.unresolvedEffectCount`が
   * 公開する）。`BRANCH`/`RANDOM_BRANCH`/`REPEAT`（RES-003）を含む未着手
   * subtreeについては、実際に適用しないまま`resolvedBindings`/
   * `effectActions`と、中断時点までの実`lastResultBox`から複製した
   * simulated last-resultだけを頼りに`countCandidateHits`が静的に
   * 見積もる（`RANDOM_BRANCH`の分岐選択はRNGを消費するため後追いで
   * 確定できず、`weight`/`probability`が明示的に0の到達不能branchは除外した
   * 上で、`WEIGHTED_ONE`は最大1分岐分、`INDEPENDENT`は未判定分も含めた
   * 全branch合算という保守的な上限を使う）。厳密な実行時カウントではなく
   * 「実行していたら発生していたであろうヒット数の保守的な上限」である点は
   * `08_ドメインイベント.md`/`SkillUseInterrupted`/`PassiveInterrupted`の
   * ペイロード仕様として明記している（PR #216再々々々々々レビュー[P2]）。
   */
  readonly interruptedCount: number;
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
 * R-SKL-01（PR #216累次レビュー）: `EffectSequence`のresolverは、`BRANCH`の
 * 直前結果依存・`RANDOM_BRANCH`の乱数結果・`REPEAT`のiteration状態・同じ
 * subtree内で先行ACTIONが生成する`LAST_RESULT`/`LAST_*_TARGETS`を、
 * 実際に定義順で適用しながら（副作用を伴って）解決する。未着手のまま中断
 * された部分の`interruptedCount`（`SkillUseInterrupted.unresolvedEffectCount`
 * が公開する"見積もり"値）は、実際に適用せず`countCandidateHits`が静的に
 * 見積もるしかない。ただし本体resolverと同じ意味論を保つため、本体が
 * ACTION適用ごとに`lastResultBox`を更新するのと同じように、この見積もりも
 * 「もし適用したら」の`current`/`lastActionTargetUnitIds`/
 * `lastDamagedTargetUnitIds`を１つの`simulated`（呼び出し元の実`lastResultBox`
 * を複製した独立コピー、実resolverの状態は一切書き換えない）へ反映しながら
 * 定義順に歩く。これにより、同じ未着手subtree内で「BINDINGへのACTION →
 * `LAST_ACTION_TARGETS`へのACTION」のような順序依存も正しく見積もれる
 * （PR #216再々々々々々レビュー[P1]）。
 *
 * - `ACTION`: `condition`（RNGを消費しない純粋な評価）が`simulated.current`
 *   に対して偽ならR-SKL-06により丸ごとスキップ、寄与0。`SELF`/`BINDING`に
 *   加え`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`も`simulated`が保持する
 *   （実履歴からシード後、この見積もり自身が更新した）値から解決する。
 *   `TRIGGER_SOURCE`/`TRIGGER_TARGET`（RES-005スコープ、まだ未対応）だけは
 *   静的に解決できないため寄与0のまま。現行のダメージ判定（`HitPolicy`）は
 *   常に命中するため、対象が1件以上あれば`resultKind: "APPLIED"`、対象0件
 *   なら`"SKIPPED"`（R-SKL-08、実resolverの対象不在ケースと同じ）として
 *   `simulated`を更新する。
 * - `BRANCH`: `condition`を`simulated.current`に対して評価し、実際に解決
 *   される側だけを数える（thenSteps/elseStepsを合算しない）。選んだ側は
 *   同じ`simulated`をそのまま引き継いで歩く。
 * - `RANDOM_BRANCH`: 分岐選択はRNG消費を伴うため、ここで実際に乱数を消費して
 *   先取りすることはできない（後続の本来のRNG消費列を狂わせてしまう）。
 *   各branchは互いに独立な仮想シナリオのため、`simulated`を複製してから
 *   個別に歩く（1つのbranchの見積もりが他branchへ波及しないように — この
 *   RANDOM_BRANCH自体を抜けた後の`simulated`は「選択結果不明」のまま更新
 *   しない）。`weight`/`probability`が明示的に0のbranchは定義上絶対に
 *   選ばれ得ないため見積もりから除外する（PR #216再々々々々々レビュー[P2]）。
 *   残った到達可能branchについて、`WEIGHTED_ONE`は常に1分岐だけを選ぶため
 *   最大値の分岐1つ分と見積もる（`Math.max`）。`INDEPENDENT`は0〜全branchが
 *   独立に成立しうるため、全branch合算のままとする（安全側の上限）。
 * - `REPEAT`: 一度入れば`count`回を確定的に繰り返す（自身の中断判定は別途
 *   handled）。各iterationは実resolverと同じく同じ`simulated`を引き継ぐ
 *   （iteration間でlastResultBoxを共有する）。
 */
function countCandidateHits(
  steps: readonly EffectStepDefinition[],
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  actorId: BattleUnitId,
  lastResultBox: LastResultBox,
): number {
  // 呼び出し元の実`lastResultBox`は書き換えない — この関数は見積もり専用。
  const simulated: LastResultBox = { ...lastResultBox };
  return walkCandidateHitsList(steps, resolvedBindings, effectActions, actorId, simulated);
}

function countCandidateHitsForStep(
  step: EffectStepDefinition,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  actorId: BattleUnitId,
  lastResultBox: LastResultBox,
): number {
  const simulated: LastResultBox = { ...lastResultBox };
  return walkCandidateHitsStep(step, resolvedBindings, effectActions, actorId, simulated);
}

function walkCandidateHitsList(
  steps: readonly EffectStepDefinition[],
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  actorId: BattleUnitId,
  simulated: LastResultBox,
): number {
  return steps.reduce(
    (sum, step) =>
      sum + walkCandidateHitsStep(step, resolvedBindings, effectActions, actorId, simulated),
    0,
  );
}

function walkCandidateHitsStep(
  step: EffectStepDefinition,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  actorId: BattleUnitId,
  simulated: LastResultBox,
): number {
  switch (step.kind) {
    case "ACTION": {
      // PR #216再々々レビュー[P1]: R-SKL-06によりconditionがfalseのstepは
      // 丸ごとスキップされ実効果を持たない（`resolveActionStepBody`と同じ
      // 判定）。
      if (!evaluateEffectStepCondition(step.condition, simulated.current)) {
        return 0;
      }
      let targetUnitIds: readonly BattleUnitId[] = [];
      if (step.target.kind === "SELF") {
        targetUnitIds = [actorId];
      } else if (step.target.kind === "BINDING") {
        targetUnitIds =
          resolvedBindings
            ?.get(step.target.targetBindingId as TargetBindingId)
            ?.units.map((unit) => unit.battleUnitId) ?? [];
      } else if (step.target.kind === "LAST_ACTION_TARGETS") {
        targetUnitIds = simulated.lastActionTargetUnitIds;
      } else if (step.target.kind === "LAST_DAMAGED_TARGETS") {
        targetUnitIds = simulated.lastDamagedTargetUnitIds;
      }
      const hitsPerTarget = step.actions.reduce((sum, actionRef) => {
        const effectAction = effectActions.get(actionRef.effectActionDefinitionId);
        return sum + (effectAction?.kind === "DAMAGE" ? effectAction.payload.hitCount : 1);
      }, 0);

      // このstepが実際に適用された場合に生成するであろう直前結果で
      // `simulated`を更新し、同じ未着手subtree内の後続stepが
      // LAST_RESULT/LAST_*_TARGETSで参照できるようにする（PR #216
      // 再々々々々々レビュー[P1]）。代表actionは定義順で最後のもの
      // （実resolverの空対象ケースと同じ規約）。
      const lastActionRef = step.actions[step.actions.length - 1];
      const lastEffectAction =
        lastActionRef === undefined
          ? undefined
          : effectActions.get(lastActionRef.effectActionDefinitionId);
      if (lastActionRef !== undefined && lastEffectAction !== undefined) {
        const resultKind: LastEffectActionResultKind =
          targetUnitIds.length > 0 ? "APPLIED" : "SKIPPED";
        simulated.current = {
          resultKind,
          effectActionKind: lastEffectAction.kind,
          effectActionDefinitionId: lastActionRef.effectActionDefinitionId,
          targetUnitIds,
        };
        simulated.lastActionTargetUnitIds = targetUnitIds;
        if (lastEffectAction.kind === "DAMAGE" && resultKind === "APPLIED") {
          simulated.lastDamagedTargetUnitIds = targetUnitIds;
        }
      }

      return targetUnitIds.length * hitsPerTarget;
    }
    case "BRANCH": {
      const satisfied = evaluateEffectStepCondition(step.condition, simulated.current);
      const chosenSteps = satisfied ? step.thenSteps : step.elseSteps;
      return walkCandidateHitsList(
        chosenSteps,
        resolvedBindings,
        effectActions,
        actorId,
        simulated,
      );
    }
    case "RANDOM_BRANCH": {
      // 各branchは独立な仮想シナリオ — `simulated`を複製してから歩き、
      // このRANDOM_BRANCH自体を抜けた後の`simulated`は変更しない
      // （どのbranchが選ばれるか不明なため）。`weight`が明示的に0の
      // branch（`WEIGHTED_ONE`）・`probability`が明示的に0のbranch
      // （`INDEPENDENT`）は定義上絶対に選ばれ得ないため、見積もりから
      // 除外する（PR #216再々々々々々レビュー[P2]: 到達不能branchを
      // 含めると過大な見積もりになり、`sequenceInterrupted`の誤検出
      // リスクを不必要に広げる）。
      const reachableBranches =
        step.mode === "WEIGHTED_ONE"
          ? step.branches.filter((branch) => (branch.weight ?? 0) > 0)
          : step.branches.filter((branch) => (branch.probability ?? 0) > 0);
      const branchCounts = reachableBranches.map((branch) =>
        walkCandidateHitsList(branch.steps, resolvedBindings, effectActions, actorId, {
          ...simulated,
        }),
      );
      return step.mode === "WEIGHTED_ONE"
        ? Math.max(0, ...branchCounts)
        : branchCounts.reduce((sum, count) => sum + count, 0);
    }
    case "REPEAT": {
      let total = 0;
      for (let iteration = 0; iteration < step.count; iteration++) {
        total += walkCandidateHitsList(
          step.steps,
          resolvedBindings,
          effectActions,
          actorId,
          simulated,
        );
      }
      return total;
    }
  }
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
   * R-SKL-08（RES-003、Issue #173）: この適用が実際に確定した`EffectAction`結果
   * （`LAST_RESULT`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`が参照する直前
   * 結果を、呼び出し側が`LastResultBox`へ書き込むために必要）。
   */
  readonly lastResult: LastEffectActionResult;
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
      lastResult: {
        resultKind: "INTERRUPTED",
        effectActionKind: effectAction.kind,
        effectActionDefinitionId: application.effectActionDefinitionId,
        targetUnitIds: [application.targetBattleUnitId],
      },
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
    // R-NUM-04: `triggerSource`/`triggerTarget`/`bindings`は
    // RES-005（Issue #172）が実ライフサイクルへ配線するまでこの呼び出し元
    // では用意できない。production CatalogのAPPLY_STAT_MOD FormulaはSKILL_SOURCE
    // 参照のみを使うため、それらを要求するFormulaは`FormulaEvaluator`が明確な
    // 例外で拒否する。`lastResults`（R-SKL-08、レビュー再指摘[P1] PR #214）は
    // `context.lastDamageResults`（呼び出し側が1解決スコープごとに新規生成する
    // 共有registry、`damage-application-service.ts`と同じもの）から使用者自身の
    // 直前DAMAGE結果だけを取り出す（`SUM_*`は現時点で参照するproduction定義が
    // ないため未配線のまま、RES-002/RES-003、Issue #174/#173）。
    const actor = requireUnit(box.units, context.actorId);
    const magnitude = evaluateFormula(effectAction.payload.formula, {
      skillSource: actor,
      target: requireUnit(box.units, application.targetBattleUnitId),
      allUnits: box.units,
      lastResults: lastDamageResultsFor(context.lastDamageResults, actor.battleUnitId),
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

/** `resolveEffectSequencePlan`とその再帰呼び出し全体で共有する可変進捗state。 */
interface ResolutionState {
  resolvedCount: number;
  interruptedCount: number;
  lastEventId: DomainEventId;
  sequenceInterrupted: boolean;
}

/**
 * R-SKL-08（RES-003、Issue #173）: 同じ解決スコープ内で直前に確定した
 * `EffectAction`結果を、`LAST_RESULT`Condition・`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`TargetReferenceへ渡すための可変box。
 * `BRANCH`/`REPEAT`の内側で発生した結果も、次のstepからそのまま参照できる
 * （box自体を分岐・反復の内外で使い回すため）。
 */
interface LastResultBox {
  current?: LastEffectActionResult;
  lastActionTargetUnitIds: readonly BattleUnitId[];
  lastDamagedTargetUnitIds: readonly BattleUnitId[];
}

function lastResultTargetsContext(
  box: UnitsBox,
  lastResultBox: LastResultBox,
): LastResultTargetContext {
  return {
    allUnits: box.units,
    lastActionTargetUnitIds: lastResultBox.lastActionTargetUnitIds,
    lastDamagedTargetUnitIds: lastResultBox.lastDamagedTargetUnitIds,
  };
}

/**
 * R-SKL-06「ACTION step」#3〜#5を1step単位で解決する。`EffectStepStarting`
 * (`TIMING_EVENT`)/`EffectStepSkipped`(DIAGNOSTIC、PSの発動契機になり得ないため
 * `yield`しない)/`EffectStepCompleted`(`EFFECT_RESOLVED`)を、EffectAction(target)
 * ごとに`resolveOneEffectActionApplication`を`yield*`委譲しながら解決する。
 * 使用者の戦闘不能を各EffectAction適用前後に再確認し、検出した時点でstep以降を
 * 静かに中断へ計上する（R-SKL-01）。中断されたstepでは`EffectStepCompleted`を
 * 発行しない。static（`resolveSkillOrder`が事前解決した`ActionStepPlan`）と
 * JIT（`DeferredStepPlan`のACTION、R-SKL-08 直前結果を要する）の両経路が
 * この同じ関数を呼ぶ — 挙動を分岐させない。適用ごとに`lastResultBox`
 * （R-SKL-08）を更新し、戻り値としてこのstepが実際に解決したaction数
 * （`EffectStepCompleted.resolvedActionCount`、BRANCH/RANDOM_BRANCH/REPEATの
 * 集計にも使う）を返す。
 */
function* resolveActionStepBody(
  stepIndex: number,
  conditionKind: ConditionKind,
  satisfied: boolean,
  applications: readonly EffectActionApplication[],
  actions: readonly EffectActionReference[],
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  const stepStarting = context.recorder.record({
    eventType: "EffectStepStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: state.lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { stepIndex, stepKind: "ACTION", conditionKind },
  });
  yield { kind: "TIMING_EVENT", event: stepStarting };
  state.lastEventId = stepStarting.eventId;

  if (isDefeated(requireUnit(box.units, context.actorId))) {
    // PR #216再々々々々レビュー[P1]: `EffectStepStarting`のPS/Memory即時連鎖で
    // actorが戦闘不能になった場合、`satisfied`が真なら`applications`が
    // このstep自身の未解決ヒットそのもの（既に解決済みの正確な値、推定ではない）。
    // PR #216再々々々々々レビュー[P1]: `sequenceInterrupted`は「戦闘不能を
    // 観測した」だけでは真にせず、実際に1件以上のpending workを破棄した場合
    // だけ真にする（falseなconditionのみのstepでは何も失われていない）。
    const candidateHits = satisfied ? countHits(applications) : 0;
    if (candidateHits > 0) {
      state.sequenceInterrupted = true;
    }
    state.interruptedCount += candidateHits;
    return 0;
  }

  if (!satisfied) {
    const stepSkipped = context.recorder.record({
      eventType: "EffectStepSkipped",
      category: "DIAGNOSTIC",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: { stepIndex, conditionKind, result: false },
    });
    state.lastEventId = stepSkipped.eventId;
    return 0;
  }

  let stepCutShort = false;
  let resolvedActionCount = 0;

  if (applications.length === 0) {
    // R-SKL-08（PR #216レビュー[P1]）: 対象0件（TargetSelector/TargetReferenceが
    // 候補を1件も解決しなかった）でも、この段階に到達した時点でこのstepは
    // 「効果適用を試みたが対象が無かった」ことが確定している。R-SKL-08
    // 「対象不在などで効果が適用されなかった場合も、結果種別を持つ直前結果
    // として記録する」を満たすため、定義された最後のactionを代表として
    // 直前結果を更新する（対象が無いため`targetUnitIds: []`、実際の
    // EffectAction適用は起きていないため`EffectActionStarting`/`Completed`は
    // 発行しない）。
    const lastActionRef = actions[actions.length - 1];
    if (lastActionRef !== undefined) {
      const effectAction = context.definitions.effectActions.get(
        lastActionRef.effectActionDefinitionId,
      );
      if (effectAction === undefined) {
        throw new DomainValidationError(
          "action.effectActionDefinitionId",
          `effectActionDefinitionId "${lastActionRef.effectActionDefinitionId}" was not found in the given effectActions (Catalog preflight should already guarantee this reference exists)`,
        );
      }
      lastResultBox.current = {
        resultKind: "SKIPPED",
        effectActionKind: effectAction.kind,
        effectActionDefinitionId: lastActionRef.effectActionDefinitionId,
        targetUnitIds: [],
      };
      lastResultBox.lastActionTargetUnitIds = [];
    }
  }

  for (const application of applications) {
    if (isDefeated(requireUnit(box.units, context.actorId))) {
      stepCutShort = true;
      if (application.hits.length > 0) {
        state.sequenceInterrupted = true;
      }
      state.interruptedCount += application.hits.length;
      continue;
    }

    const applied = yield* resolveOneEffectActionApplication(
      application,
      box,
      context,
      state.lastEventId,
    );
    state.lastEventId = applied.lastEventId;
    state.resolvedCount += applied.resolvedCount;
    state.interruptedCount += applied.interruptedCount;
    // R-SKL-08: この適用が確定した結果を直前結果として記録する
    // （MISS/付与拒否/対象不在なども結果種別を持つ直前結果として記録する）。
    lastResultBox.current = applied.lastResult;
    lastResultBox.lastActionTargetUnitIds = [application.targetBattleUnitId];
    if (
      applied.lastResult.effectActionKind === "DAMAGE" &&
      applied.lastResult.resultKind === "APPLIED"
    ) {
      lastResultBox.lastDamagedTargetUnitIds = [application.targetBattleUnitId];
    }
    if (applied.interrupted) {
      stepCutShort = true;
      state.sequenceInterrupted = true;
    } else {
      resolvedActionCount += 1;
    }
  }

  if (!stepCutShort) {
    const stepCompleted = context.recorder.record({
      eventType: "EffectStepCompleted",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: { stepIndex, resolvedActionCount },
    });
    yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
    state.lastEventId = stepCompleted.eventId;
  }
  return resolvedActionCount;
}

/**
 * R-SKL-07: `BRANCH`は`condition`が true なら`thenSteps`、false なら`elseSteps`を
 * 定義順に解決する（どちらか一方は常に解決する — ACTION stepの条件skipとは
 * 異なり、BRANCH自体が「スキップ」されることはない）。
 */
function* resolveBranchStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "BRANCH" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  const stepStarting = context.recorder.record({
    eventType: "EffectStepStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: state.lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { stepIndex, stepKind: "BRANCH", conditionKind: definition.condition.kind },
  });
  yield { kind: "TIMING_EVENT", event: stepStarting };
  state.lastEventId = stepStarting.eventId;

  if (isDefeated(requireUnit(box.units, context.actorId))) {
    // PR #216再々々々々レビュー[P1]: `EffectStepStarting`のPS/Memory即時連鎖で
    // actorが戦闘不能になった場合、このBRANCH自身が本来解決するはずだった
    // 未解決ヒット数を計上する。PR #216再々々々々々レビュー[P1]:
    // `sequenceInterrupted`は見積もりが0件（例えば選ばれる側がfalse
    // conditionのみ）なら真にしない。
    const candidateHits = countCandidateHitsForStep(
      definition,
      resolvedBindings,
      effectActions,
      context.actorId,
      lastResultBox,
    );
    if (candidateHits > 0) {
      state.sequenceInterrupted = true;
    }
    state.interruptedCount += candidateHits;
    return 0;
  }

  const satisfied = evaluateEffectStepCondition(definition.condition, lastResultBox.current);
  const chosenSteps = satisfied ? definition.thenSteps : definition.elseSteps;
  const resolvedActionCount = yield* resolveStepDefinitionList(
    chosenSteps,
    resolvedBindings,
    effectActions,
    box,
    context,
    lastResultBox,
    state,
  );

  if (!state.sequenceInterrupted) {
    const stepCompleted = context.recorder.record({
      eventType: "EffectStepCompleted",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: { stepIndex, resolvedActionCount },
    });
    yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
    state.lastEventId = stepCompleted.eventId;
  }
  return resolvedActionCount;
}

/**
 * R-SKL-07: `RANDOM_BRANCH`の`WEIGHTED_ONE`はweightに応じて1分岐だけを選び、
 * 選択結果を`RandomBranchSelected`へ記録する。`INDEPENDENT`はbranch定義順に
 * 確率判定を行い、成功したbranchのstepsを定義順に解決する（乱数消費順は
 * Catalog定義順）。
 */
function* resolveRandomBranchStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "RANDOM_BRANCH" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  const stepStarting = context.recorder.record({
    eventType: "EffectStepStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: state.lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { stepIndex, stepKind: "RANDOM_BRANCH", conditionKind: "TRUE" },
  });
  yield { kind: "TIMING_EVENT", event: stepStarting };
  state.lastEventId = stepStarting.eventId;

  if (isDefeated(requireUnit(box.units, context.actorId))) {
    // PR #216再々々々々レビュー[P1]: `EffectStepStarting`のPS/Memory即時連鎖で
    // actorが戦闘不能になった場合、このRANDOM_BRANCH自身が本来解決するはず
    // だった未解決ヒット数を計上する（分岐選択すら行われていないため、
    // `countCandidateHitsForStep`の見積もりに従う）。PR #216
    // 再々々々々々レビュー[P1]: 見積もりが0件なら`sequenceInterrupted`は
    // 真にしない。
    const candidateHits = countCandidateHitsForStep(
      definition,
      resolvedBindings,
      effectActions,
      context.actorId,
      lastResultBox,
    );
    if (candidateHits > 0) {
      state.sequenceInterrupted = true;
    }
    state.interruptedCount += candidateHits;
    return 0;
  }

  // R-SKL-01（PR #216レビュー[P1]）: `RandomBranchSelected`はFACTイベントであり、
  // これを契機とするPS即時連鎖・Memory triggeredEffectsを直ちに解決してから
  // 選択branchのstepsへ進む必要がある。`recorder.record`するだけでは
  // `applyEffectActionGroups`/PS自身の解決経路のどちらも反応できない
  // （yieldされたイベントだけを連鎖処理するため）ため、他のFACTイベントと同じく
  // `EFFECT_RESOLVED`として`yield`する。
  function* recordSelected(
    branchIndex: number,
    branch: RandomBranch,
  ): Generator<EffectResolutionStep, void, void> {
    const selected = context.recorder.record({
      eventType: "RandomBranchSelected",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: {
        stepIndex,
        mode: definition.mode,
        branchIndex,
        ...(branch.label !== undefined ? { label: branch.label } : {}),
      },
    });
    yield { kind: "EFFECT_RESOLVED", events: [selected] };
    state.lastEventId = selected.eventId;
  }

  let resolvedActionCount = 0;
  if (definition.mode === "WEIGHTED_ONE") {
    const chosen = selectWeightedBranch(definition.branches, context.random);
    const branchIndex = definition.branches.indexOf(chosen);
    yield* recordSelected(branchIndex, chosen);
    // 選択直後のPS/Memory即時連鎖でactorが戦闘不能になった場合、選択branchの
    // stepsへは進まない（R-SKL-01）。既に選ばれたbranchに残る未解決ヒット数は
    // interruptedCountへ計上する（PR #216再レビュー[P1]）。
    if (isDefeated(requireUnit(box.units, context.actorId))) {
      const candidateHits = countCandidateHits(
        chosen.steps,
        resolvedBindings,
        effectActions,
        context.actorId,
        lastResultBox,
      );
      if (candidateHits > 0) {
        state.sequenceInterrupted = true;
      }
      state.interruptedCount += candidateHits;
    } else {
      resolvedActionCount = yield* resolveStepDefinitionList(
        chosen.steps,
        resolvedBindings,
        effectActions,
        box,
        context,
        lastResultBox,
        state,
      );
    }
  } else {
    for (const [branchIndex, branch] of definition.branches.entries()) {
      if (state.sequenceInterrupted || isDefeated(requireUnit(box.units, context.actorId))) {
        // PR #216再々々々々々レビュー[P1]: INDEPENDENTは各branchが独立に
        // 0〜全件成立しうるため、まだ確率判定していない残りbranch
        // （`branchIndex`以降）全件を「成立していたかもしれない」未解決分として
        // 計上する（保守的な上限 — 例えば残り全branchのprobabilityが1.0でも
        // 正しく計上できる）。ただし`probability`が明示的に0のbranchは定義上
        // 絶対に成立し得ないため、この見積もりから除外する（PR #216
        // 再々々々々々々レビュー[P2]）。
        const candidateHits = definition.branches
          .slice(branchIndex)
          .filter((remaining) => (remaining.probability ?? 0) > 0)
          .reduce(
            (sum, remaining) =>
              sum +
              countCandidateHits(
                remaining.steps,
                resolvedBindings,
                effectActions,
                context.actorId,
                lastResultBox,
              ),
            0,
          );
        // PR #216再々々々々々レビュー[P1]: 見積もりが0件なら
        // `sequenceInterrupted`は真にしない。
        if (candidateHits > 0) {
          state.sequenceInterrupted = true;
        }
        state.interruptedCount += candidateHits;
        break;
      }
      const succeeded = resolveProbability(
        createPercentage(branch.probability ?? 0),
        context.random,
      );
      if (!succeeded) {
        continue;
      }
      yield* recordSelected(branchIndex, branch);
      if (isDefeated(requireUnit(box.units, context.actorId))) {
        // 選択済み（確率判定に成功した）branchに残る未解決ヒット数を
        // interruptedCountへ計上する（PR #216再レビュー[P1]）。見積もりが
        // 0件なら`sequenceInterrupted`は真にしない（PR #216
        // 再々々々々々レビュー[P1]）。
        const candidateHits = countCandidateHits(
          branch.steps,
          resolvedBindings,
          effectActions,
          context.actorId,
          lastResultBox,
        );
        if (candidateHits > 0) {
          state.sequenceInterrupted = true;
        }
        state.interruptedCount += candidateHits;
        break;
      }
      resolvedActionCount += yield* resolveStepDefinitionList(
        branch.steps,
        resolvedBindings,
        effectActions,
        box,
        context,
        lastResultBox,
        state,
      );
    }
  }

  if (!state.sequenceInterrupted) {
    const stepCompleted = context.recorder.record({
      eventType: "EffectStepCompleted",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: { stepIndex, resolvedActionCount },
    });
    yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
    state.lastEventId = stepCompleted.eventId;
  }
  return resolvedActionCount;
}

/**
 * R-SKL-07: `REPEAT`は指定回数だけ`steps`を繰り返す。繰り返し途中で使用者が
 * 戦闘不能になった場合、残りの繰り返しを中断する。
 */
function* resolveRepeatStep(
  stepIndex: number,
  definition: Extract<EffectStepDefinition, { kind: "REPEAT" }>,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  const stepStarting = context.recorder.record({
    eventType: "EffectStepStarting",
    category: "TIMING",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.actionScope,
    parentEventId: state.lastEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.actorId,
    payload: { stepIndex, stepKind: "REPEAT", conditionKind: "TRUE" },
  });
  yield { kind: "TIMING_EVENT", event: stepStarting };
  state.lastEventId = stepStarting.eventId;

  if (isDefeated(requireUnit(box.units, context.actorId))) {
    // PR #216再々々々々レビュー[P1]: `EffectStepStarting`のPS/Memory即時連鎖で
    // actorが戦闘不能になった場合、1回目のiterationすら開始できないため、
    // `count`回すべてが未解決ヒットとなる。PR #216再々々々々々レビュー[P1]:
    // 見積もりが0件なら`sequenceInterrupted`は真にしない。
    const candidateHits = countCandidateHitsForStep(
      definition,
      resolvedBindings,
      effectActions,
      context.actorId,
      lastResultBox,
    );
    if (candidateHits > 0) {
      state.sequenceInterrupted = true;
    }
    state.interruptedCount += candidateHits;
    return 0;
  }

  let resolvedActionCount = 0;
  for (let iteration = 0; iteration < definition.count; iteration++) {
    if (state.sequenceInterrupted || isDefeated(requireUnit(box.units, context.actorId))) {
      // R-SKL-07（PR #216再々々々レビュー[P1]）: 繰り返し途中で使用者が戦闘不能に
      // なった場合、残りの繰り返しを中断する。今回開始できなかった
      // `definition.count - iteration`回分すべての未解決ヒット数を
      // interruptedCountへ計上する（さもないと`SkillUseInterrupted`の
      // `unresolvedEffectCount`契約に反する）。PR #216再々々々々々レビュー[P1]:
      // 見積もりが0件（例えば各iterationがfalse conditionのみ）なら
      // `sequenceInterrupted`は真にしない。
      const remainingIterations = definition.count - iteration;
      const candidateHits =
        countCandidateHits(
          definition.steps,
          resolvedBindings,
          effectActions,
          context.actorId,
          lastResultBox,
        ) * remainingIterations;
      if (candidateHits > 0) {
        state.sequenceInterrupted = true;
      }
      state.interruptedCount += candidateHits;
      break;
    }
    resolvedActionCount += yield* resolveStepDefinitionList(
      definition.steps,
      resolvedBindings,
      effectActions,
      box,
      context,
      lastResultBox,
      state,
    );
  }

  if (!state.sequenceInterrupted) {
    const stepCompleted = context.recorder.record({
      eventType: "EffectStepCompleted",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.actionScope,
      parentEventId: state.lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.actorId,
      payload: { stepIndex, resolvedActionCount },
    });
    yield { kind: "EFFECT_RESOLVED", events: [stepCompleted] };
    state.lastEventId = stepCompleted.eventId;
  }
  return resolvedActionCount;
}

/**
 * R-SKL-07/R-SKL-08: `DeferredStepPlan`（`skill-resolution-service.ts`）1件を
 * その場（JIT）で解決する。`ACTION`は直前結果を踏まえてcondition・対象を
 * その場で解決してから`resolveActionStepBody`へ委譲し、`BRANCH`/
 * `RANDOM_BRANCH`/`REPEAT`はそれぞれ専用の解決関数へ委譲する。
 */
function* resolveDeferredStep(
  stepIndex: number,
  definition: EffectStepDefinition,
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  if (state.sequenceInterrupted || isDefeated(requireUnit(box.units, context.actorId))) {
    // PR #216再々々々々レビュー[P1]: 呼び出し元（`resolveStepDefinitionList`/
    // トップレベルループ）は、この呼び出しの直前まで中断を検出していなかった
    // 場合だけこの関数を呼ぶ（既に中断済みなら、呼び出し元が自分で
    // `steps.slice(index)`等を計上してこの関数を呼ばない）。そのため、この
    // 分岐へ到達するのは大抵、直前の兄弟stepの最後の効果がちょうど今
    // actorを戦闘不能にした場合であり、`state.sequenceInterrupted`はまだ
    // falseで`isDefeated`だけが真になっている。この`definition`自身が本来
    // 解決するはずだった未解決ヒット数をここで計上しないと、
    // 呼び出し元側の「次のindexから」計上でも漏れてしまう。
    // PR #216再々々々々々レビュー[P1]: 見積もりが0件なら
    // `sequenceInterrupted`は真にしない（既にtrueなら`||`の左辺で
    // このブロックへ到達しており、以下の代入は冪等）。
    const candidateHits = countCandidateHitsForStep(
      definition,
      resolvedBindings,
      effectActions,
      context.actorId,
      lastResultBox,
    );
    if (candidateHits > 0) {
      state.sequenceInterrupted = true;
    }
    state.interruptedCount += candidateHits;
    return 0;
  }

  switch (definition.kind) {
    case "ACTION": {
      if (definition.target.kind === "BINDING" && resolvedBindings === undefined) {
        throw new DomainValidationError(
          "plan.resolvedBindings",
          `EffectSequencePlan.resolvedBindings is required to resolve a DEFERRED ACTION step at stepIndex ${stepIndex} referencing a BINDING target (no resolvedBindings were provided by resolveSkillOrder/resolveChargeReleaseOrder)`,
        );
      }
      const satisfied = evaluateEffectStepCondition(definition.condition, lastResultBox.current);
      const applications = satisfied
        ? resolveActionStepApplications(
            definition,
            resolvedBindings ?? new Map(),
            requireUnit(box.units, context.actorId),
            effectActions,
            lastResultTargetsContext(box, lastResultBox),
          )
        : [];
      return yield* resolveActionStepBody(
        stepIndex,
        definition.condition.kind,
        satisfied,
        applications,
        definition.actions,
        box,
        context,
        lastResultBox,
        state,
      );
    }
    case "BRANCH":
      return yield* resolveBranchStep(
        stepIndex,
        definition,
        resolvedBindings,
        effectActions,
        box,
        context,
        lastResultBox,
        state,
      );
    case "RANDOM_BRANCH":
      return yield* resolveRandomBranchStep(
        stepIndex,
        definition,
        resolvedBindings,
        effectActions,
        box,
        context,
        lastResultBox,
        state,
      );
    case "REPEAT":
      return yield* resolveRepeatStep(
        stepIndex,
        definition,
        resolvedBindings,
        effectActions,
        box,
        context,
        lastResultBox,
        state,
      );
  }
}

/**
 * `BRANCH`/`RANDOM_BRANCH`/`REPEAT`が内包する生`EffectStepDefinition[]`
 * （それぞれ`thenSteps`/`elseSteps`/選択branchの`steps`/`REPEAT`の`steps`）を
 * 定義順に解決する。ネストしたstepの`stepIndex`payloadは、それぞれの配列内での
 * 0始まりの位置とする（トップレベルの`sequence.steps`と同じ規約）。
 */
function* resolveStepDefinitionList(
  steps: readonly EffectStepDefinition[],
  resolvedBindings: ReadonlyMap<TargetBindingId, ResolvedBinding> | undefined,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  box: UnitsBox,
  context: EffectActionGroupContext,
  lastResultBox: LastResultBox,
  state: ResolutionState,
): Generator<EffectResolutionStep, number, void> {
  let resolvedActionCount = 0;
  for (const [index, definition] of steps.entries()) {
    if (state.sequenceInterrupted) {
      // PR #216再々々々レビュー[P1]: このリスト内の残り（未着手の）兄弟stepも
      // 未解決効果であり、無言で打ち切ると`interruptedCount`から漏れる。
      state.interruptedCount += countCandidateHits(
        steps.slice(index),
        resolvedBindings,
        effectActions,
        context.actorId,
        lastResultBox,
      );
      break;
    }
    resolvedActionCount += yield* resolveDeferredStep(
      index,
      definition,
      resolvedBindings,
      effectActions,
      box,
      context,
      lastResultBox,
      state,
    );
  }
  return resolvedActionCount;
}

/**
 * R-SKL-06「ACTION step」全体を解決するgenerator本体。`plan.steps`を定義順に
 * 解決する。`ActionStepPlan`（`resolveSkillOrder`が静的に事前解決済み）は
 * `resolveActionStepBody`へ直接委譲し、`DeferredStepPlan`（R-SKL-07の
 * `BRANCH`/`RANDOM_BRANCH`/`REPEAT`、およびR-SKL-08の直前結果を参照する
 * `ACTION`step、RES-003・Issue #173）は`resolveDeferredStep`がその場（JIT）で
 * 解決する。使用者の戦闘不能を各step開始前に再確認し、検出した時点でそのstep
 * 以降を静かに中断へ計上する（R-SKL-01）。
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
  const state: ResolutionState = {
    resolvedCount: 0,
    interruptedCount: 0,
    lastEventId: context.parentEventId,
    sequenceInterrupted: false,
  };
  const lastResultBox: LastResultBox = {
    lastActionTargetUnitIds: [],
    lastDamagedTargetUnitIds: [],
  };

  for (const step of plan.steps) {
    if (state.sequenceInterrupted || isDefeated(requireUnit(box.units, context.actorId))) {
      // PR #216再々々々レビュー[P1]: トップレベルの未着手DEFERRED step
      // （BRANCH/RANDOM_BRANCH/REPEAT、または直前結果依存ACTION）も
      // 未解決効果であり、無言でcontinueすると`interruptedCount`から漏れる。
      // PR #216再々々々々々レビュー[P1]: 見積もりが0件なら
      // `sequenceInterrupted`は真にしない。
      const candidateHits =
        step.stepKind === "ACTION"
          ? countHits(step.applications)
          : countCandidateHitsForStep(
              step.definition,
              plan.resolvedBindings,
              context.definitions.effectActions,
              context.actorId,
              lastResultBox,
            );
      if (candidateHits > 0) {
        state.sequenceInterrupted = true;
      }
      state.interruptedCount += candidateHits;
      continue;
    }

    if (step.stepKind === "ACTION") {
      yield* resolveActionStepBody(
        step.stepIndex,
        step.conditionKind,
        step.satisfied,
        step.applications,
        step.actions,
        box,
        context,
        lastResultBox,
        state,
      );
      continue;
    }

    yield* resolveDeferredStep(
      step.stepIndex,
      step.definition,
      plan.resolvedBindings,
      context.definitions.effectActions,
      box,
      context,
      lastResultBox,
      state,
    );
  }

  return {
    units: box.units,
    resolvedCount: state.resolvedCount,
    sequenceInterrupted: state.sequenceInterrupted,
    interruptedCount: state.interruptedCount,
  };
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
