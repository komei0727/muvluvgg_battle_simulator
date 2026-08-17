import { describe, expect, it } from "vitest";

import { BreakDeferral } from "./break-deferral.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createDomainEventId } from "../../shared/event-ids.js";

const ENEMY = createBattleUnitId("ENEMY");
const CAUSE = createDomainEventId("EVT_CAUSE");
const LATER_CAUSE = createDomainEventId("EVT_LATER");
const ATTACKER = createBattleUnitId("ATTACKER");

/**
 * R-TEX-03 #5／R-TEX-06 #5: HP0到達をどこで解決するかは「効果処理フェーズの内側か
 * どうか」だけで決まる。保留フレームの有無がその判断そのものになるため、経路ごとの
 * 条件分岐を持たない。
 */
describe("BreakDeferral (R-TEX-03 #5 / R-TEX-06 #5)", () => {
  it("UT-R-TEX-03-017 (BOUNDARY): does not defer when no effect-processing frame is open", () => {
    // 保留フレーム0件が「効果処理の外」の境界そのものである（R-TEX-03 #5の2分岐の境目）。
    const deferral = new BreakDeferral();

    expect(deferral.isDeferring).toBe(false);
  });

  it("UT-R-TEX-03-018: defers inside an effect-processing phase and hands the record back when the phase ends", () => {
    const deferral = new BreakDeferral();
    deferral.beginEffectProcessing();

    expect(deferral.isDeferring).toBe(true);
    deferral.defer({
      targetUnitId: ENEMY,
      causeEventId: CAUSE,
      defeatSource: { sourceUnitId: ATTACKER },
    });

    expect(deferral.endEffectProcessing()).toEqual({
      targetUnitId: ENEMY,
      causeEventId: CAUSE,
      defeatSource: { sourceUnitId: ATTACKER },
    });
    expect(deferral.isDeferring).toBe(false);
  });

  it("UT-R-TEX-03-019: keeps at most one break per effect processing, absorbing a later arrival into the first", () => {
    const deferral = new BreakDeferral();
    deferral.beginEffectProcessing();
    deferral.defer({
      targetUnitId: ENEMY,
      causeEventId: CAUSE,
      defeatSource: { sourceUnitId: ATTACKER },
    });
    deferral.defer({
      targetUnitId: ENEMY,
      causeEventId: LATER_CAUSE,
      defeatSource: { sourceUnitId: ENEMY },
    });

    // R-TEX-03 #6: 確定するのは最初のHP0到達であり、後続の到達はそこへ吸収される
    // （`UnitBroken`の`parentEventId`は最初の原因イベントのまま）。
    expect(deferral.endEffectProcessing()).toMatchObject({ causeEventId: CAUSE });
  });

  it("UT-R-TEX-03-022 (NEGATIVE): rejects a second different unit reaching HP 0 in the same effect processing instead of dropping it silently", () => {
    const deferral = new BreakDeferral();
    deferral.beginEffectProcessing();
    deferral.defer({ targetUnitId: ENEMY, causeEventId: CAUSE, defeatSource: {} });

    // 2件目を黙って捨てると、その対象の保留の印を外す主体が居なくなり、HP0のまま
    // `isDefeated`が永久に偽のユニットが残る。R-TEX-01 #3により本来到達しない状態。
    expect(() =>
      deferral.defer({
        targetUnitId: createBattleUnitId("ENEMY_2"),
        causeEventId: LATER_CAUSE,
        defeatSource: {},
      }),
    ).toThrow(DomainValidationError);
    // 最初の保留は失われない。
    expect(deferral.endEffectProcessing()).toMatchObject({ targetUnitId: ENEMY });
  });

  it("UT-R-TEX-06-006: nests frames so a PS/Memory effect processing resolves its own break without draining the outer one", () => {
    const deferral = new BreakDeferral();
    deferral.beginEffectProcessing();
    deferral.defer({ targetUnitId: ENEMY, causeEventId: CAUSE, defeatSource: {} });

    // R-TEX-06 #8: ネストしたPS/MemoryのEffectSequenceは自分の保留を持つ。
    deferral.beginEffectProcessing();
    expect(deferral.endEffectProcessing()).toBeUndefined();

    expect(deferral.isDeferring).toBe(true);
    expect(deferral.endEffectProcessing()).toMatchObject({ causeEventId: CAUSE });
  });

  it("UT-R-TEX-06-007 (BOUNDARY): ending a phase that never opened yields no pending break", () => {
    const deferral = new BreakDeferral();

    expect(deferral.endEffectProcessing()).toBeUndefined();
    expect(deferral.isDeferring).toBe(false);
  });
});
