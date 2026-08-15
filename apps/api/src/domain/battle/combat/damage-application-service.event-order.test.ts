import { describe, expect, it } from "vitest";
import { applyDamageAction, type DamageEventContext } from "./damage-application-service.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import {
  unit,
  defeated,
  damageAction,
  immunityEffect,
  evasionEffect,
  hit,
  damageEventContext,
} from "../../../testing/fixtures/damage-application.js";

describe("applyDamageAction hit-level damage event order (DMG-001)", () => {
  it("UT-R-DMG-05-001 (R-DMG-05 #4, DMG-001): a hit records DamageWillBeApplied between CriticalCheckResolved and DamageCalculated, carrying the confirmed critical and piercing rates", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("GUARANTEED"),
      [attacker, target],
      random,
      context,
    );

    const events = context.recorder.getEvents();
    expect(
      events.map((event) => event.eventType).filter((eventType) => eventType !== "ActionStarted"),
    ).toEqual([
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageWillBeApplied",
      "DamageCalculated",
      "HitPointReduced",
      "DamageApplied",
    ]);

    const criticalCheckResolved = events.find((e) => e.eventType === "CriticalCheckResolved")!;
    const willBeApplied = events.find((e) => e.eventType === "DamageWillBeApplied")!;
    const damageCalculated = events.find((e) => e.eventType === "DamageCalculated")!;

    expect(willBeApplied.category).toBe("TIMING");
    expect(willBeApplied.parentEventId).toBe(criticalCheckResolved.eventId);
    expect(damageCalculated.parentEventId).toBe(willBeApplied.eventId);
    expect(willBeApplied.sourceUnitId).toBe(createBattleUnitId("ATTACKER"));
    expect(willBeApplied.targetUnitIds).toEqual([createBattleUnitId("TARGET")]);
    expect(willBeApplied.payload).toEqual({
      skillDefinitionId: createSkillDefinitionId("SKL_ATTACK"),
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK"),
      hitIndex: 1,
      targetUnitId: createBattleUnitId("TARGET"),
      damageType: "PHYSICAL",
      // R-CRT-02: 会心倍率は`1 + criticalDamageBonus(0.5)`。
      isCritical: true,
      criticalMultiplier: 1.5,
      defenseIgnoreRate: 0,
      shieldIgnoreRate: 0,
      damageReductionIgnoreRate: 0,
      // R-DMG-04（DMG-002）: どちらも`APPLY_DAMAGE_MOD`不在で1倍。
      outgoingDamageMultiplier: 1,
      incomingDamageMultiplier: 1,
    });
    // TIMINGイベントは状態変更を表さない（`08_ドメインイベント.md`「FACTイベントは、
    // 表す状態変更が確定した後に発行する」の裏返し）。
    expect(willBeApplied.stateDelta).toBeUndefined();
  });

  it("UT-R-DMG-05-002 (R-DMG-05 #4, DMG-001): each hit of a multi-hit DAMAGE records its own DamageWillBeApplied, in hit order", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    const hitIndexes = context.recorder
      .getEvents()
      .filter((event) => event.eventType === "DamageWillBeApplied")
      .map((event) => (event.payload as { hitIndex: number }).hitIndex);
    expect(hitIndexes).toEqual([1, 2]);
  });

  it("UT-R-DMG-05-003 (R-DMG-05 #4 negative, DMG-001): an evaded hit never reaches DamageWillBeApplied", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target: BattleUnit = {
      ...unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 }),
      appliedEffects: [evasionEffect("E_EVADE", "TARGET", { probability: 1 })],
    };
    const random = new SequenceRandomSource([0]);
    const context = damageEventContext();

    applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(
      context.recorder.getEvents().some((event) => event.eventType === "DamageWillBeApplied"),
    ).toBe(false);
  });

  it("UT-R-DMG-05-004 (R-DMG-05 #4 + 08_ドメインイベント.md「TIMINGイベント後の再検証」, DMG-001): a PS reacting to DamageWillBeApplied that defeats the target cancels this hit instead of applying damage to a corpse", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "DamageWillBeApplied"
          ? units.map((u) => (u.battleUnitId === createBattleUnitId("TARGET") ? defeated(u) : u))
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(result.hits).toEqual([
      {
        targetUnitId: createBattleUnitId("TARGET"),
        hitIndex: 1,
        applied: false,
        isCritical: false,
        damage: 0,
      },
    ]);
    const eventTypes = context.recorder.getEvents().map((event) => event.eventType);
    expect(eventTypes).toContain("DamageWillBeApplied");
    expect(eventTypes).not.toContain("DamageCalculated");
    expect(eventTypes).not.toContain("DamageApplied");
    // 対象は既に戦闘不能で、このヒットでHPをさらに減らしていない。
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(0);
  });

  it("UT-R-SKL-03-002 (R-SKL-03「使用者が途中で戦闘不能になった場合、残りのヒットを中断する」+ R-DMG-05 #4 再検証, DMG-001): a PS reacting to the first hit's DamageWillBeApplied that defeats the attacker interrupts every remaining hit", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 500 });
    const random = new SequenceRandomSource([]);
    let seen = 0;
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) => {
        if (event.eventType !== "DamageWillBeApplied") {
          return units;
        }
        seen += 1;
        return units.map((u) =>
          u.battleUnitId === createBattleUnitId("ATTACKER") ? defeated(u) : u,
        );
      },
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1), hit("TARGET", 2), hit("TARGET", 3)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    expect(seen).toBe(1);
    expect(result.interruptedCount).toBe(3);
    expect(result.hits.every((outcome) => !outcome.applied)).toBe(true);
    expect(
      context.recorder.getEvents().some((event) => event.eventType === "DamageCalculated"),
    ).toBe(false);
  });

  it("UT-R-DMG-05-005 (R-DMG-05 #4 再検証「ダメージ無効・軽減効果」, DMG-001): a DAMAGE_IMMUNITY granted by a PS reacting to DamageWillBeApplied still nullifies this hit, instead of being read from a pre-TIMING snapshot", () => {
    const attacker = unit("ATTACKER", "ALLY", { attack: 30 });
    const target = unit("TARGET", "ENEMY", { defense: 10, maximumHp: 100 });
    const random = new SequenceRandomSource([]);
    const context: DamageEventContext = {
      ...damageEventContext(),
      onFactEventForPassiveChain: (event, units) =>
        event.eventType === "DamageWillBeApplied"
          ? units.map((u) =>
              u.battleUnitId === createBattleUnitId("TARGET")
                ? { ...u, appliedEffects: [immunityEffect("E_IMMUNITY", "TARGET")] }
                : u,
            )
          : units,
    };

    const result = applyDamageAction(
      attacker,
      [hit("TARGET", 1)],
      damageAction("PREVENTED"),
      [attacker, target],
      random,
      context,
    );

    // R-DMG-02: 無効化されたダメージは1になる（20ではない）。
    expect(result.hits[0]!.damage).toBe(1);
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(99);
  });
});
