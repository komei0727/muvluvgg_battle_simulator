import { fileURLToPath } from "node:url";
import { summarizeEventSequence } from "./event-sequence-fingerprint.js";
import { parseGoldenEventTypesCliRequest } from "./golden-event-types-cli-request.js";
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
 * `pnpm run dump-golden-event-types unit <unitDefinitionId>`
 * `pnpm run dump-golden-event-types party <allyCsv> <enemyCsv>`
 * `pnpm run dump-golden-event-types exercise <allyCsv> <enemyUnitDefinitionId>`
 *
 * 引数解析（先頭の`--`を許容する理由を含む）は`golden-event-types-cli-request.ts`。
 *
 * battleIdは各goldenテストと違う固定値を使う——events配列の内容には影響しない識別子
 * のため、debug専用の値で足りる。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const DEBUG_BATTLE_ID = "B_GOLDEN_DEBUG";

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

const request = parseGoldenEventTypesCliRequest(process.argv.slice(2));

switch (request.kind) {
  case "unit": {
    const result = runProductionUnitBattle(CATALOG_DIR, request.unitDefinitionId, {
      turnLimit: 5,
      randomValue: 0.5,
      logLevel: "DETAILED",
    });
    printEventTypeSequence(request.unitDefinitionId, result.events);
    break;
  }
  case "party": {
    const result = runProductionPartyBattle(
      CATALOG_DIR,
      { ally: request.ally, enemy: request.enemy },
      { turnLimit: 5, randomValue: 0.5, battleId: DEBUG_BATTLE_ID },
    );
    printEventTypeSequence(
      `ally=${request.ally.join("+")} enemy=${request.enemy.join("+")}`,
      result.events,
    );
    break;
  }
  case "exercise": {
    const result = runProductionExerciseBattle(
      CATALOG_DIR,
      { ally: request.ally, enemyUnitDefinitionId: request.enemyUnitDefinitionId },
      { randomValue: 0.5, battleId: DEBUG_BATTLE_ID },
    );
    printEventTypeSequence(
      `ally=${request.ally.join("+")} enemy=${request.enemyUnitDefinitionId}`,
      result.events,
    );
    break;
  }
  case "usage":
    console.error(
      "Usage: dump-golden-event-types <unit <unitDefinitionId> | party <allyCsv> <enemyCsv> | exercise <allyCsv> <enemyUnitDefinitionId>>",
    );
    process.exitCode = 1;
    break;
}
