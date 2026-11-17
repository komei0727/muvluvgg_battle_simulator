import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BattleLogEvent } from "../../application/observation/battle-log-event.js";
import { runProductionPartyBattle } from "../../testing/scenario/run-production-battle.js";

/**
 * R-MEM-02 #3: ターン開始時はMemoryをPSより先に解決する。合成Catalogでの順序は
 * `resolve-passive-chain.test.ts`（UT-R-MEM-02-006〜008）が押さえるため、ここでは
 * production Catalogの実ユニット・実Memoryを実Battleで走らせ、ターン開始時の解決
 * スコープで両者が実際にこの順で発動することを確かめる。
 *
 * `MEM_DISCONTENT_AND_ANXIETY` はターン開始時に味方前衛全員へ付与するため、前衛に
 * 置いたユニットが必ず対象になる。`SKL_CLARA_TSUNDERE_PS2` は条件なしのターン開始時PS。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const MEMORY_ID = "MEM_DISCONTENT_AND_ANXIETY";
const TURN_START_PS_ID = "SKL_CLARA_TSUNDERE_PS2";

function detailsOf(event: BattleLogEvent): Readonly<Record<string, unknown>> {
  return event.details as Readonly<Record<string, unknown>>;
}

function turnStartScope(
  events: readonly BattleLogEvent[],
  turnNumber: number,
): readonly BattleLogEvent[] {
  const turnStarted = events.find(
    (event) => event.type === "TURN_STARTED" && event.turnNumber === turnNumber,
  );
  expect(turnStarted, `TURN_STARTED of turn ${turnNumber}`).toBeDefined();
  return events.filter((event) => event.rootSequence === turnStarted!.sequence);
}

describe("Memory and PS order at turn start (R-MEM-02 #3)", () => {
  it("SCN-BTL-038 [R-MEM-02]: a turn-start Memory activates before a turn-start PS in the same turn", () => {
    const result = runProductionPartyBattle(
      CATALOG_DIR,
      {
        ally: ["UNIT_CLARA_TSUNDERE"],
        enemy: ["UNIT_CLARA_TSUNDERE"],
        allyMemories: [MEMORY_ID],
      },
      { turnLimit: 1 },
    );

    const scope = turnStartScope(result.events, 1);
    const memory = scope.find(
      (event) =>
        event.type === "MEMORY_TRIGGERED" && detailsOf(event)["memoryDefinitionId"] === MEMORY_ID,
    );
    const allyPassive = scope.find(
      (event) =>
        event.type === "PASSIVE_ACTIVATED" &&
        event.sourceUnitId?.startsWith("ally") === true &&
        detailsOf(event)["skillDefinitionId"] === TURN_START_PS_ID,
    );

    expect(memory, "MEMORY_TRIGGERED").toBeDefined();
    expect(allyPassive, "PASSIVE_ACTIVATED").toBeDefined();
    expect(memory!.sequence).toBeLessThan(allyPassive!.sequence);
  });
});
