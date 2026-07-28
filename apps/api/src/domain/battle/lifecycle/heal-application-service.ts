import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import { evaluateFormula, damageResultsFor } from "../skill/formula-evaluator.js";
import type { FormulaEvaluationContext, DamageResultRegistry } from "../skill/formula-evaluator.js";
import { composeHealingRate } from "./action-resolution-shared.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import type { EventRecorder } from "../events/event-recorder.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";

export interface HealEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
  readonly sourceUnitId: BattleUnitId;
  /** R-HEAL-02: 回復者・対象が保持する`APPLY_HEALING_MOD`をkindで引くために必要。 */
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  readonly damageResults?: DamageResultRegistry;
  readonly onFactEventForPassiveChain?: (
    event: BattleDomainEvent,
    units: readonly BattleUnit[],
  ) => readonly BattleUnit[];
}

export interface ApplyHealActionResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly resolvedCount: number;
  /** いずれかのhitで実際にHPが増えた（`HealApplied`が非0のStateDeltaを持った）場合`true`。 */
  readonly changed: boolean;
}

/**
 * R-HEAL-01 #1（M7-005、Issue #184）: 回復量Formulaを評価する。`SKILL_POWER`は
 * `14_Catalog定義スキーマ.md`が定義するとおり「攻撃力を基礎にしたスキル威力倍率」
 * であり、`FormulaEvaluator`が返す生の`power`（0.65等）をそのまま回復量にすると
 * production定義（`ACT_LUCIE_COMPANION_AS3_HEAL`の威力65など49件）が常に0回復に
 * なってしまう。`damage-calculator.ts`の`resolveBaseDamageAndSkillPower`と同じ
 * 規約で回復者の攻撃力へ乗算する — ただし回復には防御側が存在しないため、
 * ダメージ側の「攻撃力 - 防御力」に相当する減算は行わない。`SKILL_POWER`以外の
 * Formula種別（`MAX_HP_RATIO`、`DAMAGE_DEALT_RATIO`等）は`DAMAGE`と同じく評価
 * 結果そのものが回復量になる。
 */
export function evaluateHealFormula(
  formula: FormulaDefinition,
  healerAttack: number,
  context: FormulaEvaluationContext,
): number {
  if (formula.kind === "SKILL_POWER") {
    return healerAttack * formula.power;
  }
  return evaluateFormula(formula, context, "healFormula");
}

/**
 * R-HEAL-01 即時回復（M7-005、Issue #184）。1つの`HEAL` EffectActionの各hitに
 * ついて次を行う。
 *
 * 1. `FormulaDefinition`を評価する（`evaluateHealFormula`）。
 * 2. HEAL_DISTRIBUTE: `payload.distribution === "EVEN"`なら、総回復量を
 *    `distributionShareCount`（同一EffectStep内でこのEffectActionが適用される
 *    対象数）で等分する。
 * 3. R-HEAL-02のHealingModifier倍率（回復者のOUTGOING＋対象のINCOMING）を掛ける。
 * 4. R-NUM-02に従い、適用直前に一度だけ切り捨てて整数化し、0未満は0とする。
 * 5. 最大HPを超えない範囲でHPを増やし、超過分は破棄する（`overheal: DISCARD`）。
 * 6. `HealApplied`を発行する。
 *
 * 戦闘不能の対象は回復しない（`includeDefeated`が明示された選択で到達しうるが、
 * R-HEAL-01は蘇生規則を持たない — 蘇生は`APPLY_DEATH_SURVIVAL`/DMG-006の
 * スコープ）。この場合は`HealApplied`自体を発行せず、hitは解決済みとして数える。
 */
export function applyHealAction(
  hits: readonly ResolvedEffectApplication[],
  actor: BattleUnit,
  action: Extract<EffectActionDefinition, { kind: "HEAL" }>,
  units: readonly BattleUnit[],
  context: HealEventContext,
  distributionShareCount = 1,
): ApplyHealActionResult {
  if (!Number.isInteger(distributionShareCount) || distributionShareCount < 1) {
    throw new DomainValidationError(
      "distributionShareCount",
      `must be a positive integer, received ${distributionShareCount}`,
    );
  }

  let working = new Map(units.map((u) => [u.battleUnitId, u]));
  let lastEventId = context.parentEventId;
  let resolvedCount = 0;
  let changed = false;

  function chain(event: BattleDomainEvent): void {
    if (context.onFactEventForPassiveChain === undefined) {
      return;
    }
    const updated = context.onFactEventForPassiveChain(event, Array.from(working.values()));
    working = new Map(updated.map((u) => [u.battleUnitId, u]));
  }

  for (const hit of hits) {
    const target = working.get(hit.targetBattleUnitId);
    if (target === undefined) {
      throw new DomainValidationError(
        "hits[].targetBattleUnitId",
        `references an unknown BattleUnitId: "${hit.targetBattleUnitId}"`,
      );
    }
    resolvedCount += 1;
    // 回復者自身も連鎖で変化しうるため、評価するこの瞬間の状態を引き直す
    // （`APPLY_STAT_MOD`ブランチと同じ規約 — 攻撃力バフ後の回復量を正しく反映する）。
    const healer = working.get(actor.battleUnitId) ?? actor;
    const applied = applyOneHeal(
      {
        effectActionDefinitionId: action.effectActionDefinitionId,
        formula: action.payload.formula,
        ...(action.payload.distribution === "EVEN" ? { distributionShareCount } : {}),
      },
      healer,
      target,
      Array.from(working.values()),
      context,
      lastEventId,
    );
    if (applied === undefined) {
      continue;
    }
    working = new Map(applied.units.map((u) => [u.battleUnitId, u]));
    lastEventId = applied.lastEventId;
    changed = changed || applied.appliedAmount > 0;
    chain(applied.healApplied);
  }

  return {
    units: units.map((u) => working.get(u.battleUnitId)!),
    lastEventId,
    resolvedCount,
    changed,
  };
}

/** `applyOneHeal`の入力: R-HEAL-01を1対象へ1回適用するために必要な最小のCatalog由来情報。 */
export interface OneHealInput {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly formula: FormulaDefinition;
  /**
   * HEAL_DISTRIBUTE（`payload.distribution: "EVEN"`）のときだけ指定する分配数。
   * 未指定なら分配せず、Formula評価結果の全量をこの対象へ回復する。
   */
  readonly distributionShareCount?: number;
}

export interface OneHealResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  readonly appliedAmount: number;
  readonly healApplied: BattleDomainEvent;
}

/**
 * R-HEAL-01の手順そのもの（1回復元 → 1対象、1回）。即時回復（`HEAL`、
 * `applyHealAction`）と継続回復の発火（`APPLY_CONTINUOUS_HEAL`、
 * `continuous-heal-service.ts`）が同じ手順を共有するために切り出す
 * （R-HEAL-03「`R-HEAL-01`と同じ手順で回復する」）。
 *
 * 戦闘不能の対象では`undefined`を返し、`HealApplied`自体を発行しない
 * （R-HEAL-01は蘇生規則を持たない — 蘇生は`APPLY_DEATH_SURVIVAL`/DMG-006の
 * スコープ。`HEAL`は`includeDefeated`が明示された選択で、継続回復は保持者が
 * 発火時点で戦闘不能な場合にこの経路へ到達しうる）。
 */
export function applyOneHeal(
  input: OneHealInput,
  healer: BattleUnit,
  target: BattleUnit,
  units: readonly BattleUnit[],
  context: HealEventContext,
  parentEventId: DomainEventId,
): OneHealResult | undefined {
  if (isDefeated(target)) {
    return undefined;
  }

  const formulaResult = evaluateHealFormula(input.formula, healer.combatStats.attack, {
    skillSource: healer,
    target,
    allUnits: units,
    // G-10／RES-003A（Issue #257）: `context.skillUseId`はこのHEALが属する
    // EffectSequence解決を識別し、`SUM_DAMAGE_DEALT`の集計スコープになる。
    // 継続回復（`continuous-heal-service.ts`）はEffectSequenceの外で発火するため
    // registry自体を渡さず、`SUM_*`参照は`evaluateFormula`が明確な例外で拒否する。
    ...(context.damageResults !== undefined
      ? {
          lastResults: damageResultsFor(
            context.damageResults,
            healer.battleUnitId,
            context.skillUseId,
          ),
        }
      : {}),
  });

  const distributionShareCount = input.distributionShareCount ?? 1;
  if (!Number.isInteger(distributionShareCount) || distributionShareCount < 1) {
    throw new DomainValidationError(
      "distributionShareCount",
      `must be a positive integer, received ${distributionShareCount}`,
    );
  }
  const share = formulaResult / distributionShareCount;
  // R-HEAL-02: 倍率は`1 + 合計補正`、0未満は0。回復者のOUTGOINGと対象のINCOMINGを
  // どちらも集計する（R-DMG-04の与/被ダメージ補正と同じ合成）。
  const healingModifierMultiplier = Math.max(
    0,
    1 +
      composeHealingRate(healer, "OUTGOING", context.effectActions) +
      composeHealingRate(target, "INCOMING", context.effectActions),
  );
  // R-HEAL-01 #2/#3＋R-NUM-02: 切り捨ては適用直前の1回だけ。
  const healAmount = truncateFraction(Math.max(0, share * healingModifierMultiplier));

  const hpBefore = target.currentHp;
  const currentMax = truncateFraction(target.combatStats.maximumHp);
  const hpAfter = Math.min(currentMax, hpBefore + healAmount);
  const appliedAmount = hpAfter - hpBefore;
  const discardedAmount = healAmount - appliedAmount;

  const nextUnits =
    appliedAmount > 0
      ? units.map((u) =>
          u.battleUnitId === target.battleUnitId
            ? { ...u, currentHp: createHitPoint(hpAfter, currentMax) }
            : u,
        )
      : units;

  const healApplied = context.recorder.record({
    eventType: "HealApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: context.sourceUnitId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      effectActionDefinitionId: input.effectActionDefinitionId,
      sourceUnitId: context.sourceUnitId,
      targetUnitId: target.battleUnitId,
      formulaResult,
      distributionShareCount,
      healingModifierMultiplier,
      healAmount,
      appliedAmount,
      discardedAmount,
      hpBefore,
      hpAfter,
    },
    // 変化0のStateDeltaは独立Reducerにとって無意味なno-opであり、
    // `ResourceChanged`（変化量0では発行しない）と同じ理由で付けない。
    // `HealApplied`自体はR-HEAL-01 #5に従い常に発行する — Formula評価結果と
    // HealingModifier倍率の監査証跡は回復量0でも失わない。
    ...(appliedAmount > 0
      ? {
          stateDelta: {
            units: { [target.battleUnitId]: { hp: { before: hpBefore, after: hpAfter } } },
          },
        }
      : {}),
  });

  return { units: nextUnits, lastEventId: healApplied.eventId, appliedAmount, healApplied };
}
