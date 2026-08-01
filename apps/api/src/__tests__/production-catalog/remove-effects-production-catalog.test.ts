import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { removeEffects } from "../../domain/battle/effects/effect-removal-service.js";
import { grantEffect } from "../../domain/battle/effects/effect-grant-service.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { toEffectSnapshot } from "../../domain/battle/events/state-delta.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";

/**
 * M7-001 (Issue #181, R-EFF-02): exercises REAL production `catalog/`
 * `REMOVE_EFFECTS` `EffectActionDefinition` payloads through the REAL removal
 * executor (`effect-removal-service.ts`), mirroring `marker-production-catalog.
 * test.ts`. Proves `REMOVE_BUFF_CATEGORY` (Mao's BUFF+DEBUFF cleanse) and
 * `REMOVE_EFFECTS_COUNT_LIMIT` (Mihime 3 / Lily 5) against unmodified
 * production data. `CAP_REMOVE_EFFECTS` is flipped to `IMPLEMENTED` alongside
 * this test (`catalog-src/capabilities.json`).
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function actorFor(unitDefinitionId: string, battleUnitId: string): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: toGlobalCoordinate("ALLY", { column: "LEFT", row: "FRONT" }),
    combatStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, "ALLY", { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 });
}

function newContext() {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return {
    recorder,
    context: {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      rootEventId: seed.eventId,
    },
  };
}

/**
 * M7-011（Issue #265）: `grantEffect`は`EffectActionDefinition`そのものを受け取る
 * （`EffectApplied`の分類payloadを定義から導くため）。このファイルのテスト用
 * インスタンスはいずれも符号付き`magnitude`でBUFF/DEBUFFを作る継続ステータス
 * 補正なので、定義IDを`APPLY_STAT_MOD`の最小定義へ包む。
 */
function statModDefinitionOf(
  effectActionDefinitionId: EffectActionDefinition["effectActionDefinitionId"],
): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId,
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

/** Grants `count` distinct effect instances of `definitionId` onto `holder`, with the given magnitude sign (negative = DEBUFF, non-negative = BUFF per R-EFF-05). */
function withEffects(
  context: ReturnType<typeof newContext>["context"],
  holder: BattleUnit,
  definitionId: EffectActionDefinition["effectActionDefinitionId"],
  count: number,
  magnitude: number,
): { units: readonly BattleUnit[]; lastEventId: typeof context.rootEventId } {
  let units: readonly BattleUnit[] = [holder];
  let lastEventId = context.rootEventId;
  for (let i = 0; i < count; i += 1) {
    const grant = grantEffect(
      context,
      units,
      {
        definition: statModDefinitionOf(definitionId),
        sourceId: holder.battleUnitId,
        targetId: holder.battleUnitId,
        duplicate: true,
        magnitude,
        durationDefinition: { dispellable: true, linkedEffectGroupId: null },
      },
      lastEventId,
    );
    units = grant.units;
    lastEventId = grant.lastEventId;
  }
  return { units, lastEventId };
}

/** Grants `count` distinct debuff instances (magnitude<0) of `definitionId` onto `holder`. */
function withDebuffs(
  context: ReturnType<typeof newContext>["context"],
  holder: BattleUnit,
  definitionId: EffectActionDefinition["effectActionDefinitionId"],
  count: number,
): { units: readonly BattleUnit[]; lastEventId: typeof context.rootEventId } {
  return withEffects(context, holder, definitionId, count, -0.1);
}

describe("production Catalog REMOVE_EFFECTS (M7-001, R-EFF-02)", () => {
  it.each([
    {
      unitId: "UNIT_MIHIME_SNIPER",
      effectActionId: "ACT_MIHIME_SNIPER_PS1_REMOVE_DEBUFF",
      limit: 3,
    },
    { unitId: "UNIT_LILY_SINGER", effectActionId: "ACT_LILY_SINGER_PS1_REMOVE_DEBUFF", limit: 5 },
  ])(
    "IT-REMOVE-EFFECTS-PROD-001: $effectActionId ($unitId) removes only maxRemovals debuffs (REMOVE_EFFECTS_COUNT_LIMIT)",
    ({ unitId, effectActionId, limit }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("REMOVE_EFFECTS");
      if (effectAction?.kind !== "REMOVE_EFFECTS") {
        return;
      }
      expect(effectAction.payload.maxRemovals).toBe(limit);
      expect(effectAction.requiredCapabilities).toContain("CAP_REMOVE_EFFECTS");

      const owner = actorFor(unitId, "B_1:unit:1");
      const { context } = newContext();
      // Grant one extra debuff beyond the limit to prove the cap holds.
      const debuffDefId = "ACT_TEST_DEBUFF" as EffectActionDefinition["effectActionDefinitionId"];
      const seeded = withDebuffs(context, owner, debuffDefId, limit + 1);
      const debuffDef: EffectActionDefinition = {
        kind: "APPLY_STAT_MOD",
        effectActionDefinitionId: debuffDefId,
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: -0.1 },
          stacking: { mode: "STACKABLE", max: null },
          duration: { dispellable: true, linkedEffectGroupId: null },
        },
      };

      const result = removeEffects(
        context,
        seeded.units,
        owner.battleUnitId,
        {
          categories: effectAction.payload.categories,
          ...(effectAction.payload.maxRemovals !== undefined
            ? { maxRemovals: effectAction.payload.maxRemovals }
            : {}),
        },
        new Map([[debuffDefId, debuffDef]]),
        seeded.lastEventId,
      );

      expect(result.removedCount).toBe(limit);
      const holder = result.units.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(holder.appliedEffects).toHaveLength(1);
    },
  );

  it.each([
    {
      unitId: "UNIT_SHOUKA_SCHEMER",
      effectActionId: "ACT_SHOUKA_SCHEMER_EX_REMOVE_BUFF",
      limit: 3,
    },
    {
      unitId: "UNIT_SHOUKA_SCHEMER",
      effectActionId: "ACT_SHOUKA_SCHEMER_AS3_REMOVE_BUFF",
      limit: 1,
    },
  ])(
    "IT-REMOVE-EFFECTS-PROD-004: $effectActionId ($unitId) removes only maxRemovals buffs (M7-001C, REMOVE_BUFF_CATEGORY)",
    ({ unitId, effectActionId, limit }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("REMOVE_EFFECTS");
      if (effectAction?.kind !== "REMOVE_EFFECTS") {
        return;
      }
      expect([...effectAction.payload.categories]).toEqual(["BUFF"]);
      expect(effectAction.payload.maxRemovals).toBe(limit);
      expect(effectAction.requiredCapabilities).toContain("CAP_REMOVE_EFFECTS");

      const owner = actorFor(unitId, "B_1:unit:1");
      const { context } = newContext();
      // Grant one extra buff beyond the limit to prove the cap holds.
      const buffDefId = "ACT_TEST_BUFF" as EffectActionDefinition["effectActionDefinitionId"];
      const seeded = withEffects(context, owner, buffDefId, limit + 1, 0.1);
      const buffDef: EffectActionDefinition = {
        kind: "APPLY_STAT_MOD",
        effectActionDefinitionId: buffDefId,
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: 0.1 },
          stacking: { mode: "STACKABLE", max: null },
          duration: { dispellable: true, linkedEffectGroupId: null },
        },
      };

      const result = removeEffects(
        context,
        seeded.units,
        owner.battleUnitId,
        {
          categories: effectAction.payload.categories,
          ...(effectAction.payload.maxRemovals !== undefined
            ? { maxRemovals: effectAction.payload.maxRemovals }
            : {}),
        },
        new Map([[buffDefId, buffDef]]),
        seeded.lastEventId,
      );

      expect(result.removedCount).toBe(limit);
      const holder = result.units.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(holder.appliedEffects).toHaveLength(1);
    },
  );

  it.each([
    { unitId: "UNIT_NOEL_RUMBLE", effectActionId: "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF" },
    { unitId: "UNIT_SENKA_CHRISTMAS", effectActionId: "ACT_SENKA_CHRISTMAS_PS2_REMOVE_BUFF" },
  ])(
    "IT-REMOVE-EFFECTS-PROD-005: $effectActionId ($unitId) clears all BUFFs, unbounded (M7-001C, REMOVE_BUFF_CATEGORY)",
    ({ unitId, effectActionId }) => {
      const catalog = loadCatalogFromDirectory(CATALOG_DIR);
      const snapshot = catalog.loadSnapshot([unitId as never], []);
      const effectAction = snapshot.effectActions.get(effectActionId as never);
      expect(effectAction?.kind).toBe("REMOVE_EFFECTS");
      if (effectAction?.kind !== "REMOVE_EFFECTS") {
        return;
      }
      expect([...effectAction.payload.categories]).toEqual(["BUFF"]);
      expect(effectAction.payload.maxRemovals).toBeUndefined();
      expect(effectAction.requiredCapabilities).toContain("CAP_REMOVE_EFFECTS");

      const owner = actorFor(unitId, "B_1:unit:1");
      const { context } = newContext();
      const buffDefId = "ACT_TEST_BUFF" as EffectActionDefinition["effectActionDefinitionId"];
      const seeded = withEffects(context, owner, buffDefId, 4, 0.1);
      const buffDef: EffectActionDefinition = {
        kind: "APPLY_STAT_MOD",
        effectActionDefinitionId: buffDefId,
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          stat: "ATTACK",
          valueType: "RATIO",
          formula: { kind: "CONSTANT", value: 0.1 },
          stacking: { mode: "STACKABLE", max: null },
          duration: { dispellable: true, linkedEffectGroupId: null },
        },
      };

      const result = removeEffects(
        context,
        seeded.units,
        owner.battleUnitId,
        { categories: effectAction.payload.categories },
        new Map([[buffDefId, buffDef]]),
        seeded.lastEventId,
      );

      expect(result.removedCount).toBe(4);
      const holder = result.units.find((u) => u.battleUnitId === owner.battleUnitId)!;
      expect(holder.appliedEffects).toHaveLength(0);
    },
  );

  it("IT-REMOVE-EFFECTS-PROD-002: ACT_MAO_COMMITTEE_PS2_CLEANSE clears both BUFF and DEBUFF (REMOVE_BUFF_CATEGORY)", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_MAO_COMMITTEE" as never], []);
    const cleanse = snapshot.effectActions.get("ACT_MAO_COMMITTEE_PS2_CLEANSE" as never);
    expect(cleanse?.kind).toBe("REMOVE_EFFECTS");
    if (cleanse?.kind !== "REMOVE_EFFECTS") {
      return;
    }
    expect([...cleanse.payload.categories].sort()).toEqual(["BUFF", "DEBUFF"]);

    const owner = actorFor("UNIT_MAO_COMMITTEE", "B_1:unit:1");
    const { context } = newContext();
    const buffDefId = "ACT_TEST_BUFF" as EffectActionDefinition["effectActionDefinitionId"];
    const debuffDefId = "ACT_TEST_DEBUFF" as EffectActionDefinition["effectActionDefinitionId"];
    const statModDef = (
      id: EffectActionDefinition["effectActionDefinitionId"],
    ): EffectActionDefinition => ({
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: id,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0 },
        stacking: { mode: "STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    });

    let units: readonly BattleUnit[] = [owner];
    let lastEventId = context.rootEventId;
    for (const [id, magnitude] of [
      [buffDefId, 0.2],
      [debuffDefId, -0.2],
    ] as const) {
      const grant = grantEffect(
        context,
        units,
        {
          definition: statModDef(id),
          sourceId: owner.battleUnitId,
          targetId: owner.battleUnitId,
          duplicate: true,
          magnitude,
          durationDefinition: { dispellable: true, linkedEffectGroupId: null },
        },
        lastEventId,
      );
      units = grant.units;
      lastEventId = grant.lastEventId;
    }

    const result = removeEffects(
      context,
      units,
      owner.battleUnitId,
      { categories: cleanse.payload.categories },
      new Map([
        [buffDefId, statModDef(buffDefId)],
        [debuffDefId, statModDef(debuffDefId)],
      ]),
      lastEventId,
    );

    expect(result.removedCount).toBe(2);
    const holder = result.units.find((u) => u.battleUnitId === owner.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(0);
  });

  it("IT-REMOVE-EFFECTS-PROD-003 (Issue #181 DoD, independent Reducer restoration): applying the EffectRemoved + CombatStatChanged StateDeltas to the initial snapshot reconstructs the final live state", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot(["UNIT_MAO_COMMITTEE" as never], []);
    const cleanse = snapshot.effectActions.get("ACT_MAO_COMMITTEE_PS2_CLEANSE" as never);
    expect(cleanse?.kind).toBe("REMOVE_EFFECTS");
    if (cleanse?.kind !== "REMOVE_EFFECTS") {
      return;
    }

    // Owner already carries a +20 ATTACK buff whose contribution is reflected in
    // its live combatStats (100 base -> 120). Removing it must both drop the
    // effect and revert the stat; both are captured as StateDeltas.
    const buffDefId = "ACT_TEST_ATK_BUFF" as EffectActionDefinition["effectActionDefinitionId"];
    const buffDef: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: buffDefId,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 20 },
        stacking: { mode: "STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
    const base = actorFor("UNIT_MAO_COMMITTEE", "B_1:unit:1");
    const buff: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("buff-1"),
      effectActionDefinitionId: buffDefId,
      kindKey: effectKindKeyFromDefinitionId(buffDefId),
      duplicate: true,
      sourceId: base.battleUnitId,
      targetId: base.battleUnitId,
      magnitude: 20,
      categories: ["BUFF"],
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 0,
    };
    const owner: BattleUnit = {
      ...base,
      appliedEffects: [buff],
      combatStats: { ...base.combatStats, attack: base.combatStats.attack + 20 },
    };

    const snapshotOf = (units: readonly BattleUnit[]): BattleStateSnapshot => ({
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
            ...(unit.appliedEffects.length > 0
              ? { effects: unit.appliedEffects.map((effect) => toEffectSnapshot(effect, true)) }
              : {}),
          },
        ]),
      ),
    });

    const { recorder, context } = newContext();
    const initial = snapshotOf([owner]);
    const before = recorder.getEvents().length;
    const result = removeEffects(
      context,
      [owner],
      owner.battleUnitId,
      { categories: cleanse.payload.categories },
      new Map([[buffDefId, buffDef]]),
      context.rootEventId,
    );

    // Independent restoration: only the StateDeltas emitted by the removal.
    const deltas = recorder
      .getEvents()
      .slice(before)
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]));
    const reconstructed = reduceStateDeltas(initial, deltas);

    expect(reconstructed).toEqual(snapshotOf(result.units));
    expect(reconstructed.units[owner.battleUnitId]?.effects).toBeUndefined();
    expect(reconstructed.units[owner.battleUnitId]?.combatStats.attack).toBe(
      base.combatStats.attack,
    );
  });
});
