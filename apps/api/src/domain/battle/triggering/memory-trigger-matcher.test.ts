import { describe, expect, it } from "vitest";
import { detectMemoryCandidates } from "./memory-trigger-matcher.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
  type TriggeredEffectInput,
} from "../../catalog/definitions/memory-definition.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import { DomainValidationError } from "../../shared/errors.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side, position: FormationPosition): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

const ALLY = unit("ally:1", "ALLY", { row: "FRONT", column: "CENTER" });
const ENEMY = unit("enemy:1", "ENEMY", { row: "FRONT", column: "CENTER" });
const UNITS = [ALLY, ENEMY];

function triggeredEffect(
  trigger: TriggeredEffectInput["trigger"],
  effectActionDefinitionId = "ACT_MEM_ATTACK_UP",
): TriggeredEffectInput {
  return {
    trigger,
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
          actions: [{ effectActionDefinitionId }],
        },
      ],
    },
  };
}

function memory(id: string, triggeredEffects: readonly TriggeredEffectInput[]): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
    triggeredEffects,
    metadata: { displayName: id },
  });
}

const BATTLE_STARTED: TriggerCandidateEvent = {
  eventType: "BattleStarted",
  category: "FACT",
  payload: { turnLimit: 10 },
};

const SELF_ON_BATTLE_STARTED = {
  eventType: "BattleStarted",
  category: "FACT",
  sourceSelector: "SELF",
  targetSelector: "SELF",
} as const;

describe("detectMemoryCandidates", () => {
  it("UT-R-MEM-01-001: makes a triggeredEffect whose trigger matches the event a Memory candidate", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [memory("MEM_A", [triggeredEffect(SELF_ON_BATTLE_STARTED)])],
        ENEMY: [],
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.memoryDefinitionId).toBe("MEM_A");
    expect(candidates[0]?.side).toBe("ALLY");
    expect(candidates[0]?.memoryIndex).toBe(0);
    expect(candidates[0]?.triggeredEffectIndex).toBe(0);
  });

  it("UT-R-MEM-01-002: does not make a candidate when the trigger declares a different eventType", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [
          memory("MEM_A", [
            triggeredEffect({ ...SELF_ON_BATTLE_STARTED, eventType: "TurnStarted" }),
          ]),
        ],
        ENEMY: [],
      },
    });

    expect(candidates).toHaveLength(0);
  });

  it("UT-R-MEM-01-003: does not make a candidate when the trigger condition does not hold", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [
          memory("MEM_A", [
            triggeredEffect({
              ...SELF_ON_BATTLE_STARTED,
              condition: { kind: "EVENT_PAYLOAD", field: "turnLimit", op: "GT", value: 10 },
            }),
          ]),
        ],
        ENEMY: [],
      },
    });

    expect(candidates).toHaveLength(0);
  });

  it("UT-R-MEM-01-004: keeps making the same candidate on a repeated detection (no once-per-scope guard, unlike PS)", () => {
    const input = {
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [memory("MEM_A", [triggeredEffect(SELF_ON_BATTLE_STARTED)])],
        ENEMY: [],
      },
    } as const;

    expect(detectMemoryCandidates(input)).toHaveLength(1);
    expect(detectMemoryCandidates(input)).toHaveLength(1);
  });

  it("UT-R-MEM-01-005: resolves ALLY/ENEMY selectors relative to the side that declared the Memory", () => {
    const allySourced: TriggerCandidateEvent = {
      eventType: "DamageApplied",
      category: "FACT",
      sourceUnitId: ALLY.battleUnitId,
      targetUnitIds: [ENEMY.battleUnitId],
      payload: {},
    };
    const enemySideMemory = memory("MEM_E", [
      triggeredEffect({
        eventType: "DamageApplied",
        category: "FACT",
        sourceSelector: "ENEMY",
        targetSelector: "ALLY",
      }),
    ]);
    const allySideMemory = memory("MEM_A", [
      triggeredEffect({
        eventType: "DamageApplied",
        category: "FACT",
        sourceSelector: "ENEMY",
        targetSelector: "ALLY",
      }),
    ]);

    const candidates = detectMemoryCandidates({
      event: allySourced,
      units: UNITS,
      memoriesBySide: { ALLY: [allySideMemory], ENEMY: [enemySideMemory] },
    });

    // 発生源がALLY、対象がENEMY: ENEMY陣営のMemoryから見て「敵が発生源・味方が対象」だけが成立する。
    expect(candidates.map((candidate) => candidate.memoryDefinitionId)).toEqual(["MEM_E"]);
  });

  it("UT-R-MEM-01-006: rejects a Memory trigger condition that needs an owner BattleUnit (SELF target reference)", () => {
    expect(() =>
      detectMemoryCandidates({
        event: BATTLE_STARTED,
        units: UNITS,
        memoriesBySide: {
          ALLY: [
            memory("MEM_A", [
              triggeredEffect({
                ...SELF_ON_BATTLE_STARTED,
                condition: {
                  kind: "TARGET_STATE",
                  target: { kind: "SELF" },
                  field: "IS_ALIVE",
                  op: "EQ",
                  value: true,
                },
              }),
            ]),
          ],
          ENEMY: [],
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-MEM-02-001: orders candidates by the API-declared Memory order", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [
          memory("MEM_SECOND", [triggeredEffect(SELF_ON_BATTLE_STARTED, "ACT_SECOND")]),
          memory("MEM_FIRST", [triggeredEffect(SELF_ON_BATTLE_STARTED, "ACT_FIRST")]),
        ],
        ENEMY: [],
      },
    });

    expect(candidates.map((candidate) => candidate.memoryDefinitionId)).toEqual([
      "MEM_SECOND",
      "MEM_FIRST",
    ]);
  });

  it("UT-R-MEM-02-002: orders triggeredEffects of the same Memory by their definition order", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [
          memory("MEM_A", [
            triggeredEffect(SELF_ON_BATTLE_STARTED, "ACT_1"),
            triggeredEffect(SELF_ON_BATTLE_STARTED, "ACT_2"),
          ]),
        ],
        ENEMY: [],
      },
    });

    expect(candidates.map((candidate) => candidate.triggeredEffectIndex)).toEqual([0, 1]);
  });

  it("UT-R-MEM-02-003: orders every ALLY Memory candidate before the ENEMY ones", () => {
    const candidates = detectMemoryCandidates({
      event: BATTLE_STARTED,
      units: UNITS,
      memoriesBySide: {
        ALLY: [memory("MEM_A", [triggeredEffect(SELF_ON_BATTLE_STARTED)])],
        ENEMY: [memory("MEM_E", [triggeredEffect(SELF_ON_BATTLE_STARTED)])],
      },
    });

    expect(candidates.map((candidate) => [candidate.side, candidate.memoryDefinitionId])).toEqual([
      ["ALLY", "MEM_A"],
      ["ENEMY", "MEM_E"],
    ]);
  });
});
