import { describe, expect, it } from "vitest";
import { findBlockingImmunity, incrementImmunityBlockedCount } from "./effect-immunity-service.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";

/** R-EFF-03（M7-001B、Issue #243）: `effect-immunity-service.ts`のUnitテスト。 */
describe("findBlockingImmunity", () => {
  const HOLDER = createBattleUnitId("HOLDER");

  function debuffAction(id: string): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: -10 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "TURN", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function stunAction(id: string): EffectActionDefinition {
    return {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function markerAction(id: string): EffectActionDefinition {
    return {
      kind: "APPLY_MARKER",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        markerId: createMarkerId("MARKER_TEST"),
        stack: { policy: "ADD", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
  }

  function immunityEffect(
    instanceId: string,
    overrides: Partial<NonNullable<AppliedEffect["immunity"]>>,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_IMMUNITY")),
      duplicate: true,
      sourceId: HOLDER,
      targetId: HOLDER,
      magnitude: 0,
      immunity: { categories: ["DEBUFF"], maxBlocks: null, blockedCount: 0, ...overrides },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  function holderWith(effects: readonly AppliedEffect[]): Pick<BattleUnit, "appliedEffects"> {
    return { appliedEffects: effects };
  }

  it("UT-R-EFF-03-002: finds a DEBUFF-category immunity blocking an APPLY_STAT_MOD (negative magnitude) grant", () => {
    const immunity = immunityEffect("imm-1", { categories: ["DEBUFF"] });
    const target = holderWith([immunity]);
    const found = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"), magnitude: -10 },
      debuffAction("ACT_ATK_DOWN"),
    );
    expect(found?.effectInstanceId).toBe(immunity.effectInstanceId);
  });

  it("UT-R-EFF-03-003: does not block a BUFF (positive magnitude) grant when immunity only covers DEBUFF", () => {
    const immunity = immunityEffect("imm-1", { categories: ["DEBUFF"] });
    const target = holderWith([immunity]);
    const found = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP"), magnitude: 10 },
      debuffAction("ACT_ATK_UP"),
    );
    expect(found).toBeUndefined();
  });

  it("UT-R-EFF-03-004 (EFFECT_IMMUNITY_STATUS_GRANULARITY): a STATUS immunity scoped to statusKinds STUN blocks a STUN attempt but not FREEZE", () => {
    const immunity = immunityEffect("imm-stun", { categories: ["STATUS"], statusKinds: ["STUN"] });
    const target = holderWith([immunity]);

    const blockedStun = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
        magnitude: 0,
        statusKind: "STUN",
      },
      stunAction("ACT_STUN"),
    );
    expect(blockedStun?.effectInstanceId).toBe(immunity.effectInstanceId);

    const notBlockedFreeze = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
        magnitude: 0,
        statusKind: "FREEZE",
      },
      {
        ...stunAction("ACT_FREEZE"),
        payload: { ...stunAction("ACT_FREEZE").payload, status: "FREEZE" },
      } as EffectActionDefinition,
    );
    expect(notBlockedFreeze).toBeUndefined();
  });

  it("UT-R-EFF-03-017 (PR #245 review [P2] fix): statusKinds scoping cannot be bypassed via the DEBUFF category a status ailment also carries (R-STS-01)", () => {
    // categories includes both STATUS (scoped to FREEZE) and DEBUFF (unscoped
    // on its own). STUN is classified as {STATUS, DEBUFF} per R-STS-01, so
    // without gating DEBUFF too when the candidate is a status ailment, STUN
    // would slip through via the DEBUFF entry even though statusKinds excludes it.
    const immunity = immunityEffect("imm-mixed", {
      categories: ["STATUS", "DEBUFF"],
      statusKinds: ["FREEZE"],
    });
    const target = holderWith([immunity]);

    const stunNotBlocked = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
        magnitude: 0,
        statusKind: "STUN",
      },
      stunAction("ACT_STUN"),
    );
    expect(stunNotBlocked).toBeUndefined();

    const freezeBlocked = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
        magnitude: 0,
        statusKind: "FREEZE",
      },
      {
        ...stunAction("ACT_FREEZE"),
        payload: { ...stunAction("ACT_FREEZE").payload, status: "FREEZE" },
      } as EffectActionDefinition,
    );
    expect(freezeBlocked?.effectInstanceId).toBe(immunity.effectInstanceId);

    // A plain (non-ailment) DEBUFF stat-mod is still blocked unconditionally
    // by the unscoped DEBUFF category — statusKinds only narrows ailment
    // candidates, not ordinary debuffs.
    const plainDebuffBlocked = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"), magnitude: -10 },
      debuffAction("ACT_ATK_DOWN"),
    );
    expect(plainDebuffBlocked?.effectInstanceId).toBe(immunity.effectInstanceId);
  });

  it("UT-R-EFF-03-005: a STATUS immunity with no statusKinds blocks every status ailment (whole-category, backward compatible)", () => {
    const immunity = immunityEffect("imm-status", { categories: ["STATUS"] });
    const target = holderWith([immunity]);
    const blocked = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
        magnitude: 0,
        statusKind: "FREEZE",
      },
      {
        ...stunAction("ACT_FREEZE"),
        payload: { ...stunAction("ACT_FREEZE").payload, status: "FREEZE" },
      } as EffectActionDefinition,
    );
    expect(blocked?.effectInstanceId).toBe(immunity.effectInstanceId);
  });

  it("UT-R-EFF-03-006: a MARKER-category immunity blocks an APPLY_MARKER grant", () => {
    const immunity = immunityEffect("imm-marker", { categories: ["MARKER"] });
    const target = holderWith([immunity]);
    const found = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_MARK"), magnitude: 0 },
      markerAction("ACT_MARK"),
    );
    expect(found?.effectInstanceId).toBe(immunity.effectInstanceId);
  });

  it("UT-R-EFF-03-007: a SPECIFIC_EFFECT immunity blocks only the listed effectActionDefinitionIds", () => {
    const immunity = immunityEffect("imm-specific", {
      categories: ["SPECIFIC_EFFECT"],
      effectActionDefinitionIds: [createEffectActionDefinitionId("ACT_ATK_DOWN")],
    });
    const target = holderWith([immunity]);
    const blocked = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"), magnitude: -10 },
      debuffAction("ACT_ATK_DOWN"),
    );
    expect(blocked?.effectInstanceId).toBe(immunity.effectInstanceId);

    const notBlocked = findBlockingImmunity(
      target,
      {
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_OTHER_DEBUFF"),
        magnitude: -5,
      },
      debuffAction("ACT_OTHER_DEBUFF"),
    );
    expect(notBlocked).toBeUndefined();
  });

  it("UT-R-EFF-03-008: an immunity that already reached maxBlocks no longer blocks new grants", () => {
    const immunity = immunityEffect("imm-capped", {
      categories: ["DEBUFF"],
      maxBlocks: 1,
      blockedCount: 1,
    });
    const target = holderWith([immunity]);
    const found = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"), magnitude: -10 },
      debuffAction("ACT_ATK_DOWN"),
    );
    expect(found).toBeUndefined();
  });

  it("UT-R-EFF-03-009: an immunity below maxBlocks still blocks", () => {
    const immunity = immunityEffect("imm-not-capped", {
      categories: ["DEBUFF"],
      maxBlocks: 2,
      blockedCount: 1,
    });
    const target = holderWith([immunity]);
    const found = findBlockingImmunity(
      target,
      { effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"), magnitude: -10 },
      debuffAction("ACT_ATK_DOWN"),
    );
    expect(found?.effectInstanceId).toBe(immunity.effectInstanceId);
  });
});

describe("incrementImmunityBlockedCount", () => {
  it("UT-R-EFF-03-010: increments blockedCount on an immunity-bearing AppliedEffect without mutating the original", () => {
    const effect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("imm-1"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
      kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_IMMUNITY")),
      duplicate: true,
      sourceId: createBattleUnitId("HOLDER"),
      targetId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      immunity: { categories: ["DEBUFF"], maxBlocks: null, blockedCount: 0 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };

    const updated = incrementImmunityBlockedCount(effect);

    expect(updated.immunity?.blockedCount).toBe(1);
    expect(effect.immunity?.blockedCount).toBe(0);
  });
});
