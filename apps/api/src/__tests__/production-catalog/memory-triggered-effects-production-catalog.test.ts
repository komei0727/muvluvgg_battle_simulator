import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-006（Issue #179、R-MEM-01〜04）: 実際のproduction Catalog（未改変）の
 * `triggeredEffects` を、実際の`startBattle`（`BattleStarted`）から解決し、
 * `APPLY_STAT_MOD`/`APPLY_DAMAGE_MOD`が `AppliedEffect` として付与されることを
 * 検証する。`CAP_MEMORY_TRIGGERED_EFFECT` を `IMPLEMENTED` にできる根拠。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const UNIT_DEFINITION_ID = createUnitDefinitionId("UNIT_HARRIET_SAGE");
const MEMORY_DEFINITION_IDS = [
  "MEM_HARD_WARMUP",
  "MEM_STRANGERS",
  "MEM_HEART_COLOR",
  "MEM_TIMID_REINDEER_EVE",
].map((id) => createMemoryDefinitionId(id));
const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
  [UNIT_DEFINITION_ID],
  MEMORY_DEFINITION_IDS,
);

function unitAt(battleUnitId: string, side: Side, position: FormationPosition): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: UNIT_DEFINITION_ID,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 1000,
      attack: 1000,
      defense: 100,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 });
}

function memoryOf(memoryDefinitionId: string): MemoryDefinition {
  const memory = snapshot.memories.get(createMemoryDefinitionId(memoryDefinitionId));
  if (memory === undefined) {
    throw new Error(`production Catalog has no Memory "${memoryDefinitionId}"`);
  }
  return memory;
}

function definitionsWith(
  memoriesBySide: Readonly<Record<Side, readonly MemoryDefinition[]>>,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: snapshot.effectActions,
    unitDefinitions: snapshot.units,
    skillDefinitions: snapshot.skills,
    memoriesBySide,
  };
}

function startWith(memoriesBySide: Readonly<Record<Side, readonly MemoryDefinition[]>>) {
  const battle = createBattle(
    createBattleId("B_1"),
    [
      unitAt("ally:1", "ALLY", { row: "FRONT", column: "CENTER" }),
      unitAt("ally:2", "ALLY", { row: "BACK", column: "CENTER" }),
    ],
    [
      unitAt("enemy:1", "ENEMY", { row: "FRONT", column: "CENTER" }),
      unitAt("enemy:2", "ENEMY", { row: "BACK", column: "CENTER" }),
    ],
    createTurnLimit(3),
    definitionsWith(memoriesBySide),
  );
  const recorder = new EventRecorder(createBattleId("B_1"));
  return { battle: startBattle(battle, new SequenceRandomSource([]), recorder), recorder };
}

describe("production Catalog Memory triggeredEffects", () => {
  it("UT-PROD-MEM-001 (R-MEM-01/R-MEM-03): MEM_HARD_WARMUP applies its row-specific ATTACK buffs at BattleStarted", () => {
    const { battle } = startWith({ ALLY: [memoryOf("MEM_HARD_WARMUP")], ENEMY: [] });

    const front = battle.allyUnits.find((unit) => unit.position.row === "FRONT")!;
    const back = battle.allyUnits.find((unit) => unit.position.row === "BACK")!;
    // 前衛 +4%、後衛 +2.5%（production定義の`CONSTANT`値）。
    expect(front.combatStats.attack).toBeCloseTo(1040, 6);
    expect(back.combatStats.attack).toBeCloseTo(1025, 6);
    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(0);
  });

  it("UT-PROD-MEM-002 (R-MEM-04): an ENEMY-declared MEM_TIMID_REINDEER_EVE buffs the enemy party and records sourceSide instead of a granter unit", () => {
    const { battle } = startWith({ ALLY: [], ENEMY: [memoryOf("MEM_TIMID_REINDEER_EVE")] });

    const enemyBack = battle.enemyUnits.find((unit) => unit.position.row === "BACK")!;
    const backCritDamage = enemyBack.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_MEM_TIMID_REINDEER_EVE_BACK_CRIT_DMG_UP",
    );
    expect(backCritDamage?.magnitude).toBeCloseTo(0.15, 6);
    // Memory由来の`AppliedEffect`は付与者ユニットを持たず、付与元の陣営を持つ。
    expect(backCritDamage?.sourceId).toBeUndefined();
    expect(backCritDamage?.sourceSide).toBe("ENEMY");
    // 2件目（陣営全体の会心率+5%）は両方の敵ユニットへ、味方には一切適用されない。
    expect(battle.enemyUnits.every((unit) => unit.combatStats.criticalRate > 0.1)).toBe(true);
    expect(battle.allyUnits.every((unit) => unit.appliedEffects.length === 0)).toBe(true);
  });

  it("UT-PROD-MEM-003 (R-MEM-02): resolves Memory candidates in the API-declared order, then by triggeredEffects definition order", () => {
    const { recorder } = startWith({
      ALLY: [memoryOf("MEM_STRANGERS"), memoryOf("MEM_HEART_COLOR")],
      ENEMY: [memoryOf("MEM_HARD_WARMUP")],
    });

    const triggeredOrder = recorder
      .getEvents()
      .filter((event) => event.eventType === "MemoryTriggered")
      .map((event) => {
        const payload = event.payload as {
          memoryDefinitionId: string;
          triggeredEffectIndex: number;
        };
        return `${payload.memoryDefinitionId}#${payload.triggeredEffectIndex}`;
      });

    expect(triggeredOrder).toEqual([
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
      "MEM_HEART_COLOR#0",
      "MEM_HEART_COLOR#1",
      "MEM_HARD_WARMUP#0",
      "MEM_HARD_WARMUP#1",
    ]);
  });
});
