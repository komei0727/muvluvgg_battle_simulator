import { describe, expect, it } from "vitest";
import { createMemoryDefinition } from "./memory-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

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
      requiredCapabilities: [],
      metadata: { displayName: "Colorful Bouquet" },
    });
    expect(result.memoryDefinitionId).toBe("MEM_001");
    expect(result.triggeredEffects).toHaveLength(1);
  });

  it("UT-CAT-MEM-003: rejects a Memory with no triggeredEffects", () => {
    expect(() =>
      createMemoryDefinition({
        memoryDefinitionId: "MEM_003",
        requiredCapabilities: [],
        metadata: { displayName: "Empty" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-MEM-005: rejects a non-array requiredCapabilities", () => {
    expect(() =>
      createMemoryDefinition({
        memoryDefinitionId: "MEM_005",
        triggeredEffects: [
          {
            trigger: {
              eventType: "BattleStarted",
              category: "FACT",
              sourceSelector: "ANY",
              targetSelector: "ANY",
            },
            effectSequence: {
              targetBindings: [],
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_1" }],
                },
              ],
            },
          },
        ],
        requiredCapabilities: "CAP_HEAL" as unknown as readonly string[],
        metadata: { displayName: "Invalid" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-MEM-006: rejects a non-array triggeredEffects", () => {
    expect(() =>
      createMemoryDefinition({
        memoryDefinitionId: "MEM_006",
        triggeredEffects: "not-an-array" as unknown as never[],
        requiredCapabilities: [],
        metadata: { displayName: "Invalid" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-MEM-008: rejects a typo'd sibling key inside a triggeredEffect", () => {
    expect(() =>
      createMemoryDefinition({
        memoryDefinitionId: "MEM_008",
        triggeredEffects: [
          {
            trigger: {
              eventType: "BattleStarted",
              category: "FACT",
              sourceSelector: "ANY",
              targetSelector: "ANY",
            },
            effectSequence: {
              targetBindings: [],
              steps: [
                {
                  kind: "ACTION",
                  target: { kind: "SELF" },
                  actions: [{ effectActionDefinitionId: "ACT_1" }],
                },
              ],
            },
            typoField: "oops",
          } as never,
        ],
        requiredCapabilities: [],
        metadata: { displayName: "Invalid" },
      }),
    ).toThrow(DomainValidationError);
  });
});
