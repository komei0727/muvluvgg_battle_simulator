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
import type { Attribute } from "../../domain/catalog/definitions/catalog-enums.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  captureBattleState,
  type BattleStateSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "../../domain/catalog/capability/capability-availability.js";

/**
 * M7-007（Issue #178）: `raw/memories/` の未変換Memoryのうち、所属条件を持たず
 * 静的なstat補正を中心にした6件を近似なしで変換した結果を、実際の
 * production Catalog（未改変）と実`startBattle`（`BattleStarted`）で検証する。
 *
 * `UNIT_TYPE`/`ROLE`/`ATTRIBUTE`/`POSITION_ROW`+`POSITION_COLUMN`の各
 * TargetFilterがMemory由来のEffectSequenceでも実際に効き、対象外のユニットと
 * 敵陣営には一切適用されないことを、対象・非対象の両方で確認する。
 *
 * `MEM_THREE_MAIDS_HOSPITALITY`・`MEM_ABSOLUTE_ORDER`の与ダメージ補正は
 * `APPLY_DAMAGE_MOD`（`CAP_DAMAGE_MOD`、`DMG-002`／Issue #192で実装）を要する
 * ため実行時解決はまだできない。Catalog上の変換自体は近似なしであることと、
 * Capability preflightがこの2件を編成不可として弾くことをここで固定する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const M7_007_MEMORY_IDS = [
  "MEM_PANTS_STRAY_CAT",
  "MEM_CHAOS_MAIDEN_TWINTAIL_FEST",
  "MEM_THREE_MAIDS_HOSPITALITY",
  "MEM_MOMOZONO_NEW_YEAR",
  "MEM_ABSOLUTE_ORDER",
  "MEM_EURO_TOWER_DAY",
] as const;

/** `APPLY_DAMAGE_MOD`を持たず、実ライフサイクルで最後まで解決できる4件。 */
const RUNNABLE_MEMORY_IDS = [
  "MEM_PANTS_STRAY_CAT",
  "MEM_CHAOS_MAIDEN_TWINTAIL_FEST",
  "MEM_MOMOZONO_NEW_YEAR",
  "MEM_EURO_TOWER_DAY",
] as const;

/**
 * production Unitの`unitType`/`role`（`UNIT_TYPE`/`ROLE`フィルタは静的Catalogの
 * `UnitDefinition`を引くため、実データのUnitでなければ検証にならない）。
 * `attribute`は編成時の値なのでBattlePartyMember側で与える。
 */
const ALLY_MEMBERS = [
  {
    battleUnitId: "ally:en_attacker",
    unitDefinitionId: "UNIT_CLARA_SANTA", // ENERGY / EN_ATTACKER
    attribute: "CUTE",
    position: { row: "FRONT", column: "LEFT" },
  },
  {
    battleUnitId: "ally:en_support",
    unitDefinitionId: "UNIT_HARRIET_SAGE", // ENERGY / SUPPORT
    attribute: "SMART",
    position: { row: "BACK", column: "LEFT" },
  },
  {
    battleUnitId: "ally:physical_attacker",
    unitDefinitionId: "UNIT_KEI_JACKKNIFE", // PHYSICAL / PHYSICAL_ATTACKER
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "CENTER" },
  },
  {
    battleUnitId: "ally:physical_tank",
    unitDefinitionId: "UNIT_AOI_GUARDIAN", // PHYSICAL / TANK
    attribute: "CUTE",
    position: { row: "BACK", column: "CENTER" },
  },
  {
    battleUnitId: "ally:agile_control",
    unitDefinitionId: "UNIT_ANIS_TROUBLEMAKER", // AGILE / CONTROL
    attribute: "SMART",
    position: { row: "BACK", column: "RIGHT" },
  },
] as const satisfies readonly {
  battleUnitId: string;
  unitDefinitionId: string;
  attribute: Attribute;
  position: FormationPosition;
}[];

const ENEMY_MEMBER = {
  battleUnitId: "enemy:en_attacker",
  unitDefinitionId: "UNIT_CLARA_SANTA",
  attribute: "CUTE",
  position: { row: "FRONT", column: "CENTER" },
} as const;

const UNIT_DEFINITION_IDS = [
  ...new Set([...ALLY_MEMBERS.map((m) => m.unitDefinitionId), ENEMY_MEMBER.unitDefinitionId]),
].map((id) => createUnitDefinitionId(id));

const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
  UNIT_DEFINITION_IDS,
  M7_007_MEMORY_IDS.map((id) => createMemoryDefinitionId(id)),
);

const BASE_ATTACK = 1000;
const BASE_DEFENSE = 100;
const BASE_MAXIMUM_HP = 5000;

function battleUnitOf(
  member: {
    readonly battleUnitId: string;
    readonly unitDefinitionId: string;
    readonly attribute: Attribute;
    readonly position: FormationPosition;
  },
  side: Side,
): BattleUnit {
  const partyMember: BattlePartyMember = {
    battleUnitId: createBattleUnitId(member.battleUnitId),
    unitDefinitionId: createUnitDefinitionId(member.unitDefinitionId),
    attribute: member.attribute,
    position: member.position,
    globalCoordinate: toGlobalCoordinate(side, member.position),
    combatStats: {
      maximumHp: BASE_MAXIMUM_HP,
      attack: BASE_ATTACK,
      defense: BASE_DEFENSE,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(partyMember, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
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

function createdBattleWith(allyMemoryDefinitionIds: readonly string[]) {
  return createBattle(
    createBattleId("B_1"),
    ALLY_MEMBERS.map((member) => battleUnitOf(member, "ALLY")),
    [battleUnitOf(ENEMY_MEMBER, "ENEMY")],
    createTurnLimit(3),
    definitionsWith({ ALLY: allyMemoryDefinitionIds.map(memoryOf), ENEMY: [] }),
  );
}

function startWith(allyMemoryDefinitionIds: readonly string[]) {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const created = createdBattleWith(allyMemoryDefinitionIds);
  return {
    created,
    recorder,
    battle: startBattle(created, new SequenceRandomSource([]), recorder),
  };
}

function allyBy(battle: { readonly allyUnits: readonly BattleUnit[] }, battleUnitId: string) {
  const unit = battle.allyUnits.find((candidate) => candidate.battleUnitId === battleUnitId);
  if (unit === undefined) {
    throw new Error(`no ally unit "${battleUnitId}"`);
  }
  return unit;
}

function unitSnapshotOf(snapshot: BattleStateSnapshot, battleUnitId: string) {
  return snapshot.units[createBattleUnitId(battleUnitId)];
}

describe("production Catalog M7-007 static Memory conversions (Issue #178)", () => {
  it("IT-CAP-MEMORY-STATIC-PROD-001: MEM_PANTS_STRAY_CAT raises ATTACK for every ENERGY ally and DEFENSE only for the EN_ATTACKER, leaving other unit types, other roles and the enemy untouched", () => {
    const { battle } = startWith(["MEM_PANTS_STRAY_CAT"]);

    // 効果1「ENタイプの味方の攻撃力を1250上昇させる」
    expect(allyBy(battle, "ally:en_attacker").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:en_support").combatStats.attack).toBeCloseTo(BASE_ATTACK + 1250, 6);
    // PHYSICAL / AGILE は`UNIT_TYPE`フィルタで不成立
    expect(allyBy(battle, "ally:physical_attacker").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    expect(allyBy(battle, "ally:agile_control").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);

    // 効果2「ENアタッカーの防御力を1000上昇させる」— ENERGYでもSUPPORTには乗らない
    expect(allyBy(battle, "ally:en_attacker").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE + 1000,
      6,
    );
    expect(allyBy(battle, "ally:en_support").combatStats.defense).toBeCloseTo(BASE_DEFENSE, 6);

    // 味方陣営が指定したMemoryは敵へ一切適用されない（R-MEM-04のsource side）
    expect(battle.enemyUnits[0]!.appliedEffects).toHaveLength(0);
    expect(battle.enemyUnits[0]!.combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-002: MEM_CHAOS_MAIDEN_TWINTAIL_FEST raises ATTACK for ENERGY allies only and MAXIMUM_HP for the whole ally party", () => {
    const { battle } = startWith(["MEM_CHAOS_MAIDEN_TWINTAIL_FEST"]);

    // 効果1「EN型の味方の攻撃力を750上昇させる」
    expect(allyBy(battle, "ally:en_attacker").combatStats.attack).toBeCloseTo(BASE_ATTACK + 750, 6);
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);

    // 効果2「味方全体のHPを300上昇させる」
    for (const ally of battle.allyUnits) {
      expect(ally.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 300, 6);
    }
    expect(battle.enemyUnits[0]!.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP, 6);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-003: MEM_MOMOZONO_NEW_YEAR raises ATTACK for PHYSICAL and AGILE allies through two separate triggeredEffects, never for ENERGY allies", () => {
    const { battle } = startWith(["MEM_MOMOZONO_NEW_YEAR"]);

    expect(allyBy(battle, "ally:physical_attacker").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:agile_control").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:en_attacker").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    expect(allyBy(battle, "ally:en_support").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    // 同一ユニットが両方のtriggeredEffectに該当することはない（PHYSICALかAGILEの一方）
    expect(allyBy(battle, "ally:physical_tank").appliedEffects).toHaveLength(1);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-004: MEM_EURO_TOWER_DAY applies a ROLE-filtered ratio buff and a BACK CENTER/RIGHT slot-filtered fixed buff to disjoint ally sets", () => {
    const { battle } = startWith(["MEM_EURO_TOWER_DAY"]);

    // 効果1「サポートの攻撃力を4%上昇させる」— SUPPORTロールはBACK LEFTの1体だけ
    expect(allyBy(battle, "ally:en_support").combatStats.attack).toBeCloseTo(BASE_ATTACK * 1.04, 6);
    // 効果2「右列後衛・中央列後衛の攻撃力を1250上昇させる」
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:agile_control").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    // BACK LEFT は効果2の対象外、FRONT列はどちらの対象でもない
    expect(allyBy(battle, "ally:en_support").appliedEffects).toHaveLength(1);
    expect(allyBy(battle, "ally:en_attacker").appliedEffects).toHaveLength(0);
    expect(allyBy(battle, "ally:physical_attacker").appliedEffects).toHaveLength(0);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-005: the four runnable M7-007 Memories emit MemoryTriggered/MemoryResolved with a sourceSide instead of a granter unit, and their StateDeltas alone reconstruct the started battle", () => {
    const { created, battle, recorder } = startWith(RUNNABLE_MEMORY_IDS);

    const triggered = recorder
      .getEvents()
      .filter((event) => event.eventType === "MemoryTriggered")
      .map((event) => {
        const payload = event.payload as {
          memoryDefinitionId: string;
          triggeredEffectIndex: number;
        };
        return `${payload.memoryDefinitionId}#${payload.triggeredEffectIndex}`;
      });
    // API指定順 → 同一Memory内のtriggeredEffects定義順（R-MEM-02）
    expect(triggered).toEqual([
      "MEM_PANTS_STRAY_CAT#0",
      "MEM_PANTS_STRAY_CAT#1",
      "MEM_CHAOS_MAIDEN_TWINTAIL_FEST#0",
      "MEM_CHAOS_MAIDEN_TWINTAIL_FEST#1",
      "MEM_MOMOZONO_NEW_YEAR#0",
      "MEM_MOMOZONO_NEW_YEAR#1",
      "MEM_EURO_TOWER_DAY#0",
      "MEM_EURO_TOWER_DAY#1",
    ]);
    expect(
      recorder.getEvents().filter((event) => event.eventType === "MemoryResolved"),
    ).toHaveLength(8);
    for (const effect of allyBy(battle, "ally:en_support").appliedEffects) {
      expect(effect.sourceId).toBeUndefined();
      expect(effect.sourceSide).toBe("ALLY");
    }

    // 独立Reducer復元: 開始前スナップショットへ`BattleStarted`以降のStateDeltaだけを
    // 適用すると、実際に開始した戦闘と同じ状態が再構成できる。
    const before = captureBattleState(created);
    const after = captureBattleState(battle);
    const deltas = recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]));
    const reconstructed = reduceStateDeltas(before, deltas);

    expect(reconstructed).toEqual(after);
    // 復元が空回りしていないこと: 開始前後で状態は実際に変わっており、復元側にも
    // 4 Memory分の重ね掛け（RATIO 4% + FIXED 1250 + 750）が乗っている。
    expect(before).not.toEqual(after);
    const restoredSupport = unitSnapshotOf(reconstructed, "ally:en_support");
    expect(restoredSupport?.combatStats.attack).toBeCloseTo(BASE_ATTACK * 1.04 + 1250 + 750, 6);
    // ATTACK 3件（+1250 / +750 / +4%）と MAXIMUM_HP 1件（+300）。
    expect(restoredSupport?.effects).toHaveLength(4);
    expect(restoredSupport?.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 300, 6);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-006: the damage-mod half of MEM_THREE_MAIDS_HOSPITALITY/MEM_ABSOLUTE_ORDER is converted without approximation but still gated by the unimplemented CAP_DAMAGE_MOD", () => {
    for (const memoryDefinitionId of ["MEM_THREE_MAIDS_HOSPITALITY", "MEM_ABSOLUTE_ORDER"]) {
      const memory = memoryOf(memoryDefinitionId);
      expect(memory.requiredCapabilities).toContain("CAP_DAMAGE_MOD");
      // 変換自体は近似なし: 効果1が`APPLY_DAMAGE_MOD`、効果2が`APPLY_STAT_MOD`。
      const kinds = memory.triggeredEffects.map((triggeredEffect) => {
        const step = triggeredEffect.effectSequence.steps[0]!;
        if (step.kind !== "ACTION") {
          throw new Error(`unexpected step kind "${step.kind}"`);
        }
        const action = snapshot.effectActions.get(step.actions[0]!.effectActionDefinitionId);
        return action?.kind;
      });
      expect(kinds).toEqual(["APPLY_DAMAGE_MOD", "APPLY_STAT_MOD"]);

      // `CAP_DAMAGE_MOD`は`DMG-002`（Issue #192）まで`PLANNED`のため、この2件は
      // Capability preflightが編成不可として弾く（実ライフサイクル検証は#192後）。
      const unimplemented = findUnimplementedCapabilities(
        collectRequiredCapabilities(snapshot, [], [memory.memoryDefinitionId]),
        snapshot.capabilities,
      );
      expect(unimplemented.map((capability) => capability.capabilityId)).toEqual([
        "CAP_DAMAGE_MOD",
      ]);
    }
  });
});
