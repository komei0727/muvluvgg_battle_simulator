import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { MarkerState } from "../../domain/battle/model/marker-state.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import {
  createMarkerId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId } from "../../domain/shared/event-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { Side } from "../../domain/shared/side.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

/**
 * RES-003（Issue #173、`CAP_RESOLUTION_BRANCH_REPEAT`）: `BRANCH`が`condition`を
 * step-wideスコープで評価し、trueなら`thenSteps`・falseなら`elseSteps`を定義順に
 * 解決する（R-SKL-07、`effect-action-group-resolver.ts`の`resolveBranchStep`、
 * `effect-step-condition-evaluator.ts`の`evaluateEffectStepCondition`）ことの、
 * production代表定義による検証証跡。
 *
 * 代表は2件:
 * - `SKL_KEI_JACKKNIFE_AS2`（条件`TARGET_HAS_MARKER(SELF, MARKER_ROUSHIN)`、
 *   thenで3体へ`ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED`、elseで1体へ
 *   `ACT_KEI_JACKKNIFE_AS2_DAMAGE`。両経路とも純DAMAGEで完全に解決できる。
 *   マーカーの有無だけで分岐を決定的に切り替えられる）。
 * - `SKL_SENKA_SCHEMER_EX`（条件`TARGET_STATE(TGT_BASE, IS_ALIVE)`、thenで
 *   `ACT_SENKA_SCHEMER_EX_DAMAGE_FOLLOWUP`、elseは空）。先行ACTION step
 *   （`ACT_SENKA_SCHEMER_EX_DAMAGE_ROW`）でbaseを撃破すると`IS_ALIVE`がfalseへ
 *   変わり、BRANCHが「直前stepの副作用を反映したBattle state」を読むこと・
 *   空`elseSteps`が何も適用しないことを検証する。
 *
 * どちらも実`catalog/`からロードした未改変の`resolution.steps`を、実resolver
 * （`applyEffectActionGroups`）で駆動し、Domain Event / StateDelta / 独立Reducer
 * 復元まで確認する。REPEATと直前結果（`LAST_RESULT`/`LAST_ACTION_TARGETS`/
 * `LAST_DAMAGED_TARGETS`）はランタイム実装済み・domain単体テスト（UT-R-SKL-07/08）
 * 済みだが、これらを使うproduction Skill定義が現時点で1件も存在しない
 * （`catalog-src/`全走査）ため、production代表は`BRANCH`のみとする。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

interface StatOverrides {
  readonly maximumHp?: number;
  readonly attack?: number;
  readonly defense?: number;
}

function unitOf(
  side: Side,
  id: string,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: StatOverrides = {},
  markerStates: readonly MarkerState[] = [],
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100000,
      attack: overrides.attack ?? 300,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const unit = createBattleUnit(member, side, {
    maximumAp: 4,
    maximumPp: 4,
    maximumExtraGauge: 10,
  });
  return markerStates.length > 0 ? { ...unit, markerStates } : unit;
}

function selfMarker(unit: BattleUnit, markerIdValue: string): MarkerState {
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
          maximumAp: unit.maximumAp,
          maximumPp: unit.maximumPp,
          maximumExtraGauge: unit.maximumExtraGauge,
          combatStats: unit.combatStats,
        },
      ]),
    ),
  };
}

function seedRecorder(scope: string): { recorder: EventRecorder; rootEventId: string } {
  const recorder = new EventRecorder(createBattleId(scope));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

function contextFor(
  actor: BattleUnit,
  skillId: string,
  definitions: BattleDefinitions,
  recorder: EventRecorder,
  rootEventId: string,
): EffectActionGroupContext {
  return {
    definitions,
    actorId: actor.battleUnitId,
    random: new SequenceRandomSource(new Array<number>(64).fill(0.99)),
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId(skillId),
  };
}

function definitionsFor(
  effectActions: BattleDefinitions["effectActions"],
  skillId: string,
  skill: SkillDefinition,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions,
    unitDefinitions: new Map(),
    skillDefinitions: new Map([[skillId as never, skill]]),
  };
}

function completedTargets(
  recorder: EventRecorder,
  effectActionDefinitionId: string,
): readonly string[] {
  return recorder
    .getEvents()
    .filter(
      (e) =>
        e.eventType === "EffectActionCompleted" &&
        (e.payload as { effectActionDefinitionId: string }).effectActionDefinitionId ===
          effectActionDefinitionId,
    )
    .flatMap((e) => (e.payload as { targetUnitIds: readonly string[] }).targetUnitIds);
}

function reconstruct(initial: BattleStateSnapshot, recorder: EventRecorder): BattleStateSnapshot {
  return reduceStateDeltas(
    initial,
    recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
  );
}

describe("production Catalog CAP_RESOLUTION_BRANCH_REPEAT — BRANCH (RES-003, Issue #173)", () => {
  it("IT-CAP-BRANCH-REPEAT-PROD-001: SKL_KEI_JACKKNIFE_AS2's real BRANCH takes thenSteps when SELF holds MARKER_ROUSHIN, boosting damage across three enemies (EffectStepStarting BRANCH + DamageApplied + StateDelta + independent Reducer restoration)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_KEI_JACKKNIFE" as never], []);
    const skill = snapshot.skills.get("SKL_KEI_JACKKNIFE_AS2" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_RESOLUTION_BRANCH_REPEAT");
    const step = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : [])[0];
    expect(step?.kind).toBe("BRANCH");

    const bareActor = unitOf("ALLY", "kei", "UNIT_KEI_JACKKNIFE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const actor = { ...bareActor, markerStates: [selfMarker(bareActor, "MARKER_ROUSHIN")] };
    const e1 = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, { column: "LEFT", row: "FRONT" });
    const e2 = unitOf("ENEMY", "e2", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const e3 = unitOf("ENEMY", "e3", "UNIT_TEST_ENEMY" as never, { column: "RIGHT", row: "FRONT" });
    const allUnits = [actor, e1, e2, e3];

    const definitions = definitionsFor(snapshot.effectActions, "SKL_KEI_JACKKNIFE_AS2", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_CAP_BRANCH_KEI_THEN");
    const context = contextFor(actor, "SKL_KEI_JACKKNIFE_AS2", definitions, recorder, rootEventId);
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    const branchStarting = recorder
      .getEvents()
      .filter(
        (e) =>
          e.eventType === "EffectStepStarting" &&
          (e.payload as { stepKind?: string }).stepKind === "BRANCH",
      );
    expect(branchStarting).toHaveLength(1);

    // then枝: 3体へ DAMAGE_BOOSTED、else枝の DAMAGE は一切適用しない。
    expect([...completedTargets(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED")].sort()).toEqual(
      [e1.battleUnitId, e2.battleUnitId, e3.battleUnitId].sort(),
    );
    expect(completedTargets(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE")).toEqual([]);
    for (const enemy of [e1, e2, e3]) {
      const updated = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(updated.currentHp).toBeLessThan(enemy.currentHp);
    }

    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    for (const enemy of [e1, e2, e3]) {
      const updated = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(reconstructed.units[enemy.battleUnitId]?.hp).toBe(updated.currentHp);
    }
  });

  it("IT-CAP-BRANCH-REPEAT-PROD-002: SKL_KEI_JACKKNIFE_AS2's real BRANCH takes elseSteps when SELF lacks MARKER_ROUSHIN, dealing base damage to a single enemy only", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_KEI_JACKKNIFE" as never], []);
    const skill = snapshot.skills.get("SKL_KEI_JACKKNIFE_AS2" as never)!;

    const actor = unitOf("ALLY", "kei", "UNIT_KEI_JACKKNIFE" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const e1 = unitOf("ENEMY", "e1", "UNIT_TEST_ENEMY" as never, { column: "LEFT", row: "FRONT" });
    const e2 = unitOf("ENEMY", "e2", "UNIT_TEST_ENEMY" as never, {
      column: "CENTER",
      row: "FRONT",
    });
    const e3 = unitOf("ENEMY", "e3", "UNIT_TEST_ENEMY" as never, { column: "RIGHT", row: "FRONT" });
    const allUnits = [actor, e1, e2, e3];

    const definitions = definitionsFor(snapshot.effectActions, "SKL_KEI_JACKKNIFE_AS2", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_CAP_BRANCH_KEI_ELSE");
    const context = contextFor(actor, "SKL_KEI_JACKKNIFE_AS2", definitions, recorder, rootEventId);
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    // else枝: TGT_PRIMARY 1体へ DAMAGE、then枝の DAMAGE_BOOSTED は適用しない。
    expect(completedTargets(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE_BOOSTED")).toEqual([]);
    expect(completedTargets(recorder, "ACT_KEI_JACKKNIFE_AS2_DAMAGE")).toEqual([e1.battleUnitId]);

    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    const updatedE1 = result.units.find((u) => u.battleUnitId === e1.battleUnitId)!;
    expect(updatedE1.currentHp).toBeLessThan(e1.currentHp);
    expect(reconstructed.units[e1.battleUnitId]?.hp).toBe(updatedE1.currentHp);
  });

  it("IT-CAP-BRANCH-REPEAT-PROD-003: SKL_SENKA_SCHEMER_EX's real IS_ALIVE BRANCH applies the follow-up when the base survives the preceding row-damage step", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_SENKA_SCHEMER" as never], []);
    const skill = snapshot.skills.get("SKL_SENKA_SCHEMER_EX" as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_RESOLUTION_BRANCH_REPEAT");

    const actor = unitOf("ALLY", "senka", "UNIT_SENKA_SCHEMER" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    // baseは大HPで先行 DAMAGE_ROW を生き延びる → IS_ALIVE true → then枝。
    const base = unitOf(
      "ENEMY",
      "base",
      "UNIT_TEST_ENEMY" as never,
      { column: "LEFT", row: "FRONT" },
      { maximumHp: 1_000_000, defense: 1000 },
    );
    const allUnits = [actor, base];

    const definitions = definitionsFor(snapshot.effectActions, "SKL_SENKA_SCHEMER_EX", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_CAP_BRANCH_SENKA_THEN");
    const context = contextFor(actor, "SKL_SENKA_SCHEMER_EX", definitions, recorder, rootEventId);
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    const updatedBase = result.units.find((u) => u.battleUnitId === base.battleUnitId)!;
    expect(updatedBase.currentHp).toBeGreaterThan(0);
    expect(completedTargets(recorder, "ACT_SENKA_SCHEMER_EX_DAMAGE_FOLLOWUP")).toEqual([
      base.battleUnitId,
    ]);

    const reconstructed = reconstruct(initialSnapshotFor(allUnits), recorder);
    expect(reconstructed.units[base.battleUnitId]?.hp).toBe(updatedBase.currentHp);
  });

  it("IT-CAP-BRANCH-REPEAT-PROD-004: SKL_SENKA_SCHEMER_EX's real IS_ALIVE BRANCH reads post-preceding-step state — when the base is defeated by the row-damage step, the empty elseSteps apply no follow-up", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_SENKA_SCHEMER" as never], []);
    const skill = snapshot.skills.get("SKL_SENKA_SCHEMER_EX" as never)!;

    const actor = unitOf("ALLY", "senka", "UNIT_SENKA_SCHEMER" as never, {
      column: "LEFT",
      row: "FRONT",
    });
    // baseは最小HP・防御0で先行 DAMAGE_ROW に撃破される → IS_ALIVE false → else枝（空）。
    const base = unitOf(
      "ENEMY",
      "base",
      "UNIT_TEST_ENEMY" as never,
      { column: "LEFT", row: "FRONT" },
      { maximumHp: 1, defense: 0 },
    );
    const allUnits = [actor, base];

    const definitions = definitionsFor(snapshot.effectActions, "SKL_SENKA_SCHEMER_EX", skill);
    const plan = resolveSkillOrder(skill, actor, allUnits, definitions.effectActions);
    const { recorder, rootEventId } = seedRecorder("B_CAP_BRANCH_SENKA_ELSE");
    const context = contextFor(actor, "SKL_SENKA_SCHEMER_EX", definitions, recorder, rootEventId);
    const result = applyEffectActionGroups(plan, allUnits, context);

    expect(result.outcome.status).toBe("COMPLETED");
    const updatedBase = result.units.find((u) => u.battleUnitId === base.battleUnitId)!;
    expect(updatedBase.currentHp).toBe(0);
    // else枝が空のため follow-up は一切適用されない。
    expect(completedTargets(recorder, "ACT_SENKA_SCHEMER_EX_DAMAGE_FOLLOWUP")).toEqual([]);
  });
});
