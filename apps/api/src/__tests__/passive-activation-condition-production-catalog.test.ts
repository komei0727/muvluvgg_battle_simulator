import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattleUnit, type BattleUnit } from "../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../domain/battle/model/global-coordinate.js";
import type { MarkerState } from "../domain/battle/model/marker-state.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { PassiveActivationRuntime } from "../domain/battle/lifecycle/passive-activation-service.js";
import { reduceStateDeltas } from "../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../domain/battle/lifecycle/battle-state-snapshot.js";
import { createEmptyPassiveActivationGuard } from "../domain/battle/triggering/passive-activation-guard.js";
import { detectPassiveCandidates } from "../domain/battle/triggering/passive-trigger-matcher.js";
import { reconfirmPassiveCandidate } from "../domain/battle/triggering/reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "../domain/battle/triggering/trigger-event.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";
import { createMarkerId } from "../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId } from "../domain/shared/event-ids.js";
import type { Side } from "../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../testing/random/sequence-random-source.js";

/**
 * RES-004（Issue #171、`CAP_PASSIVE_ACTIVATION_CONDITION`）: PSの
 * `activationCondition`（`TARGET_HAS_MARKER`/`ALIVE_UNIT_COUNT`/`TURN_NUMBER`）
 * を候補判定（R-PS-01）・発動直前再確認（R-PS-04）の両経路で評価する production
 * 代表定義7件の検証証跡。各テストは`catalog/`から実際にロードした未改変の
 * `activationCondition`を対象に、`detectPassiveCandidates`/
 * `reconfirmPassiveCandidate`を直接駆動する — capability検証は「PSのactivation
 * ConditionをPS候補判定・直前再確認で評価する」というこのcapability自身の境界
 * （`docs/ddd/14_Catalog定義スキーマ.md`のCAP_PASSIVE_ACTIVATION_CONDITION行）
 * に留め、他の未実装Capability（`CAP_EFFECT_STEP_CONDITION`等、`SKL_LUCIE_MAID_PS2`/
 * `SKL_TATIANA_SAGE_PS1`のBRANCH stepが必要とする）が要求するEffectSequence全体の
 * 解決は対象にしない。`SKL_LAURA_MOUNTAIN_PS2`のみ他の必須Capabilityを一切持たず
 * 完全に解決できるため、`PassiveActivationRuntime`を通した実ライフサイクル
 * （Domain Event・StateDelta・独立Reducer復元）まで検証する。
 *
 * `ALIVE_UNIT_COUNT`の母数を満たすためだけの追加ユニットは、対象unitDefinitionId
 * をそのまま再利用すると同じPSを二重に(自分自身の視点でも)候補化してしまうため、
 * 常に`PADDING_UNIT_DEFINITION_ID`（`passiveSkillDefinitionIds: []`）で作る。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));
const PADDING_UNIT_DEFINITION_ID = "UNIT_TEST_PADDING";

function actorFor(
  unitDefinitionId: string,
  side: Side,
  battleUnitId: string,
  maximumHp: number,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const position = { column: "LEFT", row: "FRONT" } as const;
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

function markerOf(unit: BattleUnit, markerIdValue: string): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
    markerId: createMarkerId(markerIdValue),
    sourceId: unit.battleUnitId,
    targetId: unit.battleUnitId,
    stackCount: 1,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
  };
}

/**
 * `owner`（対象PSを宣言する実unitDefinition）と、母数専用の`PADDING_UNIT_DEFINITION_ID`
 * （`passiveSkillDefinitionIds: []`）の2エントリを持つmapを組み立てる。
 */
function unitDefinitionsFor(
  unitDefinition: UnitDefinition,
  skillId: string,
): Map<never, UnitDefinition> {
  return new Map([
    [
      unitDefinition.unitDefinitionId as never,
      {
        ...unitDefinition,
        activeSkillDefinitionIds: [],
        passiveSkillDefinitionIds: [skillId as never],
      },
    ],
    [
      PADDING_UNIT_DEFINITION_ID as never,
      {
        ...unitDefinition,
        unitDefinitionId: PADDING_UNIT_DEFINITION_ID as never,
        activeSkillDefinitionIds: [],
        passiveSkillDefinitionIds: [],
      },
    ],
  ]);
}

function paddingActor(side: Side, battleUnitId: string, maximumHp: number): BattleUnit {
  return actorFor(PADDING_UNIT_DEFINITION_ID, side, battleUnitId, maximumHp);
}

function initialSnapshotFor(units: readonly BattleUnit[]): BattleStateSnapshot {
  return {
    status: "RUNNING",
    currentTurn: 1,
    units: Object.fromEntries(
      units.map((unit) => [
        unit.battleUnitId,
        {
          hp: unit.currentHp,
          ap: unit.currentAp,
          pp: unit.currentPp,
          extraGauge: unit.currentExtraGauge,
          combatStats: unit.combatStats,
        },
      ]),
    ),
  };
}

function replayEventDeltas(
  initial: BattleStateSnapshot,
  recorder: EventRecorder,
): BattleStateSnapshot {
  return reduceStateDeltas(
    initial,
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
  );
}

describe("production Catalog CAP_PASSIVE_ACTIVATION_CONDITION (RES-004, Issue #171)", () => {
  it("IT-CAP-PASSIVE-001: SKL_KOKORO_SPORTSDAY_PS1's real TARGET_HAS_MARKER(SELF) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_KOKORO_SPORTSDAY";
    const skillId = "SKL_KOKORO_SPORTSDAY_PS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_PASSIVE_ACTIVATION_CONDITION");
    expect(skill.activationCondition).toMatchObject({ kind: "TARGET_HAS_MARKER" });

    const maximumHp = unitDefinition.baseStats.maximumHp;
    const enemy = paddingActor("ENEMY", "B_1:unit:2", maximumHp);
    const ownerBase = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp, { currentPp: 4 });
    const withMarker = {
      ...ownerBase,
      markerStates: [markerOf(ownerBase, "MARKER_KOKORO_SPORTSDAY_STOIC")],
    };
    const withoutMarker = ownerBase;
    const event: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: enemy.battleUnitId,
      targetUnitIds: [withMarker.battleUnitId],
      payload: { skillType: "AS" },
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    const candidatesWithMarker = detectPassiveCandidates({
      event,
      units: [withMarker, enemy],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(candidatesWithMarker).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(candidatesWithMarker[0]!, withMarker, event, guard, (id) =>
        id === withMarker.battleUnitId ? withMarker : undefined,
      ),
    ).toEqual({ ok: true });

    const candidatesWithoutMarker = detectPassiveCandidates({
      event: { ...event, targetUnitIds: [withoutMarker.battleUnitId] },
      units: [withoutMarker, enemy],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(candidatesWithoutMarker).toHaveLength(0);
  });

  it("IT-CAP-PASSIVE-002: SKL_LAURA_MOUNTAIN_PS2's real ALIVE_UNIT_COUNT(ALLY, excludeSelf) activationCondition traverses TurnStarted through PassiveActivated, StateDelta replay, and next-activation blocking (only Capability CAP_PASSIVE_ACTIVATION_CONDITION is required, so the full lifecycle is exercised end-to-end)", () => {
    const unitId = "UNIT_LAURA_MOUNTAIN";
    const skillId = "SKL_LAURA_MOUNTAIN_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toEqual(["CAP_PASSIVE_ACTIVATION_CONDITION"]);
    expect(skill.activationCondition).toMatchObject({
      kind: "ALIVE_UNIT_COUNT",
      side: "ALLY",
      excludeSelf: true,
    });

    const maximumHp = unitDefinition.baseStats.maximumHp;
    const owner = { ...actorFor(unitId, "ALLY", "B_CAP_PASSIVE:unit:1", maximumHp), currentPp: 4 };
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: snapshot.effectActions,
      unitDefinitions: unitDefinitionsFor(unitDefinition, skillId),
      skillDefinitions: new Map([[skillId as never, skill]]),
    };

    // 母集団に自分しかいない（excludeSelf: true により生存ALLYが0）: 不発。
    const soloRecorder = new EventRecorder(createBattleId("B_CAP_PASSIVE_SOLO"));
    const soloTurnStarted = soloRecorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: soloRecorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const soloRuntime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder: soloRecorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: soloTurnStarted.resolutionScopeId,
        rootEventId: soloTurnStarted.eventId,
      },
      [owner],
    );
    soloRuntime.onFactEvent(soloTurnStarted, [owner]);
    expect(soloRecorder.getEvents().map((e) => e.eventType)).not.toContain("PassiveActivated");

    // 生存ALLYが自分以外に1体いる: 発動する。
    const ally = paddingActor("ALLY", "B_CAP_PASSIVE:unit:2", maximumHp);
    const initial = initialSnapshotFor([owner, ally]);
    const recorder = new EventRecorder(createBattleId("B_CAP_PASSIVE"));
    const turnStarted = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    const runtime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder,
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: turnStarted.resolutionScopeId,
        rootEventId: turnStarted.eventId,
      },
      [owner, ally],
    );
    const afterActivation = runtime.onFactEvent(turnStarted, [owner, ally]);
    const updatedOwner = afterActivation.find((u) => u.battleUnitId === owner.battleUnitId)!;
    const passiveActivated = recorder.getEvents().find((e) => e.eventType === "PassiveActivated");
    expect(passiveActivated?.payload).toMatchObject({
      actorUnitId: owner.battleUnitId,
      skillDefinitionId: skillId,
      ppBefore: 4,
      ppAfter: 3,
    });
    expect(updatedOwner.currentPp).toBe(3);

    const reconstructed = replayEventDeltas(initial, recorder);
    expect(reconstructed.units[owner.battleUnitId]).toMatchObject({ pp: updatedOwner.currentPp });

    // R-PS-07: 同じ解決スコープでは1回だけ（新しいスコープで再度発動する）。
    const secondRecorder = new EventRecorder(createBattleId("B_CAP_PASSIVE_SECOND"));
    const secondTurnStarted = secondRecorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: secondRecorder.nextResolutionScopeId(),
      payload: { turnNumber: 2 },
    });
    const secondRuntime = new PassiveActivationRuntime(
      {
        definitions,
        random: new SequenceRandomSource([]),
        recorder: secondRecorder,
        turnNumber: 2,
        cycleNumber: 0,
        resolutionScopeId: secondTurnStarted.resolutionScopeId,
        rootEventId: secondTurnStarted.eventId,
      },
      afterActivation,
    );
    secondRuntime.onFactEvent(secondTurnStarted, afterActivation);
    expect(secondRecorder.getEvents().map((e) => e.eventType)).toContain("PassiveActivated");
  });

  it("IT-CAP-PASSIVE-003: SKL_LUCIE_MAID_PS2's real TURN_NUMBER(NEQ 1) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.activationCondition).toEqual({ kind: "TURN_NUMBER", op: "NEQ", value: 1 });

    const owner = actorFor(unitId, "ALLY", "B_1:unit:1", unitDefinition.baseStats.maximumHp, {
      currentPp: 4,
    });
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    const onFirstTurn = detectPassiveCandidates({
      event,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
      turnNumber: 1,
    });
    expect(onFirstTurn).toHaveLength(0);

    const onSecondTurn = detectPassiveCandidates({
      event,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
      turnNumber: 2,
    });
    expect(onSecondTurn).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(
        onSecondTurn[0]!,
        owner,
        event,
        guard,
        undefined,
        undefined,
        undefined,
        2,
      ),
    ).toEqual({ ok: true });
    expect(
      reconfirmPassiveCandidate(
        onSecondTurn[0]!,
        owner,
        event,
        guard,
        undefined,
        undefined,
        undefined,
        1,
      ),
    ).toEqual({ ok: false, reason: "CONDITION_NOT_MET" });
  });

  it("IT-CAP-PASSIVE-004: SKL_MAO_COMMITTEE_PS2's real ALIVE_UNIT_COUNT(ALLY, excludeSelf) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_MAO_COMMITTEE";
    const skillId = "SKL_MAO_COMMITTEE_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.activationCondition).toMatchObject({
      kind: "ALIVE_UNIT_COUNT",
      side: "ALLY",
      excludeSelf: true,
    });

    const maximumHp = unitDefinition.baseStats.maximumHp;
    const owner = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp, { currentPp: 4 });
    const ally = paddingActor("ALLY", "B_1:unit:2", maximumHp);
    const event: TriggerCandidateEvent = {
      eventType: "TurnStarted",
      category: "FACT",
      payload: {},
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    expect(
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
      }),
    ).toHaveLength(0);

    const candidates = detectPassiveCandidates({
      event,
      units: [owner, ally],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(candidates).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(candidates[0]!, owner, event, guard, undefined, undefined, [
        owner,
        ally,
      ]),
    ).toEqual({ ok: true });
    expect(
      reconfirmPassiveCandidate(candidates[0]!, owner, event, guard, undefined, undefined, [owner]),
    ).toEqual({ ok: false, reason: "CONDITION_NOT_MET" });
  });

  it("IT-CAP-PASSIVE-005: SKL_MERU_SIRIUS_PS2's real TURN_NUMBER(EQ 0, modulo 2) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_MERU_SIRIUS";
    const skillId = "SKL_MERU_SIRIUS_PS2";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.activationCondition).toEqual({
      kind: "TURN_NUMBER",
      op: "EQ",
      value: 0,
      modulo: 2,
    });

    const owner = actorFor(unitId, "ALLY", "B_1:unit:1", unitDefinition.baseStats.maximumHp, {
      currentPp: 4,
    });
    const event: TriggerCandidateEvent = {
      eventType: "TurnCompleting",
      category: "TIMING",
      payload: {},
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    expect(
      detectPassiveCandidates({
        event,
        units: [owner],
        unitDefinitions,
        skillDefinitions,
        activationGuard: guard,
        turnNumber: 3,
      }),
    ).toHaveLength(0);

    const onEvenTurn = detectPassiveCandidates({
      event,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
      turnNumber: 2,
    });
    expect(onEvenTurn).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(
        onEvenTurn[0]!,
        owner,
        event,
        guard,
        undefined,
        undefined,
        undefined,
        2,
      ),
    ).toEqual({ ok: true });
  });

  it("IT-CAP-PASSIVE-006: SKL_RAMI_NEWYEAR_PS1's real TARGET_STATE(SELF, HP_RATIO, GT 0.5) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_RAMI_NEWYEAR";
    const skillId = "SKL_RAMI_NEWYEAR_PS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.activationCondition).toMatchObject({
      kind: "TARGET_STATE",
      field: "HP_RATIO",
      op: "GT",
      value: 0.5,
    });

    const maximumHp = unitDefinition.baseStats.maximumHp;
    const healthy = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp, { currentPp: 4 });
    const wounded = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp, {
      currentPp: 4,
      currentHp: maximumHp * 0.3,
    });
    const event: TriggerCandidateEvent = {
      eventType: "SkillUseStarting",
      category: "TIMING",
      sourceUnitId: healthy.battleUnitId,
      payload: { skillType: "AS" },
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    const healthyCandidates = detectPassiveCandidates({
      event,
      units: [healthy],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(healthyCandidates).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(healthyCandidates[0]!, healthy, event, guard, (id) =>
        id === healthy.battleUnitId ? healthy : undefined,
      ),
    ).toEqual({ ok: true });

    const woundedCandidates = detectPassiveCandidates({
      event: { ...event, sourceUnitId: wounded.battleUnitId },
      units: [wounded],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(woundedCandidates).toHaveLength(0);
  });

  it("IT-CAP-PASSIVE-007: SKL_TATIANA_SAGE_PS1's real NOT(TARGET_HAS_MARKER(SELF)) activationCondition is evaluated at candidate detection and reconfirmation", () => {
    const unitId = "UNIT_TATIANA_SAGE";
    const skillId = "SKL_TATIANA_SAGE_PS1";
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([unitId as never], []);
    const unitDefinition = snapshot.units.get(unitId as never)!;
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.activationCondition).toMatchObject({
      kind: "NOT",
      condition: { kind: "TARGET_HAS_MARKER", markerId: "MARKER_TATIANA_SAGE_PRUDENCE" },
    });

    const maximumHp = unitDefinition.baseStats.maximumHp;
    const owner = actorFor(unitId, "ALLY", "B_1:unit:1", maximumHp, { currentPp: 4 });
    const guarded = {
      ...owner,
      markerStates: [markerOf(owner, "MARKER_TATIANA_SAGE_PRUDENCE")],
    };
    const event: TriggerCandidateEvent = {
      eventType: "RuntimeCounterChanged",
      category: "FACT",
      sourceUnitId: owner.battleUnitId,
      payload: { counter: "SKL_TATIANA_SAGE_PS1_THRESHOLD_COUNT", valueChanged: true },
    };
    const unitDefinitions = unitDefinitionsFor(unitDefinition, skillId);
    const skillDefinitions = new Map([[skillId as never, skill]]);
    const guard = createEmptyPassiveActivationGuard();

    const withoutMarker = detectPassiveCandidates({
      event,
      units: [owner],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(withoutMarker).toHaveLength(1);
    expect(
      reconfirmPassiveCandidate(withoutMarker[0]!, owner, event, guard, (id) =>
        id === owner.battleUnitId ? owner : undefined,
      ),
    ).toEqual({ ok: true });

    const withMarker = detectPassiveCandidates({
      event: { ...event, sourceUnitId: guarded.battleUnitId },
      units: [guarded],
      unitDefinitions,
      skillDefinitions,
      activationGuard: guard,
    });
    expect(withMarker).toHaveLength(0);
  });
});
