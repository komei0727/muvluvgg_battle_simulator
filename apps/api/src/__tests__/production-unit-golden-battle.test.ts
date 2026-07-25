import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBattleInvariants } from "../testing/scenario/run-scenario.js";
import {
  runProductionUnitBattle,
  selectableProductionUnitIds,
} from "../testing/scenario/run-production-battle.js";

/**
 * Golden battle 回帰層（`12_テスト戦略.md`「golden battle」）。GET一覧APIが
 * `selectable: true` と公開する全 production Unit について、味方・敵に据えた実戦闘が
 * 決定的に完走し、基本不変条件を満たすことを検証する。公開イベントの type 列と勝敗を
 * 小さく安定したsnapshotで固定し、ユニット追加に伴うルール間結合の回帰を検出する。
 *
 * 新たに `selectable` となったUnitは自動的にケースが増え、snapshot未登録なら失敗する
 * （強制関数）。個別の回帰意図を持つテスト（例: `kei-jackknife-...`）は別途残す。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../catalog", import.meta.url));
const SELECTABLE_UNIT_IDS = selectableProductionUnitIds(CATALOG_DIR);

describe("production Unit golden battles", () => {
  it("E2E-GOLDEN-000: at least one production Unit is selectable (guards against a silently empty golden layer)", () => {
    expect(SELECTABLE_UNIT_IDS.length).toBeGreaterThan(0);
  });

  it.each(SELECTABLE_UNIT_IDS)(
    "E2E-GOLDEN: %s completes a deterministic mirror battle and holds battle invariants",
    (unitDefinitionId) => {
      const result = runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
        turnLimit: 5,
        randomValue: 0.5,
      });

      expect(typeof result.outcome).toBe("string");
      expect(typeof result.completionReason).toBe("string");
      assertBattleInvariants(result);

      // 小さく安定したsnapshot: 勝敗・終了理由・公開イベントの type 列のみ
      // （レスポンス全文ではない）。数値差分やダメージ値はsnapshot対象にしない。
      expect({
        unitDefinitionId,
        outcome: result.outcome,
        completionReason: result.completionReason,
        completedTurn: result.completedTurn,
        eventTypes: result.events.map((event) => event.type),
      }).toMatchSnapshot();
    },
  );
});
