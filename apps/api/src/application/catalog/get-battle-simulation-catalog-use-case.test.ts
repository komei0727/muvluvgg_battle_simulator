import { describe, expect, it } from "vitest";
import {
  CATALOG_PROJECTION_VERSION,
  GetBattleSimulationCatalogUseCase,
} from "./get-battle-simulation-catalog-use-case.js";
import { buildGearEffects, gearEffectsFingerprint } from "./gear-effect-catalog.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../domain/catalog/definitions/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../domain/catalog/definitions/skill-definition.js";
import {
  createUnitDefinition,
  type UnitDefinition,
} from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";

function damageAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
    },
    "effectAction",
  );
}

const SKILL_COST_RESOURCE = { AS: "AP", PS: "PP", EX: "EX_GAUGE" } as const;

function attackSkill(
  id: string,
  effectActionId: string,
  skillType: "AS" | "PS" | "EX" = "AS",
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType,
    cost: { resource: SKILL_COST_RESOURCE[skillType], amount: 1 },
    ...(skillType === "PS"
      ? {
          triggers: [
            {
              eventType: "BattleStarted",
              category: "FACT",
              sourceSelector: "SELF",
              targetSelector: "ALLY",
            },
          ],
        }
      : {}),
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: effectActionId }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    metadata: { displayName: `${id}-display` },
  });
}

const BUFF_DURATION = { dispellable: true, timeLimit: { unit: "ACTION", count: 1 } };

function statModAction(id: string, formula: Record<string, unknown>): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula,
        stacking: { mode: "STACKABLE" },
        duration: BUFF_DURATION,
      },
    },
    "effectAction",
  );
}

function damageModAction(id: string, damageType: string | null): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_DAMAGE_MOD",
      payload: {
        direction: "INCOMING",
        damageType,
        formula: { kind: "CONSTANT", value: -0.3 },
        stacking: { mode: "STACKABLE" },
        duration: BUFF_DURATION,
      },
    },
    "effectAction",
  );
}

function statusAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_STATUS",
      payload: { status: "STUN", duration: BUFF_DURATION },
    },
    "effectAction",
  );
}

function unitDefinition(
  id: string,
  overrides: {
    requiredCapabilities?: readonly string[];
    activeSkillDefinitionIds?: readonly string[];
    passiveSkillDefinitionIds?: readonly string[];
    extraSkillDefinitionId?: string;
    category?: string;
    exerciseActive?: boolean;
  } = {},
): UnitDefinition {
  return createUnitDefinition({
    unitDefinitionId: id,
    ...(overrides.category === undefined ? {} : { category: overrides.category }),
    ...(overrides.exerciseActive === undefined ? {} : { exerciseActive: overrides.exerciseActive }),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: overrides.activeSkillDefinitionIds ?? [],
    passiveSkillDefinitionIds: overrides.passiveSkillDefinitionIds ?? [],
    extraSkillDefinitionId: overrides.extraSkillDefinitionId ?? "SKL_EX",
    metadata: {
      displayName: `${id}-name`,
      characterName: `${id}-char`,
      characterId: id,
    },
  });
}

function memoryDefinition(id: string, effectActionId: string): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ALLY",
        },
        effectSequence: {
          targetBindings: [
            {
              targetBindingId: "TGT_ALL_ALLIES",
              selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
            },
          ],
          steps: [
            {
              kind: "ACTION",
              target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
              actions: [{ effectActionDefinitionId: effectActionId }],
            },
          ],
        },
      },
    ],
    metadata: { displayName: id },
  });
}

class FakeBattleCatalogDirectory implements BattleCatalogDirectory {
  callCount = 0;
  private readonly snapshot: BattleCatalogSnapshot;

  constructor(snapshot: BattleCatalogSnapshot) {
    this.snapshot = snapshot;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    this.callCount++;
    return this.snapshot;
  }
}

function snapshotOf(overrides: Partial<BattleCatalogSnapshot>): BattleCatalogSnapshot {
  return {
    catalogRevision: "rev-1",
    units: new Map(),
    skills: new Map(),
    effectActions: new Map(),
    memories: new Map(),
    ...overrides,
  };
}

function toMap<K, V>(entries: readonly V[], keyOf: (value: V) => K): ReadonlyMap<K, V> {
  return new Map(entries.map((value) => [keyOf(value), value]));
}

describe("GetBattleSimulationCatalogUseCase", () => {
  it("returns the catalogRevision and every Unit/Memory in definition-ID ascending order", () => {
    const unitB = unitDefinition("UNIT_B");
    const unitA = unitDefinition("UNIT_A");
    const memoryB = memoryDefinition("MEM_B", "ACT_MEM");
    const memoryA = memoryDefinition("MEM_A", "ACT_MEM");
    const snapshot = snapshotOf({
      units: toMap([unitB, unitA], (u) => u.unitDefinitionId),
      memories: toMap([memoryB, memoryA], (m) => m.memoryDefinitionId),
      effectActions: toMap([damageAction("ACT_MEM")], (e) => e.effectActionDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();

    expect(result.catalogRevision).toBe("rev-1");
    expect(result.units.map((u) => u.unitDefinitionId)).toEqual(["UNIT_A", "UNIT_B"]);
    expect(result.memories.map((m) => m.memoryDefinitionId)).toEqual(["MEM_A", "MEM_B"]);
  });

  it("projects category and exerciseActive so clients can split unit pools (R-TEX-11 #1/#4)", () => {
    const playable = unitDefinition("UNIT_A");
    const exerciseEnemy = unitDefinition("UNIT_TEX", {
      category: "EXERCISE_ENEMY",
      exerciseActive: false,
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({ units: toMap([playable, exerciseEnemy], (u) => u.unitDefinitionId) }),
      ),
    });

    const result = useCase.execute();

    expect(result.units).toEqual([
      expect.objectContaining({ unitDefinitionId: "UNIT_A", category: "PLAYABLE" }),
      expect.objectContaining({
        unitDefinitionId: "UNIT_TEX",
        category: "EXERCISE_ENEMY",
        exerciseActive: false,
      }),
    ]);
    expect("exerciseActive" in (result.units[0] ?? {})).toBe(false);
  });

  it("publishes the gear effect table and derives representationRevision from the catalogRevision and that table", () => {
    const snapshot = snapshotOf({ catalogRevision: "rev-1" });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();

    expect(result.gearEffects).toEqual(buildGearEffects());
    // 効果表はコード定数でありCatalogファイルに紐づかないため、ETag導出元は
    // `catalogRevision`だけでは足りない（10_API設計.md「ETag」）。
    expect(result.representationRevision).toContain("rev-1");
    expect(result.representationRevision).toContain(gearEffectsFingerprint(result.gearEffects));
    expect(result.representationRevision).not.toBe("rev-1");
  });

  it("loads the snapshot and projects the read model only once, reusing it across repeated execute() calls", () => {
    const unit = unitDefinition("UNIT_A");
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
    });
    const directory = new FakeBattleCatalogDirectory(snapshot);
    const useCase = new GetBattleSimulationCatalogUseCase({ battleCatalogDirectory: directory });

    const first = useCase.execute();
    const second = useCase.execute();

    expect(directory.callCount).toBe(1);
    expect(second).toBe(first);
  });

  it("freezes the shared Result graph so mutation attempts are rejected and later execute() calls stay unaffected", () => {
    const unit = unitDefinition("UNIT_A");
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();
    const unitSummary = result.units[0]!;

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.units)).toBe(true);
    expect(Object.isFrozen(unitSummary)).toBe(true);

    expect(() => (result.units as unknown as unknown[]).push(unitSummary)).toThrow();
    expect(() => {
      (result as unknown as Record<string, unknown>).catalogRevision = "mutated";
    }).toThrow();

    expect(useCase.execute().units.length).toBe(1);
  });

  it("UT-CATALOG-LABEL-001: projects every Skill with its display name, type and the owning unit's slot label (AS/PS in declaration order, EX)", () => {
    const unit = unitDefinition("UNIT_A", {
      activeSkillDefinitionIds: ["SKL_A_AS1", "SKL_A_AS2"],
      passiveSkillDefinitionIds: ["SKL_A_PS1", "SKL_A_PS2"],
      extraSkillDefinitionId: "SKL_A_EX",
    });
    const skills = [
      attackSkill("SKL_A_PS2", "ACT_A", "PS"),
      attackSkill("SKL_A_AS2", "ACT_A"),
      attackSkill("SKL_A_EX", "ACT_A", "EX"),
      attackSkill("SKL_A_AS1", "ACT_A"),
      attackSkill("SKL_A_PS1", "ACT_A", "PS"),
    ];
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({
          units: toMap([unit], (u) => u.unitDefinitionId),
          skills: toMap(skills, (s) => s.skillDefinitionId),
          effectActions: toMap([damageAction("ACT_A")], (e) => e.effectActionDefinitionId),
        }),
      ),
    });

    const result = useCase.execute();

    expect(result.skills).toEqual([
      {
        skillDefinitionId: "SKL_A_AS1",
        displayName: "SKL_A_AS1-display",
        skillType: "AS",
        ownerUnitDefinitionId: "UNIT_A",
        slotLabel: "AS1",
      },
      {
        skillDefinitionId: "SKL_A_AS2",
        displayName: "SKL_A_AS2-display",
        skillType: "AS",
        ownerUnitDefinitionId: "UNIT_A",
        slotLabel: "AS2",
      },
      {
        skillDefinitionId: "SKL_A_EX",
        displayName: "SKL_A_EX-display",
        skillType: "EX",
        ownerUnitDefinitionId: "UNIT_A",
        slotLabel: "EX",
      },
      {
        skillDefinitionId: "SKL_A_PS1",
        displayName: "SKL_A_PS1-display",
        skillType: "PS",
        ownerUnitDefinitionId: "UNIT_A",
        slotLabel: "PS1",
      },
      {
        skillDefinitionId: "SKL_A_PS2",
        displayName: "SKL_A_PS2-display",
        skillType: "PS",
        ownerUnitDefinitionId: "UNIT_A",
        slotLabel: "PS2",
      },
    ]);
  });

  it("UT-CATALOG-LABEL-002: omits owner and slot for a Skill no unit or more than one unit declares, since neither names a single slot", () => {
    const unitA = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_SHARED"] });
    const unitB = unitDefinition("UNIT_B", { passiveSkillDefinitionIds: ["SKL_SHARED"] });
    const skills = [
      attackSkill("SKL_SHARED", "ACT_A"),
      attackSkill("SKL_ORPHAN", "ACT_A"),
      attackSkill("SKL_EX", "ACT_A", "EX"),
    ];
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({
          units: toMap([unitA, unitB], (u) => u.unitDefinitionId),
          skills: toMap(skills, (s) => s.skillDefinitionId),
          effectActions: toMap([damageAction("ACT_A")], (e) => e.effectActionDefinitionId),
        }),
      ),
    });

    const result = useCase.execute();

    // `SKL_EX`は両ユニットのEXとして宣言されている（`unitDefinition`の既定値）。
    expect(result.skills).toEqual([
      { skillDefinitionId: "SKL_EX", displayName: "SKL_EX-display", skillType: "EX" },
      { skillDefinitionId: "SKL_ORPHAN", displayName: "SKL_ORPHAN-display", skillType: "AS" },
      { skillDefinitionId: "SKL_SHARED", displayName: "SKL_SHARED-display", skillType: "AS" },
    ]);
  });

  it("UT-CATALOG-LABEL-003: projects every EffectAction with its kind and only the classification fields that kind declares", () => {
    const effects = [
      statusAction("ACT_STATUS"),
      damageModAction("ACT_DMG_MOD", "EN"),
      damageModAction("ACT_DMG_MOD_ANY", null),
      statModAction("ACT_STAT", { kind: "CONSTANT", value: 0.05 }),
      damageAction("ACT_DAMAGE"),
    ];
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({ effectActions: toMap(effects, (e) => e.effectActionDefinitionId) }),
      ),
    });

    const result = useCase.execute();

    expect(result.effects).toEqual([
      { effectActionDefinitionId: "ACT_DAMAGE", kind: "DAMAGE" },
      {
        effectActionDefinitionId: "ACT_DMG_MOD",
        kind: "APPLY_DAMAGE_MOD",
        direction: "INCOMING",
        damageType: "EN",
        constantMagnitude: -0.3,
      },
      {
        effectActionDefinitionId: "ACT_DMG_MOD_ANY",
        kind: "APPLY_DAMAGE_MOD",
        direction: "INCOMING",
        constantMagnitude: -0.3,
      },
      {
        effectActionDefinitionId: "ACT_STAT",
        kind: "APPLY_STAT_MOD",
        stat: "ATTACK",
        valueType: "RATIO",
        constantMagnitude: 0.05,
      },
      { effectActionDefinitionId: "ACT_STATUS", kind: "APPLY_STATUS", status: "STUN" },
    ]);
  });

  it("UT-CATALOG-LABEL-004: publishes constantMagnitude only for a CONSTANT formula, since any other formula is evaluated per grant", () => {
    const effects = [
      statModAction("ACT_SCALED", {
        kind: "STAT_RATIO",
        source: { kind: "SKILL_SOURCE" },
        stat: "ATTACK",
        ratio: 0.1,
      }),
    ];
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({ effectActions: toMap(effects, (e) => e.effectActionDefinitionId) }),
      ),
    });

    const [summary] = useCase.execute().effects;

    expect(summary).toEqual({
      effectActionDefinitionId: "ACT_SCALED",
      kind: "APPLY_STAT_MOD",
      stat: "ATTACK",
      valueType: "RATIO",
    });
  });

  it("UT-CATALOG-LABEL-005: does not expose Skill or EffectAction resolution shapes (cost, steps, formula, duration) in the summaries", () => {
    const unit = unitDefinition("UNIT_A", { activeSkillDefinitionIds: ["SKL_A"] });
    const snapshot = snapshotOf({
      units: toMap([unit], (u) => u.unitDefinitionId),
      skills: toMap([attackSkill("SKL_A", "ACT_A")], (s) => s.skillDefinitionId),
      effectActions: toMap(
        [statModAction("ACT_A", { kind: "CONSTANT", value: 0.1 })],
        (e) => e.effectActionDefinitionId,
      ),
    });
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(snapshot),
    });

    const result = useCase.execute();
    const serialized = JSON.stringify({ skills: result.skills, effects: result.effects });

    for (const hidden of [
      "cost",
      "resolution",
      "steps",
      "cooldown",
      "formula",
      "duration",
      "payload",
    ]) {
      expect(serialized).not.toContain(`"${hidden}"`);
    }
  });

  it("UT-CATALOG-LABEL-010 (10_API設計.md「ETag」): derives representationRevision from the projection version too, so a deploy that only adds response fields is not answered with 304", () => {
    const useCase = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: new FakeBattleCatalogDirectory(
        snapshotOf({ catalogRevision: "rev-1" }),
      ),
    });

    const result = useCase.execute();

    expect(result.representationRevision).toContain(
      `projection.${String(CATALOG_PROJECTION_VERSION)}`,
    );
  });
});
