import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";
import { detectRuntimeCounterUpdates } from "../../domain/battle/triggering/runtime-counter-matcher.js";
import { evaluateTriggerCondition } from "../../domain/battle/triggering/trigger-condition-evaluator.js";
import { skillFrom, testBattleUnit, unitFrom } from "../fixtures/index.js";

/**
 * `SKILL_RUNTIME` スコープの実行時カウンタ（`R-EFF-11`）をユニット効果軸から
 * 観測するためのハーネス。
 *
 * カウンタの増減は `-001` の振る舞い表の観測（`SkillUseObservation`）に載らない。
 * 表は「スキル使用1回が起こしたこと」を見るもので、`RuntimeCounterChanged` は
 * 契機イベントから `detectRuntimeCounterUpdates` が独立に起こすためである。
 * したがって各ユニットの `-004` 以降が、そのユニット自身の宣言だけを観測する。
 */

/** `RuntimeCounterChanged` 1件ぶんの観測。 */
export interface ObservedCounterChange {
  readonly skillDefinitionId: string;
  readonly counter: string;
  readonly before: number;
  readonly after: number;
  readonly valueChanged: boolean;
}

/** このユニットのものではないPSのID。どのcounterの契機条件にも一致しない。 */
const UNRELATED_SKILL_ID = "SKL_UNRELATED_TO_THIS_UNIT";

const COMBAT_STATS = {
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function actorFor(
  unitDefinitionId: string,
  side: "ALLY" | "ENEMY",
  battleUnitId: string,
  maximumHp: number,
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    combatStats: { ...COMBAT_STATS, maximumHp },
  });
}

function declaredSkillIds(snapshot: BattleCatalogSnapshot, unitDefinitionId: string): string[] {
  const unit = unitFrom(snapshot, unitDefinitionId);
  return [
    ...unit.activeSkillDefinitionIds,
    ...unit.passiveSkillDefinitionIds,
    unit.extraSkillDefinitionId,
  ];
}

function changesOf(
  event: TriggerCandidateEvent,
  units: readonly BattleUnit[],
  snapshot: BattleCatalogSnapshot,
): readonly ObservedCounterChange[] {
  return detectRuntimeCounterUpdates({
    event,
    units,
    unitDefinitions: snapshot.units,
    skillDefinitions: snapshot.skills,
  }).changes.map((change) => ({
    skillDefinitionId: change.skillDefinitionId,
    counter: change.counter,
    before: change.before,
    after: change.after,
    valueChanged: change.valueChanged,
  }));
}

function passiveActivatedEvent(
  ownerUnitId: BattleUnitId,
  skillDefinitionId: string,
): TriggerCandidateEvent {
  return {
    eventType: "PassiveActivated",
    category: "FACT",
    sourceUnitId: ownerUnitId,
    targetUnitIds: [ownerUnitId],
    payload: { skillDefinitionId },
  };
}

export interface ActivationCounterDeclaration {
  readonly skillDefinitionId: string;
  readonly counter: string;
  readonly scope: string;
  readonly amount: number;
}

export interface ActivationCounterObservation {
  /** このユニットが宣言する発動回数counter（`PassiveActivated` 契機の `INCREMENT`）。 */
  readonly declarations: readonly ActivationCounterDeclaration[];
  /**
   * 各PSの `PassiveActivated` を1件流したときに動いたcounter。自分のcounterだけが
   * 動くこと（同じユニットの別PSのcounterは動かないこと）がこの表に現れる。
   */
  readonly changesByActivatedSkill: Readonly<Record<string, readonly ObservedCounterChange[]>>;
  /** このユニットのものではないPSの `PassiveActivated` では何も動かない。 */
  readonly changesOnUnrelatedSkill: readonly ObservedCounterChange[];
}

/**
 * 発動回数counterの観測。宣言は実 `catalog/` のユニット定義から導くため、
 * 新しいPSがcounterを宣言すれば表に行が増えて `toEqual` が落ちる。
 */
export function observeActivationCounters(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionId: string,
): ActivationCounterObservation {
  const unitDefinition = unitFrom(snapshot, unitDefinitionId);
  const owner = actorFor(
    unitDefinitionId,
    "ALLY",
    "B_RUNTIME_COUNTER:unit:1",
    unitDefinition.baseStats.maximumHp,
  );

  const declarations: ActivationCounterDeclaration[] = [];
  for (const skillDefinitionId of declaredSkillIds(snapshot, unitDefinitionId)) {
    const skill: SkillDefinition = skillFrom(snapshot, skillDefinitionId);
    for (const update of skill.counterUpdates) {
      if (update.kind !== "INCREMENT" || update.trigger.eventType !== "PassiveActivated") {
        continue;
      }
      declarations.push({
        skillDefinitionId,
        counter: update.counter,
        scope: update.scope,
        amount: update.amount,
      });
    }
  }

  return {
    declarations,
    changesByActivatedSkill: Object.fromEntries(
      declarations.map((declaration) => [
        declaration.skillDefinitionId,
        changesOf(
          passiveActivatedEvent(owner.battleUnitId, declaration.skillDefinitionId),
          [owner],
          snapshot,
        ),
      ]),
    ),
    changesOnUnrelatedSkill: changesOf(
      passiveActivatedEvent(owner.battleUnitId, UNRELATED_SKILL_ID),
      [owner],
      snapshot,
    ),
  };
}

export interface CumulativeThresholdObservation {
  readonly declaration: {
    readonly counter: string;
    readonly scope: string;
    readonly maxHpRatio: number;
  };
  /** PS側の契機。閾値を跨いだ変化だけを拾うため `RuntimeCounterChanged` である。 */
  readonly triggerEventType: string;
  /** 閾値の半分の被弾（carryだけが動く）。 */
  readonly subThreshold: {
    readonly changes: readonly ObservedCounterChange[];
    readonly triggerMatched: boolean;
  };
  /** ちょうど閾値ぶんの被弾（境界。公開値が1だけ動く）。 */
  readonly atThreshold: {
    readonly changes: readonly ObservedCounterChange[];
    readonly triggerMatched: boolean;
  };
  /** 閾値2つぶんの被弾（公開値が2動く）。 */
  readonly crossing: {
    readonly changes: readonly ObservedCounterChange[];
    readonly triggerMatched: boolean;
  };
}

/**
 * 累計ダメージ閾値counterの観測。`RuntimeCounterChanged` は carry だけが動いた
 * 被弾でも追跡のために発行される（`14_Catalog定義スキーマ.md`「counterUpdates」）
 * ため、実 `catalog/` の trigger 条件自身が `valueChanged` で両者を判別できないと、
 * 閾値に達していない被弾のたびにPSが発動してしまう。
 */
export function observeCumulativeThresholdCounter(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionId: string,
  skillDefinitionId: string,
): CumulativeThresholdObservation {
  const unitDefinition = unitFrom(snapshot, unitDefinitionId);
  const skill = skillFrom(snapshot, skillDefinitionId);
  const update = skill.counterUpdates.find(
    (entry) => entry.kind === "CUMULATIVE_DAMAGE_THRESHOLD",
  )!;
  const trigger = skill.triggers[0]!;

  const maximumHp = unitDefinition.baseStats.maximumHp;
  const threshold = maximumHp * update.maxHpRatio;
  const owner = actorFor(unitDefinitionId, "ALLY", "B_RUNTIME_COUNTER:unit:1", maximumHp);
  const enemy = actorFor(unitDefinitionId, "ENEMY", "B_RUNTIME_COUNTER:unit:2", maximumHp);

  const observe = (hitPointDamage: number) => {
    const damage: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: enemy.battleUnitId,
      targetUnitIds: [owner.battleUnitId],
      payload: { hitPointDamage },
    };
    const changes = changesOf(damage, [owner, enemy], snapshot);
    return {
      changes,
      triggerMatched:
        changes.length === 1 &&
        evaluateTriggerCondition(
          trigger.condition,
          { payload: { counter: changes[0]!.counter, valueChanged: changes[0]!.valueChanged } },
          { owner, skillDefinitionId: skill.skillDefinitionId },
        ),
    };
  };

  return {
    declaration: {
      counter: update.counter,
      scope: update.scope,
      maxHpRatio: update.maxHpRatio,
    },
    triggerEventType: trigger.eventType,
    subThreshold: observe(threshold / 2),
    atThreshold: observe(threshold),
    crossing: observe(threshold * 2),
  };
}
