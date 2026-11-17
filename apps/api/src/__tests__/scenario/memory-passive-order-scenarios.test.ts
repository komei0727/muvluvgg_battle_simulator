import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import { runProductionPartyBattle } from "../../testing/scenario/run-production-battle.js";

/**
 * R-MEM-02 #3: ターン開始時はMemoryをPSより先に解決する。合成Catalogでの順序は
 * `resolve-passive-chain.test.ts`（UT-R-MEM-02-006〜008）が押さえるため、ここでは
 * production Catalogの実ユニット・実Memoryを実Battleで走らせ、ターン開始時Memoryの
 * 攻撃力補正が**同じターン**のターン開始時PSの対象選択・ダメージに反映されることを、
 * Memoryの有無を変えた2戦闘の比較で確かめる。順序が逆（PSが先）なら、1ターン目の
 * PSはMemoryの有無によらず同じ結果になる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function detailsOf(event: BattleLogEvent): Readonly<Record<string, unknown>> {
  return event.details as Readonly<Record<string, unknown>>;
}

/** 1ターン目のTURN_STARTEDを起点とする解決スコープのイベント。 */
function firstTurnStartScope(
  ally: readonly string[],
  allyMemories: readonly string[],
): readonly BattleLogEvent[] {
  const result = runProductionPartyBattle(
    CATALOG_DIR,
    { ally, enemy: ["UNIT_CLARA_TSUNDERE"], allyMemories },
    { turnLimit: 1 },
  );
  const turnStarted = result.events.find(
    (event) => event.type === "TURN_STARTED" && event.turnNumber === 1,
  );
  expect(turnStarted, "TURN_STARTED of turn 1").toBeDefined();
  return result.events.filter((event) => event.rootSequence === turnStarted!.sequence);
}

function completedTargetsOf(
  scope: readonly BattleLogEvent[],
  effectActionDefinitionId: string,
): readonly string[] {
  const completed = scope.filter(
    (event) =>
      event.type === "EFFECT_ACTION_COMPLETED" &&
      detailsOf(event)["effectActionDefinitionId"] === effectActionDefinitionId,
  );
  expect(completed, `EFFECT_ACTION_COMPLETED of ${effectActionDefinitionId}`).toHaveLength(1);
  return completed[0]!.targetUnitIds;
}

function damageOf(scope: readonly BattleLogEvent[], effectActionDefinitionId: string): number {
  const applied = scope.filter(
    (event) =>
      event.type === "DAMAGE_APPLIED" &&
      detailsOf(event)["effectActionDefinitionId"] === effectActionDefinitionId,
  );
  expect(applied, `DAMAGE_APPLIED of ${effectActionDefinitionId}`).toHaveLength(1);
  return detailsOf(applied[0]!)["calculatedDamage"] as number;
}

describe("Turn-start Memory before turn-start PS (R-MEM-02 #3)", () => {
  /**
   * `SKL_MERU_BESIDE_PS2` はターン開始時に攻撃力が最も高い味方1体（自身を含む）を選ぶ。
   * 開始時の攻撃力は `UNIT_URUU_TIMID`（積極）が `UNIT_MERU_FLATSPIN`（コミカル）より
   * 高いが、差は `MEM_LIKE_FRIENDS`（コミカル・クレバーの攻撃力+1000）より小さい。
   * 桃園める（内気）自身はMemoryの対象外で、どちらよりも攻撃力が低い。
   */
  it("SCN-BTL-038 [R-MEM-02]: a turn-start Memory's attack bonus changes the target a turn-start PS selects in the same turn", () => {
    const party = ["UNIT_MERU_BESIDE", "UNIT_URUU_TIMID", "UNIT_MERU_FLATSPIN"];

    const withoutMemory = firstTurnStartScope(party, []);
    const withMemory = firstTurnStartScope(party, ["MEM_LIKE_FRIENDS"]);

    // 編成は前列左から ally:1（める）、ally:2（うるう）、ally:3（めるフラットスピン）。
    expect(completedTargetsOf(withoutMemory, "ACT_MERU_BESIDE_PS2_EX_UP")).toEqual(["ally:2"]);
    expect(completedTargetsOf(withMemory, "ACT_MERU_BESIDE_PS2_EX_UP")).toEqual(["ally:3"]);
  });

  /** `SKL_KOKORO_SPORTSDAY_PS2` はターン開始時に攻撃する。ここあ（キュート）は `MEM_GREATEST_FORTUNE` の対象。 */
  it("SCN-BTL-039 [R-MEM-02]: a turn-start Memory's attack bonus raises the damage of a turn-start PS in the same turn", () => {
    const party = ["UNIT_KOKORO_SPORTSDAY"];

    const withoutMemory = damageOf(
      firstTurnStartScope(party, []),
      "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE",
    );
    const withMemory = damageOf(
      firstTurnStartScope(party, ["MEM_GREATEST_FORTUNE"]),
      "ACT_KOKORO_SPORTSDAY_PS2_DAMAGE",
    );

    expect(withMemory).toBeGreaterThan(withoutMemory);
  });
});
