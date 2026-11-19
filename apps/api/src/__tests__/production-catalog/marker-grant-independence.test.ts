import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProductionSnapshot, seedRecorder } from "../../testing/fixtures/index.js";
import { observeEffectExpiry } from "../../testing/production-unit/effect-expiry.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  productionBoard,
  type PrecedingAction,
  type ProductionBoard,
} from "../../testing/production-unit/skill-behaviour.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";

/**
 * R-EFF-09/R-EFF-10（Issue #830）: 同じ`markerId`でも付与ごとに付与元・期限を持つ別の
 * 付与分として保持し、付与分に紐づく補正はその付与分の解除・失効だけに連動する。
 * 実`catalog/`の定義で、永続＋期限付き・同名複数・複数保持者の組合せを確かめる。
 */

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  "UNIT_AOI_ELEGANT",
  "UNIT_LAYLA_NURSE",
  "UNIT_HIIRO_FREEWOLF",
  "UNIT_TARISA_TROUBLEMAKER",
  "UNIT_SUIRAN_CASINO",
  "UNIT_NOEL_RUMBLE",
]);

const SUBJECT = "ally:subject";

/**
 * 前提アクションを1つの記録器で続けて適用する。呼び出しごとに記録器を作り直すと
 * インスタンスIDが重複し、実戦闘では起こらない付与分の取り違えが起こる。
 */
function sharedPreceding(): (
  board: ProductionBoard,
  actions: readonly PrecedingAction[],
) => readonly BattleUnit[] {
  const recorder = seedRecorder("B_MARKER_GRANTS");
  return (board, actions) => applyPrecedingActions(board, actions, { recorder });
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  return units.find((unit) => unit.battleUnitId === battleUnitId)!;
}

function grantsOf(
  unit: BattleUnit,
  markerId: string,
): readonly BattleUnit["markerStates"][number][] {
  return unit.markerStates.filter((marker) => marker.markerId === markerId);
}

function effectIdsOf(unit: BattleUnit): readonly string[] {
  return unit.appliedEffects.map((effect) => effect.effectActionDefinitionId);
}

/** 盤面の一時的な戦闘不能を使い、合成スキルの単体対象を`enemy:front`以外へ向ける。 */
function withDefeated(
  board: ProductionBoard,
  units: readonly BattleUnit[],
  defeatedUnitId: string,
): ProductionBoard {
  return {
    ...board,
    units: units.map((unit) =>
      unit.battleUnitId === defeatedUnitId ? { ...unit, currentHp: 0 } : unit,
    ),
  };
}

function restoreHp(units: readonly BattleUnit[], before: readonly BattleUnit[]): BattleUnit[] {
  return units.map((unit) => ({ ...unit, currentHp: unitOf(before, unit.battleUnitId).currentHp }));
}

/** 親と子を同じスキル使用で付与する前提アクション列。 */
function grant(parentId: string, childIds: readonly string[], target: PrecedingAction["target"]) {
  return [
    { effectActionDefinitionId: parentId, target },
    ...childIds.map(
      (effectActionDefinitionId): PrecedingAction => ({
        effectActionDefinitionId,
        target,
        withPrevious: true,
      }),
    ),
  ];
}

describe("marker grant independence (R-EFF-09, R-EFF-10)", () => {
  it("IT-CAT-MKGRANT-001 [R-EFF-10] (SR-264, SR-265): 永続の浮足と葵2行動の浮足は別の付与分で、期限付きの分だけが期限で消える（付与順を問わない）", () => {
    const precede = sharedPreceding();
    const UKIASHI = "MARKER_AOI_ELEGANT_UKIASHI";
    const permanent = {
      effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_MARKER_UKIASHI",
      target: "ENEMY",
    } as const;
    const timed = {
      effectActionDefinitionId: "ACT_AOI_ELEGANT_AS2_MARKER",
      target: "ENEMY",
    } as const;
    const board = productionBoard(snapshot, "UNIT_AOI_ELEGANT");

    for (const order of [
      [permanent, timed],
      [timed, permanent],
    ]) {
      const granted = precede(board, order);
      expect(grantsOf(unitOf(granted, "enemy:front"), UKIASHI)).toHaveLength(2);

      // 期限付きの分は付与者（葵）の2行動で消える。永続分は残る。
      const expiry = observeEffectExpiry({
        units: granted,
        definitions: board.definitions,
        steps: [
          { kind: "ACTION_END", actor: SUBJECT },
          { kind: "ACTION_END", actor: SUBJECT },
        ],
        watchMarkers: ["enemy:front"],
      });
      expect(
        expiry.steps.map((step) => step.markers?.["enemy:front/MARKER_AOI_ELEGANT_UKIASHI"]),
      ).toEqual([2, 1]);
      const left = grantsOf(unitOf(expiry.units, "enemy:front"), UKIASHI);
      expect(left).toHaveLength(1);
      expect(left[0]!.duration.definition.timeLimit).toEqual({ unit: "BATTLE", count: 1 });
    }
  });

  it("IT-CAT-MKGRANT-002 [R-EFF-09] (SR-266): 高揚の専用解除は選んだ保持者の付与分と子だけを外し、別の保持者の高揚と子効果は残す", () => {
    const precede = sharedPreceding();
    const KOUYOU = "MARKER_AOI_ELEGANT_KOUYOU";
    const kouyouGrant = grant(
      "ACT_AOI_ELEGANT_AS1_MARKER_KOUYOU",
      ["ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN", "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT"],
      "ENEMY",
    );
    const board = productionBoard(snapshot, "UNIT_AOI_ELEGANT");
    const onFront = precede(board, kouyouGrant);
    // `enemy:front`を一時的に倒れた扱いにして、2人目の保持者へ同じ付与をする。
    const onSecond = restoreHp(
      precede(withDefeated(board, onFront, "enemy:front"), kouyouGrant),
      onFront,
    );
    const secondHolder = onSecond.find(
      (unit) => unit.battleUnitId !== "enemy:front" && grantsOf(unit, KOUYOU).length > 0,
    )!;

    const cleared = precede({ ...board, units: onSecond }, [
      { effectActionDefinitionId: "ACT_AOI_ELEGANT_PS2_CLEAR_KOUYOU", target: "ENEMY" },
    ]);

    const front = unitOf(cleared, "enemy:front");
    expect(grantsOf(front, KOUYOU)).toEqual([]);
    expect(effectIdsOf(front)).toEqual([]);
    const second = unitOf(cleared, secondHolder.battleUnitId);
    expect(grantsOf(second, KOUYOU)).toHaveLength(1);
    expect(effectIdsOf(second)).toEqual([
      "ACT_AOI_ELEGANT_AS1_KOUYOU_CRIT_DOWN",
      "ACT_AOI_ELEGANT_AS1_KOUYOU_DOT",
    ]);
  });

  it("IT-CAT-MKGRANT-003 [R-EFF-09, R-EFF-10] (SR-299): 観察は付与分ごとに期限を持ち、先の付与分の失効では後の付与分の攻撃低下・回復リンクを残す", () => {
    const precede = sharedPreceding();
    const KANSATSU = "MARKER_LAYLA_NURSE_KANSATSU";
    const kansatsuGrant = grant(
      "ACT_LAYLA_NURSE_PS1_KANSATSU_MARK",
      ["ACT_LAYLA_NURSE_PS1_ATK_DOWN", "ACT_LAYLA_NURSE_PS1_HEALING_LINK"],
      "ENEMY",
    );
    const board = productionBoard(snapshot, "UNIT_LAYLA_NURSE");
    const first = precede(board, kansatsuGrant);
    // レイラが1行動してから2回目の観察が付く（1回目は残り1、2回目は残り2）。
    const afterOneAction = observeEffectExpiry({
      units: first,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: SUBJECT }],
    }).units;
    const second = precede({ ...board, units: afterOneAction }, kansatsuGrant);
    const holderBefore = unitOf(second, "enemy:front");
    expect(grantsOf(holderBefore, KANSATSU)).toHaveLength(2);
    // 攻撃力20%低下（重複可）が2付与分乗る。
    expect(holderBefore.combatStats.attack).toBeCloseTo(1000 * (1 - 0.2 * 2), 9);

    const expiry = observeEffectExpiry({
      units: second,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: SUBJECT }],
    });

    const holder = unitOf(expiry.units, "enemy:front");
    expect(grantsOf(holder, KANSATSU)).toHaveLength(1);
    expect(grantsOf(holder, KANSATSU)[0]!.duration.timeLimitRemaining).toBe(1);
    expect([...effectIdsOf(holder)].sort()).toEqual(
      ["ACT_LAYLA_NURSE_PS1_ATK_DOWN", "ACT_LAYLA_NURSE_PS1_HEALING_LINK"].sort(),
    );
    expect(holder.combatStats.attack).toBeCloseTo(1000 * (1 - 0.2), 9);
  });

  it("IT-CAT-MKGRANT-004 [R-EFF-09] (SR-336, SR-338): 闘志の補正は通常のBUFF解除で単独に剥がれず、闘志1個の消費で対応する補正1組だけが外れる", () => {
    const precede = sharedPreceding();
    const FIGHTING_SPIRIT = "MARKER_HIIRO_FREEWOLF_FIGHTING_SPIRIT";
    const spiritGrant = grant(
      "ACT_HIIRO_FREEWOLF_AS1_MARKER",
      ["ACT_HIIRO_FREEWOLF_AS1_ATK_UP", "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP"],
      "SELF",
    );
    const board = productionBoard(snapshot, "UNIT_HIIRO_FREEWOLF");
    const granted = precede(board, [
      ...spiritGrant,
      ...spiritGrant,
      { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF", target: "SELF" },
    ]);
    const held = unitOf(granted, SUBJECT);
    expect(grantsOf(held, FIGHTING_SPIRIT)).toHaveLength(2);
    expect(held.appliedEffects).toHaveLength(4);
    expect(held.combatStats.attack).toBeCloseTo(1000 * 1.08, 9);

    const consumed = precede({ ...board, units: granted }, [
      { effectActionDefinitionId: "ACT_HIIRO_FREEWOLF_PS1_REMOVE_MARKER", target: "SELF" },
    ]);
    const after = unitOf(consumed, SUBJECT);
    expect(grantsOf(after, FIGHTING_SPIRIT)).toHaveLength(1);
    expect(effectIdsOf(after)).toEqual([
      "ACT_HIIRO_FREEWOLF_AS1_ATK_UP",
      "ACT_HIIRO_FREEWOLF_AS1_CRIT_DMG_UP",
    ]);
    expect(after.combatStats.attack).toBeCloseTo(1000 * 1.04, 9);
  });

  it("IT-CAT-MKGRANT-005 [R-EFF-09, R-EFF-10] (SR-397): 負けん気の3個解除は古い付与分3つと対応する攻撃力バフ3件だけを外し、残りの付与分の補正は保つ", () => {
    const precede = sharedPreceding();
    const SPIRIT = "MARKER_TARISA_TROUBLEMAKER_FIGHTING_SPIRIT";
    const spiritGrant = grant(
      "ACT_TARISA_TROUBLEMAKER_PS1_MARKER",
      ["ACT_TARISA_TROUBLEMAKER_PS1_ATK_UP"],
      "SELF",
    );
    const board = productionBoard(snapshot, "UNIT_TARISA_TROUBLEMAKER");
    const granted = precede(board, Array.from({ length: 5 }, () => spiritGrant).flat());
    const before = grantsOf(unitOf(granted, SUBJECT), SPIRIT);
    expect(before).toHaveLength(5);

    const reduced = precede({ ...board, units: granted }, [
      { effectActionDefinitionId: "ACT_TARISA_TROUBLEMAKER_PS1_REMOVE_MARKER", target: "SELF" },
    ]);
    const after = unitOf(reduced, SUBJECT);
    expect(grantsOf(after, SPIRIT).map((marker) => marker.markerInstanceId)).toEqual(
      before.slice(3).map((marker) => marker.markerInstanceId),
    );
    expect(after.appliedEffects).toHaveLength(2);
    expect(after.appliedEffects.map((effect) => effect.duration.linkedGroupAnchor)).toEqual(
      before.slice(3).map((marker) => `M:${marker.markerInstanceId}`),
    );
    expect(after.combatStats.attack).toBeCloseTo(1000 * (1 + 0.025 * 2), 9);
  });

  it("IT-CAT-MKGRANT-006 [R-EFF-10] (SR-405, SR-407): スリーカードのEX3行動分とAS3の1行動分は共存し、短い分の失効後もEX由来の付与分が残る", () => {
    const precede = sharedPreceding();
    const THREE_CARD = "MARKER_SUIRAN_CASINO_THREE_CARD";
    const board = productionBoard(snapshot, "UNIT_SUIRAN_CASINO");
    const granted = precede(board, [
      { effectActionDefinitionId: "ACT_SUIRAN_CASINO_EX_MARKER", target: "SELF" },
      { effectActionDefinitionId: "ACT_SUIRAN_CASINO_AS3_MARKER", target: "SELF" },
    ]);
    expect(
      grantsOf(unitOf(granted, SUBJECT), THREE_CARD).map(
        (marker) => marker.duration.timeLimitRemaining,
      ),
    ).toEqual([3, 1]);

    const expiry = observeEffectExpiry({
      units: granted,
      definitions: board.definitions,
      steps: [{ kind: "ACTION_END", actor: SUBJECT }],
    });
    expect(
      grantsOf(unitOf(expiry.units, SUBJECT), THREE_CARD).map(
        (marker) => marker.duration.timeLimitRemaining,
      ),
    ).toEqual([2]);
  });

  it("IT-CAT-MKGRANT-007 [R-EFF-09]: 付与分単位で連動する子（`SKILL_USE`範囲の`CHILD`）は、どのスキル・Memoryでも同じグループの親より後に付与される", () => {
    // 子は付与時点で同じスキル使用の最新の親へ紐づく。親より先に並ぶと、子は紐づく親を
    // 持てず付与されない（`hasLinkedParentForGrant`）。
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(PRODUCTION_CATALOG_DIR, file), "utf8"));
    type Step = Record<string, unknown>;
    type Duration = {
      readonly linkedEffectGroupId?: string | null;
      readonly linkedEffectGroupRole?: string;
      readonly linkedEffectGroupScope?: string;
    };
    const durations = new Map(
      (
        read("effects.json") as {
          effectActionDefinitionId: string;
          payload: { duration?: Duration };
        }[]
      ).map((definition) => [definition.effectActionDefinitionId, definition.payload.duration]),
    );
    const violations: string[] = [];
    let checkedChildren = 0;
    const visit = (owner: string, steps: readonly Step[], parentsSeen: Set<string>): void => {
      for (const nested of steps) {
        for (const key of ["thenSteps", "elseSteps", "steps"]) {
          if (Array.isArray(nested[key])) {
            visit(owner, nested[key] as Step[], parentsSeen);
          }
        }
        if (Array.isArray(nested["branches"])) {
          for (const branch of nested["branches"] as { steps: Step[] }[]) {
            visit(owner, branch.steps, parentsSeen);
          }
        }
        const actions = (nested["actions"] ?? []) as { effectActionDefinitionId: string }[];
        for (const action of actions) {
          const duration = durations.get(action.effectActionDefinitionId);
          if (duration?.linkedEffectGroupScope !== "SKILL_USE") {
            continue;
          }
          if (duration.linkedEffectGroupRole === "PARENT") {
            parentsSeen.add(duration.linkedEffectGroupId!);
          } else if (duration.linkedEffectGroupRole === "CHILD") {
            checkedChildren += 1;
            if (!parentsSeen.has(duration.linkedEffectGroupId!)) {
              violations.push(`${owner}: ${action.effectActionDefinitionId}`);
            }
          }
        }
      }
    };
    for (const skill of read("skills.json") as {
      skillDefinitionId: string;
      resolution: { steps: Step[] };
    }[]) {
      visit(skill.skillDefinitionId, skill.resolution.steps, new Set());
    }
    for (const memory of read("memories.json") as {
      memoryDefinitionId: string;
      triggeredEffects: { effectSequence: { steps: Step[] } }[];
    }[]) {
      memory.triggeredEffects.forEach((triggered, index) => {
        visit(`${memory.memoryDefinitionId}#${index}`, triggered.effectSequence.steps, new Set());
      });
    }
    expect(violations).toEqual([]);
    expect(checkedChildren).toBeGreaterThan(30);
  });
});
