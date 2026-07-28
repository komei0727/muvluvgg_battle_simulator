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
  EffectInstanceId,
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
  /**
   * R-SKL-02（PR #259再々レビュー[P2]）: 使用者がPS/Memory連鎖で戦闘不能になったため
   * **一切適用しなかった**hit数。`applyDamageActionSteps`の同名フィールドと同じ意味で、
   * `resolveActionApplications`が同じEffectStepの残りの対象・後続stepを止める際の
   * 未解決数になる。
   */
  readonly interruptedCount: number;
  /**
   * R-SKL-01（同上）: 使用者の戦闘不能によってこのEffectActionが途中で打ち切られた
   * 場合`true`。`interruptedCount`とは別に持つ — 最後のhitの`HealApplied`連鎖で
   * 使用者が倒れた場合、そのhit自体は適用済み（`HealApplied`発行済み）で残りhitも
   * 無いため`interruptedCount`は0になるが、未解決の転送を残して打ち切っている以上
   * `EffectActionCompleted.resultKind`は`INTERRUPTED`でなければならない。
   */
  readonly interrupted: boolean;
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
 *
 * PR #259再レビュー[P2]（Issue #229、R-HEAL-04 #4/#6）: `HealApplied`と各
 * `HealingTransferred`の直後にPS/Memory連鎖を解決するため、`applyDamageActionSteps`
 * と同じgenerator形をとる。`context.onFactEventForPassiveChain`がある経路
 * （AS/EX・チャージ発動・継続回復）はその場で同期的に連鎖を解決するため何も
 * `yield`しない。callbackを持たない経路（PS自身のEffectSequence解決）だけが
 * 連鎖境界ごとに`yield`し、`effect-action-group-resolver.ts`がそれを
 * `EFFECT_RESOLVED`として`driveActivation`へ中継する — これが無いと、HEAL
 * EffectAction全体（転送を含む）を適用し終えてからまとめてyieldすることになり、
 * `HealApplied`起点の子PSが転送後のHPを観測してしまう。
 */
export function* applyHealActionSteps(
  hits: readonly ResolvedEffectApplication[],
  actor: BattleUnit,
  action: Extract<EffectActionDefinition, { kind: "HEAL" }>,
  units: readonly BattleUnit[],
  context: HealEventContext,
  distributionShareCount = 1,
): Generator<HealResolutionStep, ApplyHealActionResult, readonly BattleUnit[] | undefined> {
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
  let interruptedCount = 0;
  let interrupted = false;

  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index]!;
    // R-SKL-02（PR #259再々レビュー[P2]）: 使用者が直前の対象の連鎖で戦闘不能に
    // なった場合、残りの対象へ効果を適用しない（`applyDamageActionSteps`が
    // ヒットごとに行う再検証と同じ）。解決済みの効果は巻き戻さない（R-SKL-01）。
    const currentActor = working.get(actor.battleUnitId);
    if (currentActor === undefined || isDefeated(currentActor)) {
      interruptedCount = hits.length - index;
      interrupted = true;
      break;
    }
    const target = working.get(hit.targetBattleUnitId);
    if (target === undefined) {
      throw new DomainValidationError(
        "hits[].targetBattleUnitId",
        `references an unknown BattleUnitId: "${hit.targetBattleUnitId}"`,
      );
    }
    resolvedCount += 1;
    const applied = yield* applyOneHealSteps(
      {
        effectActionDefinitionId: action.effectActionDefinitionId,
        formula: action.payload.formula,
        ...(action.payload.distribution === "EVEN" ? { distributionShareCount } : {}),
        // R-SKL-01: 各連鎖境界からの再開直後に使用者の生存を再検証させ、
        // 戦闘不能なら未解決の転送を中断させる。
        interruptWhenDefeatedUnitId: actor.battleUnitId,
      },
      // 回復者自身も連鎖で変化しうるため、評価するこの瞬間の状態を引き直す
      // （`APPLY_STAT_MOD`ブランチと同じ規約 — 攻撃力バフ後の回復量を正しく反映する）。
      currentActor,
      target,
      Array.from(working.values()),
      context,
      lastEventId,
    );
    if (applied === undefined) {
      continue;
    }
    // `applyOneHealSteps`が`HealApplied`／各`HealingTransferred`の発行直後に連鎖を
    // 解決済みのため（R-HEAL-04 #4/#6）、ここで再度連鎖させてはならない。
    working = new Map(applied.units.map((u) => [u.battleUnitId, u]));
    lastEventId = applied.lastEventId;
    // R-HEAL-04: 転送先のHPだけが増えた場合（100%転送）も「回復した」と扱う。
    changed = changed || applied.changed;
    if (applied.interrupted) {
      // この対象の転送が使用者の戦闘不能で中断された。残りの対象も適用しない。
      interruptedCount = hits.length - index - 1;
      interrupted = true;
      break;
    }
  }

  return {
    units: units.map((u) => working.get(u.battleUnitId)!),
    lastEventId,
    resolvedCount,
    changed,
    interruptedCount,
    interrupted,
  };
}

/**
 * `applyHealActionSteps`の同期driver（`damage-application-service.ts`の
 * `applyDamageAction`と同じ形）。`context.onFactEventForPassiveChain`を持つ経路
 * では`yield`が一切起きないため、この形で完全に等価である。callbackを持たない
 * 経路でこれを使うと連鎖境界が失われる（`yield`されたstepを誰も処理しない）ので、
 * PS自身のEffectSequence解決からは`applyHealActionSteps`を直接駆動すること。
 */
export function applyHealAction(
  hits: readonly ResolvedEffectApplication[],
  actor: BattleUnit,
  action: Extract<EffectActionDefinition, { kind: "HEAL" }>,
  units: readonly BattleUnit[],
  context: HealEventContext,
  distributionShareCount = 1,
): ApplyHealActionResult {
  const generator = applyHealActionSteps(
    hits,
    actor,
    action,
    units,
    context,
    distributionShareCount,
  );
  let step = generator.next();
  while (!step.done) {
    step = generator.next(step.value.units);
  }
  return step.value;
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
  /**
   * R-SKL-01（PR #259再々レビュー[P2]）: 各連鎖境界から再開した直後にこのユニットの
   * 生存を再検証し、戦闘不能なら未解決の転送を中断する（`interrupted: true`）。
   * スキル使用の一部として解決される即時回復（`applyHealActionSteps`）が使用者を
   * 指定する。継続回復（`continuous-heal-service.ts`）はスキル使用ではなく
   * R-SKL-01/02の「使用者」を持たないため指定しない。
   */
  readonly interruptWhenDefeatedUnitId?: BattleUnitId;
}

export interface OneHealResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /** 対象自身が実際に増やしたHP量（R-HEAL-04で転送された分は含まない）。 */
  readonly appliedAmount: number;
  /** 対象・転送先のいずれかで実際にHPが増えた場合`true`。 */
  readonly changed: boolean;
  /**
   * R-SKL-01（PR #259再々レビュー[P2]）: `interruptWhenDefeatedUnitId`が連鎖の
   * 途中で戦闘不能になり、未解決の転送を中断した場合`true`。発行済みの
   * `HealApplied`／`HealingTransferred`は巻き戻さない。
   */
  readonly interrupted: boolean;
}

/**
 * R-HEAL-04 #4/#6の連鎖境界（PR #259再レビュー[P2]）。`applyDamageActionSteps`の
 * カスケードstepと同じく、この時点の`units`を駆動側へ渡して子PS連鎖を解決させ、
 * その結果を`next(units)`で受け取ってから次へ進む。
 */
export interface HealResolutionStep {
  readonly units: readonly BattleUnit[];
}

/** R-HEAL-04 #2で確定した1リンク分の転送割り当て。 */
interface HealingLinkTransfer {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly toUnitId: BattleUnitId;
  readonly transferRate: number;
  readonly amount: number;
}

/**
 * R-HEAL-04 #2（`M7-005-HEAL-LINK`、Issue #229）: 保持者が持つ回復リンクを付与順
 * （`appliedEffects`の配列順＝付与順、R-TGT-10と同じ定義順評価の規約）に評価し、
 * 各リンクの転送量を確定する。転送量は`切り捨て(転送前回復量 × 転送率)`とし
 * （R-NUM-02）、その時点の未転送残量を上限とする — 転送率の合計が1を超えても
 * 保持者の回復量が負になることはない。
 *
 * 次の3つは転送を発生させない（対応する分は保持者へ留まる）。
 * - 転送先が保持者自身（自己リンクは恒等。`SKL_ELENA_MOODMAKER_AS1`は自身にも
 *   リンクを付与するため、production経路で実際に通る分岐）
 * - 転送先が戦闘不能（R-HEAL-01は蘇生規則を持たない）
 * - 転送先が盤面から引けない（防御的fallback）
 *
 * 転送によって生じた回復からさらに転送を発生させないため（R-HEAL-04の再リンク
 * 禁止）、この関数は保持者の`appliedEffects`だけを読み、転送先のリンクは辿らない。
 */
function allocateHealingLinkTransfers(
  holder: BattleUnit,
  healAmount: number,
  units: readonly BattleUnit[],
): readonly HealingLinkTransfer[] {
  const transfers: HealingLinkTransfer[] = [];
  let remaining = healAmount;
  for (const effect of holder.appliedEffects) {
    if (effect.healingLink === undefined || remaining <= 0) {
      continue;
    }
    const { transferToUnitId, transferRate } = effect.healingLink;
    if (transferToUnitId === holder.battleUnitId) {
      continue;
    }
    const destination = units.find((u) => u.battleUnitId === transferToUnitId);
    if (destination === undefined || isDefeated(destination)) {
      continue;
    }
    const amount = Math.min(remaining, truncateFraction(healAmount * transferRate));
    if (amount <= 0) {
      continue;
    }
    remaining -= amount;
    transfers.push({
      effectInstanceId: effect.effectInstanceId,
      effectActionDefinitionId: effect.effectActionDefinitionId,
      toUnitId: transferToUnitId,
      transferRate,
      amount,
    });
  }
  return transfers;
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
 *
 * PRレビュー指摘[P2]（PR #259、Issue #229）: PS/Memory連鎖はこの関数**自身**が、
 * `HealApplied`と各`HealingTransferred`の発行直後に解決する。呼び出し側が戻り値を
 * 受け取った後にまとめて連鎖させる形だと、(1)`HealApplied`に反応するPSが転送後の
 * HPを観測し、(2)その連鎖で転送先が戦闘不能になっても転送前に前提を再検証できず、
 * 既存の「各FACT発行直後に連鎖を解決してから次へ進む」契約から外れてしまう。
 * そのため`OneHealResult`は連鎖用のイベント列を返さない — 二重連鎖を型として防ぐ。
 *
 * 連鎖の解決方法は経路によって2通りある（`applyDamageActionSteps`と同じ）。
 * `context.onFactEventForPassiveChain`がある経路（AS/EX・チャージ発動・継続回復）は
 * その場で同期的に呼び、何も`yield`しない。callbackを持たない経路（PS自身の
 * EffectSequence解決）は連鎖境界ごとに`yield`し、駆動側（`effect-action-group-
 * resolver.ts`）が`EFFECT_RESOLVED`として中継したうえで、連鎖後のunitsを
 * `next(units)`で返す。
 */
export function* applyOneHealSteps(
  input: OneHealInput,
  healer: BattleUnit,
  target: BattleUnit,
  units: readonly BattleUnit[],
  context: HealEventContext,
  parentEventId: DomainEventId,
): Generator<HealResolutionStep, OneHealResult | undefined, readonly BattleUnit[] | undefined> {
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

  // R-HEAL-04（M7-005-HEAL-LINK、Issue #229）: 回復リンクの転送分を先に差し引き、
  // 対象自身のHP上限判定（#3）は転送後の残量に対して行う — 転送された分は対象の
  // overhealとして破棄されない。
  const transfers = allocateHealingLinkTransfers(target, healAmount, units);
  const transferredAmount = transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
  const retainedAmount = healAmount - transferredAmount;

  const hpBefore = target.currentHp;
  const currentMax = truncateFraction(target.combatStats.maximumHp);
  const hpAfter = Math.min(currentMax, hpBefore + retainedAmount);
  const appliedAmount = hpAfter - hpBefore;
  const discardedAmount = retainedAmount - appliedAmount;

  let nextUnits =
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
      transferredAmount,
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

  let lastEventId = healApplied.eventId;
  let changed = appliedAmount > 0;
  let interrupted = false;

  /**
   * R-SKL-01（PR #259再々レビュー[P2]・再々々レビュー[P2]）: 使用者が戦闘不能なら、
   * **まだ適用していない転送が残っている場合に限り**中断する — R-SKL-01が中断を
   * 求めるのは「未解決効果」であり、この適用に未解決分が無ければ中断ではない。
   * 各iterationの先頭で1回だけ判定することで、次の2つを同時に満たす。
   *
   * - `HealApplied`の連鎖で倒れた場合: 転送が1件以上あるときだけ中断する
   *   （リンクなしのHEALは`transfers`が空なのでループに入らず、中断にならない）。
   * - 各`HealingTransferred`の連鎖で倒れた場合: 次の転送が残っているときだけ
   *   中断する（最後の転送を適用し終えていれば中断にならない）。
   *
   * 残りの対象（hit）がある場合の中断は`applyHealActionSteps`の次hit開始時の
   * 生存チェックが担う（R-SKL-02）。既に発行済みのイベントは巻き戻さない。
   */
  const userDefeated = (current: readonly BattleUnit[]): boolean => {
    if (input.interruptWhenDefeatedUnitId === undefined) {
      return false;
    }
    const user = current.find((u) => u.battleUnitId === input.interruptWhenDefeatedUnitId);
    return user === undefined || isDefeated(user);
  };

  // R-HEAL-04 #3の直後（＝転送の適用より前）にPS/Memory連鎖を解決する
  // （PRレビュー指摘[P2]、PR #259）。`HealApplied`に反応するPSは転送前のHPを観測し、
  // 続く各転送はこの連鎖後の最新stateに対して前提を再検証してから適用される。
  nextUnits = yield* chainFactEvent(context, healApplied, nextUnits);

  // R-HEAL-04 #4/#5: 各転送先へ転送量をそのまま適用する。回復量Formulaと
  // HealingModifier（R-HEAL-02）は再計算しない（R-LNK-02と同じ規約）。最大HP上限と
  // `overheal: DISCARD`は転送先自身へ適用し、HP変化のStateDeltaは
  // `HealingTransferred`が持つ（同じHP変化を`HealApplied`と二重に運ばない）。
  for (const transfer of transfers) {
    if (userDefeated(nextUnits)) {
      interrupted = true;
      break;
    }
    const destination = nextUnits.find((u) => u.battleUnitId === transfer.toUnitId);
    if (destination === undefined) {
      // 防御的fallback（現行モデルではユニットが配列から消えることはない）。
      continue;
    }
    // #2の割り当て時点では生存していた転送先が、直前の連鎖で戦闘不能になっている
    // ことがある。R-HEAL-01「戦闘不能の対象は回復しない」（蘇生規則を持たない）に
    // 従い適用しない — 割り当て済みの転送量は破棄し、保持者へは戻さない
    // （`HealApplied`のStateDeltaは既に確定済みであり、`R-INT-03`「元ダメージの
    // 適用結果を巻き戻さない」と同じ規約）。監査証跡を失わないよう、
    // `appliedAmount: 0`／`discardedAmount: 転送量`の`HealingTransferred`は発行する。
    const receivable = !isDefeated(destination);
    const destinationMax = truncateFraction(destination.combatStats.maximumHp);
    const destinationHpBefore = destination.currentHp;
    const destinationHpAfter = receivable
      ? Math.min(destinationMax, destinationHpBefore + transfer.amount)
      : destinationHpBefore;
    const destinationApplied = destinationHpAfter - destinationHpBefore;
    if (destinationApplied > 0) {
      nextUnits = nextUnits.map((u) =>
        u.battleUnitId === transfer.toUnitId
          ? { ...u, currentHp: createHitPoint(destinationHpAfter, destinationMax) }
          : u,
      );
      changed = true;
    }
    const transferred = context.recorder.record({
      eventType: "HealingTransferred",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: healApplied.eventId,
      rootEventId: context.rootEventId,
      sourceUnitId: context.sourceUnitId,
      targetUnitIds: [transfer.toUnitId],
      payload: {
        effectInstanceId: transfer.effectInstanceId,
        effectActionDefinitionId: transfer.effectActionDefinitionId,
        fromUnitId: target.battleUnitId,
        toUnitId: transfer.toUnitId,
        transferRate: transfer.transferRate,
        transferredAmount: transfer.amount,
        appliedAmount: destinationApplied,
        discardedAmount: transfer.amount - destinationApplied,
        hpBefore: destinationHpBefore,
        hpAfter: destinationHpAfter,
      },
      // `HealApplied`と同じ規約 — 変化0のStateDeltaは独立Reducerにとって
      // 無意味なno-opなので付けない。
      ...(destinationApplied > 0
        ? {
            stateDelta: {
              units: {
                [transfer.toUnitId]: {
                  hp: { before: destinationHpBefore, after: destinationHpAfter },
                },
              },
            },
          }
        : {}),
    });
    lastEventId = transferred.eventId;
    // R-HEAL-04 #5: 次の転送へ進む前にこの転送の連鎖を解決する（同上）。
    // この連鎖で使用者が戦闘不能になった場合の中断判定は、次iterationの先頭で行う
    // （＝残りの転送があるときだけ中断する）。
    nextUnits = yield* chainFactEvent(context, transferred, nextUnits);
  }

  return { units: nextUnits, lastEventId, appliedAmount, changed, interrupted };
}

/**
 * 1つのFACTイベントについてPS/Memory即時連鎖を解決し、連鎖後の最新stateを返す
 * （PRレビュー指摘[P2]・再レビュー[P2]、PR #259）。
 *
 * - callbackがある経路（AS/EX・チャージ発動・継続回復）はその場で同期的に解決する。
 * - callbackが無い経路（PS自身のEffectSequence解決）は`yield`して駆動側へ委ね、
 *   連鎖後のunitsを`next(units)`で受け取る。駆動側が何も返さない場合
 *   （generatorを単純にdrainする同期driver）は、連鎖が起きなかったものとして
 *   渡したunitsをそのまま使う。
 */
function* chainFactEvent(
  context: HealEventContext,
  event: BattleDomainEvent,
  units: readonly BattleUnit[],
): Generator<HealResolutionStep, readonly BattleUnit[], readonly BattleUnit[] | undefined> {
  if (context.onFactEventForPassiveChain !== undefined) {
    return context.onFactEventForPassiveChain(event, units);
  }
  const resumed = yield { units };
  return resumed ?? units;
}

/**
 * `applyOneHealSteps`の同期driver（`applyHealAction`と同じ理由・同じ形）。
 * 継続回復（`continuous-heal-service.ts`）は行動開始時の4経路すべてから連鎖
 * callback付きで呼ばれるため`yield`が起きず、この形で完全に等価である。
 */
export function applyOneHeal(
  input: OneHealInput,
  healer: BattleUnit,
  target: BattleUnit,
  units: readonly BattleUnit[],
  context: HealEventContext,
  parentEventId: DomainEventId,
): OneHealResult | undefined {
  const generator = applyOneHealSteps(input, healer, target, units, context, parentEventId);
  let step = generator.next();
  while (!step.done) {
    step = generator.next(step.value.units);
  }
  return step.value;
}
