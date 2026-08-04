import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { recoverTurnResources, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  loadProductionSnapshot,
  testBattleUnit,
  testUnitDefinition,
  unitFrom,
} from "../../testing/fixtures/index.js";

/**
 * M7-002A（Issue #255、`CAP_RESOURCE_CAPACITY_MOD`／G-09）: production Catalogの
 * `UNIT_FLUTE_VAMPIRE`／`SKL_FLUTE_VAMPIRE_PS1`「イモータル・ヴァンパイア」が持つ
 * `ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP`（`MODIFY_RESOURCE_CAPACITY`、`resource: AP` /
 * `operation: ADD` / 戦闘中恒久）を実カタログから無改変で読み込み、実PS発動経路
 * （`PassiveActivationRuntime.onFactEvent`→`effect-action-group-resolver.ts`→
 * `resource-capacity-recalculation-service.ts`）で上限が実際に上がることを検証する。
 *
 * 検証の要点は3つ:
 * 1. 上限（`maximumAp`）だけが上がり、現在値（`currentAp`）は追随しない（R-ACT-04）
 * 2. 上がった上限がターン開始のリソース回復で実際に使われる（`recoverTurnResources`）
 *    — 上限がどこにも効かない「記録だけの値」になっていないことの証拠
 * 3. `ResourceCapacityChanged`のStateDeltaが独立Reducer（`state-delta-reducer.ts`）
 *    で同じ上限へ復元できる
 *
 * PS1のTriggerは`HitPointReduced`＋`sourceSelector: SELF`のため、HP減少の発生源が
 * 自身であるイベントだけを拾う。ここでは実`applyDamageAction`へFlute自身を攻撃者
 * 兼対象として渡し、その実イベントをPS発動経路へ流す（本Issueの検証対象は
 * `MODIFY_RESOURCE_CAPACITY`の解決であり、Trigger自体はM7-001D／Issue #247で
 * 実装済みの`TARGET_STATE`/`RUNTIME_COUNTER`条件をそのまま通す）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const FLUTE_UNIT_ID = "UNIT_FLUTE_VAMPIRE";
const FLUTE_PS1_ID = "SKL_FLUTE_VAMPIRE_PS1";
const MAX_AP_UP_ID = "ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP";
const SELF_HIT_EFFECT_ID = "ACT_TEST_SELF_HIT";
const PEER_UNIT_ID = "UNIT_TEST_CAPACITY_PEER";

/** `UNIT_FLUTE_VAMPIRE.baseStats.maximumAp`（実Catalog）。上限変更前の基準。 */
const FLUTE_BASE_MAX_AP = 4;
const FLUTE_MAX_HP = 1000;
const LIMITS = { maximumAp: FLUTE_BASE_MAX_AP, maximumPp: 4, maximumExtraGauge: 7 };

const COMBAT_STATS = {
  maximumHp: FLUTE_MAX_HP,
  attack: 100,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

/**
 * `HitPointReduced`をFlute自身を発生源として起こすためだけの最小DAMAGE定義。
 * 会心・属性・貫通のゆらぎを持たず、`SKILL_POWER`だけで固定量を削る。
 */
function selfHitAction(power: number): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(SELF_HIT_EFFECT_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function setup() {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, [FLUTE_UNIT_ID]);

  // 実Catalogの定義形をこのテストの前提として固定する（近似・差し替えなし）。
  const maxApUp = effectActionFrom(snapshot, MAX_AP_UP_ID);
  expect(maxApUp).toMatchObject({
    kind: "MODIFY_RESOURCE_CAPACITY",
    payload: {
      resource: "AP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: 1 },
      duration: { dispellable: false, timeLimit: { unit: "BATTLE", count: 1 } },
    },
    requiredCapabilities: ["CAP_RESOURCE_CAPACITY_MOD"],
  });
  expect(unitFrom(snapshot, FLUTE_UNIT_ID).baseStats.maximumAp).toBe(FLUTE_BASE_MAX_AP);

  const selfHit = selfHitAction(1);
  const flute = testBattleUnit({
    battleUnitId: "ally:flute",
    unitDefinitionId: FLUTE_UNIT_ID,
    position: { column: "CENTER", row: "FRONT" },
    combatStats: { ...COMBAT_STATS, attack: 950 },
    limits: LIMITS,
    // PSコスト1PP分と、AP消費済み（上限が上がっても現在値は追随しないことを見るため）。
    overrides: { currentPp: LIMITS.maximumPp, currentAp: 0, currentHp: 1000 },
  });
  const enemy = testBattleUnit({
    battleUnitId: "enemy:1",
    unitDefinitionId: PEER_UNIT_ID,
    side: "ENEMY",
    position: { column: "CENTER", row: "FRONT" },
    combatStats: COMBAT_STATS,
    limits: LIMITS,
  });

  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(selfHit.effectActionDefinitionId, selfHit);
  const definitions = definitionsWith(snapshot, {
    units: [
      testUnitDefinition(PEER_UNIT_ID, {
        baseStats: { ...COMBAT_STATS, maximumAp: LIMITS.maximumAp, maximumPp: LIMITS.maximumPp },
        extraGaugeMaximum: LIMITS.maximumExtraGauge,
      }),
    ],
    overrides: { effectActions },
  });

  const recorder = new EventRecorder(createBattleId("B_CAPACITY"));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });

  return { definitions, recorder, resolutionScopeId, seed, flute, enemy, selfHit };
}

/**
 * Flute自身を発生源とする実`HitPointReduced`（HPを10%以下へ落とす）を起こし、
 * PS1の発動条件を実際に成立させる。
 */
function reduceOwnHitPoints(context: ReturnType<typeof setup>): {
  readonly hitPointReduced: BattleDomainEvent;
  readonly units: readonly BattleUnit[];
} {
  const { recorder, resolutionScopeId, seed, flute, enemy, selfHit } = context;
  const actionId = recorder.nextActionId();
  const damage = applyDamageAction(
    flute,
    [
      {
        targetUnitId: flute.battleUnitId,
        effectActionDefinitionId: selfHit.effectActionDefinitionId,
        hitIndex: 1,
      },
    ],
    selfHit,
    [flute, enemy],
    new SequenceRandomSource([]),
    {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      skillUseId: recorder.nextSkillUseId(),
      resolutionScopeId,
      rootEventId: seed.eventId,
      parentEventId: seed.eventId,
      skillDefinitionId: createSkillDefinitionId("SKL_TEST_SELF_HIT"),
    },
  );
  const hitPointReduced = recorder.getEvents().find((e) => e.eventType === "HitPointReduced")!;
  const damagedFlute = damage.units.find((u) => u.battleUnitId === flute.battleUnitId)!;
  // R-PS-01の`TARGET_STATE HP_RATIO <= 0.1`が成立していることを、条件評価に頼らず固定する。
  expect(damagedFlute.currentHp / damagedFlute.combatStats.maximumHp).toBeLessThanOrEqual(0.1);
  return { hitPointReduced, units: damage.units };
}

function activatePassive(
  context: ReturnType<typeof setup>,
  hitPointReduced: BattleDomainEvent,
  units: readonly BattleUnit[],
): readonly BattleUnit[] {
  const runtime = new PassiveActivationRuntime(
    {
      definitions: context.definitions,
      random: new SequenceRandomSource([]),
      recorder: context.recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: context.resolutionScopeId,
      rootEventId: hitPointReduced.eventId,
    },
    units,
  );
  const activated = runtime.onFactEvent(hitPointReduced, units).units;
  expect(
    context.recorder
      .getEvents()
      .some(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId === FLUTE_PS1_ID,
      ),
  ).toBe(true);
  return activated;
}

describe("production Catalog ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP (M7-002A, Issue #255, G-09/CAP_RESOURCE_CAPACITY_MOD)", () => {
  it("IT-CAP-RESOURCE-CAPACITY-MOD-PROD-001 (real lifecycle wiring): the real MODIFY_RESOURCE_CAPACITY raises maximumAp by 1 while leaving the immutable base and the current AP untouched, and emits ResourceCapacityChanged", () => {
    const context = setup();
    const { hitPointReduced, units } = reduceOwnHitPoints(context);

    const activated = activatePassive(context, hitPointReduced, units);

    const flute = activated.find((u) => u.battleUnitId === context.flute.battleUnitId)!;
    expect(flute.maximumAp).toBe(FLUTE_BASE_MAX_AP + 1);
    // 不変の基準は動かない — 失効・解除時にここへ戻せることが再合成方式の前提。
    expect(flute.baseMaximumAp).toBe(FLUTE_BASE_MAX_AP);
    // R-ACT-04: 上限が上がっただけでは現在値は追随しない。
    expect(flute.currentAp).toBe(0);
    expect(
      flute.appliedEffects.some((effect) => effect.effectActionDefinitionId === MAX_AP_UP_ID),
    ).toBe(true);

    const capacityChanged = context.recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "ResourceCapacityChanged" }> =>
          event.eventType === "ResourceCapacityChanged",
      );
    expect(capacityChanged).toHaveLength(1);
    expect(capacityChanged[0]!.payload).toMatchObject({
      battleUnitId: context.flute.battleUnitId,
      resource: "AP",
      before: FLUTE_BASE_MAX_AP,
      after: FLUTE_BASE_MAX_AP + 1,
      reason: "EFFECT_APPLIED",
    });
    expect(capacityChanged[0]!.stateDelta?.units?.[context.flute.battleUnitId]?.maximumAp).toEqual({
      before: FLUTE_BASE_MAX_AP,
      after: FLUTE_BASE_MAX_AP + 1,
    });
  });

  it("IT-CAP-RESOURCE-CAPACITY-MOD-PROD-002: the raised capacity is what the next turn's resource recovery fills to, so the extra AP is actually usable", () => {
    const context = setup();
    const { hitPointReduced, units } = reduceOwnHitPoints(context);

    const activated = activatePassive(context, hitPointReduced, units);
    const recovered = recoverTurnResources(
      activated.find((u) => u.battleUnitId === context.flute.battleUnitId)!,
    );

    // 06_戦闘状態遷移.md TURN_STARTING #2: APは最大値まで回復する。上限変更が
    // 効いていなければここは基準の4のままになる。
    expect(recovered.currentAp).toBe(FLUTE_BASE_MAX_AP + 1);
  });

  it("IT-CAP-RESOURCE-CAPACITY-MOD-PROD-003 (independent Reducer restoration): applying only the StateDeltas emitted by the activation reconstructs the same raised capacity", () => {
    const context = setup();
    const { hitPointReduced, units } = reduceOwnHitPoints(context);
    // 発動直前の実状態と、そこから先に記録されたStateDeltaだけを突き合わせる。
    const initial = initialSnapshotFor(units, { include: ["effects", "markers"] });
    const before = context.recorder.getEvents().length;

    const activated = activatePassive(context, hitPointReduced, units);

    const restored = reduceStateDeltas(
      initial,
      context.recorder
        .getEvents()
        .slice(before)
        .flatMap((event) => (event.stateDelta !== undefined ? [event.stateDelta] : [])),
    );

    const live = activated.find((u) => u.battleUnitId === context.flute.battleUnitId)!;
    expect(restored.units[context.flute.battleUnitId]!.maximumAp).toBe(live.maximumAp);
    expect(restored.units[context.flute.battleUnitId]!.ap).toBe(live.currentAp);
    expect(restored.units[context.flute.battleUnitId]!.hp).toBe(live.currentHp);
  });
});
