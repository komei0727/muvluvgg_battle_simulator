import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../../testing/fixtures/index.js";
import {
  PRODUCTION_CATALOG_DIR,
  productionBoard,
  type BoardUnitSpec,
} from "../../testing/production-unit/skill-behaviour.js";
import {
  activatedPassiveSkillIds,
  openPassiveChain,
} from "../../testing/production-unit/passive-activation.js";
import { turnStarted } from "../../testing/production-unit/trigger-events.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

/**
 * Issue #858（R-PS-03 / R-PS-07 / R-ATM-03）: 攻撃前PSの発動機会はスキル使用単位。
 *
 * ターン開始時にヒイロ2体の先制攻撃PS（`SKL_HIIRO_LONEWOLF_PS1`・`SKL_HIIRO_FREEWOLF_PS2`）が
 * 別々のスキル使用として解決される。CT0のイーヴィーPS1（かばう）はそれぞれの攻撃に
 * 発動でき、CT1行動のルナPS1は最初の攻撃の後はCT中のため発動しない。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_HIIRO_LONEWOLF",
  "UNIT_HIIRO_FREEWOLF",
  "UNIT_EVIE_ECO",
  "UNIT_LUNA_HUNGRY",
]);

const HIIRO_FREEWOLF: BoardUnitSpec = {
  id: "ally:freewolf",
  position: { column: "LEFT", row: "FRONT" },
  unitDefinitionId: "UNIT_HIIRO_FREEWOLF",
};

const ORIGINAL: BoardUnitSpec = {
  id: "enemy:original",
  position: { column: "CENTER", row: "FRONT" },
  combatStats: { attack: 2000 },
  state: { currentHp: 3000 },
};

const EVIE: BoardUnitSpec = {
  id: "enemy:evie",
  position: { column: "LEFT", row: "FRONT" },
  unitDefinitionId: "UNIT_EVIE_ECO",
  state: { currentHp: 10000 },
};

const LUNA: BoardUnitSpec = {
  id: "enemy:luna",
  position: { column: "RIGHT", row: "FRONT" },
  unitDefinitionId: "UNIT_LUNA_HUNGRY",
  state: { currentHp: 10000 },
};

function resolveTurnStart(allies: readonly BoardUnitSpec[], enemies: readonly BoardUnitSpec[]) {
  const board = productionBoard(snapshot, "UNIT_HIIRO_LONEWOLF", { allies, enemies });
  const chain = openPassiveChain({
    definitions: board.definitions,
    actorUnitId: board.subject.battleUnitId,
    battleId: "B_PRE_ATTACK_OPPORTUNITY",
  });
  const units = chain.fire(turnStarted({ turnNumber: 1 }), board.units);
  const unit = (id: string): BattleUnit =>
    units.find((candidate) => candidate.battleUnitId === id)!;
  return { chain, units, unit };
}

describe("pre-attack opportunity per skill use (Issue #858)", () => {
  it("IT-CAT-PREATK-001 [R-PS-07]: CT0のイーヴィーは同じターン開始処理の独立した先制攻撃2つにそれぞれかばうを発動する", () => {
    const { chain, unit } = resolveTurnStart([HIIRO_FREEWOLF], [ORIGINAL, EVIE]);

    const activated = activatedPassiveSkillIds(chain);
    expect(activated.filter((id) => id === "SKL_HIIRO_LONEWOLF_PS1")).toHaveLength(1);
    expect(activated.filter((id) => id === "SKL_HIIRO_FREEWOLF_PS2")).toHaveLength(1);
    expect(activated.filter((id) => id === "SKL_EVIE_ECO_PS1")).toHaveLength(2);
    // 2回とも肩代わりが成立し、元の対象は被弾しない。
    expect(unit("enemy:original").currentHp).toBe(3000);
    // 初期PP4から2回ぶんのコストを支払う（ヒイロPS1のPP0化は肩代わり者へ付く）。
    expect(unit("enemy:evie").currentHp).toBeLessThan(10000);
  });

  it("IT-CAT-PREATK-002 [R-PS-04]: PP不足のイーヴィーは新しい発動機会でも発動しない", () => {
    const { chain } = resolveTurnStart(
      [HIIRO_FREEWOLF],
      [ORIGINAL, { ...EVIE, state: { ...EVIE.state, currentPp: 1 } }],
    );
    // 1回目でPP1を支払い（さらにヒイロPS1のPP0化）、2回目はPP不足。
    expect(activatedPassiveSkillIds(chain).filter((id) => id === "SKL_EVIE_ECO_PS1")).toHaveLength(
      1,
    );
  });

  it("IT-CAT-PREATK-003 [R-PS-04]: CT1行動のルナは最初の先制攻撃にだけかばうを発動する", () => {
    const { chain } = resolveTurnStart([HIIRO_FREEWOLF], [ORIGINAL, LUNA]);
    expect(
      activatedPassiveSkillIds(chain).filter((id) => id === "SKL_LUNA_HUNGRY_PS1"),
    ).toHaveLength(1);
  });

  it("IT-CAT-PREATK-004 [R-PS-03, R-ATM-03]: 全体EXへの攻撃前では、イーヴィーとルナのかばうのうち最速の1つだけが発動しPPを消費する", () => {
    const { activated, unit } = useLonewolfEx([
      { ...EVIE, combatStats: { actionSpeed: 300 } },
      ORIGINAL,
      LUNA,
    ]);

    expect(activated.filter((id) => id === "SKL_EVIE_ECO_PS1")).toHaveLength(1);
    expect(activated).not.toContain("SKL_LUNA_HUNGRY_PS1");
    expect(unit("enemy:evie").currentPp).toBe(3);
    expect(unit("enemy:luna").currentPp).toBe(4);
  });

  it("IT-CAT-PREATK-005 [R-PS-03, R-PS-04]: 最速のかばうがPP不足なら、発動開始前に次のかばうへ繰り上がる", () => {
    const { activated, unit } = useLonewolfEx([
      { ...EVIE, combatStats: { actionSpeed: 300 }, state: { ...EVIE.state, currentPp: 0 } },
      ORIGINAL,
      LUNA,
    ]);

    expect(activated).not.toContain("SKL_EVIE_ECO_PS1");
    expect(activated.filter((id) => id === "SKL_LUNA_HUNGRY_PS1")).toHaveLength(1);
    expect(unit("enemy:luna").currentPp).toBe(3);
  });
});

/** ヒイロ（孤狼）のEX（敵全体攻撃）を実`resolveSkillUse`経路で1回使わせる。 */
function useLonewolfEx(enemies: readonly BoardUnitSpec[]) {
  const board = productionBoard(snapshot, "UNIT_HIIRO_LONEWOLF", { allies: [], enemies });
  const actor: BattleUnit = { ...board.subject, currentExtraGauge: 100 };
  const roster = board.units.map((u) => (u.battleUnitId === actor.battleUnitId ? actor : u));
  const skill = board.definitions.skillDefinitions.get(
    createSkillDefinitionId("SKL_HIIRO_LONEWOLF_EX"),
  )!;
  const recorder = new EventRecorder(createBattleId("B_PRE_ATTACK_EX"));
  const result = resolveSkillUse(
    actor,
    skill,
    "EX",
    "EX",
    roster,
    board.definitions,
    new SequenceRandomSource(new Array<number>(64).fill(0.5)),
    recorder,
    1,
    0,
    createActionId("B_PRE_ATTACK_EX:action:1"),
    recorder.nextResolutionScopeId(),
  );
  const activated = recorder
    .getEvents()
    .filter((event) => event.eventType === "PassiveActivated")
    .map((event) => String((event.payload as { skillDefinitionId: string }).skillDefinitionId));
  const unit = (id: string): BattleUnit =>
    result.units.find((candidate) => candidate.battleUnitId === id)!;
  return { activated, unit };
}
