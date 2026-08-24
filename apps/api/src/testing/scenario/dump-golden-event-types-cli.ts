import { fileURLToPath } from "node:url";
import { summarizeEventSequence } from "./event-sequence-fingerprint.js";
import {
  runProductionExerciseBattle,
  runProductionPartyBattle,
  runProductionUnitBattle,
} from "./run-production-battle.js";

/**
 * `production-*-golden-battle.test.ts`（Issue #607）のデバッグ経路。snapshotは
 * `eventTypeCounts`＋`eventSequenceHash`のみを固定するため、ハッシュだけが変わった行では
 * 「何が変わったか」が読めない。疑わしいケースの識別フィールド（snapshot上の
 * `unitDefinitionId` / `ally`・`enemy` / `ally`・`enemyUnitDefinitionId`）をそのまま
 * このCLIへ渡すと、そのケースが発行した公開イベントのtype列を発生順に出力する。
 *
 * `pnpm run dump-golden-event-types -- unit <unitDefinitionId>`
 * `pnpm run dump-golden-event-types -- party <allyCsv> <enemyCsv>`
 * `pnpm run dump-golden-event-types -- exercise <allyCsv> <enemyUnitDefinitionId>`
 *
 * battleIdは各goldenテストと違う固定値を使う——events配列の内容には影響しない識別子
 * のため、debug専用の値で足りる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const DEBUG_BATTLE_ID = "B_GOLDEN_DEBUG";

function parseIds(csv: string): readonly string[] {
  return csv
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function printEventTypeSequence(label: string, events: readonly { readonly type: string }[]): void {
  const summary = summarizeEventSequence(events);
  console.log(`# ${label}`);
  console.log(`eventCount: ${summary.eventCount}`);
  console.log(`eventSequenceHash: ${summary.eventSequenceHash}`);
  console.log(
    JSON.stringify(
      events.map((event) => event.type),
      null,
      2,
    ),
  );
}

const [kind, ...args] = process.argv.slice(2);

if (kind === "unit" && args[0] !== undefined) {
  const unitDefinitionId = args[0];
  const result = runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
    turnLimit: 5,
    randomValue: 0.5,
    logLevel: "DETAILED",
  });
  printEventTypeSequence(unitDefinitionId, result.events);
} else if (kind === "party" && args[0] !== undefined && args[1] !== undefined) {
  const ally = parseIds(args[0]);
  const enemy = parseIds(args[1]);
  const result = runProductionPartyBattle(
    CATALOG_DIR,
    { ally, enemy },
    { turnLimit: 5, randomValue: 0.5, battleId: DEBUG_BATTLE_ID },
  );
  printEventTypeSequence(`ally=${ally.join("+")} enemy=${enemy.join("+")}`, result.events);
} else if (kind === "exercise" && args[0] !== undefined && args[1] !== undefined) {
  const ally = parseIds(args[0]);
  const enemyUnitDefinitionId = args[1];
  const result = runProductionExerciseBattle(
    CATALOG_DIR,
    { ally, enemyUnitDefinitionId },
    { randomValue: 0.5, battleId: DEBUG_BATTLE_ID },
  );
  printEventTypeSequence(`ally=${ally.join("+")} enemy=${enemyUnitDefinitionId}`, result.events);
} else {
  console.error(
    "Usage: dump-golden-event-types <unit <unitDefinitionId> | party <allyCsv> <enemyCsv> | exercise <allyCsv> <enemyUnitDefinitionId>>",
  );
  process.exitCode = 1;
}
