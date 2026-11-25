import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEffectActionDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { durationOf } from "../../domain/catalog/integrity/effect-action-inspection.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import { memoryEffectActionClosure } from "../../testing/production-unit/definition-closure.js";
import { observeMemoryEffectRemoval } from "../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../testing/production-unit/skill-behaviour.js";
import { runProductionExerciseBattle } from "../../testing/scenario/run-production-battle.js";

/**
 * R-MEM-05: Memoryが付与する効果は解除不可である。production Catalogの全Memoryを
 * 棚卸しし、宣言（静的）と実際の`removeEffects`（動的）の両面から確かめる。
 * Memoryを追加しただけでこの表が自動的に広がるよう、ID一覧はCatalogから読む。
 */
const MEMORY_DEFINITION_IDS: readonly string[] = (
  JSON.parse(readFileSync(join(PRODUCTION_CATALOG_DIR, "memories.json"), "utf8")) as readonly {
    readonly memoryDefinitionId: string;
  }[]
).map((memory) => memory.memoryDefinitionId);

describe("production Memory effects are undispellable (R-MEM-05)", () => {
  it("IT-R-MEM-05-001: every effect any production Memory can grant declares duration.dispellable false", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], MEMORY_DEFINITION_IDS);
    const dispellable: string[] = [];
    let durationCount = 0;
    for (const memoryDefinitionId of MEMORY_DEFINITION_IDS) {
      for (const id of memoryEffectActionClosure(snapshot, memoryDefinitionId)) {
        const effectAction = snapshot.effectActions.get(createEffectActionDefinitionId(id));
        const duration = effectAction === undefined ? undefined : durationOf(effectAction);
        if (duration === undefined) {
          continue;
        }
        durationCount += 1;
        if (duration.dispellable) {
          dispellable.push(`${memoryDefinitionId}: ${id}`);
        }
      }
    }
    // 棚卸しが空回りしていない（Memoryの効果を実際に検査している）ことを固定する。
    expect(MEMORY_DEFINITION_IDS.length).toBeGreaterThanOrEqual(48);
    expect(durationCount).toBeGreaterThanOrEqual(119);
    expect(dispellable).toEqual([]);
  });

  it.each(MEMORY_DEFINITION_IDS)(
    "IT-R-MEM-05-002: an unlimited BUFF/DEBUFF REMOVE_EFFECTS removes nothing %s granted at battle start",
    (memoryDefinitionId) => {
      for (const side of ["ALLY", "ENEMY"] as const) {
        const observed = observeMemoryEffectRemoval(memoryDefinitionId, side);
        expect(observed.removed).toEqual([]);
        expect(observed.heldAfter).toEqual(observed.heldBefore);
      }
    },
  );

  /**
   * 戦術演習のリディアTEX PS1は、敵から付与されたデバフを契機に自身のデバフを
   * 付与順の古い順に1件解除する。メモリー由来のデバフは戦闘開始時に付くため常に最も古いが、
   * 解除不可なので枠を消費せず、後から付いたスキル由来のデバフが代わりに剥がれる。
   */
  it("IT-R-MEM-05-004 [R-MEM-05, R-EFF-02]: in a tactical exercise, UNIT_LYDIA_SUMMER_TEX's maxRemovals:1 debuff removal never strips the Memory-granted debuff", () => {
    const { events, finalState } = runProductionExerciseBattle(
      PRODUCTION_CATALOG_DIR,
      {
        ally: ["UNIT_JUNKA_CHILDHOOD"],
        enemyUnitDefinitionId: "UNIT_LYDIA_SUMMER_TEX",
        allyMemories: ["MEM_OJOSAMA_MANNERS"],
      },
      { randomValue: 0.5, battleId: "B_MEM_UNDISPELLABLE" },
    );
    const detailsOf = (event: (typeof events)[number]) =>
      event.details as Readonly<Record<string, unknown>>;
    const removedFromBoss = events
      .filter(
        (event) =>
          event.type === "EFFECT_REMOVED" &&
          detailsOf(event)["battleUnitId"] === "enemy:1" &&
          detailsOf(event)["reason"] === "REMOVED",
      )
      .map((event) => String(detailsOf(event)["effectActionDefinitionId"]));

    // ボスのデバフ解除そのものは起きている（空回りではない）。
    expect(removedFromBoss.length).toBeGreaterThan(0);
    expect(removedFromBoss.filter((id) => id.startsWith("ACT_MEM_"))).toEqual([]);
    expect(
      (finalState.units[createBattleUnitId("enemy:1")]!.effects ?? []).map(
        (effect) => effect.effectDefinitionId,
      ),
    ).toContain("ACT_MEM_OJOSAMA_MANNERS_ENEMY_DMG_UP");
  });
});
