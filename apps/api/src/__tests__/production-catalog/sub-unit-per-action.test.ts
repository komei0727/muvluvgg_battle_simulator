import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, noMissNoCrit } from "../../testing/fixtures/index.js";
import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { SUBUNIT_PROVIDER_ATTACK_KEY } from "../../domain/battle/model/applied-effect.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../domain/battle/model/applied-effect.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { createEffectInstanceId } from "../../domain/shared/event-ids.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { applyPrecedingActions } from "../../testing/production-unit/skill-behaviour.js";
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
  "UNIT_MIRIAM_MAGE",
  "UNIT_SHIRANA_SORA",
  "UNIT_EVIE_ECO",
  "UNIT_NADYA_SUCCESSOR",
  "UNIT_MERU_BESIDE",
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

/** 会心率50%の盤面で、サブユニット1体（Ⅲ）を持つ使用者がスキルを1回使ったイベント列。 */
function eventsOfSkillUseWithSubUnit(
  unitDefinitionId: string,
  skillDefinitionId: string,
  criticalDraws: readonly number[],
  options: {
    readonly enemies?: BoardOverrides["enemies"];
    readonly preceding?: readonly PrecedingAction[];
    readonly prepare?: (units: readonly BattleUnit[]) => readonly BattleUnit[];
  } = {},
): readonly BattleDomainEvent[] {
  const board = productionBoard(snapshot, unitDefinitionId, {
    combatStats: { criticalRate: 0.5 },
    enemies: options.enemies ?? [
      { id: "enemy:center", position: { column: "CENTER", row: "FRONT" } },
    ],
  });
  const prepared = applyPrecedingActions(board, [SUBUNIT_III, ...(options.preceding ?? [])]);
  const units = options.prepare === undefined ? prepared : options.prepare(prepared);
  const skill = snapshot.skills.get(createSkillDefinitionId(skillDefinitionId));
  if (skill === undefined) {
    throw new Error(`missing ${skillDefinitionId}`);
  }
  const actionType = skill.skillType === "EX" ? "EX" : "AS";
  const recorder = new EventRecorder(createBattleId("B_SUBACT_CRIT"));
  const random = new SequenceRandomSource(criticalDraws);
  resolveSkillUse(
    unitOf(units, SUBJECT_ID),
    skill,
    actionType,
    actionType,
    units,
    board.definitions,
    random,
    recorder,
    1,
    0,
    createActionId("B_SUBACT_CRIT:action:1"),
    recorder.nextResolutionScopeId(),
  );
  // 抽選は元攻撃の各ヒットの会心判定だけで、追加ヒットは乱数を使わない。
  expect(random.consumedValues).toHaveLength(criticalDraws.length);
  return recorder.getEvents();
}

function damageCalculations(events: readonly BattleDomainEvent[]) {
  return events.flatMap((event) => (event.eventType === "DamageCalculated" ? [event.payload] : []));
}

describe("FIX-12 追加ヒットの会心はスキル使用全体の対象別会心を継承する（R-SUB-02）", () => {
  it("IT-CAT-SUBACT-006 [R-SUB-02]: 亦菲EXで後続のDAMAGEだけが会心でも、追加ヒットは会心（1000×8.5%×1.5＝127）になり、最後のDAMAGEの後に1回だけ解決する", () => {
    const calculations = damageCalculations(
      eventsOfSkillUseWithSubUnit("UNIT_YIFEI_STORM", "SKL_YIFEI_STORM_EX", [
        ...new Array<number>(7).fill(0.99),
        0.1,
      ]),
    );
    expect(calculations.map((payload) => payload.effectActionDefinitionId)).toEqual([
      ...new Array<string>(7).fill("ACT_YIFEI_STORM_EX_DAMAGE_MULTI"),
      "ACT_YIFEI_STORM_EX_DAMAGE_FINISH",
      "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
    ]);
    expect(calculations[7]!.criticalMultiplier).toBe(1.5);
    expect(calculations[8]!.criticalMultiplier).toBe(1.5);
    expect(calculations[8]!.finalDamage).toBe(127);
  });

  it("IT-CAT-SUBACT-007 [R-SUB-02]: 亦菲EXで最初のヒットだけが会心でも追加ヒットは会心、どのヒットも非会心なら非会心（85）", () => {
    const firstOnly = damageCalculations(
      eventsOfSkillUseWithSubUnit("UNIT_YIFEI_STORM", "SKL_YIFEI_STORM_EX", [
        0.1,
        ...new Array<number>(7).fill(0.99),
      ]),
    );
    expect(firstOnly.at(-1)!.finalDamage).toBe(127);
    const none = damageCalculations(
      eventsOfSkillUseWithSubUnit(
        "UNIT_YIFEI_STORM",
        "SKL_YIFEI_STORM_EX",
        new Array<number>(8).fill(0.99),
      ),
    );
    expect(none.at(-1)!.finalDamage).toBe(85);
  });

  it("IT-CAT-SUBACT-008 [R-SUB-02]: ミリアムAS1で別stepの後続DAMAGEだけが会心でも追加ヒットは会心になり、後続DAMAGEの後に解決する", () => {
    const calculations = damageCalculations(
      eventsOfSkillUseWithSubUnit("UNIT_MIRIAM_MAGE", "SKL_MIRIAM_MAGE_AS1", [0.99, 0.1]),
    );
    expect(calculations.map((payload) => payload.effectActionDefinitionId)).toEqual([
      "ACT_MIRIAM_MAGE_AS1_DAMAGE",
      "ACT_MIRIAM_MAGE_AS1_DAMAGE_EXTRA",
      "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
    ]);
    expect(calculations[2]!.finalDamage).toBe(127);
  });

  it("IT-CAT-SUBACT-009 [R-SUB-02]: オルガAS2の追加ヒットは、DAMAGEの後・DAMAGEを含まない吸収stepより前に解決する", () => {
    const events = eventsOfSkillUseWithSubUnit("UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS2", [0.99]);
    const subUnitHit = events.findIndex(
      (event) =>
        event.eventType === "DamageCalculated" &&
        event.payload.effectActionDefinitionId === "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
    );
    const heal = events.findIndex(
      (event) =>
        event.eventType === "EffectActionStarting" &&
        event.payload.effectActionDefinitionId === "ACT_OLGA_VETERAN_AS2_HEAL",
    );
    expect(subUnitHit).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(subUnitHit);
  });
});

describe("FIX-12 分岐の中のDAMAGEでも追加ヒットは同じ攻撃の中で解決する（R-SUB-02・R-EFF-07）", () => {
  it("IT-CAT-SUBACT-010 [R-SUB-02, R-EFF-07]: 白奈PS1（分岐の腕のDAMAGE）の追加ヒットにも、対象が持つ「次に受けるEN攻撃−75%」が乗る（312→78）", () => {
    const ps1 = (withSubUnit: boolean) =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_SHIRANA_SORA",
        use: {
          kind: "PASSIVE",
          skillDefinitionId: "SKL_SHIRANA_SORA_PS1",
          trigger: skillUseCompleted({
            actor: SUBJECT_ID,
            targets: ["ally:front"],
            skillType: "AS",
          }),
          triggeredBy: SUBJECT_ID,
        },
        board: {
          subject: {
            state: {
              skillCounters: {
                [createSkillDefinitionId("SKL_SHIRANA_SORA_PS1")]: {
                  [createRuntimeCounterId("SKL_SHIRANA_SORA_PS1_TRIGGER_COUNT")]: {
                    value: 1,
                    carry: 0,
                  },
                },
              },
            },
          },
          enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }],
        },
        precedingActions: [
          { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS2_GUARD", target: "ENEMY" },
          ...(withSubUnit
            ? [{ effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_SUBUNIT", target: "SELF" as const }]
            : []),
        ],
      }).hpDeltas?.["enemy:front"] ?? 0;
    // 子機Ⅱの追加ダメージ1000×31.2%＝312に、同じ攻撃で消費されたガード（EN−75%）が乗る。
    expect(ps1(true) - ps1(false)).toBe(-78);
  });
});

/** 使用者の攻撃を`covererUnitId`が全量肩代わりする状態（R-INT-02）。 */
function coveredBy(covererUnitId: string) {
  return (units: readonly BattleUnit[]): readonly BattleUnit[] => {
    const coverDefinitionId = createEffectActionDefinitionId("ACT_TEST_COVER");
    const cover: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("TEST_COVER"),
      effectActionDefinitionId: coverDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(coverDefinitionId),
      duplicate: true,
      sourceUnitId: createBattleUnitId(covererUnitId),
      targetUnitId: createBattleUnitId(SUBJECT_ID),
      magnitude: 0,
      categories: ["DEBUFF"],
      cover: {
        covererUnitId: createBattleUnitId(covererUnitId),
        damageShareRate: 1,
        guardRate: 0,
        actionKinds: ["DAMAGE"],
      },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    return units.map((unit) =>
      unit.battleUnitId === SUBJECT_ID
        ? { ...unit, appliedEffects: [...unit.appliedEffects, cover] }
        : unit,
    );
  };
}

describe("FIX-12 肩代わり・後続stepでも追加ヒットは元攻撃の一部として解決する（R-SUB-02・R-INT-02・R-EFF-07）", () => {
  it("IT-CAT-SUBACT-011 [R-SUB-02, R-INT-02]: リディアAS2の全ヒットを後列中央が肩代わりし、最後のヒットだけが会心なら、肩代わり役への追加ヒットは全ヒットの後に1回だけ会心（127）", () => {
    const calculations = damageCalculations(
      eventsOfSkillUseWithSubUnit("UNIT_LYDIA_SUMMER", "SKL_LYDIA_SUMMER_AS2", [0.9, 0.9, 0.1], {
        enemies: [
          { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
          { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
          { id: "enemy:right", position: { column: "RIGHT", row: "FRONT" } },
        ],
        prepare: coveredBy("enemy:back"),
      }),
    );
    expect(
      calculations.map((payload) => [payload.effectActionDefinitionId, payload.targetUnitId]),
    ).toEqual([
      ["ACT_LYDIA_SUMMER_AS2_DAMAGE_CENTER", "enemy:back"],
      ["ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS", "enemy:back"],
      ["ACT_LYDIA_SUMMER_AS2_DAMAGE_OTHERS", "enemy:back"],
      ["ACT_LYDIA_SUMMER_PS2_SUBUNIT", "enemy:back"],
    ]);
    expect(calculations[3]!.finalDamage).toBe(127);
  });

  it("IT-CAT-SUBACT-012 [R-SUB-02, R-EFF-07]: オルガAS1（後続の分岐が不成立）の追加ヒットにも、元攻撃で消費された対象の「次に受けるEN攻撃−75%」が乗る（312→78）", () => {
    const as1 = (withSubUnit: boolean) =>
      observeSkillUse({
        snapshot,
        unitDefinitionId: "UNIT_OLGA_VETERAN",
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
        board: {
          enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }],
        },
        precedingActions: [
          { effectActionDefinitionId: "ACT_SHIRANA_SORA_PS2_GUARD", target: "ENEMY" },
          ...(withSubUnit
            ? [{ effectActionDefinitionId: "ACT_SHIRANA_SORA_EX_SUBUNIT", target: "SELF" as const }]
            : []),
        ],
      }).hpDeltas?.["enemy:center"] ?? 0;
    expect(as1(true) - as1(false)).toBe(-78);
  });
});

describe("FIX-12 追加ヒットにはその対象を攻撃した攻撃の消費済み効果だけが乗る（R-SUB-02・R-EFF-07）", () => {
  it("IT-CAT-SUBACT-013 [R-SUB-02, R-EFF-07]: リディアAS2で中央への攻撃が使い切った「次の攻撃の与ダメージ−60%」は中央への追加ヒット（34）にだけ乗り、別の攻撃を受けた左右への追加ヒットは85のまま", () => {
    const calculations = damageCalculations(
      eventsOfSkillUseWithSubUnit(
        "UNIT_LYDIA_SUMMER",
        "SKL_LYDIA_SUMMER_AS2",
        new Array<number>(3).fill(0.99),
        {
          enemies: [
            { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
            { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
            { id: "enemy:right", position: { column: "RIGHT", row: "FRONT" } },
          ],
          preceding: [{ effectActionDefinitionId: "ACT_EVIE_ECO_AS1_DEBUFF", target: "SELF" }],
        },
      ),
    );
    const additions = calculations
      .filter((payload) => payload.effectActionDefinitionId === "ACT_LYDIA_SUMMER_PS2_SUBUNIT")
      .map((payload) => [payload.targetUnitId, payload.finalDamage]);
    expect(additions).toEqual([
      ["enemy:back", 34],
      ["enemy:left", 85],
      ["enemy:right", 85],
    ]);
  });
});

/**
 * 段階G（Issue #840）: 要修正のうちサブユニットを付与する12評価行すべてについて、付与される
 * 実サブユニット定義ごとに「対象ごと・1体ごとに1行動1ヒット」を確かめる。リリィAS1は基準＋
 * 隣接の複数対象へ複数のDAMAGEを撃ち、AS2は単体へ1回だけ撃つ。追加ヒット1回分の量は
 * 対象ごとに同じため、AS1の各対象への追加がAS2の1回分と一致すれば、DAMAGEの数だけ
 * 増えていないことになる。
 */
const SUB_UNIT_ROWS = [
  ["SR-354", "UNIT_NADYA_SUCCESSOR", "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT"],
  ["SR-355", "UNIT_NADYA_SUCCESSOR", "ACT_NADYA_SUCCESSOR_PS1_SUBUNIT"],
  ["SR-356", "UNIT_NADYA_SUCCESSOR", "ACT_NADYA_SUCCESSOR_PS2_SUBUNIT"],
  ["SR-358", "UNIT_NADYA_SUCCESSOR", "ACT_NADYA_SUCCESSOR_EX_SUBUNIT"],
  ["SR-364", "UNIT_OLGA_VETERAN", "ACT_OLGA_VETERAN_PS1_SUBUNIT"],
  ["SR-365", "UNIT_OLGA_VETERAN", "ACT_OLGA_VETERAN_PS2_SUBUNIT"],
  ["SR-366", "UNIT_SHIRANA_SORA", "ACT_SHIRANA_SORA_AS1_SUBUNIT"],
  ["SR-368", "UNIT_SHIRANA_SORA", "ACT_SHIRANA_SORA_EX_SUBUNIT"],
  ["SR-369", "UNIT_LYDIA_SUMMER", "ACT_LYDIA_SUMMER_PS1_SUBUNIT"],
  ["SR-370", "UNIT_LYDIA_SUMMER", "ACT_LYDIA_SUMMER_PS2_SUBUNIT"],
  ["SR-371", "UNIT_LYDIA_SUMMER", "ACT_LYDIA_SUMMER_EX_SUBUNIT"],
  ["SR-376", "UNIT_MERU_BESIDE", "ACT_MERU_BESIDE_EX_SUBUNIT"],
] as const;

/**
 * めるEXのサブユニットは耐久をそのスキルの与ダメージ合計から決めるため、前提アクション
 * 単独では耐久を評価できない。追加ヒットの回数・量は耐久と独立なので、耐久だけを定数へ
 * 置き換え、追加ダメージの実定義はそのまま使う。
 */
function withConstantDurability(effectActionDefinitionId: string): typeof snapshot {
  const id = createEffectActionDefinitionId(effectActionDefinitionId);
  const definition = snapshot.effectActions.get(id)!;
  const payload = definition.payload as { readonly durability: unknown };
  return {
    ...snapshot,
    effectActions: new Map(snapshot.effectActions).set(id, {
      ...definition,
      payload: { ...payload, durability: { formula: { kind: "CONSTANT", value: 1000 } } },
    } as typeof definition),
  };
}

const DURABILITY_FROM_SKILL_RESULT = new Set(["ACT_MERU_BESIDE_EX_SUBUNIT"]);

describe("FIX-12 サブユニット付与12評価行の1行動1ヒット（段階G）", () => {
  function extraDamage(
    skillDefinitionId: string,
    subUnit: string,
    bodies: number,
    board: BoardOverrides,
  ): Readonly<Record<string, number>> {
    const observe = (count: number) =>
      observeSkillUse({
        snapshot: DURABILITY_FROM_SKILL_RESULT.has(subUnit)
          ? withConstantDurability(subUnit)
          : snapshot,
        unitDefinitionId: "UNIT_LILY_HERO",
        use: { kind: "ACTIVE", skillDefinitionId },
        board,
        precedingActions: Array.from(
          { length: count },
          (): PrecedingAction => ({ effectActionDefinitionId: subUnit, target: "SELF" }),
        ),
      }).hpDeltas ?? {};
    const without = observe(0);
    const withSubUnits = observe(bodies);
    return Object.fromEntries(
      Object.keys(without).map((unitId) => [
        unitId,
        (withSubUnits[unitId] ?? 0) - (without[unitId] ?? 0),
      ]),
    );
  }

  it.each(SUB_UNIT_ROWS)(
    "IT-CAT-SUBACT-014 [R-SUB-02] (%s): %s の %s は、複数対象×複数DAMAGEの攻撃でも対象ごと・1体ごとに追加1ヒットで、単体1DAMAGEの追加と同じ量になる",
    (_sr, _unitDefinitionId, subUnit) => {
      const single = extraDamage("SKL_LILY_HERO_AS2", subUnit, 1, {
        enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }],
      });
      const perHit = single["enemy:center"]!;
      expect(perHit).toBeLessThan(0);

      const multi = extraDamage("SKL_LILY_HERO_AS1", subUnit, 2, THREE_FRONT);
      for (const enemy of ["enemy:center", "enemy:left", "enemy:right"]) {
        expect(multi[enemy]).toBe(2 * perHit);
      }
    },
  );
});
