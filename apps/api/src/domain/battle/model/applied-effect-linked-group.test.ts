import { describe, expect, it } from "vitest";
import { collectLinkedGroupCascade } from "./applied-effect-linked-group.js";
import { createBattleUnit, type BattleUnit } from "./battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "./applied-effect.js";
import type { BattlePartyMember } from "./battle-party.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

const EFFECT_ACTION_DEFINITION_ID = createEffectActionDefinitionId("ACT_LINK");

function effect(id: string, target: BattleUnit, linkedEffectGroupId: string | null): AppliedEffect {
  const definition: DurationDefinition = {
    dispellable: true,
    linkedEffectGroupId,
  };
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: EFFECT_ACTION_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(EFFECT_ACTION_DEFINITION_ID),
    duplicate: true,
    sourceId: target.battleUnitId,
    targetId: target.battleUnitId,
    magnitude: 10,
    duration: { definition },
    appliedTurnNumber: 1,
  };
}

describe("collectLinkedGroupCascade", () => {
  it("UT-R-EFF-09-001 (R-EFF-09): returns just the initial set when none of its instances share a linkedEffectGroupId", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, null);
    const sibling = effect("sibling", target, null);
    const units = [{ ...target, appliedEffects: [parent, sibling] }];

    const result = collectLinkedGroupCascade(units, new Set([parent.effectInstanceId]));

    expect(result).toEqual(new Set([parent.effectInstanceId]));
  });

  it("UT-R-EFF-09-002 (R-EFF-09): expands to sibling instances sharing the same linkedEffectGroupId on the same unit", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, "GROUP_A");
    const child = effect("child", target, "GROUP_A");
    const unrelated = effect("unrelated", target, "GROUP_B");
    const units = [{ ...target, appliedEffects: [parent, child, unrelated] }];

    const result = collectLinkedGroupCascade(units, new Set([parent.effectInstanceId]));

    expect(result).toEqual(new Set([parent.effectInstanceId, child.effectInstanceId]));
  });

  it("UT-R-EFF-09-003 (R-EFF-09): expands across different units holding the same linkedEffectGroupId", () => {
    const targetA = unit("target-a");
    const targetB = unit("target-b");
    const parent = effect("parent", targetA, "GROUP_A");
    const child = effect("child", targetB, "GROUP_A");
    const units = [
      { ...targetA, appliedEffects: [parent] },
      { ...targetB, appliedEffects: [child] },
    ];

    const result = collectLinkedGroupCascade(units, new Set([parent.effectInstanceId]));

    expect(result).toEqual(new Set([parent.effectInstanceId, child.effectInstanceId]));
  });

  it("UT-R-EFF-09-004 (R-EFF-09): does not expand through an instance with linkedEffectGroupId null", () => {
    const target = unit("target-1");
    const parent = effect("parent", target, null);
    const other = effect("other", target, null);
    const units = [{ ...target, appliedEffects: [parent, other] }];

    const result = collectLinkedGroupCascade(units, new Set([parent.effectInstanceId]));

    expect(result).toEqual(new Set([parent.effectInstanceId]));
  });
});
