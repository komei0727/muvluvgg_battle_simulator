import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { reduceStateDeltas } from "../../domain/battle/events/state-delta-reducer.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";
import { assertBattleInvariants } from "../../testing/scenario/run-scenario.js";
import { allExerciseEnemyProductionUnitIds } from "../../testing/scenario/run-production-battle.js";
import {
  REVIEWED_UNIT_IDS,
  runStageGScenario,
  scenarioUnitIds,
  stageGScenarios,
  type StageGScenario,
} from "../../testing/scenario/stage-g-sweep.js";

/**
 * 段階G（Issue #840）: スキルレビュー対象の84ユニットを、固定乱数（seed付き）の実戦闘で
 * 横断的に回す。個別のproductionテストは1スキル・1盤面に閉じるため、共通処理の改修が
 * 起こすAS／PS／EXの連鎖・AP／PP不足・CT・複数行動を跨ぐ期限・撃破の組み合わせは
 * ここでしか通らない。
 *
 * 各戦闘について、不変条件・公開差分からの状態再構築・撃破の二重計上なしを確かめ、
 * 同じ `(seed, runIndex)` が同じイベント列・最終状態を再現することを確かめる。最後に、
 * 84体それぞれが味方・敵の両方で戦い、5スキルすべてが実際に発動したことを確かめる。
 *
 * 戦闘結果の全量を保持するとメモリを圧迫するため、各戦闘は1回だけ走らせて検査に要る
 * 要約だけを残す。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SCENARIOS = stageGScenarios(allExerciseEnemyProductionUnitIds(CATALOG_DIR));

/** 決定性の再実行は1つの並べ方と焦点シナリオに絞る（全件の再実行は時間に見合わない）。 */
const DETERMINISM_SCENARIOS = SCENARIOS.filter(
  (scenario) => scenario.scenarioId.includes("-S1-") || scenario.scenarioId.startsWith("FOCUS-"),
);

interface ScenarioSummary {
  readonly invariantViolation: string | undefined;
  readonly reconstructed: boolean;
  readonly defeatedMoreThanOnce: readonly string[];
  readonly defeatedButAlive: readonly string[];
  readonly firedSkillIds: ReadonlySet<string>;
  readonly fingerprint: string;
  readonly completedTurn: number;
}

type StageGResult = ReturnType<typeof runStageGScenario>;

function fingerprintOf(result: StageGResult): string {
  return createHash("sha256")
    .update(JSON.stringify([result.events, result.stateTransitions, result.finalState]))
    .digest("hex");
}

function summarize(result: StageGResult): ScenarioSummary {
  let invariantViolation: string | undefined;
  try {
    assertBattleInvariants(result);
  } catch (error) {
    invariantViolation = (error as Error).message;
  }
  const reconstructed = isDeepStrictEqual(
    reduceStateDeltas(
      result.initialState,
      result.stateTransitions.map((transition) => transition.stateDelta),
    ),
    result.finalState,
  );

  const defeats = new Map<string, number>();
  const firedSkillIds = new Set<string>();
  for (const event of result.events) {
    const details = event.details as { readonly unitId?: string; skillDefinitionId?: string };
    if (event.type === "UNIT_DEFEATED") {
      defeats.set(details.unitId!, (defeats.get(details.unitId!) ?? 0) + 1);
    } else if (
      event.type === "SKILL_USE_STARTED" ||
      event.type === "PASSIVE_ACTIVATED" ||
      event.type === "CHARGE_STARTED"
    ) {
      firedSkillIds.add(details.skillDefinitionId!);
    }
  }
  return {
    invariantViolation,
    reconstructed,
    defeatedMoreThanOnce: [...defeats].filter(([, count]) => count > 1).map(([unitId]) => unitId),
    defeatedButAlive: [...defeats.keys()].filter(
      (unitId) => (result.finalState.units[unitId as BattleUnitId]?.hp ?? 0) > 0,
    ),
    firedSkillIds,
    fingerprint: fingerprintOf(result),
    completedTurn: result.completedTurn,
  };
}

const unitSkills = new Map(
  (
    JSON.parse(readFileSync(`${CATALOG_DIR}/units.json`, "utf8")) as {
      readonly unitDefinitionId: string;
      readonly activeSkillDefinitionIds: readonly string[];
      readonly passiveSkillDefinitionIds: readonly string[];
      readonly extraSkillDefinitionId: string;
    }[]
  ).map((unit) => [
    unit.unitDefinitionId,
    [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ],
  ]),
);

describe("段階G: レビュー対象84ユニットの固定乱数による横断回帰", () => {
  const summaries = new Map<string, ScenarioSummary>();

  beforeAll(() => {
    for (const scenario of SCENARIOS) {
      summaries.set(scenario.scenarioId, summarize(runStageGScenario(CATALOG_DIR, scenario)));
    }
  }, 900_000);

  it("E2E-STAGEG-000: the sweep covers exactly the 84 reviewed units, each as an ally in both battle kinds and as a normal-battle enemy", () => {
    expect(REVIEWED_UNIT_IDS).toHaveLength(84);
    expect(new Set(REVIEWED_UNIT_IDS).size).toBe(84);
    const asAlly = (kind: StageGScenario["kind"]) =>
      new Set(
        SCENARIOS.filter((scenario) => scenario.kind === kind).flatMap((scenario) => scenario.ally),
      );
    const asEnemy = new Set(
      SCENARIOS.flatMap((scenario) => (scenario.kind === "PARTY" ? scenario.enemy : [])),
    );
    for (const unitId of REVIEWED_UNIT_IDS) {
      expect(asAlly("EXERCISE").has(unitId), `${unitId} as exercise ally`).toBe(true);
      expect(asAlly("PARTY").has(unitId), `${unitId} as party ally`).toBe(true);
      expect(asEnemy.has(unitId), `${unitId} as party enemy`).toBe(true);
    }
  });

  it.each(SCENARIOS.map((scenario) => [scenario.scenarioId, scenario] as const))(
    "E2E-STAGEG-001: %s holds the battle invariants, restores finalState from initialState + StateDeltas, and never defeats a unit twice",
    (scenarioId) => {
      const summary = summaries.get(scenarioId)!;
      expect(summary.invariantViolation).toBeUndefined();
      expect(summary.reconstructed).toBe(true);
      expect(summary.defeatedMoreThanOnce).toEqual([]);
      expect(summary.defeatedButAlive).toEqual([]);
      expect(summary.completedTurn).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(DETERMINISM_SCENARIOS.map((scenario) => [scenario.scenarioId, scenario] as const))(
    "E2E-STAGEG-002: %s reproduces the identical event sequence, StateDeltas and final state for the same (seed, runIndex)",
    (scenarioId, scenario) => {
      expect(fingerprintOf(runStageGScenario(CATALOG_DIR, scenario))).toBe(
        summaries.get(scenarioId)!.fingerprint,
      );
    },
    120_000,
  );

  it("E2E-STAGEG-003: different runIndex values reach different battles, so the reproduction above is not vacuous", () => {
    const fingerprints = SCENARIOS.filter((scenario) => scenario.kind === "EXERCISE").map(
      (scenario) => summaries.get(scenario.scenarioId)!.fingerprint,
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it.each(REVIEWED_UNIT_IDS.map((unitId) => [unitId] as const))(
    "E2E-STAGEG-004: %s fires every one of its Active, Passive and EX skills somewhere in the sweep",
    (unitId) => {
      const fired = new Set(
        SCENARIOS.filter((scenario) => scenarioUnitIds(scenario).includes(unitId)).flatMap(
          (scenario) => [...summaries.get(scenario.scenarioId)!.firedSkillIds],
        ),
      );
      const skills = unitSkills.get(unitId)!;
      expect(skills).toHaveLength(5);
      expect(skills.filter((skillId) => !fired.has(skillId))).toEqual([]);
    },
  );
});
