import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, noMissNoCrit } from "../../testing/fixtures/index.js";
import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import {
  PRODUCTION_CATALOG_DIR,
  SUBJECT_ID,
  observeSkillUse,
  productionBoard,
  type BoardOverrides,
  type PrecedingAction,
} from "../../testing/production-unit/skill-behaviour.js";

/**
 * Issue #832（FIX-08）: 吸収・反撃・低ダメージ条件は、最後の1ヒットではなく元の攻撃
 * 全体の計算ダメージ（シールド吸収・残HP制限前）の合計で決める（R-SKL-08）。
 *
 * 盤面は攻撃力1000・防御力500・会心0・属性相性なし。クララAS1（威力36.14%×4ヒット）は
 * 1ヒット `(1000-500)×0.3614` の切り捨て180、合計720になる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_CLARA_TSUNDERE",
  "UNIT_KOKORO_SPORTSDAY",
  "UNIT_AOI_GUARDIAN",
  "UNIT_STELLA_STATUE",
  "UNIT_OLGA_VETERAN",
  "UNIT_YUI_HEIR",
  "UNIT_TARISA_TROUBLEMAKER",
  "UNIT_LYDIA_SUMMER",
  "UNIT_FEE_ACTOR",
]);

const ATTACKER_ID = "enemy:attacker";
const CLARA_HIT = 180;

interface SkillUseRun {
  readonly units: readonly BattleUnit[];
  readonly events: readonly BattleDomainEvent[];
}

/** `actorUnitId`のAS/EXを実経路で1回使い、PS連鎖を含む全イベントを返す。 */
function useSkill(
  board: BoardOverrides & { readonly subjectUnitDefinitionId: string },
  actorUnitId: string,
  skillDefinitionId: string,
  random: RandomSource = noMissNoCrit(),
): SkillUseRun {
  const production = productionBoard(snapshot, board.subjectUnitDefinitionId, board);
  const skill = snapshot.skills.get(createSkillDefinitionId(skillDefinitionId));
  if (skill === undefined) {
    throw new Error(`missing ${skillDefinitionId}`);
  }
  const actor = production.units.find((unit) => unit.battleUnitId === actorUnitId);
  if (actor === undefined) {
    throw new Error(`missing ${actorUnitId}`);
  }
  const actionType = skill.skillType === "EX" ? "EX" : "AS";
  const recorder = new EventRecorder(createBattleId("B_ATKSUM"));
  const result = resolveSkillUse(
    actor,
    skill,
    actionType,
    actionType,
    production.units,
    production.definitions,
    random,
    recorder,
    1,
    0,
    createActionId("B_ATKSUM:action:1"),
    recorder.nextResolutionScopeId(),
  );
  return { units: result.units, events: recorder.getEvents() };
}

/**
 * `effectActionDefinitionId`のDAMAGEが計算した量。`baseDamage`は`SKILL_POWER`以外の
 * Formula（反撃の`DAMAGE_RECEIVED_RATIO`等）の評価結果、`finalDamage`はシールド吸収・
 * 残HP制限前の計算ダメージ。
 */
function calculated(
  events: readonly BattleDomainEvent[],
  effectActionDefinitionId: string,
  field: "baseDamage" | "finalDamage",
): number[] {
  return events.flatMap((event) =>
    event.eventType === "DamageCalculated" &&
    event.payload.effectActionDefinitionId === effectActionDefinitionId
      ? [event.payload[field] ?? Number.NaN]
      : [],
  );
}

/** 敵（クララ）が自身（被検ユニット）へAS1を撃つ盤面。 */
function struckByClara(
  subjectUnitDefinitionId: string,
  subject: BoardOverrides["subject"] = {},
): BoardOverrides & { readonly subjectUnitDefinitionId: string } {
  return {
    subjectUnitDefinitionId,
    subject,
    allies: [],
    enemies: [
      {
        id: ATTACKER_ID,
        position: { column: "CENTER", row: "FRONT" },
        unitDefinitionId: "UNIT_CLARA_TSUNDERE",
      },
      { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    ],
  };
}

describe("FIX-08 反撃は元ASで本人が受けた計算ダメージ合計を基準にする（R-SKL-08）", () => {
  it("IT-CAT-ATKSUM-001 [R-SKL-08] (SR-383): ココロPS1の反撃は元AS全体の合計720×120%＝864を基礎にし、最後の180×120%にしない", () => {
    const run = useSkill(
      struckByClara("UNIT_KOKORO_SPORTSDAY", {
        markers: [{ markerId: "MARKER_KOKORO_SPORTSDAY_STOIC" }],
      }),
      ATTACKER_ID,
      "SKL_CLARA_TSUNDERE_AS1",
    );
    expect(calculated(run.events, "ACT_CLARA_TSUNDERE_AS1_DAMAGE", "finalDamage")).toEqual(
      Array.from({ length: 4 }, () => CLARA_HIT),
    );
    // 近い順の敵2体へそれぞれ同じ基礎量で反撃する。
    const counters = calculated(run.events, "ACT_KOKORO_SPORTSDAY_PS1_COUNTER", "baseDamage");
    expect(counters).toHaveLength(2);
    for (const counter of counters) {
      expect(counter).toBeCloseTo(4 * CLARA_HIT * 1.2, 10);
    }
  });

  it("IT-CAT-ATKSUM-002 [R-SKL-08] (SR-236): 葵PS2の反撃は元AS全体の合計720×100%を基礎にする", () => {
    const run = useSkill(struckByClara("UNIT_AOI_GUARDIAN"), ATTACKER_ID, "SKL_CLARA_TSUNDERE_AS1");
    expect(calculated(run.events, "ACT_AOI_GUARDIAN_PS2_COUNTER", "baseDamage")).toEqual([
      4 * CLARA_HIT,
    ]);
  });

  it("IT-CAT-ATKSUM-003 [R-SKL-08] (SR-136): ステラPS2の反撃は元の被攻撃1回の全ヒット合計720×50%＝360を基礎にする", () => {
    const run = useSkill(
      struckByClara("UNIT_STELLA_STATUE"),
      ATTACKER_ID,
      "SKL_CLARA_TSUNDERE_AS1",
    );
    expect(calculated(run.events, "ACT_STELLA_STATUE_PS2_COUNTER", "baseDamage")).toEqual([
      (4 * CLARA_HIT) / 2,
    ]);
  });
});

/** 「うみのともだちⅢ」1体の追加ダメージ: 付与時攻撃力1000×8.5%（所持者攻撃1000 ≥ 防御500）。 */
const SUBUNIT_III_HIT = 85;
const SUBUNIT_III: PrecedingAction = {
  effectActionDefinitionId: "ACT_LYDIA_SUMMER_PS2_SUBUNIT",
  target: "SELF",
};
/** フィーPS1の追撃1ヒット: 所持者攻撃1000・防御500で `(1000-500)×0.2808` の切り捨て140。 */
const FEE_FOLLOW_UP_HIT = 140;
const FEE_FOLLOW_UP: PrecedingAction = {
  effectActionDefinitionId: "ACT_FEE_ACTOR_PS1_FOLLOW_UP",
  target: "SELF",
};
const SINGLE_ENEMY: BoardOverrides = {
  enemies: [{ id: "enemy:center", position: { column: "CENTER", row: "FRONT" } }],
};

/** 自身のAS使用での自己回復量（HP差分）。 */
function selfHeal(
  unitDefinitionId: string,
  skillDefinitionId: string,
  precedingActions: readonly PrecedingAction[] = [],
): number {
  return (
    observeSkillUse({
      snapshot,
      unitDefinitionId,
      use: { kind: "ACTIVE", skillDefinitionId },
      board: SINGLE_ENEMY,
      precedingActions,
    }).hpDeltas?.[SUBJECT_ID] ?? 0
  );
}

describe("FIX-08 吸収は当該攻撃の本体＋所属する追加の計算ダメージ合計を基準にする（R-SKL-08）", () => {
  it("IT-CAT-ATKSUM-004 [R-SKL-08] (SR-408): 唯依AS1は371×3＝1113の30%で333回復し、最後の371から111としない", () => {
    expect(selfHeal("UNIT_YUI_HEIR", "SKL_YUI_HEIR_AS1")).toBe(Math.floor(3 * 371 * 0.3));
  });

  it("IT-CAT-ATKSUM-005 [R-SKL-08] (SR-408): 唯依AS1はサブユニット追加85を含む1198の30%で359回復する", () => {
    expect(selfHeal("UNIT_YUI_HEIR", "SKL_YUI_HEIR_AS1", [SUBUNIT_III])).toBe(
      Math.floor((3 * 371 + SUBUNIT_III_HIT) * 0.3),
    );
  });

  it("IT-CAT-ATKSUM-006 [R-SKL-08] (SR-363): オルガAS2は本体1060＋追加85＝1145の17.5%で200回復し、最後の追加85から14としない", () => {
    expect(selfHeal("UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS2", [SUBUNIT_III])).toBe(
      Math.floor((1060 + SUBUNIT_III_HIT) * 0.175),
    );
  });

  it("IT-CAT-ATKSUM-013 [R-SKL-08] (SR-363): 複数サブユニット（2体）の追加は各1回だけ合計へ入り、1060＋85×2＝1230の17.5%で215回復する", () => {
    expect(selfHeal("UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS2", [SUBUNIT_III, SUBUNIT_III])).toBe(
      Math.floor((1060 + 2 * SUBUNIT_III_HIT) * 0.175),
    );
  });

  it("IT-CAT-ATKSUM-014 [R-SKL-08] [R-FUP-01] (SR-408): 唯依AS1は追撃（フィーPS1、140）を含む1113＋140＝1253の30%で375回復する", () => {
    expect(selfHeal("UNIT_YUI_HEIR", "SKL_YUI_HEIR_AS1", [FEE_FOLLOW_UP])).toBe(
      Math.floor((3 * 371 + FEE_FOLLOW_UP_HIT) * 0.3),
    );
  });

  it("IT-CAT-ATKSUM-015 [R-SKL-08] [R-FUP-01] (SR-363): オルガAS2は追撃（フィーPS1、140）を含む1060＋140＝1200の17.5%で210回復する", () => {
    expect(selfHeal("UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS2", [FEE_FOLLOW_UP])).toBe(
      Math.floor((1060 + FEE_FOLLOW_UP_HIT) * 0.175),
    );
  });
});

const FIGHTING_SPIRIT = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";

/** タリサが「負けん気」5個を持ち、防御力`defense`の敵1体へ`skillDefinitionId`を撃った後の個数。 */
function fightingSpiritAfter(skillDefinitionId: string, defense: number): number {
  const run = useSkill(
    {
      subjectUnitDefinitionId: "UNIT_TARISA_TROUBLEMAKER",
      subject: {
        markers: [{ markerId: FIGHTING_SPIRIT, stackCount: 5 }],
        state: { currentExtraGauge: 10 },
      },
      allies: [],
      enemies: [
        {
          id: "enemy:center",
          position: { column: "CENTER", row: "FRONT" },
          combatStats: { defense },
        },
      ],
    },
    SUBJECT_ID,
    skillDefinitionId,
  );
  const subject = run.units.find((unit) => unit.battleUnitId === SUBJECT_ID);
  return (subject?.markerStates ?? [])
    .filter((marker) => marker.markerId === FIGHTING_SPIRIT)
    .reduce((total, marker) => total + marker.stackCount, 0);
}

describe("FIX-08 「10以下」は当該攻撃スキル全体の計算ダメージ合計で判定する（R-SKL-08）", () => {
  it("IT-CAT-ATKSUM-007 [R-SKL-08] (SR-397): タリサAS1の5×7＝35は合計10を超えるため、＋1だけで3個解除しない", () => {
    // (1000-980)×0.2968＝5.936 → 1ヒット5。旧実装は1ヒット5≦10で解除していた。
    expect(fightingSpiritAfter("SKL_TARISA_TROUBLEMAKER_AS1", 980)).toBe(6);
  });

  it("IT-CAT-ATKSUM-008 [R-SKL-08] (SR-397): タリサAS2の4×3＝12は11以上なので解除しない", () => {
    // (1000-992)×0.546＝4.368 → 1ヒット4。
    expect(fightingSpiritAfter("SKL_TARISA_TROUBLEMAKER_AS2", 992)).toBe(6);
  });

  it("IT-CAT-ATKSUM-009 [R-SKL-08] (SR-397): タリサEXの1×10＝10は10以下なので、＋1の後に3個解除する", () => {
    // 攻撃力≦防御力では1ヒットが最低1ダメージになる。
    expect(fightingSpiritAfter("SKL_TARISA_TROUBLEMAKER_EX", 1000)).toBe(3);
  });
});

/** クララ（被検ユニット）が残HP`enemyHp`の敵1体へAS1を撃つ。 */
function claraAs1Against(enemyHp: number, random?: RandomSource): SkillUseRun {
  return useSkill(
    {
      subjectUnitDefinitionId: "UNIT_CLARA_TSUNDERE",
      allies: [],
      enemies: [
        {
          id: "enemy:center",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: enemyHp },
        },
      ],
    },
    SUBJECT_ID,
    "SKL_CLARA_TSUNDERE_AS1",
    random,
  );
}

function hpOf(units: readonly BattleUnit[], battleUnitId: string): number {
  const unit = units.find((candidate) => candidate.battleUnitId === battleUnitId);
  if (unit === undefined) {
    throw new Error(`missing ${battleUnitId}`);
  }
  return unit.currentHp;
}

function eventsOf(
  events: readonly BattleDomainEvent[],
  eventType: BattleDomainEvent["eventType"],
): readonly BattleDomainEvent[] {
  return events.filter((event) => event.eventType === eventType);
}

describe("FIX-08 クララAS1は撃破後も4ヒットを処理し、その合計で回復する（SR-115の固有例外）", () => {
  it("IT-CAT-ATKSUM-010 [R-SKL-08] (SR-115): 敵残HP100でも180×4＝720の40%で288回復する", () => {
    const run = claraAs1Against(100);
    expect(calculated(run.events, "ACT_CLARA_TSUNDERE_AS1_DAMAGE", "finalDamage")).toEqual(
      Array.from({ length: 4 }, () => CLARA_HIT),
    );
    expect(hpOf(run.units, SUBJECT_ID) - 5000).toBe(Math.floor(4 * CLARA_HIT * 0.4));
  });

  it("IT-CAT-ATKSUM-011 [R-SKL-08] (SR-115): 撃破後のヒットはHPへ適用せず、撃破イベント・被弾イベントを重複させない", () => {
    const run = claraAs1Against(100);
    expect(hpOf(run.units, "enemy:center")).toBe(0);
    expect(eventsOf(run.events, "UnitDefeated")).toHaveLength(1);
    expect(
      eventsOf(run.events, "DamageApplied").filter(
        (event) => event.targetUnitIds?.[0] === "enemy:center",
      ),
    ).toHaveLength(1);
  });

  it("IT-CAT-ATKSUM-012 [R-SKL-08] (SR-115): 通常生存時も4ヒット合計720の40%で288回復する（既存値を維持）", () => {
    const run = claraAs1Against(5000);
    expect(hpOf(run.units, "enemy:center")).toBe(5000 - 4 * CLARA_HIT);
    expect(hpOf(run.units, SUBJECT_ID) - 5000).toBe(Math.floor(4 * CLARA_HIT * 0.4));
  });
});
