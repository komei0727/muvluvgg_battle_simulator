import { describe, expect, it } from "vitest";
import {
  guardedDamage,
  selectCover,
  selectDamageLinks,
  selectDeathSurvival,
  selectReflects,
  selectTargetRedirect,
} from "./defensive-intervention-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import { createBattleUnitId, type BattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { ActionKind } from "../../catalog/definitions/catalog-enums.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(id: string, side: Side = "ENEMY"): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 30,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

function defeated(target: BattleUnit): BattleUnit {
  return { ...target, currentHp: createHitPoint(0, target.combatStats.maximumHp) };
}

function unitMap(...units: readonly BattleUnit[]): ReadonlyMap<BattleUnitId, BattleUnit> {
  return new Map(units.map((candidate) => [candidate.battleUnitId, candidate]));
}

function baseEffect(id: string, holderId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(`ACT_${id}`);
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    targetId: createBattleUnitId(holderId),
    magnitude: 0,
    categories: ["DEBUFF"],
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function redirectEffect(
  id: string,
  holderId: string,
  redirectToUnitId: string,
  actionKinds: readonly ActionKind[] = ["DAMAGE"],
): AppliedEffect {
  return {
    ...baseEffect(id, holderId),
    targetRedirect: { redirectToUnitId: createBattleUnitId(redirectToUnitId), actionKinds },
  };
}

function coverEffect(
  id: string,
  holderId: string,
  covererUnitId: string,
  guardRate = 0,
  actionKinds: readonly ActionKind[] = ["DAMAGE"],
): AppliedEffect {
  return {
    ...baseEffect(id, holderId),
    cover: {
      covererUnitId: createBattleUnitId(covererUnitId),
      damageShareRate: 1,
      guardRate,
      actionKinds,
    },
  };
}

function reflectEffect(
  id: string,
  holderId: string,
  ratio: number,
  recursive = false,
): AppliedEffect {
  return {
    ...baseEffect(id, holderId),
    categories: ["BUFF"],
    reflect: {
      formula: {
        kind: "DAMAGE_RECEIVED_RATIO",
        sourceResult: "LAST_DAMAGE_RECEIVED",
        ratio,
      },
      allowRecursiveReflect: recursive,
    },
  };
}

function damageLinkEffect(
  id: string,
  holderId: string,
  linkToUnitId: string,
  linkRate = 0.35,
): AppliedEffect {
  return {
    ...baseEffect(id, holderId),
    damageLink: { linkToUnitId: createBattleUnitId(linkToUnitId), linkRate },
  };
}

function deathSurvivalEffect(
  id: string,
  holderId: string,
  consumptionRemaining?: number,
): AppliedEffect {
  const effect = baseEffect(id, holderId);
  return {
    ...effect,
    categories: ["BUFF"],
    deathSurvival: {
      survivalHp: { kind: "CONSTANT", value: 1 },
      healAfterSurvival: null,
    },
    duration:
      consumptionRemaining === undefined
        ? effect.duration
        : {
            definition: {
              consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            consumptionRemaining,
          },
  };
}

const TARGET = createBattleUnitId("TARGET");

describe("defensive intervention policy (DMG-006, R-INT-01〜03)", () => {
  describe("R-INT-01 #1 target redirect", () => {
    it("UT-R-INT-01-001: selects the redirect an attacker holds when appliesTo covers this attack", () => {
      const target = unit("TARGET", "ALLY");
      const taunter = unit("TAUNTER", "ALLY");
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [redirectEffect("E1", "ATTACKER", "TAUNTER")],
      };

      expect(
        selectTargetRedirect(attacker, TARGET, "DAMAGE", unitMap(target, taunter, attacker)),
      ).toEqual({
        effectInstanceId: createEffectInstanceId("E1"),
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_E1"),
        redirectToUnitId: taunter.battleUnitId,
      });
    });

    // production Catalogは`["DAMAGE"]`以外の`appliesTo.actionKinds`を
    // ロード時点で拒否する（`catalog-integrity.ts`の`UT-R-INT-01-021`）。ここで検証するのは
    // Catalogを経由しない合成定義に対する`appliesTo`の意味論そのものである。
    it("UT-R-INT-01-002: does not select a redirect whose appliesTo excludes this attack kind, and does select ANY", () => {
      const target = unit("TARGET", "ALLY");
      const taunter = unit("TAUNTER", "ALLY");
      const debuffOnly = {
        ...unit("ATTACKER"),
        appliedEffects: [redirectEffect("E1", "ATTACKER", "TAUNTER", ["DEBUFF"])],
      };
      const any = {
        ...unit("ATTACKER"),
        appliedEffects: [redirectEffect("E2", "ATTACKER", "TAUNTER", ["ANY"])],
      };
      const units = unitMap(target, taunter, debuffOnly);

      expect(selectTargetRedirect(debuffOnly, TARGET, "DAMAGE", units)).toBeUndefined();
      expect(selectTargetRedirect(any, TARGET, "DAMAGE", units)?.redirectToUnitId).toBe(
        taunter.battleUnitId,
      );
    });

    it("UT-R-INT-01-003: does not redirect to a defeated destination (R-ACTN-01 #2)", () => {
      const target = unit("TARGET", "ALLY");
      const taunter = defeated(unit("TAUNTER", "ALLY"));
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [redirectEffect("E1", "ATTACKER", "TAUNTER")],
      };

      expect(
        selectTargetRedirect(attacker, TARGET, "DAMAGE", unitMap(target, taunter, attacker)),
      ).toBeUndefined();
    });

    it("UT-R-INT-01-004: does not redirect when the destination is already this attack's target", () => {
      const target = unit("TARGET", "ALLY");
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [redirectEffect("E1", "ATTACKER", "TARGET")],
      };

      expect(
        selectTargetRedirect(attacker, TARGET, "DAMAGE", unitMap(target, attacker)),
      ).toBeUndefined();
    });

    it("UT-R-INT-01-005: R-INT-02第3項の優先順を「付与順の古い順」に具体化する（先に成立した引き寄せが優先される）", () => {
      const target = unit("TARGET", "ALLY");
      const first = unit("TAUNTER_1", "ALLY");
      const second = unit("TAUNTER_2", "ALLY");
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [
          redirectEffect("E1", "ATTACKER", "TAUNTER_1"),
          redirectEffect("E2", "ATTACKER", "TAUNTER_2"),
        ],
      };

      expect(
        selectTargetRedirect(attacker, TARGET, "DAMAGE", unitMap(target, first, second, attacker))
          ?.redirectToUnitId,
      ).toBe(first.battleUnitId);
    });
  });

  describe("R-INT-01 #2 / R-INT-02 cover", () => {
    it("UT-R-INT-02-002: selects the cover an attacker holds and reports both R-INT-02 rates", () => {
      const target = unit("TARGET", "ALLY");
      const coverer = unit("COVERER", "ALLY");
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [coverEffect("E1", "ATTACKER", "COVERER", 0.5)],
      };

      expect(selectCover(attacker, TARGET, "DAMAGE", unitMap(target, coverer, attacker))).toEqual({
        effectInstanceId: createEffectInstanceId("E1"),
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_E1"),
        covererUnitId: coverer.battleUnitId,
        damageShareRate: 1,
        guardRate: 0.5,
      });
    });

    it("UT-R-INT-02-003: treats a self-cover with no guard as a no-op, but keeps it when it guards (ACT_EVIE_ECO_PS1_COVER)", () => {
      const target = unit("TARGET", "ALLY");
      const noGuard = {
        ...unit("ATTACKER"),
        appliedEffects: [coverEffect("E1", "ATTACKER", "TARGET", 0)],
      };
      const guarding = {
        ...unit("ATTACKER"),
        appliedEffects: [coverEffect("E2", "ATTACKER", "TARGET", 0.5)],
      };
      const units = unitMap(target, noGuard);

      expect(selectCover(noGuard, TARGET, "DAMAGE", units)).toBeUndefined();
      expect(selectCover(guarding, TARGET, "DAMAGE", units)?.guardRate).toBe(0.5);
    });

    it("UT-R-INT-02-004: does not establish a cover whose coverer is defeated (R-ACTN-01 #2)", () => {
      const target = unit("TARGET", "ALLY");
      const coverer = defeated(unit("COVERER", "ALLY"));
      const attacker = {
        ...unit("ATTACKER"),
        appliedEffects: [coverEffect("E1", "ATTACKER", "COVERER")],
      };

      expect(
        selectCover(attacker, TARGET, "DAMAGE", unitMap(target, coverer, attacker)),
      ).toBeUndefined();
    });

    it("UT-R-INT-02-005: guardedDamage reduces the pre-truncation damage by the guard rate (boundaries: 0 and 1)", () => {
      expect(guardedDamage(100, 0)).toBe(100);
      expect(guardedDamage(100, 0.5)).toBe(50);
      expect(guardedDamage(100, 1)).toBe(0);
      // Q-DMG-01: 途中で丸めない。
      expect(guardedDamage(101, 0.5)).toBe(50.5);
    });
  });

  describe("R-INT-01 #4 / R-INT-03 reflect", () => {
    it("UT-R-INT-03-001: returns every reflect the defender holds in grant order", () => {
      const defender = {
        ...unit("DEFENDER", "ALLY"),
        appliedEffects: [
          reflectEffect("E1", "DEFENDER", 0.75),
          reflectEffect("E2", "DEFENDER", 0.5),
        ],
      };

      expect(selectReflects(defender).map((selection) => selection.effectInstanceId)).toEqual([
        createEffectInstanceId("E1"),
        createEffectInstanceId("E2"),
      ]);
    });

    it("UT-R-INT-03-002: excludes an instance declaring allowRecursiveReflect (R-INT-03第2項)", () => {
      const defender = {
        ...unit("DEFENDER", "ALLY"),
        appliedEffects: [reflectEffect("E1", "DEFENDER", 0.75, true)],
      };

      expect(selectReflects(defender)).toEqual([]);
    });
  });

  describe("R-INT-01 #3 / R-LNK-01〜03 damage link", () => {
    it("UT-R-LNK-02-001: returns every link the damaged unit holds in grant order (R-LNK-02 does not divide by count)", () => {
      const holder = {
        ...unit("HOLDER", "ALLY"),
        appliedEffects: [
          damageLinkEffect("E1", "HOLDER", "PEER_A"),
          damageLinkEffect("E2", "HOLDER", "PEER_B", 0.5),
        ],
      };
      const units = unitMap(holder, unit("PEER_A", "ALLY"), unit("PEER_B", "ALLY"));

      expect(selectDamageLinks(holder, units)).toEqual([
        {
          effectInstanceId: createEffectInstanceId("E1"),
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_E1"),
          linkToUnitId: createBattleUnitId("PEER_A"),
          linkRate: 0.35,
        },
        {
          effectInstanceId: createEffectInstanceId("E2"),
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_E2"),
          linkToUnitId: createBattleUnitId("PEER_B"),
          linkRate: 0.5,
        },
      ]);
    });

    it("UT-R-LNK-02-002: excludes a self-link (the holder is its own destination, which would double its own damage)", () => {
      const holder = {
        ...unit("HOLDER", "ALLY"),
        appliedEffects: [damageLinkEffect("E1", "HOLDER", "HOLDER")],
      };

      expect(selectDamageLinks(holder, unitMap(holder))).toEqual([]);
    });

    it("UT-R-LNK-02-003: excludes a link whose destination is defeated or absent from the board (R-ACTN-01 #2)", () => {
      const peer = unit("PEER", "ALLY");
      const holder = {
        ...unit("HOLDER", "ALLY"),
        appliedEffects: [
          damageLinkEffect("E1", "HOLDER", "PEER"),
          damageLinkEffect("E2", "HOLDER", "GONE"),
        ],
      };

      expect(selectDamageLinks(holder, unitMap(holder, defeated(peer)))).toEqual([]);
    });

    it("UT-R-LNK-02-004: returns nothing for a unit that holds no damage link at all", () => {
      const holder = {
        ...unit("HOLDER", "ALLY"),
        appliedEffects: [reflectEffect("E1", "HOLDER", 0.75)],
      };

      expect(selectDamageLinks(holder, unitMap(holder))).toEqual([]);
    });
  });

  describe("R-INT-01 #5 death survival", () => {
    it("UT-R-INT-01-006: selects the oldest instance that still has a LETHAL_DAMAGE consumption left", () => {
      const target = {
        ...unit("TARGET", "ALLY"),
        appliedEffects: [
          deathSurvivalEffect("E1", "TARGET", 0),
          deathSurvivalEffect("E2", "TARGET", 1),
        ],
      };

      expect(selectDeathSurvival(target)?.effectInstanceId).toBe(createEffectInstanceId("E2"));
    });

    it("UT-R-INT-01-007: selects an instance that declares no consumption at all", () => {
      const target = {
        ...unit("TARGET", "ALLY"),
        appliedEffects: [deathSurvivalEffect("E1", "TARGET")],
      };

      expect(selectDeathSurvival(target)?.survivalHp).toEqual({ kind: "CONSTANT", value: 1 });
    });

    it("UT-R-INT-01-008: selects nothing once every instance has spent its consumption", () => {
      const target = {
        ...unit("TARGET", "ALLY"),
        appliedEffects: [deathSurvivalEffect("E1", "TARGET", 0)],
      };

      expect(selectDeathSurvival(target)).toBeUndefined();
    });
  });
});
