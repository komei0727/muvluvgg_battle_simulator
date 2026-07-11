import { describe, expect, it } from "vitest";
import { createMemoryDefinition } from "./memory-definition.js";
import { DomainValidationError } from "../shared/errors.js";

describe("MemoryDefinition", () => {
  it("UT-CAT-MEM-001: maps the doc's triggeredEffects example (BattleStarted fixed-attack Memory)", () => {
    const result = createMemoryDefinition({
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
                actions: [{ effectActionDefinitionId: "ACT_MEMORY_ATTACK_FIXED_250" }],
              },
            ],
          },
        },
      ],
      metadata: { displayName: "Colorful Bouquet" },
    });
    expect(result.memoryDefinitionId).toBe("MEM_001");
    expect(result.triggeredEffects).toHaveLength(1);
    expect(result.modifiers).toEqual([]);
  });

  it("UT-CAT-MEM-002: maps the modifiers shorthand example", () => {
    const result = createMemoryDefinition({
      memoryDefinitionId: "MEM_002",
      modifiers: [
        { targetFilter: { kind: "ALL" }, stat: "ATTACK", valueType: "FIXED", value: 250 },
      ],
      metadata: { displayName: "Fixed Attack Buff" },
    });
    expect(result.modifiers).toEqual([
      { targetFilter: { kind: "ALL" }, stat: "ATTACK", valueType: "FIXED", value: 250 },
    ]);
  });

  it("UT-CAT-MEM-003: rejects a Memory with neither triggeredEffects nor modifiers", () => {
    expect(() =>
      createMemoryDefinition({ memoryDefinitionId: "MEM_003", metadata: { displayName: "Empty" } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-MEM-004: rejects an unknown modifier stat", () => {
    expect(() =>
      createMemoryDefinition({
        memoryDefinitionId: "MEM_004",
        modifiers: [
          { targetFilter: { kind: "ALL" }, stat: "AFFINITY_BONUS", valueType: "FIXED", value: 1 },
        ],
        metadata: { displayName: "Invalid" },
      }),
    ).toThrow(DomainValidationError);
  });
});
