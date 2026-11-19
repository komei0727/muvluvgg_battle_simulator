import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { DamageLinkSelection, ReflectSelection } from "./defensive-intervention-policy.js";
import { damageResultsFor, evaluateFormula } from "../skill/formula-evaluator.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import { findUnit, notifyOrYieldNewEvents } from "./damage-hit-chain.js";
import {
  applyConfirmedDamageSteps,
  type ConfirmedDamageApplication,
} from "./damage-hit-point-application.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * 元ダメージの確定後に、そのダメージから**派生する**ダメージ（R-LNK-01〜03のリンク、
 * R-INT-03の反射）を発生させる。どちらも`applyConfirmedDamageSteps`を直接呼び、
 * 介入解決（`resolveDefensiveInterventionsSteps`）とこのモジュール自身をもう一度
 * 通らない — 再リンク・再反射を構造的に禁じるためであり、相互リンク・循環リンクも
 * 常に1往復で停止する。
 */

/** R-LNK-02: 元ダメージから分配が確定した1リンク分。 */
export interface DamageLinkAllocation extends DamageLinkSelection {
  readonly linkedDamage: number;
}

/**
 * R-LNK-01／R-LNK-02: 軽減後・シールド吸収前の元ダメージ（`DamageCalculated.finalDamage`）
 * から、保持者のリンクごとの分配量を付与順に確定する。リンクは元の被害へ**追加**される
 * のではなく、元ダメージから差し引いてリンク先へ移す（総被害は元ダメージを超えない）。
 *
 * - 各リンクの分配量は`切り捨て(元ダメージ × linkRate)`（R-NUM-02）で、その時点の
 *   未分配残量を上限とする（R-HEAL-04 #2の回復リンクと同じ規約）。リンク率の合計が1を
 *   超えても元対象の取り分が負にならない
 * - 分配量へ最低1ダメージは適用しない。切り捨てで0になったリンクは成立させず、元対象が
 *   その分を受ける — 最低1を課すと1ダメージのヒットが丸ごとリンク先へ移ってしまうため
 * - `retainedDamage`は元対象が自身のシールド・HPへ受ける量であり、各側のシールドは
 *   分配後の量を独立に吸収する
 */
export function allocateDamageLinks(
  sourceDamage: number,
  links: readonly DamageLinkSelection[],
): { readonly allocations: readonly DamageLinkAllocation[]; readonly retainedDamage: number } {
  const allocations: DamageLinkAllocation[] = [];
  let remaining = sourceDamage;
  for (const link of links) {
    const linkedDamage = Math.min(remaining, Math.floor(sourceDamage * link.linkRate));
    if (linkedDamage <= 0) {
      continue;
    }
    remaining -= linkedDamage;
    allocations.push({ ...link, linkedDamage });
  }
  return { allocations, retainedDamage: remaining };
}

/**
 * R-INT-01 #3／R-LNK-01〜03: 元対象への分配分の適用が完了した直後、反射（R-INT-01 #4）
 * より前に、`allocateDamageLinks`が確定させた分配量をリンク先へ付与順に適用する。
 *
 * - R-LNK-01: `sourceDamage`は分配前の`DamageCalculated.finalDamage`であり、イベントの
 *   監査証跡として運ぶ。分配量自体は呼び出し側が元ダメージの適用前に確定させている
 * - R-LNK-02「リンク先では属性、会心、ダメージ増減効果を再計算しない」「リンク先ごとに
 *   対応するシールドとHPへ適用する」: 適用は`applyConfirmedDamageSteps`が担うため、
 *   リンク先自身のシールド・サブユニット・致死耐えがそのまま働く
 * - R-LNK-01第3項／R-LNK-02第5項: `damageType`と`shieldApplicable`をそのまま渡す
 * - R-LNK-03: 適用は`applyConfirmedDamageSteps`を直接呼ぶため再リンクしない
 *
 * 保持者がこの元ヒットで戦闘不能になっても、分配が確定したリンク分は発生させる — 分配分は
 * すでに元対象の被害から差し引かれており、ここで止めると総被害が失われるためである。
 * 撃破後の別の攻撃では保持者が攻撃対象にならず、リンクはそれ以上発生しない。
 * リンク先が戦闘不能な場合は適用しない（R-ACTN-01 #2）。
 */
export function* applyLinkedDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  linkedFromUnitId: BattleUnitId,
  damageType: DamageType,
  sourceDamage: number,
  allocations: readonly DamageLinkAllocation[],
  sourceDamageEventId: DomainEventId,
  parentEventId: DomainEventId,
  shieldApplicable = true,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  for (const link of allocations) {
    const destination = working.get(link.linkToUnitId);
    if (destination === undefined || isDefeated(destination)) {
      continue;
    }
    const { linkedDamage } = link;
    const generatedEventsStart = context.recorder.getEvents().length;
    const generated = context.recorder.record({
      eventType: "LinkedDamageGenerated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: linkedFromUnitId,
      targetUnitIds: [link.linkToUnitId],
      payload: {
        sourceDamageEventId,
        effectInstanceId: link.effectInstanceId,
        effectActionDefinitionId: link.effectActionDefinitionId,
        linkedFromUnitId,
        linkToUnitId: link.linkToUnitId,
        sourceDamage,
        linkRate: link.linkRate,
        linkedDamage,
        damageType,
        shieldApplicable,
      },
    });
    lastEventId = generated.eventId;
    yield* notifyOrYieldNewEvents(context, working, generatedEventsStart);

    // 連鎖がリンク先を倒していれば適用しない（R-ACTN-01 #2）。
    const destinationBeforeApply = working.get(link.linkToUnitId);
    if (destinationBeforeApply === undefined || isDefeated(destinationBeforeApply)) {
      continue;
    }
    const application = yield* applyConfirmedDamageSteps(
      context,
      working,
      linkedFromUnitId,
      link.linkToUnitId,
      {
        effectActionDefinitionId: link.effectActionDefinitionId,
        // リンクはヒット列を持たないため常に0（`isReflectedDamage`と同じ規約）。
        hitIndex: 0,
        damageType,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      linkedDamage,
      lastEventId,
      { isLinkedDamage: true, shieldApplicable },
    );
    lastEventId = application.lastEventId;
    if (application.kind === "INTERRUPT") {
      return { kind: application.kind, lastEventId };
    }
  }
  return { kind: "APPLIED", lastEventId };
}

/**
 * R-INT-01 #4／R-INT-03（DMG-006）: 元ダメージの適用が完了した直後に、防御側が保持して
 * いた反射（`resolveDefensiveInterventionsSteps`が確定させた集合）を付与順に発生させる。
 *
 * - R-INT-03第1項「反射は元ダメージの確定後、元ダメージの適用結果を巻き戻さずに
 *   発生する」: 元ダメージの`DamageApplied`（`sourceDamageEventId`）を契機として
 *   `ReflectedDamageGenerated`を発行し、続けて反射先へ適用する。この適用で反射元が
 *   戦闘不能になっていても（元ダメージで倒れていても）反射は取り消さない
 * - R-INT-03第2項「反射からさらに反射を発生させない」: 反射ダメージの適用は
 *   `applyConfirmedDamageSteps`を直接呼ぶ。したがって再反射も、引き寄せ・肩代わりによる
 *   反射先の差し替えも起きない
 * - R-INT-03第3項: 適用の`DamageApplied`は`isReflectedDamage: true`を持つ
 *
 * 反射量は`APPLY_REFLECT.formula`（production例は`DAMAGE_RECEIVED_RATIO`／
 * `LAST_DAMAGE_RECEIVED`の75%）の評価結果へ、R-DMG-02の最終切り捨てと最低1ダメージ
 * だけを適用する。属性相性・会心・与/被ダメージ補正はいずれも掛けない — R-INT-03は
 * 反射量を「元ダメージからの割合」としてのみ規定し、反射元のスキル威力でも攻撃でも
 * ないためである（R-DOT-01の継続ダメージと同じ扱い）。ダメージタイプと貫通は
 * 元ダメージから引き継ぐ／持たない。
 *
 * 反射先（`reflectTo: TRIGGER_SOURCE`＝元ダメージの攻撃者）が戦闘不能、または
 * 反射元自身の場合は発生させない（R-ACTN-01 #2、および自己反射が恒等になる
 * `allocateHealingLinkTransfers`の自己リンクと同じ扱い）。
 */
export function* applyReflectedDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  reflectToUnitId: BattleUnitId,
  reflectedByUnitId: BattleUnitId,
  damageType: DamageType,
  sourceDamage: number,
  reflects: readonly ReflectSelection[],
  sourceDamageEventId: DomainEventId,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  if (reflects.length === 0 || reflectToUnitId === reflectedByUnitId) {
    return { kind: "APPLIED", lastEventId };
  }
  for (const reflect of reflects) {
    const destination = working.get(reflectToUnitId);
    if (destination === undefined || isDefeated(destination)) {
      break;
    }
    // 反射元がこの元ヒットで戦闘不能になっても、そのヒット分の反射は確定して発生させる。
    // 撃破後の別の攻撃では保持者が攻撃対象にならないため、反射が残り続けることはない。
    const reflectingUnit = findUnit(working, reflectedByUnitId, "reflect.holderUnitId");
    const formulaResult = evaluateFormula(
      reflect.formula,
      {
        skillSource: reflectingUnit,
        target: destination,
        allUnits: Array.from(working.values()),
        ...(context.exercise !== undefined ? { exercise: context.exercise } : {}),
        lastResults: {
          ...damageResultsFor(context.damageResults, reflectedByUnitId, context.skillUseId),
          // R-INT-03: 反射が参照する「受けたダメージ」はこの元ダメージそのものである。
          // registryの直前結果に依存させない — 元ダメージの適用後に解決するPS連鎖が
          // 別のDAMAGEを挟むと、registry側の`LAST_DAMAGE_RECEIVED`が既にそちらへ
          // 置き換わっている可能性があるためである。
          LAST_DAMAGE_RECEIVED: sourceDamage,
        },
      },
      "reflect.formula",
    );
    // R-DMG-02 #1/#3: 最終結果で切り捨て、1未満は1にする。
    const reflectedDamage = Math.max(1, Math.floor(formulaResult));
    const generatedEventsStart = context.recorder.getEvents().length;
    const generated = context.recorder.record({
      eventType: "ReflectedDamageGenerated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      skillUseId: context.skillUseId,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: reflectedByUnitId,
      targetUnitIds: [reflectToUnitId],
      payload: {
        sourceDamageEventId,
        effectInstanceId: reflect.effectInstanceId,
        effectActionDefinitionId: reflect.effectActionDefinitionId,
        reflectedByUnitId,
        reflectToUnitId,
        sourceDamage,
        formulaResult,
        reflectedDamage,
        damageType,
      },
    });
    lastEventId = generated.eventId;
    yield* notifyOrYieldNewEvents(context, working, generatedEventsStart);

    // 連鎖が反射先を倒していれば適用しない（R-ACTN-01 #2）。反射元の戦闘不能は
    // 反射を取り消さない（R-INT-03第1項）。
    const destinationBeforeApply = working.get(reflectToUnitId);
    if (destinationBeforeApply === undefined || isDefeated(destinationBeforeApply)) {
      break;
    }
    const application = yield* applyConfirmedDamageSteps(
      context,
      working,
      reflectedByUnitId,
      reflectToUnitId,
      {
        effectActionDefinitionId: reflect.effectActionDefinitionId,
        // 反射はヒット列を持たないため常に0（`08_ドメインイベント.md`の
        // `isReflectedDamage`と併せて通常ヒットと区別できる）。
        hitIndex: 0,
        damageType,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      reflectedDamage,
      lastEventId,
      { isReflectedDamage: true },
    );
    lastEventId = application.lastEventId;
    if (application.kind !== "APPLIED") {
      return { kind: application.kind, lastEventId };
    }
  }
  return { kind: "APPLIED", lastEventId };
}
