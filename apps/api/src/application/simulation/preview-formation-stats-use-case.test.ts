import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import type { PreviewFormationStatsCommand } from "./preview-formation-stats-command.js";
import { PreviewFormationStatsUseCase } from "./preview-formation-stats-use-case.js";
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createMemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import {
  exSkillDefinition,
  formationSlot as slot,
  unitDefinition,
  DEFAULT_EX_SKILL_ID,
} from "../../testing/scenario/definition-builders.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";

const ALLY = unitDefinition("UNIT_ALLY", { attribute: "AGGRESSIVE" });
/** 成長値を持つユニット。R-ENH-05 #5 の受理側を確かめるために使う。 */
const GROWING = unitDefinition("UNIT_GROWING", {
  attribute: "SHY",
  levelGrowth: { hp: 10, attack: 2, defense: 1, actionSpeed: 0.5 },
});

/**
 * プレビューはMemoryの`triggeredEffects`を解決しない（R-MEM-03の発動は
 * `BattleStarted`以降）。ここでは「存在するMemory定義」であることだけが要るため、
 * 定義として最小限に妥当な1件を持たせる。
 */
const MEMORY = createMemoryDefinition({
  memoryDefinitionId: "MEM_001",
  triggeredEffects: [
    {
      trigger: {
        eventType: "BattleStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
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
            actions: [{ effectActionDefinitionId: "ACT_NOOP" }],
          },
        ],
      },
    },
  ],
  metadata: { displayName: "MEM_001", tags: [] },
});

function snapshot(units: readonly UnitDefinition[]): BattleCatalogSnapshot {
  return {
    catalogRevision: "rev-preview",
    units: new Map(units.map((unit) => [unit.unitDefinitionId, unit])),
    skills: new Map([
      [createSkillDefinitionId(DEFAULT_EX_SKILL_ID), exSkillDefinition(DEFAULT_EX_SKILL_ID)],
    ]),
    effectActions: new Map(),
    memories: new Map([[createMemoryDefinitionId("MEM_001"), MEMORY]]),
  };
}

function directory(units: readonly UnitDefinition[] = [ALLY, GROWING]): BattleCatalogDirectory {
  return { loadSnapshot: () => snapshot(units) };
}

function useCase(units: readonly UnitDefinition[] = [ALLY, GROWING]): PreviewFormationStatsUseCase {
  return new PreviewFormationStatsUseCase({ battleCatalogDirectory: directory(units) });
}

function command(
  overrides: Partial<PreviewFormationStatsCommand> = {},
): PreviewFormationStatsCommand {
  return {
    allyFormation: { slots: [slot("UNIT_ALLY", 0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot("UNIT_GROWING", 1)], memoryDefinitionIds: [] },
    ...overrides,
  };
}

describe("PreviewFormationStatsUseCase", () => {
  it("UT-STAT-PREVIEW-010 (09_アプリケーション設計.md「FormationStatPreviewResult」): returns one entry per slot, allies first, keeping each side's command order", () => {
    const result = useCase().execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_ALLY", 1, "REAR"), slot("UNIT_GROWING", 0)],
          memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
        },
      }),
    );

    expect(result.catalogRevision).toBe("rev-preview");
    expect(
      result.units.map((unit) => ({
        side: unit.side,
        unitDefinitionId: unit.unitDefinitionId,
        position: unit.position,
      })),
    ).toEqual([
      {
        side: "ALLY",
        unitDefinitionId: createUnitDefinitionId("UNIT_ALLY"),
        position: { column: "CENTER", row: "BACK" },
      },
      {
        side: "ALLY",
        unitDefinitionId: createUnitDefinitionId("UNIT_GROWING"),
        position: { column: "LEFT", row: "FRONT" },
      },
      {
        side: "ENEMY",
        unitDefinitionId: createUnitDefinitionId("UNIT_GROWING"),
        position: { column: "CENTER", row: "FRONT" },
      },
    ]);
  });

  it("UT-STAT-PREVIEW-011 (R-STA-01/R-ENH-01 #2): an enhanced side reports higher base stats than the same slot without an enhancement specification", () => {
    const plain = useCase().execute(command());
    const enhanced = useCase().execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_ALLY", 0)],
          memoryDefinitionIds: [],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
        },
      }),
    );

    expect(enhanced.units[0]!.combatStats.attack).toBeGreaterThan(
      plain.units[0]!.combatStats.attack,
    );
    expect(enhanced.units[0]!.combatStats.maximumHp).toBeGreaterThan(
      plain.units[0]!.combatStats.maximumHp,
    );
    // 強化指定のない敵陣営は従来どおりユニット定義の基本ステータスのままである。
    expect(enhanced.units[1]!.combatStats).toEqual(plain.units[1]!.combatStats);
  });

  it("UT-STAT-PREVIEW-012 (09_アプリケーション設計.md「Command検証」): rejects an invalid placement without touching the Catalog", () => {
    let loadCount = 0;
    const countingUseCase = new PreviewFormationStatsUseCase({
      battleCatalogDirectory: {
        loadSnapshot: () => {
          loadCount += 1;
          return snapshot([ALLY, GROWING]);
        },
      },
    });

    expect(() =>
      countingUseCase.execute(
        command({
          allyFormation: {
            slots: [slot("UNIT_ALLY", 0), slot("UNIT_ALLY", 0)],
            memoryDefinitionIds: [],
          },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        violations: [expect.objectContaining({ path: "allyFormation.slots[1].position" })],
      }),
    );
    expect(loadCount).toBe(0);
  });

  it("UT-STAT-PREVIEW-013 (09_アプリケーション設計.md「参照検証」): reports an unknown UnitDefinitionId as DEFINITION_NOT_FOUND", () => {
    expect(() =>
      useCase().execute(
        command({
          allyFormation: { slots: [slot("UNIT_MISSING", 0)], memoryDefinitionIds: [] },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "DEFINITION_NOT_FOUND",
        violations: [
          expect.objectContaining({
            path: "allyFormation.slots[0].unitDefinitionId",
            definitionId: "UNIT_MISSING",
          }),
        ],
      }),
    );
  });

  it("UT-STAT-PREVIEW-014 (R-ENH-05 #5): rejects a level other than 200 for a unit without levelGrowth, and accepts it for a unit that has one", () => {
    const withLevel = (unitId: string): PreviewFormationStatsCommand =>
      command({
        allyFormation: {
          slots: [{ ...slot(unitId, 0), enhancement: { level: 220 } }],
          memoryDefinitionIds: [],
          enhancement: {},
        },
      });

    expect(() => useCase().execute(withLevel("UNIT_ALLY"))).toThrow(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        violations: [expect.objectContaining({ path: "allyFormation.slots[0].enhancement.level" })],
      }),
    );
    expect(useCase().execute(withLevel("UNIT_GROWING")).units).toHaveLength(2);
  });

  it("UT-STAT-PREVIEW-015 (10_API設計.md「FormationStatPreviewResponse」/12_テスト戦略.md): the preview equals the initialState the battle reports for the same formations and enhancement", () => {
    const previewCommand = command({
      allyFormation: {
        slots: [
          { ...slot("UNIT_GROWING", 0), enhancement: { level: 260, gears: [] } },
          { ...slot("UNIT_ALLY", 1, "REAR") },
        ],
        memoryDefinitionIds: [],
        enhancement: {
          academyLevels: { unitTypes: { PHYSICAL: 30 }, attributes: { SHY: 40 } },
        },
      },
      enemyFormation: { slots: [slot("UNIT_ALLY", 2)], memoryDefinitionIds: [] },
    });

    const preview = useCase().execute(previewCommand);

    const battleCatalog: BattleCatalog = { loadSnapshot: () => snapshot([ALLY, GROWING]) };
    const battle = new SimulateBattleUseCase({
      battleCatalog,
      battleIdGenerator: new FixedBattleIdGenerator(["battle-preview"]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 64 }, () => 0.5)),
      clock: new ManualClock(0),
    }).execute(
      { ...previewCommand, turnLimit: 1, logLevel: "SUMMARY" },
      { requestId: "preview-consistency", deadlineEpochMs: Number.MAX_SAFE_INTEGER },
    );

    expect(
      preview.units.map((unit) => ({
        maximumHp: unit.combatStats.maximumHp,
        attack: unit.combatStats.attack,
        defense: unit.combatStats.defense,
        criticalRate: unit.combatStats.criticalRate,
        actionSpeed: unit.combatStats.actionSpeed,
        affinityBonus: unit.combatStats.affinityBonus,
        criticalDamageBonus: unit.combatStats.criticalDamageBonus,
      })),
    ).toEqual(
      battle.unitRoster.map((entry) => {
        const stats = battle.initialState.units[entry.battleUnitId]!.combatStats;
        return {
          maximumHp: stats.maximumHp,
          attack: stats.attack,
          defense: stats.defense,
          criticalRate: stats.criticalRate,
          actionSpeed: stats.actionSpeed,
          affinityBonus: stats.affinityBonus,
          criticalDamageBonus: stats.criticalDamageBonus,
        };
      }),
    );
  });

  it("UT-STAT-PREVIEW-018: previews a formation whose other side is still empty, so stats are available while the formation is being filled in", () => {
    const result = useCase().execute(
      command({ enemyFormation: { slots: [], memoryDefinitionIds: [] } }),
    );

    expect(result.units.map((unit) => unit.side)).toEqual(["ALLY"]);
    expect(result.units[0]!.combatStats.maximumHp).toBeGreaterThan(0);
  });

  it("UT-STAT-PREVIEW-024 (09_アプリケーション設計.md「FormationStatPreviewResult」/R-ENH-06): reports the enhanced base stats alongside the corrected combat stats", () => {
    const result = useCase().execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_ALLY", 0)],
          memoryDefinitionIds: [],
          enhancement: { academyLevels: { unitTypes: { PHYSICAL: 50 } } },
        },
      }),
    );

    // 強化指定のある味方は、強化後基本ステータスをユニット定義の基本値より高く報告する。
    expect(result.units[0]!.enhancedBaseStats.attack).toBeGreaterThan(ALLY.baseStats.attack);
    // 強化指定のない敵陣営はユニット定義の基本ステータスをそのまま報告する。
    expect(result.units[1]!.enhancedBaseStats).toEqual(GROWING.baseStats);
  });

  it("UT-STAT-PREVIEW-025 (R-STA-01): the reported enhanced base stats exclude the aptitude penalty that the combat stats include", () => {
    // 前衛適性しか持たないユニットを後衛へ置き、適性補正-5%だけを成立させる
    // （1体編成のため役は成立せず、編成補正は0）。
    const frontOnly = unitDefinition("UNIT_FRONT_ONLY", { positionAptitudes: ["FRONT"] });
    const result = useCase([ALLY, GROWING, frontOnly]).execute(
      command({
        allyFormation: {
          slots: [slot("UNIT_FRONT_ONLY", 1, "REAR")],
          memoryDefinitionIds: [],
        },
      }),
    );

    expect(result.units[0]!.enhancedBaseStats.attack).toBeCloseTo(10, 6);
    expect(result.units[0]!.combatStats.attack).toBeCloseTo(9.5, 6);
  });

  it("UT-STAT-PREVIEW-016 (09_アプリケーション設計.md「PreviewFormationStatsUseCase」): is deterministic — the same command produces the same stats on every call", () => {
    const preview = useCase();
    expect(preview.execute(command())).toEqual(preview.execute(command()));
  });

  it("UT-STAT-PREVIEW-017: reports an unknown MemoryDefinitionId as DEFINITION_NOT_FOUND instead of failing later inside the formation factory", () => {
    const error = (() => {
      try {
        useCase().execute(
          command({
            allyFormation: {
              slots: [slot("UNIT_ALLY", 0)],
              memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
            },
          }),
        );
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
  });

  it("UT-STAT-PREVIEW-019 (R-TEX-11 #5): mode TACTICAL_EXERCISE previews an EXERCISE_ENEMY enemy that the default NORMAL mode rejects", () => {
    const exerciseEnemy = unitDefinition("UNIT_TEX", {
      category: "EXERCISE_ENEMY",
      exerciseActive: true,
    });
    const preview = useCase([ALLY, exerciseEnemy]);
    const cmd = (mode?: PreviewFormationStatsCommand["mode"]) =>
      command({
        enemyFormation: { slots: [slot("UNIT_TEX", 0)], memoryDefinitionIds: [] },
        ...(mode === undefined ? {} : { mode }),
      });

    expect(preview.execute(cmd("TACTICAL_EXERCISE")).units).toHaveLength(2);

    try {
      preview.execute(cmd());
      expect.fail("expected the NORMAL-mode preview to reject the EXERCISE_ENEMY unit");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ ruleId: "R-TEX-11" }),
      );
    }
  });

  it("UT-STAT-PREVIEW-022: rejects an unknown mode as INVALID_COMMAND without touching the Catalog", () => {
    try {
      useCase().execute(command({ mode: "RANKED" as unknown as "NORMAL" }));
      expect.fail("expected the preview to reject the unknown mode");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "mode" }),
      );
    }
  });
});
