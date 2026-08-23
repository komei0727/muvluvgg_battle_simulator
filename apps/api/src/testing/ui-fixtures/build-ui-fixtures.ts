import type { FastifyInstance } from "fastify";
import {
  buildServer,
  type SimulateBattleUseCasePort,
} from "../../presentation/http/build-server.js";
import {
  buildGearEffects,
  gearEffectsFingerprint,
} from "../../application/catalog/gear-effect-catalog.js";
import type { BattleSimulationCatalogResult } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { SimulationCapacityExceededError } from "../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { ManualClock } from "../clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../random/sequence-random-source-factory.js";
import { CatalogBuilder } from "../scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  unitDefinition,
} from "../scenario/definition-builders.js";

/**
 * `docs/ui-design/06_UIテスト戦略.md`§5が名指す7ファイル。生成器の出力キーは
 * 常にこの一覧と一致する（`build-ui-fixtures.test.ts`が突き合わせる）。
 */
export const UI_FIXTURE_FILENAMES = [
  "m4.5-catalog.json",
  "m4-success-minimal.json",
  "m4-success-duplicate-definition.json",
  "success-unknown-event.json",
  "error-invalid-command.json",
  "error-capacity.json",
  "malformed-success.json",
] as const;

export type UiFixtureFilename = (typeof UI_FIXTURE_FILENAMES)[number];

/**
 * `build-server.test.ts` / `openapi-test-use-case.ts`と同じ薄いdirect adapter。
 * Worker Pool越しの実行を、同じ変換（`toSimulateBattleCommand`）をメインスレッド内で
 * 直接呼ぶ形へ差し替える——契約fixtureはHTTPシリアライズだけを実サーバー経由で
 * 得たいのであって、Workerスレッド境界そのものを検証対象にしないため。
 */
function toDirectExecutor(useCase: SimulateBattleUseCase): SimulateBattleUseCasePort {
  return {
    execute: (request, context: SimulationExecutionContext) =>
      Promise.resolve(useCase.execute(toSimulateBattleCommand(request), context)),
  };
}

const STRIKER_SKILL_ID = "SKL_UI_FIXTURE_STRIKE";
const STRIKER_EFFECT_ACTION_ID = "ACT_UI_FIXTURE_STRIKE";

/**
 * 1体で敵を確実に1ターン目で撃破できる最小Catalog。attack(1000) - defense(10)の
 * 大きな差分で威力計算の詳細を気にせず必殺化し（`R-DMG-01`）、`guaranteedHit`と
 * `criticalMode: "PREVENTED"`で命中・会心の乱数消費を無くす。敵は
 * `activeSkillDefinitionIds: []`のため常にWAITし、行動順の乱数だけが残る
 * ——`randomValues`に十分な定数バッファを積んで賄う。
 */
function buildFixtureCatalog() {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_UI_FIXTURE_ALLY", {
        baseStats: { attack: 1000 },
        activeSkillDefinitionIds: [createSkillDefinitionId(STRIKER_SKILL_ID)],
      }),
      unitDefinition("UNIT_UI_FIXTURE_ENEMY"),
    )
    .withSkill(attackSkill(STRIKER_SKILL_ID, STRIKER_EFFECT_ACTION_ID, { guaranteedHit: true }))
    .withEffectAction(damageEffectAction(STRIKER_EFFECT_ACTION_ID, 1, "PREVENTED"))
    .build();
}

function buildFixtureUseCase(battleId: string): SimulateBattleUseCasePort {
  return toDirectExecutor(
    new SimulateBattleUseCase({
      battleCatalog: buildFixtureCatalog(),
      battleIdGenerator: new FixedBattleIdGenerator([battleId]),
      randomSourceFactory: new SequenceRandomSourceFactory(Array.from({ length: 10 }, () => 0.99)),
      clock: new ManualClock(0),
    }),
  );
}

function unitSlot(unitDefinitionId: string, column: 0 | 1 | 2, row: "FRONT" | "REAR" = "FRONT") {
  return { unitDefinitionId, position: { column, row } };
}

async function postBattleSimulation(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/battle-simulations",
    payload,
  });
  return response.json<Record<string, unknown>>();
}

async function buildMinimalSuccessFixture(): Promise<Record<string, unknown>> {
  const app = await buildServer(buildFixtureUseCase("B_UI_FIXTURE_MINIMAL"));
  try {
    return await postBattleSimulation(app, {
      allyFormation: {
        units: [unitSlot("UNIT_UI_FIXTURE_ALLY", 0)],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        units: [unitSlot("UNIT_UI_FIXTURE_ENEMY", 0)],
        memoryDefinitionIds: [],
      },
      turnLimit: 3,
      // 既定はSUMMARY（finalState/events/stateTransitionsを返さない）。契約
      // fixtureはevents/stateTransitionsを含む完全な形が要るためDETAILEDを明示する。
      options: { logLevel: "DETAILED" },
    });
  } finally {
    await app.close();
  }
}

async function buildDuplicateDefinitionSuccessFixture(): Promise<Record<string, unknown>> {
  const app = await buildServer(buildFixtureUseCase("B_UI_FIXTURE_DUPLICATE"));
  try {
    return await postBattleSimulation(app, {
      allyFormation: {
        units: [unitSlot("UNIT_UI_FIXTURE_ALLY", 0), unitSlot("UNIT_UI_FIXTURE_ALLY", 1)],
        memoryDefinitionIds: [],
      },
      enemyFormation: {
        units: [unitSlot("UNIT_UI_FIXTURE_ENEMY", 0)],
        memoryDefinitionIds: [],
      },
      turnLimit: 3,
      options: { logLevel: "DETAILED" },
    });
  } finally {
    await app.close();
  }
}

/**
 * 実装は未知のevent typeを絶対に発行しない（発行し得るなら既知のはずである）ため、
 * 「未知typeへUIが耐える」ことを検証するfixtureは実サーバーからは作れない。
 * 実際に生成した成功レスポンスへ、末尾へ1件だけ未知typeのeventを追記する
 * ——他の全フィールドは実生成のまま、この1点だけが意図的な合成である
 * （`apps/ui/e2e/fixtures/battle-success.ts`の`MYSTERIOUS_FUTURE_EVENT`と同じ方針）。
 */
function appendUnknownEvent(success: Record<string, unknown>): Record<string, unknown> {
  const events = success["events"] as Array<Record<string, unknown>>;
  const lastEvent = events[events.length - 1];
  const nextSequence = typeof lastEvent?.["sequence"] === "number" ? lastEvent["sequence"] + 1 : 1;
  return {
    ...success,
    events: [
      ...events,
      {
        sequence: nextSequence,
        type: "UI_FIXTURE_FUTURE_EVENT",
        turnNumber:
          success["result"] && (success["result"] as Record<string, unknown>)["completedTurn"],
        cycleNumber: 1,
        stateVersionAfter: lastEvent?.["stateVersionAfter"],
        details: {
          note: "REF-053: synthetic — no real event type is ever unknown to its own server",
        },
      },
    ],
  };
}

/**
 * `unitSummaries`はUIの`response-validator`が必須とする集計配列（
 * `docs/ddd/10_API設計.md`「UnitBattleSummaryResponse」）。実サーバーは常にこれを
 * 返すため、契約違反の200を再現するにはやはり実生成レスポンスからの意図的な
 * 欠落しか作りようがない。
 */
function dropUnitSummaries(success: Record<string, unknown>): Record<string, unknown> {
  const { unitSummaries: _dropped, ...withoutUnitSummaries } = success;
  return withoutUnitSummaries;
}

async function buildInvalidCommandErrorFixture(): Promise<Record<string, unknown>> {
  const app = await buildServer(buildFixtureUseCase("B_UI_FIXTURE_UNUSED"));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [unitSlot("UNIT_UI_FIXTURE_ALLY", 0)],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [unitSlot("UNIT_UI_FIXTURE_ENEMY", 0)],
          memoryDefinitionIds: [],
        },
        // API-CONTRACT-009: JSON Schemaではなくコマンド検証で拒否される値域外。
        turnLimit: 0,
      },
    });
    return response.json<Record<string, unknown>>();
  } finally {
    await app.close();
  }
}

async function buildCapacityErrorFixture(): Promise<Record<string, unknown>> {
  // API-CONTRACT-021: 容量超過はUseCase自体を実行しないため、Worker Pool不足を
  // 表す最小のstub UseCaseで足りる（実装済みの契約テストと同じ形）。
  const app = await buildServer({
    execute: () => {
      throw new SimulationCapacityExceededError();
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/battle-simulations",
      payload: {
        allyFormation: {
          units: [unitSlot("UNIT_UI_FIXTURE_ALLY", 0)],
          memoryDefinitionIds: [],
        },
        enemyFormation: {
          units: [unitSlot("UNIT_UI_FIXTURE_ENEMY", 0)],
          memoryDefinitionIds: [],
        },
        turnLimit: 3,
      },
    });
    return response.json<Record<string, unknown>>();
  } finally {
    await app.close();
  }
}

const UNUSED_BATTLE_USE_CASE: SimulateBattleUseCasePort = {
  execute: () => {
    throw new Error("REF-053 catalog fixture never exercises the battle-simulation use case");
  },
};

function buildCatalogResult(): BattleSimulationCatalogResult {
  const gearEffects = buildGearEffects();
  const catalogRevision = "ui-fixture-catalog-rev-1";
  return {
    catalogRevision,
    gearEffects,
    representationRevision: `${catalogRevision}+gear.${gearEffectsFingerprint(gearEffects)}`,
    units: [
      {
        unitDefinitionId: "UNIT_UI_FIXTURE_ALLY",
        displayName: "UI Fixture Ally",
        characterName: "UI Fixture Ally",
        category: "PLAYABLE",
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT", "BACK"],
      },
      {
        unitDefinitionId: "UNIT_UI_FIXTURE_ENEMY",
        displayName: "UI Fixture Enemy",
        characterName: "UI Fixture Enemy",
        category: "PLAYABLE",
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        role: "PHYSICAL_ATTACKER",
        positionAptitudes: ["FRONT", "BACK"],
      },
      // R-TEX-11 #1/#4: 戦術演習専用ユニットの表現（category/exerciseActive）。
      {
        unitDefinitionId: "UNIT_UI_FIXTURE_EXERCISE",
        displayName: "UI Fixture Exercise Enemy",
        characterName: "UI Fixture Exercise Enemy",
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        attribute: "AGGRESSIVE",
        unitType: "PHYSICAL",
        role: "TANK",
        positionAptitudes: ["FRONT"],
      },
    ],
    memories: [
      {
        memoryDefinitionId: "MEM_UI_FIXTURE",
        displayName: "UI Fixture Memory",
      },
    ],
  } as unknown as BattleSimulationCatalogResult;
}

async function buildCatalogFixture(): Promise<Record<string, unknown>> {
  const app = await buildServer(UNUSED_BATTLE_USE_CASE, {
    catalogUseCase: { execute: () => buildCatalogResult() },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/battle-simulation-catalog" });
    return response.json<Record<string, unknown>>();
  } finally {
    await app.close();
  }
}

/**
 * REF-053 (Issue #598): `apps/ui/src/test/fixtures/*.json`を実際に生成する。
 * `write-ui-fixtures-cli.ts`が書き出し、`check-ui-fixtures-cli.ts`が既存ファイルとの
 * drift（`mise run check-ui-fixtures`）を検査する——`ui:openapi:generate`/
 * `ui:openapi:check`（REF-052）と同じ生成・検査ペアの規約に倣う。
 */
export async function buildUiFixtures(): Promise<Record<UiFixtureFilename, unknown>> {
  const minimalSuccess = await buildMinimalSuccessFixture();

  return {
    "m4.5-catalog.json": await buildCatalogFixture(),
    "m4-success-minimal.json": minimalSuccess,
    "m4-success-duplicate-definition.json": await buildDuplicateDefinitionSuccessFixture(),
    "success-unknown-event.json": appendUnknownEvent(minimalSuccess),
    "error-invalid-command.json": await buildInvalidCommandErrorFixture(),
    "error-capacity.json": await buildCapacityErrorFixture(),
    "malformed-success.json": dropUnitSummaries(minimalSuccess),
  };
}
