import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { createBattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * RES-003A（Issue #257、G-10）: `FormulaDefinition`の`sourceResult: SUM_DAMAGE_DEALT`
 * （同一`EffectSequence`実行中の累計与ダメージ）を、実production Catalogの定義と
 * 実ライフサイクル（`resolveSkillUse`→`resolveEffectSequencePlan`→
 * `damage-application-service.ts`／`heal-application-service.ts`）で検証する。
 *
 * 検証対象は`14_Catalog定義スキーマ.md`がG-10の代表例として挙げる
 * `SKL_FLUTE_VAMPIRE_EX`「＃ぽよ・オア・トリート」— 列攻撃と条件付き追撃の
 * **合計**与ダメージの60%を自己回復する。`LAST_DAMAGE_DEALT`近似では追撃分
 * （最後の1件）しか回復できないため、両者の差がそのまま本Issueの回帰ガードになる。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const FLUTE_UNIT_ID = "UNIT_FLUTE_VAMPIRE";
const EX_SKILL_ID = "SKL_FLUTE_VAMPIRE_EX";
const SELF_HEAL_ID = "ACT_FLUTE_VAMPIRE_EX_SELF_HEAL";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function member(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
  overrides: { maximumHp?: number; attack?: number } = {},
): BattlePartyMember {
  return {
    battleUnitId: createBattleUnitId(battleUnitId),
    unitDefinitionId: unitDefinitionId as never,
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 5000,
      attack: overrides.attack ?? 100,
      defense: 0,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
}

function testUnitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 5000,
      attack: 100,
      defense: 0,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: `CHAR_${id}`,
      affiliations: [],
      tags: [],
    },
  };
}

function definitionsWith(
  snapshot: ReturnType<ReturnType<typeof loadCatalogFromDirectory>["loadSnapshot"]>,
  extraUnitDefinitionIds: readonly string[],
): BattleDefinitions {
  const unitDefinitions = new Map(snapshot.units);
  for (const id of extraUnitDefinitionIds) {
    unitDefinitions.set(createUnitDefinitionId(id), testUnitDefinition(id));
  }
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: new Map(snapshot.effectActions),
    unitDefinitions,
    skillDefinitions: new Map(snapshot.skills),
  };
}

const ENEMY_UNIT_ID = "UNIT_TEST_SUM_DAMAGE_ENEMY";

function runFluteEx(): {
  readonly damages: readonly number[];
  readonly heal: Extract<BattleDomainEvent, { eventType: "HealApplied" }>;
  readonly fluteHpAfter: number;
} {
  const catalog = loadCatalogFromDirectory(CATALOG_DIR);
  const snapshot = catalog.loadSnapshot([FLUTE_UNIT_ID as never], []);
  const skill = snapshot.skills.get(createSkillDefinitionId(EX_SKILL_ID))!;

  const flute = {
    ...createBattleUnit(
      member("ally:flute", FLUTE_UNIT_ID, "ALLY", { column: "LEFT", row: "FRONT" }),
      "ALLY",
      LIMITS,
    ),
    currentExtraGauge: LIMITS.maximumExtraGauge,
    currentHp: 100,
  };
  // 同一列の敵2体（`TGT_COLUMN`が`SAME_COLUMN_AS_BASE`で解決する）。
  const frontEnemy = createBattleUnit(
    member("enemy:front", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "FRONT" }),
    "ENEMY",
    LIMITS,
  );
  const backEnemy = createBattleUnit(
    member("enemy:back", ENEMY_UNIT_ID, "ENEMY", { column: "LEFT", row: "BACK" }),
    "ENEMY",
    LIMITS,
  );
  const recorder = new EventRecorder(createBattleId("B_1"));

  const result = resolveSkillUse(
    flute,
    skill,
    "EX",
    "EX",
    [flute, frontEnemy, backEnemy],
    definitionsWith(snapshot, [ENEMY_UNIT_ID]),
    // 会心判定（`critical.mode: NORMAL`）の抽選分。criticalRateは0なので
    // どの値でも非会心に決まるが、消費自体は決定的に用意しておく。
    new SequenceRandomSource([0, 0, 0, 0, 0, 0]),
    recorder,
    1,
    0,
    createActionId("B_1:action:1"),
    recorder.nextResolutionScopeId(),
  );

  const damages = recorder
    .getEvents()
    .filter((event) => event.eventType === "DamageApplied")
    .map((event) => event.payload.calculatedDamage);
  const heal = recorder.getEvents().find((event) => event.eventType === "HealApplied") as Extract<
    BattleDomainEvent,
    { eventType: "HealApplied" }
  >;
  return {
    damages,
    heal,
    fluteHpAfter: result.units.find((u) => u.battleUnitId === flute.battleUnitId)!.currentHp,
  };
}

describe("production Catalog SUM_DAMAGE_DEALT (RES-003A, Issue #257, G-10)", () => {
  it("IT-CAP-SUM-DAMAGE-PROD-001: the real ACT_FLUTE_VAMPIRE_EX_SELF_HEAL declares DAMAGE_DEALT_RATIO(SUM_DAMAGE_DEALT, 0.6) and the capability that now covers it", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const snapshot = catalog.loadSnapshot([FLUTE_UNIT_ID as never], []);
    const heal = snapshot.effectActions.get(createEffectActionDefinitionId(SELF_HEAL_ID))!;

    expect(heal).toMatchObject({
      kind: "HEAL",
      payload: {
        formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 0.6 },
      },
    });
    expect(heal.requiredCapabilities).toContain("CAP_SUM_DAMAGE_RESULT");
  });

  it("IT-CAP-SUM-DAMAGE-PROD-002 (real lifecycle wiring): SKL_FLUTE_VAMPIRE_EX heals 60% of the column attack AND the conditional follow-up combined, not 60% of the follow-up alone", () => {
    const { damages, heal, fluteHpAfter } = runFluteEx();

    // 列攻撃（同一列の敵2体）＋ 条件付き追撃（TGT_BASE生存）で3件のDAMAGE結果。
    expect(damages).toEqual([101, 101, 46]);
    const total = 101 + 101 + 46;

    expect(heal.payload).toMatchObject({
      effectActionDefinitionId: SELF_HEAL_ID,
      formulaResult: total * 0.6,
      healAmount: Math.floor(total * 0.6),
      appliedAmount: Math.floor(total * 0.6),
    });
    expect(fluteHpAfter).toBe(100 + Math.floor(total * 0.6));
    // 回帰ガード: `LAST_DAMAGE_DEALT`近似なら追撃分46の60%しか回復しない。
    expect(heal.payload.formulaResult).toBeGreaterThan(damages.at(-1)! * 0.6);
  });
});
