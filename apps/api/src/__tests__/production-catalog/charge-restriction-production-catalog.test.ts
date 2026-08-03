import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveChargeRelease,
  resolveChargeStart,
} from "../../domain/battle/lifecycle/action-charge-resolver.js";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { reconfirmPassiveCandidate } from "../../domain/battle/triggering/reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import {
  definitionsWith,
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  testBattleUnit,
  testUnitDefinition,
} from "../../testing/fixtures/index.js";

/**
 * M7-016（Issue #270、`CAP_CHARGE_RESTRICTION`）: 「チャージ中の回避・PS制限」を
 * 実ライフサイクル（`resolveChargeStart`／`resolveChargeRelease`と、その間に挟まる
 * `resolveSkillUse`の命中判定・`PassiveActivationRuntime`のPS解決）経由で検証する。
 *
 * 完了境界となるRule ID（M7-010／Issue #177が未確定のまま引き継いだもの）は次の3件:
 *
 * - `R-HIT-02`「特別な回避効果」: 「対象がチャージ中なら自身の回避効果を発動させない」
 * - `R-HIT-04`「Nヒット回避」: 必中とチャージ中の不発は`R-HIT-02`と同じ。加えて
 *   「チャージ中で発動しなかった場合」は被ヒット消費を減らさない
 * - `R-PS-04`「発動直前確認」: 「所有者がチャージ中でない」を満たさない候補を破棄する
 *
 * production使用は`SKL_MIRIAM_MAGE_AS2`・`SKL_SIENA_OFFSTAGE_AS1`（`resolution.kind:
 * CHARGE`の2件）で、どちらも未改変の実`catalog/`から読み込んでチャージ状態を作る。
 * 回避効果側も未改変のproduction定義（`ACT_ANIS_TROUBLEMAKER_EX_EVASION`は実際に
 * `SKL_ANIS_TROUBLEMAKER_EX`が`side: ALLY, count: ALL`で味方全体へ配る`EVASION`、
 * `ACT_FLUTE_VAMPIRE_PS2_EVASION`は`HIT_EVASION`）をそのまま使う。
 *
 * 定義元スキル自身ではなく最小限の合成ASで実EffectActionDefinitionを包む方針は
 * `hit-evasion-guaranteed-hit-production-catalog.test.ts`と同じ。ただし付与は必ず
 * 「チャージ中のユニット以外の味方」から行う — `R-EFF-01`の行動単位期間は付与対象
 * 自身の行動終了時に減るため、チャージ中ユニット自身に行動を取らせるとチャージ開始
 * 行動の終了で`ACTION(1)`の回避が失効してしまい、回避不発の原因が「チャージ中」か
 * 「失効済み」か区別できなくなる。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const MIRIAM_UNIT_ID = "UNIT_MIRIAM_MAGE";
const SIENA_UNIT_ID = "UNIT_SIENA_OFFSTAGE";
const ANIS_UNIT_ID = "UNIT_ANIS_TROUBLEMAKER";
const FLUTE_UNIT_ID = "UNIT_FLUTE_VAMPIRE";

const MIRIAM_CHARGE_SKILL_ID = "SKL_MIRIAM_MAGE_AS2";
const SIENA_CHARGE_SKILL_ID = "SKL_SIENA_OFFSTAGE_AS1";
const SIENA_PASSIVE_SKILL_ID = "SKL_SIENA_OFFSTAGE_PS1";
const EVASION_EFFECT_ID = "ACT_ANIS_TROUBLEMAKER_EX_EVASION";
const HIT_EVASION_EFFECT_ID = "ACT_FLUTE_VAMPIRE_PS2_EVASION";

const SUPPORT_UNIT_ID = "UNIT_TEST_CHARGE_SUPPORT";
const ATTACKER_UNIT_ID = "UNIT_TEST_CHARGE_ATTACKER";
const ATTACK_EFFECT_ID = "ACT_TEST_CHARGE_ATTACK";
const GRANT_SKILL_ID = "SKL_TEST_GRANT_EVASION_TO_ALLIES";
const ATTACK_SKILL_ID = "SKL_TEST_CHARGE_ATTACKER";

const LIMITS = { maximumAp: 3, maximumPp: 4, maximumExtraGauge: 100 };

const COMBAT_STATS = {
  maximumHp: 200,
  attack: 50,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function actorFor(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position,
    combatStats: COMBAT_STATS,
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp, currentPp: LIMITS.maximumPp },
  });
}

/** PSを一切持たない補助ユニット定義（付与役・攻撃役）。 */
function plainUnitDefinition(id: string): UnitDefinition {
  return testUnitDefinition(id, {
    baseStats: {
      ...COMBAT_STATS,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
  });
}

/**
 * 実production EffectActionDefinitionだけを味方全体へ適用する最小限の合成AS。
 * `SKL_ANIS_TROUBLEMAKER_EX`の`TGT_ALL_ALLIES`（`side: ALLY, count: ALL`）と同じ
 * 対象形で、チャージ中の味方にも回避効果が届く形を再現する。
 */
function allyGrantSkill(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(GRANT_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_ALL_ALLIES"),
          selector: {
            kind: "SELECT",
            side: "ALLY",
            count: "ALL",
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALL_ALLIES") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: GRANT_SKILL_ID, tags: [] },
  };
}

/** 通常命中（`accuracy.mode: NORMAL`）の2ヒット攻撃を、指定した1体へ撃つ合成AS。 */
function attackerSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(ATTACK_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: ATTACK_SKILL_ID, tags: [] },
  };
}

function twoHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 2,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly skillOf: (skillDefinitionId: string) => SkillDefinition;
  readonly unitDefinitionOf: (unitDefinitionId: string) => UnitDefinition;
}

/**
 * 実`catalog/`から`unitIds`を読み込み、そこへ合成の付与AS・攻撃AS・補助ユニット
 * 定義だけを足す。production定義（unit/skill/effectAction）は一切書き換えない。
 */
function fixture(unitIds: readonly string[], grantEffectActionId?: string): Fixture {
  const snapshot = loadProductionSnapshot(CATALOG_DIR, unitIds);

  const attack = twoHitAttack();
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(attack.effectActionDefinitionId, attack);

  const definitions = definitionsWith(snapshot, {
    units: [plainUnitDefinition(SUPPORT_UNIT_ID), plainUnitDefinition(ATTACKER_UNIT_ID)],
    skills: [
      attackerSkill(),
      ...(grantEffectActionId === undefined ? [] : [allyGrantSkill(grantEffectActionId)]),
    ],
    overrides: { effectActions },
  });

  return {
    definitions,
    recorder: new EventRecorder(createBattleId("B_CHARGE")),
    skillOf: (skillDefinitionId) =>
      definitions.skillDefinitions.get(createSkillDefinitionId(skillDefinitionId))!,
    unitDefinitionOf: (unitDefinitionId) =>
      definitions.unitDefinitions.get(createUnitDefinitionId(unitDefinitionId))!,
  };
}

function unitIn(units: readonly BattleUnit[], target: BattleUnit): BattleUnit {
  return units.find((u) => u.battleUnitId === target.battleUnitId)!;
}

/**
 * `charging`が真なら実チャージASでチャージ状態にし、その後で味方（`support`）が
 * 実production回避効果を味方全体へ配り、最後に敵が2ヒット攻撃を撃つ。
 */
function runEvasionScenario(options: {
  readonly chargerUnitId: string;
  readonly chargeSkillId: string;
  readonly evasionEffectActionId: string;
  readonly charging: boolean;
  readonly extraUnitIds?: readonly string[];
}): {
  readonly recorder: EventRecorder;
  readonly eventsDuringAttack: readonly BattleDomainEvent[];
  readonly chargerBefore: BattleUnit;
  readonly chargerAfterCharge: BattleUnit;
  readonly chargerAfterAttack: BattleUnit;
  readonly initialSnapshot: BattleStateSnapshot;
} {
  const { definitions, recorder, skillOf } = fixture(
    [options.chargerUnitId, ...(options.extraUnitIds ?? [])],
    options.evasionEffectActionId,
  );
  const chargeSkill = skillOf(options.chargeSkillId);
  const grantSkill = skillOf(GRANT_SKILL_ID);
  const attackSkill = skillOf(ATTACK_SKILL_ID);

  const charger = actorFor("B_CHARGE:unit:1", options.chargerUnitId, "ALLY", {
    column: "CENTER",
    row: "FRONT",
  });
  const support = actorFor("B_CHARGE:unit:2", SUPPORT_UNIT_ID, "ALLY", {
    column: "LEFT",
    row: "BACK",
  });
  const attacker = actorFor("B_CHARGE:unit:3", ATTACKER_UNIT_ID, "ENEMY", {
    column: "CENTER",
    row: "FRONT",
  });
  const initialSnapshot = initialSnapshotFor([charger, support, attacker]);

  let units: readonly BattleUnit[] = [charger, support, attacker];
  if (options.charging) {
    units = resolveChargeStart(
      charger,
      chargeSkill,
      "AS",
      "AS",
      units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_CHARGE:action:1"),
      recorder.nextResolutionScopeId(),
    ).units;
  }
  const chargerAfterCharge = unitIn(units, charger);

  units = resolveSkillUse(
    unitIn(units, support),
    grantSkill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:2"),
    recorder.nextResolutionScopeId(),
  ).units;

  const eventsBeforeAttack = recorder.getEvents().length;
  units = resolveSkillUse(
    unitIn(units, attacker),
    attackSkill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:3"),
    recorder.nextResolutionScopeId(),
  ).units;

  return {
    recorder,
    eventsDuringAttack: recorder.getEvents().slice(eventsBeforeAttack),
    chargerBefore: charger,
    chargerAfterCharge,
    chargerAfterAttack: unitIn(units, charger),
    initialSnapshot,
  };
}

describe("production Catalog CAP_CHARGE_RESTRICTION (M7-016, Issue #270, R-SKL-05/R-HIT-02/R-HIT-04/R-PS-04)", () => {
  it("IT-CAP-CHARGE-RESTRICTION-PROD-001 (R-SKL-05/R-HIT-02, real lifecycle wiring): starting the real SKL_MIRIAM_MAGE_AS2 charge puts Miriam into a charge state observable on the ChargeStarted Domain Event, StateDelta and independent Reducer replay, and while charging the real production ACT_ANIS_TROUBLEMAKER_EX_EVASION she holds does not evade a single hit of an incoming NORMAL-accuracy attack", () => {
    const result = runEvasionScenario({
      chargerUnitId: MIRIAM_UNIT_ID,
      chargeSkillId: MIRIAM_CHARGE_SKILL_ID,
      evasionEffectActionId: EVASION_EFFECT_ID,
      charging: true,
      extraUnitIds: [ANIS_UNIT_ID],
    });

    // チャージ状態そのもの（R-SKL-05）。
    expect(result.chargerAfterCharge.charge).toBeDefined();
    expect(result.chargerAfterCharge.charge!.skill.skillDefinitionId).toBe(MIRIAM_CHARGE_SKILL_ID);

    const chargeStarted = result.recorder
      .getEvents()
      .find((e) => e.eventType === "ChargeStarted") as Extract<
      BattleDomainEvent,
      { eventType: "ChargeStarted" }
    >;
    expect(chargeStarted).toBeDefined();
    expect(chargeStarted.payload).toMatchObject({
      actorUnitId: result.chargerBefore.battleUnitId,
      skillDefinitionId: MIRIAM_CHARGE_SKILL_ID,
    });
    expect(chargeStarted.stateDelta!.units![result.chargerBefore.battleUnitId]!.charge).toEqual({
      before: undefined,
      after: {
        skillDefinitionId: MIRIAM_CHARGE_SKILL_ID,
        startedActionId: "B_CHARGE:action:1",
      },
    });
    const replayed = reconstruct(result.initialSnapshot, result.recorder);
    expect(replayed.units[result.chargerBefore.battleUnitId]!.charge).toEqual({
      skillDefinitionId: MIRIAM_CHARGE_SKILL_ID,
      startedActionId: "B_CHARGE:action:1",
    });

    // 回避効果は実際に保持している（未付与や失効による不発ではない）。
    const evasion = result.chargerAfterAttack.appliedEffects.find(
      (e) => e.effectActionDefinitionId === EVASION_EFFECT_ID,
    );
    expect(evasion).toBeDefined();
    expect(evasion!.statusKind).toBe("EVASION");
    expect(evasion!.statusDetails).toMatchObject({ probability: 1 });

    // R-HIT-02: チャージ中なので発動しない — 2ヒットとも命中する。
    expect(
      result.eventsDuringAttack.filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(0);
    expect(result.eventsDuringAttack.filter((e) => e.eventType === "HitConfirmed")).toHaveLength(2);
    expect(result.chargerAfterAttack.currentHp).toBeLessThan(result.chargerBefore.currentHp);
  });

  it("IT-CAP-CHARGE-RESTRICTION-PROD-002 (R-HIT-02, negative control): the identical setup without the charge start lets the same real production ACT_ANIS_TROUBLEMAKER_EX_EVASION evade the first hit, proving the suppression in PROD-001 is caused by the charge state alone", () => {
    const result = runEvasionScenario({
      chargerUnitId: MIRIAM_UNIT_ID,
      chargeSkillId: MIRIAM_CHARGE_SKILL_ID,
      evasionEffectActionId: EVASION_EFFECT_ID,
      charging: false,
      extraUnitIds: [ANIS_UNIT_ID],
    });

    expect(result.chargerAfterCharge.charge).toBeUndefined();
    expect(
      result.eventsDuringAttack.filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(1);
    expect(result.eventsDuringAttack.filter((e) => e.eventType === "HitConfirmed")).toHaveLength(1);
  });

  it("IT-CAP-CHARGE-RESTRICTION-PROD-003 (R-HIT-04 boundary): while the real SKL_SIENA_OFFSTAGE_AS1 charge is pending, the real production HIT_EVASION ACT_FLUTE_VAMPIRE_PS2_EVASION neither evades nor spends its INCOMING_HIT consumption, since a hit it did not evade must not reduce it", () => {
    const charging = runEvasionScenario({
      chargerUnitId: SIENA_UNIT_ID,
      chargeSkillId: SIENA_CHARGE_SKILL_ID,
      evasionEffectActionId: HIT_EVASION_EFFECT_ID,
      charging: true,
      extraUnitIds: [FLUTE_UNIT_ID],
    });

    expect(charging.chargerAfterCharge.charge).toBeDefined();
    expect(charging.chargerAfterCharge.charge!.skill.skillDefinitionId).toBe(SIENA_CHARGE_SKILL_ID);

    const hitEvasion = charging.chargerAfterAttack.appliedEffects.find(
      (e) => e.effectActionDefinitionId === HIT_EVASION_EFFECT_ID,
    );
    expect(hitEvasion).toBeDefined();
    expect(hitEvasion!.statusKind).toBe("HIT_EVASION");
    // 「回避が成立しなかった被ヒットでは、その回避効果の被ヒット消費を減らさない」。
    expect(hitEvasion!.duration.consumptionRemaining).toBe(1);
    expect(
      charging.eventsDuringAttack.filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(0);
    expect(charging.eventsDuringAttack.filter((e) => e.eventType === "HitConfirmed")).toHaveLength(
      2,
    );

    // 対照: チャージしていなければ1ヒット目を回避し、その被ヒットで自身の消費が尽きる。
    const notCharging = runEvasionScenario({
      chargerUnitId: SIENA_UNIT_ID,
      chargeSkillId: SIENA_CHARGE_SKILL_ID,
      evasionEffectActionId: HIT_EVASION_EFFECT_ID,
      charging: false,
      extraUnitIds: [FLUTE_UNIT_ID],
    });
    expect(
      notCharging.eventsDuringAttack.filter((e) => e.eventType === "EvasionActivated"),
    ).toHaveLength(1);
    expect(
      notCharging.chargerAfterAttack.appliedEffects.find(
        (e) => e.effectActionDefinitionId === HIT_EVASION_EFFECT_ID,
      ),
    ).toBeUndefined();
  });

  it("IT-CAP-CHARGE-RESTRICTION-PROD-004 (R-PS-04): the real SKL_SIENA_OFFSTAGE_PS1 TurnStarted passive activates for an idle Siena but is discarded with reason OWNER_CHARGING once the real SKL_SIENA_OFFSTAGE_AS1 charge is pending, so no PassiveActivated is emitted", () => {
    const { definitions, recorder, skillOf } = fixture([SIENA_UNIT_ID]);
    const chargeSkill = skillOf(SIENA_CHARGE_SKILL_ID);
    const passiveSkill = skillOf(SIENA_PASSIVE_SKILL_ID);
    expect(passiveSkill.triggers[0]).toMatchObject({
      eventType: "TurnStarted",
      sourceSelector: "SELF",
    });

    const siena = actorFor("B_CHARGE:unit:1", SIENA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });
    const enemy = actorFor("B_CHARGE:unit:2", ATTACKER_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });

    const charged = resolveChargeStart(
      siena,
      chargeSkill,
      "AS",
      "AS",
      [siena, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_CHARGE:action:1"),
      recorder.nextResolutionScopeId(),
    ).units;
    const chargingSiena = unitIn(charged, siena);
    expect(chargingSiena.charge).toBeDefined();

    const turnStartedEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      sourceUnitId: siena.battleUnitId,
      targetUnitIds: [siena.battleUnitId],
      payload: { turnNumber: 2 },
    };
    const guard = createEmptyPassiveActivationGuard();
    const detectFor = (owner: BattleUnit) =>
      detectPassiveCandidates({
        event: turnStartedEvent,
        units: [owner, enemy],
        unitDefinitions: definitions.unitDefinitions,
        skillDefinitions: definitions.skillDefinitions,
        activationGuard: guard,
      }).filter((c) => c.skillDefinition.skillDefinitionId === SIENA_PASSIVE_SKILL_ID);

    // チャージしていなければ候補化し、発動直前確認も通る。
    const idleCandidates = detectFor(siena);
    expect(idleCandidates).toHaveLength(1);
    expect(reconfirmPassiveCandidate(idleCandidates[0]!, siena, turnStartedEvent, guard)).toEqual({
      ok: true,
    });

    // R-PS-04: 同じ候補を、チャージ中の最新状態で再確認すると破棄される。
    expect(
      reconfirmPassiveCandidate(idleCandidates[0]!, chargingSiena, turnStartedEvent, guard),
    ).toEqual({ ok: false, reason: "OWNER_CHARGING" });
    // R-PS-01側の候補判定でも、チャージ中の所有者は最初から候補にならない。
    expect(detectFor(chargingSiena)).toHaveLength(0);

    // 実ライフサイクル（`PassiveActivationRuntime`）でも同じ結論になる。
    const chargingRecorder = new EventRecorder(createBattleId("B_CHARGE_PS_CHARGING"));
    const chargingTurnStarted = chargingRecorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: chargingRecorder.nextResolutionScopeId(),
      payload: { turnNumber: 2 },
    });
    new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder: chargingRecorder,
        turnNumber: 2,
        cycleNumber: 0,
        resolutionScopeId: chargingTurnStarted.resolutionScopeId,
        rootEventId: chargingTurnStarted.eventId,
      },
      [chargingSiena, enemy],
    ).onFactEvent(chargingTurnStarted, [chargingSiena, enemy]);
    expect(chargingRecorder.getEvents().map((e) => e.eventType)).not.toContain("PassiveActivated");

    const idleRecorder = new EventRecorder(createBattleId("B_CHARGE_PS_IDLE"));
    const idleTurnStarted = idleRecorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: idleRecorder.nextResolutionScopeId(),
      payload: { turnNumber: 2 },
    });
    const idleUnits = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder: idleRecorder,
        turnNumber: 2,
        cycleNumber: 0,
        resolutionScopeId: idleTurnStarted.resolutionScopeId,
        rootEventId: idleTurnStarted.eventId,
      },
      [siena, enemy],
    ).onFactEvent(idleTurnStarted, [siena, enemy]).units;
    const activated = idleRecorder.getEvents().find((e) => e.eventType === "PassiveActivated");
    expect(activated?.payload).toMatchObject({
      actorUnitId: siena.battleUnitId,
      skillDefinitionId: SIENA_PASSIVE_SKILL_ID,
    });
    expect(unitIn(idleUnits, siena).currentPp).toBeLessThan(siena.currentPp);
  });

  it("IT-CAP-CHARGE-RESTRICTION-PROD-005 (R-SKL-05/R-PS-04 boundary): completing the real SKL_SIENA_OFFSTAGE_AS1 charge release clears the charge on the units, on the ActionCompleting StateDelta and on an independent Reducer replay, and the R-PS-04 restriction lifts on the very same candidate", () => {
    const { definitions, recorder, skillOf } = fixture([SIENA_UNIT_ID]);
    const chargeSkill = skillOf(SIENA_CHARGE_SKILL_ID);

    const siena = actorFor("B_CHARGE:unit:1", SIENA_UNIT_ID, "ALLY", {
      column: "CENTER",
      row: "FRONT",
    });
    const enemy = actorFor("B_CHARGE:unit:2", ATTACKER_UNIT_ID, "ENEMY", {
      column: "CENTER",
      row: "FRONT",
    });
    const initialSnapshot = initialSnapshotFor([siena, enemy]);

    const charged = resolveChargeStart(
      siena,
      chargeSkill,
      "AS",
      "AS",
      [siena, enemy],
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_CHARGE:action:1"),
      recorder.nextResolutionScopeId(),
    ).units;

    const released = resolveChargeRelease(
      unitIn(charged, siena),
      "AS",
      charged,
      definitions,
      // チャージ解放（`ACT_SIENA_OFFSTAGE_AS1_DAMAGE`）は会心判定でRandomSourceを
      // 消費する。会心率0のユニットでも判定自体は行われるため、常に非会心になる
      // 十分な数の固定値を与える。
      new SequenceRandomSource(Array.from({ length: 32 }, () => 0.99)),
      recorder,
      1,
      0,
      createActionId("B_CHARGE:action:2"),
      recorder.nextResolutionScopeId(),
    ).units;
    const sienaAfterRelease = unitIn(released, siena);
    expect(sienaAfterRelease.charge).toBeUndefined();

    const chargeClearing = recorder
      .getEvents()
      .filter(
        (e) =>
          e.stateDelta?.units?.[siena.battleUnitId]?.charge?.after === undefined &&
          e.stateDelta?.units?.[siena.battleUnitId]?.charge !== undefined,
      );
    expect(chargeClearing.map((e) => e.eventType)).toEqual(["ActionCompleting"]);
    expect(
      reconstruct(initialSnapshot, recorder).units[siena.battleUnitId]!.charge,
    ).toBeUndefined();

    const turnStartedEvent: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      sourceUnitId: siena.battleUnitId,
      targetUnitIds: [siena.battleUnitId],
      payload: { turnNumber: 2 },
    };
    const guard = createEmptyPassiveActivationGuard();
    const candidates = detectPassiveCandidates({
      event: turnStartedEvent,
      units: [sienaAfterRelease, enemy],
      unitDefinitions: definitions.unitDefinitions,
      skillDefinitions: definitions.skillDefinitions,
      activationGuard: guard,
    }).filter((c) => c.skillDefinition.skillDefinitionId === SIENA_PASSIVE_SKILL_ID);
    expect(candidates).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(candidates[0]!, sienaAfterRelease, turnStartedEvent, guard),
    ).toEqual({ ok: true });
  });

  it("IT-CAP-CHARGE-RESTRICTION-PROD-006 (M7-016, Issue #270 review [P1]): both real CHARGE definitions carry an empty start-side steps array, so nothing a charge start would silently drop is declared, and a real charge start applies no MarkerState at all", () => {
    for (const [unitId, skillId] of [
      [MIRIAM_UNIT_ID, MIRIAM_CHARGE_SKILL_ID],
      [SIENA_UNIT_ID, SIENA_CHARGE_SKILL_ID],
    ] as const) {
      const { definitions, recorder, skillOf } = fixture([unitId]);
      const chargeSkill = skillOf(skillId);

      // Catalog契約: 開始側はEffectSequenceを持たない（`targetBindings`だけが
      // `activationCondition`のスコープとして意味を持つ）。`chargeRelease`は持つ。
      expect(chargeSkill.resolution.kind).toBe("CHARGE");
      expect(chargeSkill.resolution.steps).toEqual([]);
      if (chargeSkill.resolution.kind === "CHARGE") {
        expect(chargeSkill.resolution.chargeRelease.steps.length).toBeGreaterThan(0);
      }
      // 「チャージ中」を表す`APPLY_MARKER`は`charge`状態と重複する変換由来の定義
      // だったため除去済み。実カタログのどこからも参照されない。
      expect(
        [...definitions.effectActions.keys()].filter((id) => id.endsWith("_CHARGE_MARKER")),
      ).toEqual([]);

      const charger = actorFor("B_CHARGE:unit:1", unitId, "ALLY", {
        column: "CENTER",
        row: "FRONT",
      });
      const enemy = actorFor("B_CHARGE:unit:2", ATTACKER_UNIT_ID, "ENEMY", {
        column: "CENTER",
        row: "FRONT",
      });

      const charged = resolveChargeStart(
        charger,
        chargeSkill,
        "AS",
        "AS",
        [charger, enemy],
        definitions,
        new SequenceRandomSource([]),
        recorder,
        1,
        0,
        createActionId("B_CHARGE:action:1"),
        recorder.nextResolutionScopeId(),
      ).units;

      // runtime: チャージ開始はEffectSequenceを一切解決しない
      // （`06_戦闘状態遷移.md`「チャージ開始」#1〜6）。両者が一致している。
      const chargerAfter = unitIn(charged, charger);
      expect(chargerAfter.charge).toBeDefined();
      expect(chargerAfter.markerStates).toEqual([]);
      expect(chargerAfter.appliedEffects).toEqual([]);
      expect(recorder.getEvents().map((e) => e.eventType)).not.toContain("MarkerApplied");
      expect(recorder.getEvents().map((e) => e.eventType)).not.toContain("EffectApplied");
    }
  });
});
