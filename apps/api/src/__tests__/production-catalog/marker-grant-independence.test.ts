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
import { createEffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition-factory.js";

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

/**
 * 段階G（Issue #840）: FIX-06が担当する38評価行のスキルが付与する加算（`ADD`）マーカー
 * すべてについて、付与分の独立を同じ手順で確かめる。代表例（-001〜-007）だけでなく、
 * 定義移行だけで直した行も実定義で通す。
 *
 * 1. 同じ保持者へ親（＋同じスキル使用の子）を2回付ける → 付与分は2つ
 * 2. 敵・味方へ付けるマーカーは別の保持者へも1回付ける
 * 3. 保持者のマーカーを古い順に1つだけ外す（合成の`REMOVE_MARKER count: 1`）
 * 4. 外れるのは1回目の付与分とその子だけで、2回目の付与分と子・別の保持者は残る
 */
const FIX06_ROWS = [
  ["SR-264", "UNIT_AOI_ELEGANT", "SKL_AOI_ELEGANT_AS1"],
  ["SR-265", "UNIT_AOI_ELEGANT", "SKL_AOI_ELEGANT_AS2"],
  ["SR-266", "UNIT_AOI_ELEGANT", "SKL_AOI_ELEGANT_PS2"],
  ["SR-275", "UNIT_FEE_BATH", "SKL_FEE_BATH_AS1"],
  ["SR-276", "UNIT_FEE_BATH", "SKL_FEE_BATH_AS2"],
  ["SR-283", "UNIT_KOTOHA_DAILY", "SKL_KOTOHA_DAILY_EX"],
  ["SR-297", "UNIT_HARRIET_SAGE", "SKL_HARRIET_SAGE_AS1"],
  ["SR-299", "UNIT_LAYLA_NURSE", "SKL_LAYLA_NURSE_PS1"],
  ["SR-309", "UNIT_URUU_SUMMER", "SKL_URUU_SUMMER_PS1"],
  ["SR-336", "UNIT_HIIRO_FREEWOLF", "SKL_HIIRO_FREEWOLF_AS1"],
  ["SR-338", "UNIT_HIIRO_FREEWOLF", "SKL_HIIRO_FREEWOLF_PS1"],
  ["SR-345", "UNIT_MAO_SUMMER", "SKL_MAO_SUMMER_EX"],
  ["SR-351", "UNIT_NANAE_SOVEREIGN", "SKL_NANAE_SOVEREIGN_EX"],
  ["SR-354", "UNIT_NADYA_SUCCESSOR", "SKL_NADYA_SUCCESSOR_AS1"],
  ["SR-355", "UNIT_NADYA_SUCCESSOR", "SKL_NADYA_SUCCESSOR_PS1"],
  ["SR-356", "UNIT_NADYA_SUCCESSOR", "SKL_NADYA_SUCCESSOR_PS2"],
  ["SR-358", "UNIT_NADYA_SUCCESSOR", "SKL_NADYA_SUCCESSOR_EX"],
  ["SR-361", "UNIT_OLGA_NADYA_BOND", "SKL_OLGA_NADYA_BOND_EX"],
  ["SR-363", "UNIT_OLGA_VETERAN", "SKL_OLGA_VETERAN_AS2"],
  ["SR-373", "UNIT_MERU_BESIDE", "SKL_MERU_BESIDE_AS2"],
  ["SR-374", "UNIT_MERU_BESIDE", "SKL_MERU_BESIDE_PS1"],
  ["SR-375", "UNIT_MERU_BESIDE", "SKL_MERU_BESIDE_PS2"],
  ["SR-376", "UNIT_MERU_BESIDE", "SKL_MERU_BESIDE_EX"],
  ["SR-377", "UNIT_YURIA_JOKER", "SKL_YURIA_JOKER_AS1"],
  ["SR-388", "UNIT_RAVEL_MODEL", "SKL_RAVEL_MODEL_AS2"],
  ["SR-389", "UNIT_RAVEL_MODEL", "SKL_RAVEL_MODEL_PS1"],
  ["SR-391", "UNIT_RAVEL_MODEL", "SKL_RAVEL_MODEL_EX"],
  ["SR-397", "UNIT_TARISA_TROUBLEMAKER", "SKL_TARISA_TROUBLEMAKER_PS1"],
  ["SR-405", "UNIT_SUIRAN_CASINO", "SKL_SUIRAN_CASINO_AS3"],
  ["SR-407", "UNIT_SUIRAN_CASINO", "SKL_SUIRAN_CASINO_EX"],
  ["SR-412", "UNIT_NINA_ZINA_FRONTRUNNER", "SKL_NINA_ZINA_FRONTRUNNER_AS2"],
  ["SR-413", "UNIT_NINA_ZINA_FRONTRUNNER", "SKL_NINA_ZINA_FRONTRUNNER_PS1"],
  ["SR-414", "UNIT_NINA_ZINA_FRONTRUNNER", "SKL_NINA_ZINA_FRONTRUNNER_PS2"],
  ["SR-415", "UNIT_NINA_ZINA_FRONTRUNNER", "SKL_NINA_ZINA_FRONTRUNNER_EX"],
  ["SR-416", "UNIT_TATIANA_SAGE", "SKL_TATIANA_SAGE_AS1"],
  ["SR-417", "UNIT_TATIANA_SAGE", "SKL_TATIANA_SAGE_AS2"],
  ["SR-418", "UNIT_TATIANA_SAGE", "SKL_TATIANA_SAGE_AS3"],
  ["SR-420", "UNIT_TATIANA_SAGE", "SKL_TATIANA_SAGE_EX"],
] as const;

const sweepSnapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  ...new Set(FIX06_ROWS.map(([, unitDefinitionId]) => unitDefinitionId)),
]);

type MarkerDuration = {
  readonly linkedEffectGroupId?: string | null;
  readonly linkedEffectGroupRole?: string;
  readonly linkedEffectGroupScope?: string;
};

interface MarkerGrantCase {
  readonly markerId: string;
  /** 同じ保持者へ2つ目の付与分を持てるか（`stack.max`が1なら持てない）。 */
  readonly stackable: boolean;
  readonly parentId: string;
  readonly childIds: readonly string[];
  readonly target: PrecedingAction["target"];
}

function durationOf(effectActionDefinitionId: string): MarkerDuration | undefined {
  const definition = sweepSnapshot.effectActions.get(effectActionDefinitionId as never);
  return (definition?.payload as { readonly duration?: MarkerDuration } | undefined)?.duration;
}

/** スキル定義を辿り、各EffectAction IDを最初に現れたstepの対象（自身／味方／敵）と組で返す。 */
function actionsWithTarget(skillDefinitionId: string): Map<string, PrecedingAction["target"]> {
  const skill = sweepSnapshot.skills.get(skillDefinitionId as never)!;
  const bindings = new Map(
    skill.resolution.targetBindings.map((binding) => [
      String(binding.targetBindingId),
      JSON.stringify(binding.selector),
    ]),
  );
  const targetOf = (step: Record<string, unknown>): PrecedingAction["target"] => {
    const reference = step["target"] as { kind: string; targetBindingId?: string } | undefined;
    if (reference === undefined || reference.kind === "SELF") {
      return "SELF";
    }
    const selector = bindings.get(String(reference.targetBindingId)) ?? "";
    return selector.includes('"side":"ALLY"') ? "ALLY" : "ENEMY";
  };
  const found = new Map<string, PrecedingAction["target"]>();
  const visit = (steps: readonly Record<string, unknown>[]): void => {
    for (const step of steps) {
      for (const key of ["thenSteps", "elseSteps", "steps"]) {
        if (Array.isArray(step[key])) {
          visit(step[key] as Record<string, unknown>[]);
        }
      }
      for (const branch of (step["branches"] ?? []) as { steps: Record<string, unknown>[] }[]) {
        visit(branch.steps);
      }
      for (const action of (step["actions"] ?? []) as { effectActionDefinitionId: string }[]) {
        if (!found.has(action.effectActionDefinitionId)) {
          found.set(action.effectActionDefinitionId, targetOf(step));
        }
      }
    }
  };
  visit(skill.resolution.steps);
  // 命中時効果（`onHitEffects`）のように効果の中から参照される効果は、参照元と同じ対象へ付く。
  const nested = (node: unknown, target: PrecedingAction["target"]): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => nested(item, target));
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (
          key === "effectActionDefinitionId" &&
          typeof value === "string" &&
          !found.has(value) &&
          sweepSnapshot.effectActions.has(value as never)
        ) {
          found.set(value, target);
          nested(sweepSnapshot.effectActions.get(value as never)!.payload, target);
        } else {
          nested(value, target);
        }
      }
    }
  };
  for (const [id, target] of [...found]) {
    nested(sweepSnapshot.effectActions.get(id as never)?.payload, target);
  }
  return found;
}

function markerGrantCases(skillDefinitionId: string): readonly MarkerGrantCase[] {
  const actions = actionsWithTarget(skillDefinitionId);
  return [...actions].flatMap(([effectActionDefinitionId, target]) => {
    const definition = sweepSnapshot.effectActions.get(effectActionDefinitionId as never);
    const payload = definition?.payload as
      | {
          readonly markerId?: string;
          readonly stack?: { readonly policy?: string; readonly max?: number | null };
        }
      | undefined;
    if (definition?.kind !== "APPLY_MARKER" || payload?.stack?.policy !== "ADD") {
      return [];
    }
    const duration = durationOf(effectActionDefinitionId);
    const childIds =
      duration?.linkedEffectGroupScope === "SKILL_USE" &&
      duration.linkedEffectGroupRole === "PARENT"
        ? [...actions.keys()].filter((id) => {
            const child = durationOf(id);
            return (
              child?.linkedEffectGroupRole === "CHILD" &&
              child.linkedEffectGroupId === duration.linkedEffectGroupId
            );
          })
        : [];
    const max = payload.stack.max ?? null;
    return [
      {
        markerId: payload.markerId!,
        stackable: max === null || max >= 2,
        parentId: effectActionDefinitionId,
        childIds,
        target,
      },
    ];
  });
}

const FIX06_CASES = FIX06_ROWS.flatMap(([sr, unitDefinitionId, skillDefinitionId]) =>
  markerGrantCases(skillDefinitionId).map(
    (grantCase) => [sr, grantCase.parentId, { unitDefinitionId, ...grantCase }] as const,
  ),
);

/** 保持者のそのマーカーを古い付与分から1つだけ外す合成の効果を盤面の定義へ足す。 */
function withRemoveOne(board: ProductionBoard, markerId: string): ProductionBoard {
  const definition = createEffectActionDefinition(
    {
      effectActionDefinitionId: `ACT_TEST_REMOVE_ONE_${markerId}`,
      kind: "REMOVE_MARKER",
      payload: { markerId, count: 1 },
    },
    "test",
  );
  return {
    ...board,
    definitions: {
      ...board.definitions,
      effectActions: new Map(board.definitions.effectActions).set(
        definition.effectActionDefinitionId,
        definition,
      ),
    },
  };
}

function childInstanceIds(unit: BattleUnit, childIds: readonly string[]): readonly string[] {
  return unit.appliedEffects
    .filter((effect) => childIds.includes(effect.effectActionDefinitionId))
    .map((effect) => effect.effectInstanceId);
}

describe("FIX-06 付与分の独立（段階G・38評価行の実定義）", () => {
  it("IT-CAT-MKGRANT-008 [R-EFF-10]: FIX-06の評価行のうち加算マーカーを付けるスキルは全て横断対象に入り、子を連動させる親も含む", () => {
    const rowsWithMarkers = new Set(FIX06_CASES.map(([sr]) => sr));
    // 解除だけを持つ行（緋色PS1の闘志消費）は付与を持たないため、-004が単独で担う。
    expect(FIX06_ROWS.filter(([sr]) => !rowsWithMarkers.has(sr)).map(([sr]) => sr)).toEqual([
      "SR-338",
    ]);
    // 子を連動させる親（`SKILL_USE`範囲のPARENT）を持つ行が横断から漏れていないこと。
    const linkedParents = new Set(
      FIX06_CASES.filter(([, , grantCase]) => grantCase.childIds.length > 0).map(
        ([, parentId]) => parentId,
      ),
    );
    expect(linkedParents.size).toBeGreaterThanOrEqual(15);
  });

  it.each(FIX06_CASES)(
    "IT-CAT-MKGRANT-009 [R-EFF-09, R-EFF-10] (%s): %s の付与分を古い順に1つ外すと、その付与分と子だけが消え、後の付与分・子と別の保持者は残る",
    (_sr, _parentId, { unitDefinitionId, markerId, stackable, parentId, childIds, target }) => {
      const precede = sharedPreceding();
      const board = withRemoveOne(productionBoard(sweepSnapshot, unitDefinitionId), markerId);

      const first = precede(board, grant(parentId, childIds, target));
      const holder = first.find((unit) => grantsOf(unit, markerId).length > 0)!;
      expect(holder, "the first grant lands on some unit").toBeDefined();
      const firstGrant = grantsOf(holder, markerId)[0]!.markerInstanceId;
      const firstChildren = childInstanceIds(holder, childIds);
      expect(firstChildren).toHaveLength(childIds.length);

      // 上限1のマーカーは同じ保持者に2つ目の付与分を持てないため、別保持者の独立だけを見る。
      let units = first;
      let keptGrants: readonly string[] = [];
      let keptChildren: readonly string[] = [];
      if (stackable) {
        units = precede({ ...board, units: first }, grant(parentId, childIds, target));
        const holderTwice = unitOf(units, holder.battleUnitId);
        expect(grantsOf(holderTwice, markerId)).toHaveLength(2);
        keptGrants = grantsOf(holderTwice, markerId)
          .map((marker) => marker.markerInstanceId)
          .filter((id) => id !== firstGrant);
        keptChildren = childInstanceIds(holderTwice, childIds).filter(
          (id) => !firstChildren.includes(id),
        );
      }

      // 別の保持者へ、別のスキル使用で同じ親子を付ける。自身へ付けるマーカーは他の味方、
      // 敵・味方へ付けるマーカーは保持者を一時的に倒れた扱いにして次の候補へ付ける。
      units =
        target === "SELF"
          ? precede({ ...board, units }, grant(parentId, childIds, "ALLY"))
          : restoreHp(
              precede(
                withDefeated(board, units, holder.battleUnitId),
                grant(parentId, childIds, target),
              ),
              units,
            );
      const otherHolderId = units.find(
        (unit) => unit.battleUnitId !== holder.battleUnitId && grantsOf(unit, markerId).length > 0,
      )?.battleUnitId;
      expect(otherHolderId, "a second holder receives its own grant").toBeDefined();
      const otherBefore = unitOf(units, otherHolderId!);

      const removed = precede({ ...board, units }, [
        { effectActionDefinitionId: `ACT_TEST_REMOVE_ONE_${markerId}`, target },
      ]);
      const after = unitOf(removed, holder.battleUnitId);
      expect(grantsOf(after, markerId).map((marker) => marker.markerInstanceId)).toEqual(
        keptGrants,
      );
      const remainingChildren = childInstanceIds(after, childIds);
      expect(remainingChildren.filter((id) => firstChildren.includes(id))).toEqual([]);
      expect(keptChildren.filter((id) => !remainingChildren.includes(id))).toEqual([]);

      const other = unitOf(removed, otherHolderId!);
      expect(grantsOf(other, markerId)).toEqual(grantsOf(otherBefore, markerId));
      expect(childInstanceIds(other, childIds)).toEqual(childInstanceIds(otherBefore, childIds));
    },
  );
});
