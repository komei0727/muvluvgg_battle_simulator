import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import { evaluateEffectStepCondition } from "../../domain/battle/skill/effect-step-condition-evaluator.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import type { StatusKind } from "../../domain/catalog/definitions/effect-action-payload.js";
import type { Side } from "../../domain/shared/side.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-001E（Issue #248、`CAP_TARGET_STATE_EXTENDED_FIELD`）: `BattleUnit`だけからは
 * 解決できない`TARGET_STATE.field`を、実 `catalog/` の未改変定義に対して検証する。
 *
 * - `HAS_STATUS`: 対象が保持する`APPLY_STATUS`由来の状態種別への存在量化
 *   （`SKL_NANAE_COMMANDER_PS1`のBRANCH条件、気絶／凍結／暗闇のOR）
 * - trigger scopeの`UNIT_TYPE`: Catalogの`UnitDefinition`参照
 *   （`SKL_LUCIE_MAID_PS1`のtrigger条件「物理型／敏捷型の味方が…」）
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function unitOf(
  id: string,
  side: Side,
  unitDefinitionId: UnitDefinitionId,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return {
    ...createBattleUnit(member, side, { maximumAp: 4, maximumPp: 4, maximumExtraGauge: 10 }),
    ...overrides,
  };
}

function statusEffect(holder: BattleUnit, statusKind: StatusKind): AppliedEffect {
  const effectActionDefinitionId = createEffectActionDefinitionId(`ACT_TEST_${statusKind}`);
  return {
    effectInstanceId: createEffectInstanceId(`B_CAP_TSF:effect:${statusKind}`),
    effectActionDefinitionId,
    kindKey: effectKindKeyFromDefinitionId(effectActionDefinitionId),
    duplicate: true,
    targetId: holder.battleUnitId,
    magnitude: 0,
    statusKind,
    categories: ["DEBUFF", "STATUS"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

describe("production Catalog TARGET_STATE extended fields (CAP_TARGET_STATE_EXTENDED_FIELD, M7-001E Issue #248)", () => {
  it("IT-CAP-TARGET-STATE-FIELD-PROD-001: SKL_NANAE_COMMANDER_PS1's real HAS_STATUS BRANCH condition holds exactly when she carries one of STUN/FREEZE/BLIND", () => {
    const unitId = "UNIT_NANAE_COMMANDER";
    const skillId = "SKL_NANAE_COMMANDER_PS1";
    const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_TARGET_STATE_EXTENDED_FIELD");
    const branch = (skill.resolution.kind === "IMMEDIATE" ? skill.resolution.steps : []).find(
      (step) => step.kind === "BRANCH",
    );
    if (branch?.kind !== "BRANCH") {
      throw new Error(`${skillId} has no BRANCH step`);
    }
    // 未改変の定義そのもの（STUN/FREEZE/BLINDのOR）を評価対象にする。
    expect(branch.condition).toMatchObject({ kind: "OR" });

    const owner = unitOf("owner", "ALLY", unitId as never, { column: "LEFT", row: "FRONT" });
    const holds = (statusKind: StatusKind | undefined): boolean =>
      evaluateEffectStepCondition(branch.condition, undefined, undefined, () => [
        statusKind === undefined
          ? owner
          : { ...owner, appliedEffects: [statusEffect(owner, statusKind)] },
      ]);

    expect(holds("STUN")).toBe(true);
    expect(holds("FREEZE")).toBe(true);
    expect(holds("BLIND")).toBe(true);
    // R-STS-01: 対象自身に有利な状態（STEALTH）は状態異常ではないので成立しない。
    expect(holds("STEALTH")).toBe(false);
    expect(holds(undefined)).toBe(false);
  });

  it("IT-CAP-TARGET-STATE-FIELD-PROD-002: SKL_LUCIE_MAID_PS1's real UNIT_TYPE trigger condition reads the attacker's UnitDefinition through the unitDefinitions the passive matcher threads through", () => {
    const unitId = "UNIT_LUCIE_MAID";
    const skillId = "SKL_LUCIE_MAID_PS1";
    const attackerUnitId = "UNIT_TEST_ATTACKER";
    const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot([unitId as never], []);
    const skill = snapshot.skills.get(skillId as never)!;
    expect(skill.requiredCapabilities).toContain("CAP_TARGET_STATE_EXTENDED_FIELD");
    const trigger = skill.triggers[0]!;
    // 未改変の定義（TRIGGER_SOURCEのUNIT_TYPEが物理型または敏捷型）を評価対象にする。
    expect(trigger).toMatchObject({ eventType: "UnitBeingAttacked", sourceSelector: "ENEMY" });
    expect(JSON.stringify(trigger.condition)).toContain("UNIT_TYPE");

    const owner = unitOf("owner", "ALLY", unitId as never, { column: "LEFT", row: "FRONT" });
    const attacker = unitOf("attacker", "ENEMY", attackerUnitId as never, {
      column: "LEFT",
      row: "FRONT",
    });
    const ownerDefinition = snapshot.units.get(unitId as never)!;
    const detect = (attackerUnitType: "PHYSICAL" | "ENERGY" | "AGILE") =>
      detectPassiveCandidates({
        event: {
          eventType: trigger.eventType,
          category: trigger.category,
          sourceUnitId: attacker.battleUnitId,
          targetUnitIds: [owner.battleUnitId],
          payload: {},
        },
        units: [owner, attacker],
        unitDefinitions: new Map([
          [unitId as never, { ...ownerDefinition, passiveSkillDefinitionIds: [skillId as never] }],
          [
            attackerUnitId as never,
            {
              ...ownerDefinition,
              unitDefinitionId: attackerUnitId,
              unitType: attackerUnitType,
              passiveSkillDefinitionIds: [],
            },
          ],
        ]) as never,
        skillDefinitions: new Map([[skillId as never, skill]]),
        activationGuard: createEmptyPassiveActivationGuard(),
        turnNumber: 1,
      });

    // 物理型・敏捷型の攻撃者なら候補になる。
    expect(detect("PHYSICAL").length).toBeGreaterThan(0);
    expect(detect("AGILE").length).toBeGreaterThan(0);
    // EN型では同じtrigger条件が不成立になる
    // （`unitDefinitions`が実際に評価へ効いていることの証跡）。
    expect(detect("ENERGY")).toEqual([]);
  });
});
