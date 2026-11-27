import type { Violation } from "../contracts/application-error.js";
import { prefixViolationPaths } from "./evaluation-command.js";
import { validateExpectedRevisions } from "./evaluation-runtime-info.js";

/**
 * 単発APIで大量試行の1試行を再実行する指定（`10_API設計.md`「SimulationReplay」）。
 * 識別情報はすべて必須にする — 省略を許すと、別の実装・Catalog・乱数導出で得た結果を
 * 保存済みの試行の再生として返してしまう。
 */
export interface SimulationReplayRequest {
  readonly seed: string;
  readonly runIndex: number;
  readonly expectedCatalogRevision: string;
  readonly expectedEngineRevision: string;
  readonly expectedSeedDerivationVersion: string;
}

export interface SimulationReplayIdentity {
  readonly catalogRevision: string;
  readonly engineRevision: string;
  readonly seedDerivationVersion: string;
}

/** `SeededRandomSourceProvider.forRun`が受け付ける範囲と同じ（符号なし32bit整数）。 */
const MAX_RUN_INDEX = 0xffffffff;

/**
 * 再生指定を実行前に検証する。違反はまとめて返し、1件でもあれば戦闘を開始しない。
 * 再生は詳細ログを返すための操作なので、`SUMMARY`の明示は黙って上書きせず拒否する。
 */
export function validateSimulationReplay(
  replay: SimulationReplayRequest,
  requestedLogLevel: string | undefined,
  actual: SimulationReplayIdentity,
): Violation[] {
  const violations: Violation[] = [];
  if (replay.seed.trim() === "") {
    violations.push({ path: "replay.seed", reason: "must not be blank" });
  }
  if (
    !Number.isInteger(replay.runIndex) ||
    replay.runIndex < 0 ||
    replay.runIndex > MAX_RUN_INDEX
  ) {
    violations.push({
      path: "replay.runIndex",
      reason: `must be an integer between 0 and ${MAX_RUN_INDEX}, got ${replay.runIndex}`,
    });
  }
  violations.push(
    ...prefixViolationPaths(
      validateExpectedRevisions(replay, {
        catalogRevision: actual.catalogRevision,
        engineRevision: actual.engineRevision,
      }),
      "replay",
    ),
  );
  if (replay.expectedSeedDerivationVersion !== actual.seedDerivationVersion) {
    violations.push({
      path: "replay.expectedSeedDerivationVersion",
      reason: `does not match the server seedDerivationVersion "${actual.seedDerivationVersion}", got "${replay.expectedSeedDerivationVersion}"`,
    });
  }
  if (requestedLogLevel !== undefined && requestedLogLevel !== "DETAILED") {
    violations.push({
      path: "options.logLevel",
      reason: `must be DETAILED or omitted when replay is specified, got "${requestedLogLevel}"`,
    });
  }
  return violations;
}
