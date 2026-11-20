import { describe, expect, it } from "vitest";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
} from "../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  productionBoard,
  type BoardUnitSpec,
} from "../../testing/production-unit/skill-behaviour.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../testing/production-unit/passive-activation.js";
import { turnStarted } from "../../testing/production-unit/trigger-events.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";

/**
 * Issue #856（R-INT-02第2項）: かばわれた攻撃の、命中条件を持たない後続効果の付与先。
 *
 * ヒイロPS1（`SKL_HIIRO_LONEWOLF_PS1`）は同じACTION stepで攻撃力最上位の敵へ
 * `DAMAGE`→`MODIFY_RESOURCE(PP, SET 0)`を解決する。PP削りは回避でも行う（命中条件なし）
 * が、攻撃がイーヴィーPS1（`SKL_EVIE_ECO_PS1`）に肩代わりされた場合は、実際に攻撃を
 * 受けた肩代わり者のPPを削る。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_HIIRO_LONEWOLF",
  "UNIT_EVIE_ECO",
]);

const ORIGINAL: BoardUnitSpec = {
  id: "enemy:original",
  position: { column: "CENTER", row: "FRONT" },
  combatStats: { attack: 2000 },
};

const EVIE: BoardUnitSpec = {
  id: "enemy:evie",
  position: { column: "LEFT", row: "FRONT" },
  unitDefinitionId: "UNIT_EVIE_ECO",
  state: { currentHp: 10000 },
};

function resolveTurnStart(enemies: readonly BoardUnitSpec[]) {
  const board = productionBoard(snapshot, "UNIT_HIIRO_LONEWOLF", { enemies });
  const initial = initialSnapshotFor(board.units);
  const chain = openPassiveChain({
    definitions: board.definitions,
    actorUnitId: board.subject.battleUnitId,
    battleId: "B_COVER_FOLLOW_UP",
  });
  const units = chain.fire(turnStarted({ turnNumber: 1 }), board.units);
  const unit = (id: string): BattleUnit =>
    units.find((candidate) => candidate.battleUnitId === id)!;
  return { chain, initial, units, unit };
}

describe("covered attack follow-up target (R-INT-02, Issue #856)", () => {
  it("IT-CAT-COVERFU-001 [R-INT-02]: イーヴィーに引き寄せ・肩代わりされたヒイロPS1のPP削りは、元の対象ではなくイーヴィーへ付く", () => {
    const { chain, initial, unit } = resolveTurnStart([ORIGINAL, EVIE]);

    expect(activatedPassiveSkillIds(chain)).toEqual(
      expect.arrayContaining(["SKL_HIIRO_LONEWOLF_PS1", "SKL_EVIE_ECO_PS1"]),
    );
    // 引き寄せでイーヴィーへ移り、肩代わり（イーヴィー自身）の軽減が乗る。
    expect(
      chain.eventsOfType("DamageRedirected").map((event) => ({
        reason: event.payload.reason,
        from: event.payload.originalTargetUnitId,
        to: event.payload.newTargetUnitId,
      })),
    ).toEqual([
      { reason: "TARGET_REDIRECT", from: "enemy:original", to: "enemy:evie" },
      { reason: "COVER", from: "enemy:evie", to: "enemy:evie" },
    ]);

    // 元の対象は攻撃も受けず、PPも削られない。
    expect(unit("enemy:original").currentHp).toBe(5000);
    expect(unit("enemy:original").currentPp).toBe(4);
    // 肩代わり者は被弾し、PS1のコスト支払後のPP3が0になる。
    expect(unit("enemy:evie").currentHp).toBeLessThan(10000);
    expect(unit("enemy:evie").currentPp).toBe(0);

    const ppChanges = chain
      .eventsOfType("ResourceChanged")
      .filter((event) => event.payload.reason === "EFFECT_ACTION")
      .map((event) => event.payload);
    expect(ppChanges).toEqual([
      expect.objectContaining({ battleUnitId: "enemy:evie", resource: "PP", before: 3, after: 0 }),
    ]);

    // 公開差分だけを当て直した状態が、実行結果の最終状態と一致する。
    const restored = reconstruct(initial, chain.recorder);
    for (const id of ["enemy:original", "enemy:evie"].map((id) => createBattleUnitId(id))) {
      expect(restored.units[id]!.pp).toBe(unit(id).currentPp);
      expect(restored.units[id]!.hp).toBe(unit(id).currentHp);
    }
  });

  it("IT-CAT-COVERFU-002 [R-INT-02]: 肩代わりが無ければPP削りは通常どおり元の対象へ付く", () => {
    // イーヴィーのPPが0ならPS1を発動できず、肩代わりは成立しない。
    const { chain, unit } = resolveTurnStart([
      ORIGINAL,
      { ...EVIE, state: { ...EVIE.state, currentPp: 0 } },
    ]);

    expect(activatedPassiveSkillIds(chain)).not.toContain("SKL_EVIE_ECO_PS1");
    expect(chain.eventsOfType("DamageRedirected")).toEqual([]);
    expect(unit("enemy:original").currentHp).toBeLessThan(5000);
    expect(unit("enemy:original").currentPp).toBe(0);
    expect(unit("enemy:evie").currentPp).toBe(0);
    expect(unit("enemy:evie").currentHp).toBe(10000);
  });
});
