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

/**
 * R-INT-01 #3／R-LNK-01〜03（DMG-007）: 元ダメージの適用が完了した直後、反射
 * （R-INT-01 #4）より前に、リンク元（＝この攻撃で実際にダメージを受けた側）が
 * 保持していたリンクを付与順に発生させる。
 *
 * - R-LNK-01「対象へ算出された最終ダメージをリンク元の量とする」「シールド・HPへの
 *   振り分け前の量を使用する」: `sourceDamage`は`DamageApplied.calculatedDamage`
 *   （＝`finalDamage`）そのものであり、実際にHPへ通った量でもシールド吸収後の残りでも
 *   ない。したがってリンク元のシールドが全て吸収してHPが1も減らなくてもリンクは同量で
 *   発生する
 * - R-LNK-02「リンクされた全対象へ、リンク元と同量のダメージをそれぞれ発生させる」
 *   「対象数で分割しない」: 各リンクが`linkRate`をそれぞれ独立に適用する（リンク件数で
 *   割らない）。「同量」の量とは各リンク先が受ける量が等しいという意味であり、
 *   production定義が持つ35%/50%の割合は`linkRate`が表す
 * - R-LNK-02「リンク先では属性、会心、ダメージ増減効果を再計算しない」: 反射と同じく
 *   `linkRate`を掛けた結果へR-DMG-02の切り捨てと最低1ダメージだけを適用する
 * - R-LNK-02「リンク先ごとに対応するシールドとHPへ適用する」: 適用は
 *   `applyConfirmedDamageSteps`が担うため、リンク先自身のシールド・サブユニット・
 *   致死耐えがそのまま働く
 * - R-LNK-01「元ダメージの物理／ENタイプと、シールド適用可否を引き継ぐ」／R-LNK-02
 *   「元ダメージが毒・炎上などシールド対象外なら、リンク先でもシールド対象外とする」:
 *   `damageType`と`shieldApplicable`を呼び出し側から受け取ってそのまま渡す
 * - R-LNK-03「リンクダメージに`isLinkedDamage=true`を付ける」「そのダメージから新たな
 *   リンクを発生させない」: 適用は`applyConfirmedDamageSteps`を直接呼ぶ
 *
 * リンク元がこの元ダメージ（またはその連鎖）で戦闘不能になっていればリンクは発生させず、
 * リンク先が戦闘不能な場合も同様である（R-ACTN-01 #2、`applyReflectedDamageSteps`と
 * 同じ扱い）。
 */
export function* applyLinkedDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  linkedFromUnitId: BattleUnitId,
  damageType: DamageType,
  sourceDamage: number,
  links: readonly DamageLinkSelection[],
  sourceDamageEventId: DomainEventId,
  parentEventId: DomainEventId,
  shieldApplicable = true,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  if (links.length === 0) {
    return { kind: "APPLIED", lastEventId };
  }
  for (const link of links) {
    const linkedFromUnit = working.get(linkedFromUnitId);
    if (linkedFromUnit === undefined || isDefeated(linkedFromUnit)) {
      break;
    }
    const destination = working.get(link.linkToUnitId);
    if (destination === undefined || isDefeated(destination)) {
      continue;
    }
    // R-DMG-02 #1/#3: 最終結果で切り捨て、1未満は1にする。
    const linkedDamage = Math.max(1, Math.floor(sourceDamage * link.linkRate));
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
    const reflectingUnit = findUnit(working, reflectedByUnitId, "reflect.holderUnitId");
    // 反射元がこの元ダメージ（またはその連鎖）で戦闘不能になっていれば反射しない。
    // R-INT-03第1項が禁じているのは「元ダメージの適用結果を巻き戻すこと」であって、
    // 戦闘不能になった保持者が以後も効果を発生させることまでは認めていない
    // （R-ACTN-01 #2の一般則、および`heal-application-service.ts`が戦闘不能の
    // 転送先へ転送しないのと同じ扱い）。
    if (isDefeated(reflectingUnit)) {
      break;
    }
    const formulaResult = evaluateFormula(
      reflect.formula,
      {
        skillSource: reflectingUnit,
        target: destination,
        allUnits: Array.from(working.values()),
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
