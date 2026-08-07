import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import type { CooldownStateResponseBody } from "../../application/contracts/response.js";
import { toBattleSimulationResponseBody } from "../../application/simulation/simulate-battle-response-mapper.js";
import { battleSimulationResponseDocSchema } from "../../presentation/http/schemas/simulation/simulation-schema.js";
import {
  runProductionUnitBattle,
  allProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * REL-004（Issue #203）: `10_API設計.md`「OpenAPIへの反映」の
 * 「イベントdetailsの種別ごとのスキーマ」「API例と実レスポンスの契約一致」を
 * 実`catalog/`の全 selectable Unit で確かめる。
 *
 * 実行時のresponse schemaは`details: {}`（意図的に緩い）で、種別ごとの
 * `additionalProperties: false`は公開文書側の`battleSimulationResponseDocSchema`
 * にしか無い。そのdoc schemaへ実レスポンスを通していたのは
 * `API-OPENAPI-002`（合成Catalogの1戦）と`API-STATE-RESTORE-007`だけで、
 * Memory・PSチェーン・シールド・サブユニット・Marker系のdetailsは
 * 手書きリテラルでしか検証されていなかった。
 *
 * DIAGNOSTICで実行するのは、公開レベルの上限＝発行され得るイベント種別の
 * 全量だから（DETAILEDは`EffectStepSkipped`等を含まない）。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const PRODUCTION_UNIT_IDS = allProductionUnitIds(CATALOG_DIR);

function describeErrors(validate: ValidateFunction): string {
  return JSON.stringify(validate.errors?.slice(0, 5) ?? [], null, 2);
}

describe("published response conforms to the v1 doc schema across the production Catalog (REL-004)", () => {
  it("IT-REL-004-DOC-SCHEMA-001: every selectable production Unit's DIAGNOSTIC response satisfies battleSimulationResponseDocSchema, including the per-event-type details oneOf", () => {
    expect(PRODUCTION_UNIT_IDS.length).toBeGreaterThan(0);
    const validate = new Ajv({ strict: false }).compile(battleSimulationResponseDocSchema);

    const failures: string[] = [];
    const publishedEventTypes = new Set<string>();

    for (const unitDefinitionId of PRODUCTION_UNIT_IDS) {
      let body: ReturnType<typeof toBattleSimulationResponseBody>;
      try {
        body = toBattleSimulationResponseBody(
          runProductionUnitBattle(CATALOG_DIR, unitDefinitionId, {
            turnLimit: 5,
            randomValue: 0.5,
            logLevel: "DIAGNOSTIC",
          }),
        );
      } catch (error) {
        // 例外も失敗として集める。1体目で止まると「他に何体壊れているか」が分からない。
        failures.push(`${unitDefinitionId}: THREW ${(error as Error).message}`);
        continue;
      }
      for (const event of body.events) {
        publishedEventTypes.add(event.type);
      }
      if (!validate(body)) {
        failures.push(`${unitDefinitionId}: ${describeErrors(validate)}`);
      }
    }

    expect(
      failures,
      `units whose published response violates the doc schema:\n${failures.join("\n")}`,
    ).toEqual([]);

    // カバレッジの下限を明示する。1〜2種別しか出ない編成に痩せていたら、
    // 「全 selectable Unit を通した」という主張が実質を失っていることになる。
    expect(publishedEventTypes.size).toBeGreaterThan(20);
  }, 60000);

  it("IT-REL-004-DOC-SCHEMA-002 (R-SKL-04): a cooldown started by a Passive Skill outside any action serializes with no setting scope instead of failing the response mapper", () => {
    // `SKL_LUCIE_MAID_PS1`はターン境界のトップレベルイベントから発動するため、
    // `unit: "ACTION"`でありながら設定scope（`setActionId`）を持たない
    // （`cooldown-state.ts`の`startCooldown`、`scope === undefined`）。
    // Response Mapperがこれを不変条件違反として落としていたので、実HTTP経路は
    // `500 INTERNAL_INVARIANT_VIOLATION`を返していた。
    const body = toBattleSimulationResponseBody(
      runProductionUnitBattle(CATALOG_DIR, "UNIT_LUCIE_MAID", {
        turnLimit: 5,
        randomValue: 0.5,
        logLevel: "DIAGNOSTIC",
      }),
    );

    const addedCooldowns = body.stateTransitions
      .flatMap((transition) => Object.values(transition.delta.units ?? {}))
      .flatMap((unit) => unit.cooldowns?.added ?? [])
      .map((cooldown) => cooldown as CooldownStateResponseBody);
    const scopeless = addedCooldowns.filter(
      (cooldown) => cooldown.unit === "ACTION" && cooldown.setAtActionId === undefined,
    );

    // このUnitが該当状態を作らなくなったら、テストは意味を失ったことを申告する。
    expect(
      scopeless.length,
      `UNIT_LUCIE_MAID no longer produces a scope-less cooldown: ${JSON.stringify(addedCooldowns)}`,
    ).toBeGreaterThan(0);
    for (const cooldown of scopeless) {
      expect(cooldown.setAtTurnNumber).toBeUndefined();
      expect(cooldown.remaining).toBeGreaterThan(0);
    }

    const validate = new Ajv({ strict: false }).compile(battleSimulationResponseDocSchema);
    expect(validate(body), describeErrors(validate)).toBe(true);
  });
});
