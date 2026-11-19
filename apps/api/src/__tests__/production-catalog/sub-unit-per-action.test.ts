import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, noMissNoCrit } from "../../testing/fixtures/index.js";
import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { SUBUNIT_PROVIDER_ATTACK_KEY } from "../../domain/battle/model/applied-effect.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { createRuntimeCounterId } from "../../domain/catalog/definitions/catalog-ids.js";
import { openPassiveChain } from "../../testing/production-unit/passive-activation.js";
import { skillUseCompleted } from "../../testing/production-unit/trigger-events.js";
import {
  PRODUCTION_CATALOG_DIR,
  SUBJECT_ID,
  observeSkillUse,
  productionBoard,
  type BoardOverrides,
  type ObserveSkillUseOptions,
  type PrecedingAction,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * Issue #836（FIX-12）: サブユニットの追加ダメージは攻撃1回（1スキル使用）につき、
 * 元攻撃の対象ごとに所持サブユニット1体あたり1ヒットだけ加わる。同じ対象が同じ
 * スキル使用の複数DAMAGEに現れても、その数だけ増やさない（R-SUB-02）。
 *
 * 追加ダメージ量そのものは他のテストが固定しているため、ここでは「サブユニットを
 * 持つ場合と持たない場合の被ダメージ差」で追加ヒットの回数だけを測る。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_LYDIA_SUMMER",
  "UNIT_LILY_HERO",
  "UNIT_YIFEI_STORM",
  "UNIT_OLGA_VETERAN",
]);

/** 「うみのともだちⅢ」1体の追加ダメージ: 付与時攻撃力1000×8.5%（所持者攻撃1000 ≥ 防御500）。 */
const SUBUNIT_III_HIT = 85;
const SUBUNIT_III: PrecedingAction = {
  effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
  target: "SELF",
};

function hpDeltasWithAndWithout(
  options: Omit<ObserveSkillUseOptions, "snapshot" | "precedingActions">,
  bodies: number,
): {
  readonly with: Readonly<Record<string, number>>;
  readonly without: Readonly<Record<string, number>>;
} {
  const without = observeSkillUse({ snapshot, ...options }).hpDeltas ?? {};
  const withSubUnits =
    observeSkillUse({
      snapshot,
      ...options,
      precedingActions: Array.from({ length: bodies }, () => SUBUNIT_III),
    }).hpDeltas ?? {};
  return { with: withSubUnits, without };
}

/** 基準（前列中央）と左右に敵がいる盤面。 */
const THREE_FRONT: BoardOverrides = {
  enemies: [
    { id: "enemy:center", position: { column: "CENTER", row: "FRONT" } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:right", position: { column: "RIGHT", row: "FRONT" } },
  ],
};

describe("FIX-12 サブユニット追加は元対象ごとに1行動1ヒット（R-SUB-02）", () => {
  it("IT-CAT-SUBACT-001 [R-SUB-02] (SR-354/356): 同じ対象への2つのDAMAGE（亦菲EX）でも、各体の追加は1回だけ", () => {
    const deltas = hpDeltasWithAndWithout(
      {
        unitDefinitionId: "UNIT_YIFEI_STORM",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_YIFEI_STORM_EX" },
        board: { enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }] },
      },
      2,
    );
    expect((deltas.with["enemy:center"] ?? 0) - (deltas.without["enemy:center"] ?? 0)).toBe(
      -2 * SUBUNIT_III_HIT,
    );
  });

  it("IT-CAT-SUBACT-002 [R-SUB-02] (SR-356/358): 複数対象×複数DAMAGE×複数体（リリィAS1）でも、対象ごとに各体1回", () => {
    const deltas = hpDeltasWithAndWithout(
      {
        unitDefinitionId: "UNIT_LILY_HERO",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
        board: THREE_FRONT,
      },
      2,
    );
    for (const enemy of ["enemy:center", "enemy:left", "enemy:right"]) {
      expect((deltas.with[enemy] ?? 0) - (deltas.without[enemy] ?? 0)).toBe(-2 * SUBUNIT_III_HIT);
    }
  });

  it("IT-CAT-SUBACT-003 [R-SUB-02]: 単体・1DAMAGE・1体の既存値は維持する", () => {
    const deltas = hpDeltasWithAndWithout(
      {
        unitDefinitionId: "UNIT_LILY_HERO",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS2" },
        board: { enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }] },
      },
      1,
    );
    expect((deltas.with["enemy:center"] ?? 0) - (deltas.without["enemy:center"] ?? 0)).toBe(
      -SUBUNIT_III_HIT,
    );
  });
});

/** production の AS/EX を1回だけ実経路で使い、使用後の盤面を返す。 */
function useActiveSkill(
  unitDefinitionId: string,
  skillDefinitionId: string,
  board?: BoardOverrides,
  units?: readonly BattleUnit[],
): readonly BattleUnit[] {
  const production = productionBoard(snapshot, unitDefinitionId, board);
  const startUnits = units ?? production.units;
  const skill = snapshot.skills.get(createSkillDefinitionId(skillDefinitionId));
  if (skill === undefined) {
    throw new Error(`missing ${skillDefinitionId}`);
  }
  const actionType = skill.skillType === "EX" ? "EX" : "AS";
  const recorder = new EventRecorder(createBattleId("B_SUBACT"));
  return resolveSkillUse(
    unitOf(startUnits, SUBJECT_ID),
    skill,
    actionType,
    actionType,
    startUnits,
    production.definitions,
    noMissNoCrit(),
    recorder,
    1,
    0,
    createActionId("B_SUBACT:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === battleUnitId);
  if (unit === undefined) {
    throw new Error(`missing ${battleUnitId}`);
  }
  return unit;
}

describe("FIX-12 サブユニット付与時の所持者攻撃力低下（SR-369〜371）", () => {
  it("IT-CAT-SUBACT-004 [R-SUB-02] (SR-371): リディアEXは「うみのともだちⅡ」1体ごとに所持者へ−7.5%を付け、3体後の攻撃力は775。各体は付与時点の攻撃力を個別に保存する", () => {
    const after = unitOf(useActiveSkill("UNIT_LYDIA_SUMMER", "SKL_LYDIA_SUMMER_EX"), SUBJECT_ID);
    expect(after.combatStats.attack).toBe(775);
    const providerAttacks = after.appliedEffects
      .filter((effect) => effect.subUnit !== undefined)
      .map((effect) => effect.snapshot?.[SUBUNIT_PROVIDER_ATTACK_KEY]);
    // 1体目は低下前の1000、2体目は1件目の低下後925、3体目は2件目の低下後850。
    expect(providerAttacks).toEqual([1000, 925, 850]);
  });
});

describe("FIX-12 付与時攻撃力の保存とFIX-05の両立（SR-364）", () => {
  const PS1_COUNTER_AT_THREE: BoardOverrides = {
    subject: {
      state: {
        skillCounters: {
          [createSkillDefinitionId("SKL_OLGA_VETERAN_PS1")]: {
            [createRuntimeCounterId("SKL_OLGA_VETERAN_PS1_TRIGGER_COUNT")]: { value: 3, carry: 0 },
          },
        },
      },
    },
    enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }],
  };

  it("IT-CAT-SUBACT-005 [R-SUB-02] (SR-364): オルガPS1の「カムラッドⅡ」3体は付与時攻撃力1300を保存し、PS終了後の本人攻撃は1000。次の攻撃で各体137ずつ追加する", () => {
    const board = productionBoard(snapshot, "UNIT_OLGA_VETERAN", PS1_COUNTER_AT_THREE);
    const chain = openPassiveChain({ definitions: board.definitions, actorUnitId: SUBJECT_ID });
    const afterPs = chain.fire(
      skillUseCompleted({
        actor: SUBJECT_ID,
        targets: ["enemy:center"],
        skillType: "AS",
        skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
      }),
      board.units,
    );
    const holder = unitOf(afterPs, SUBJECT_ID);
    expect(holder.combatStats.attack).toBe(1000);
    expect(
      holder.appliedEffects
        .filter((effect) => effect.subUnit !== undefined)
        .map((effect) => effect.snapshot?.[SUBUNIT_PROVIDER_ATTACK_KEY]),
    ).toEqual([1300, 1300, 1300]);

    // サブユニットを除いた同じ盤面との被ダメージ差が、追加ヒットだけの量になる。
    const withoutSubUnits = afterPs.map((unit) =>
      unit.battleUnitId === SUBJECT_ID
        ? { ...unit, appliedEffects: unit.appliedEffects.filter((e) => e.subUnit === undefined) }
        : unit,
    );
    const hpAfter = (units: readonly BattleUnit[]) =>
      unitOf(
        useActiveSkill("UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS1", PS1_COUNTER_AT_THREE, units),
        "enemy:center",
      ).currentHp;
    // 1300×10.6%＝137.8 → 137（所持者攻撃1000 ≥ 防御500）。3体で各1回。
    expect(hpAfter(afterPs) - hpAfter(withoutSubUnits)).toBe(-3 * 137);
  });
});
