import { describe, expect, it } from "vitest";
import { shieldPoolsOf } from "../../../domain/battle/combat/shield-policy.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  seedRecorder,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { observeClassificationTrigger } from "../../../testing/production-unit/effect-application.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { effectApplied, turnStarted } from "../../../testing/production-unit/trigger-events.js";
import { observeHitPointRatioCritical } from "../../../testing/production-unit/hit-point-ratio-critical-probe.js";

/**
 * `UNIT_LILY_SINGER`（【想い響かせるヒーローシンガー】リリー・ラヴォア）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LILY_SINGER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** raw原文「対象の味方単体にかけられたデバフを5個解除し」。`ACT_LILY_SINGER_PS1_REMOVE_DEBUFF.maxRemovals`。 */
const MAX_REMOVALS = 5;

const PS2_SHIELD = "ACT_LILY_SINGER_PS2_SHIELD";
const PS2_ATK_UP = "ACT_LILY_SINGER_PS2_ATK_UP";

function subjectIn(units: readonly BattleUnit[]): BattleUnit {
  return units.find((unit) => unit.battleUnitId === "ally:subject")!;
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LILY_SINGER_EX",
    intent:
      "敵全体に対し、自身の現在HP×75%のダメージを与えるEN攻撃を行う。与えられるダメージは自身の攻撃力×75%を上限とする。さらに自身に対し1行動の間、敵から受ける攻撃のダメージを無効にする効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY", targets: ["ally:subject"] },
      ],
      // 現在HP5000の75%＝3750より、攻撃力1000の75%＝750の方が小さいので上限が効く
      // （`SKILL_POWER`ではないため防御力は引かれない、R-DMG-01）。
      hpDeltas: {
        "enemy:front": -750,
        "enemy:left": -750,
        "enemy:back": -750,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_EX",
    intent: "（現在HPが低い場合）上限ではなく自身の現在HP×75%がダメージになる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_EX" },
    board: { subject: { state: { currentHp: 400 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -300,
        "enemy:left": -300,
        "enemy:back": -300,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_AS1",
    intent:
      "前列優先で味方単体に対し、攻撃を2回受けるまで被ダメージを無効にする効果を付与するが、同時に自身の行動速度を100低下させ（重複可）、さらに1行動の間自身の攻撃力を30%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_AS1" },
    // 自身を後列に置き、「前列優先」が自身ではなく前列の味方を選ぶことを見る。
    board: { subject: { position: { column: "CENTER", row: "BACK" } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_IMMUNITY", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_SPEED_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_SPEED_DOWN",
          magnitude: -100,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_AS2",
    intent: "敵全体に威力63.6でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -318,
        "enemy:left": -318,
        "enemy:back": -318,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent:
      "他の味方がデバフを付与された際に発動。対象の味方単体にかけられたデバフを5個解除し、次に受けるEN攻撃でのダメージを25%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "enemy:front",
    },
    // 解除対象を実 production 定義で用意する（前提アクションの適用は観測の基準線）。
    precedingActions: [
      { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN", target: "ALLY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS1_REMOVE_DEBUFF", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN", targets: ["ally:front"] },
      ],
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN",
          magnitude: -0.25,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent: "(不成立): 自身へのデバフ付与では発動しない（「他の味方が」付与された場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent: "(不成立): 味方へのバフ付与では発動しない（「デバフを付与された際」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "ally:back",
        target: "ally:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
      triggeredBy: "ally:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS2",
    intent:
      "ターン開始時に発動。前列の味方に自身の最大HP×25%のENシールドを付与する。さらに前列の味方の攻撃力を15%上昇させる（重複可）（解除不可）が、自身が次に受けるEN攻撃の被ダメージが10%増加するデバフも付与される（重複可）。シールドは2行動後に消滅し、シールドの消滅と共に攻撃力バフも消滅する。このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SELF_EN_VULN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          // シールド量は付与者（自身）の最大HP10000の25%。
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SELF_EN_VULN",
          magnitude: 0.1,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_PS2", remaining: 99 },
      ],
    },
  },
];

describe("production Catalog UNIT_LILY_SINGER (【想い響かせるヒーローシンガー】リリー・ラヴォア)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LILY-SINGER-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-LILY-SINGER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-LILY-SINGER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-LILY-SINGER-004 [R-PS-01] (R-PS-01): PS1の「他の味方にデバフが付与された際」は、実 resolver が `EffectApplied` へ載せた分類で判定される — 被ダメージ補正のバフ／デバフは`magnitude`の符号ではなく`direction`で決まる", () => {
    // `-001` のPS1行が使う契機イベントはハーネスが組み立てたもので、payload の
    // `categories` はテスト側の宣言でしかない。**実装がその効果をどう分類したか**は
    // 実 resolver に発行させたイベントにしか現れない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const trigger = (effectActionDefinitionId: string, from: string, to: string) =>
      observeClassificationTrigger({
        definitions: board.definitions,
        units: board.units,
        effectActionDefinitionId,
        from,
        to,
        battleId: `B_LILY_CLASSIFY_${effectActionDefinitionId}_${to}`,
      });

    expect(trigger("ACT_LILY_SINGER_AS1_ATK_DOWN", "enemy:front", "ally:front")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["DEBUFF"] },
      activated: ["SKL_LILY_SINGER_PS1"],
    });
    // `OTHER_ALLY` は所有者自身を含まない（同じデバフでも自分への付与では発動しない）。
    expect(trigger("ACT_LILY_SINGER_AS1_ATK_DOWN", "enemy:front", "ally:subject")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["DEBUFF"] },
      activated: [],
    });
    expect(trigger("ACT_LILY_SINGER_PS2_ATK_UP", "enemy:front", "ally:front")).toEqual({
      classification: { effectKind: "APPLY_STAT_MOD", categories: ["BUFF"] },
      activated: [],
    });
    // 被ダメージ**増加**は `magnitude` が正でも保持者を弱化するのでデバフ。
    expect(trigger("ACT_LILY_SINGER_PS2_SELF_EN_VULN", "enemy:front", "ally:front")).toEqual({
      classification: { effectKind: "APPLY_DAMAGE_MOD", categories: ["DAMAGE_MOD", "DEBUFF"] },
      activated: ["SKL_LILY_SINGER_PS1"],
    });
  });

  it("IT-UNIT-LILY-SINGER-005 [R-EFF-02] (R-EFF-02): PS1の「デバフを5個解除」は `maxRemovals` で頭打ちになる — 6つ持っていても5つしか解除されず、6つ目は残る", () => {
    // `-001` のPS1行は解除対象を1つしか持たないため、上限そのものは現れない
    // （上限が無くても、上限が10でも同じ観測になる）。上限より1つ多い前提を
    // 実 production 定義で積んで、解除件数が5で止まることを固定する。
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_LILY_SINGER_PS1",
        trigger: effectApplied({
          source: "enemy:front",
          target: "ally:front",
          effectKind: "APPLY_STAT_MOD",
          categories: ["DEBUFF"],
        }),
        triggeredBy: "enemy:front",
      },
      precedingActions: Array.from({ length: MAX_REMOVALS + 1 }, () => ({
        effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
        target: "ALLY" as const,
      })),
    });

    expect(observation.effectsRemoved).toEqual(
      Array.from({ length: MAX_REMOVALS }, () => ({
        unitId: "ally:front",
        effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
        magnitude: -0.3,
        timeLimit: { unit: "ACTION", count: 1 },
      })),
    );
    expect(observation.effectsApplied).toEqual([
      {
        unitId: "ally:front",
        effectActionDefinitionId: "ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN",
        magnitude: -0.25,
        consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
      },
    ]);
  });

  it("IT-UNIT-LILY-SINGER-006 [R-SHD-01] (R-SHD-01/R-EFF-09): PS2が配る実シールドは `EN` プールで、EN攻撃だけを受けて物理攻撃は素通りさせる。EN攻撃で削り切ると枯渇失効し、同じ連動グループの攻撃力バフも巻き添えで消える。付与の公開差分だけからも `EN` シールドを含む状態を復元できる", () => {
    // `-001` のPS2行は付与そのもの（`magnitude: 2500`＝自身の最大HP×25%・2行動）
    // までを固定するが、観測は `shieldType` も `linkedEffectGroupId` も持たない。
    // どちらも**以後に飛んでくる攻撃**で初めて差が出る（タイプなしプールでも同じ
    // 2500が付き、連動していなくても同じ2行動で消える）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const grantRecorder = seedRecorder("B_LILY_SHIELD_GRANT");
    const shielded = applyPrecedingActions(
      board,
      [
        { effectActionDefinitionId: PS2_SHIELD, target: "SELF" },
        { effectActionDefinitionId: PS2_ATK_UP, target: "SELF" },
      ],
      { recorder: grantRecorder },
    );
    // 連動グループの子（攻撃力+15%）が効いている状態から始める。
    expect(subjectIn(shielded).combatStats.attack).toBe(1150);

    // 付与前スナップショットへ `EffectApplied` の公開差分だけを当てた結果を、
    // **スナップショット全体**で突き合わせる。`EffectSnapshot.shield.shieldType` が
    // 公開差分から落ちる回帰は、以下の実Domain状態に対する検証では捕まらない。
    const restored = reconstruct(
      initialSnapshotFor(board.units, { include: ["effects"] }),
      grantRecorder.recorder,
    );
    expect(restored).toEqual(initialSnapshotFor(shielded, { include: ["effects"] }));
    // 復元結果が実際に `EN` プールのシールドを含んでいること（上の全体比較が
    // 「どちらにもシールドが無い」で成立していないことの確認）。
    expect(
      restored.units[createBattleUnitId("ally:subject")]!.effects!.map((effect) => [
        effect.effectDefinitionId,
        effect.shield?.shieldType ?? null,
      ]),
    ).toEqual([
      [PS2_SHIELD, "EN"],
      [PS2_ATK_UP, null],
    ]);

    const strike = (
      units: readonly BattleUnit[],
      damageType: "EN" | "PHYSICAL",
      power: number,
      battleId: string,
    ) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        damageType,
        power,
        battleId,
      });

    // EN攻撃（攻撃力1000 - 防御力500 = 500）は `EN` プールが受ける。
    const byEn = strike(shielded, "EN", 1, "B_LILY_SHIELD_EN");
    expect(byEn.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 500,
        typedShieldAbsorbed: 500,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 0,
        hitPointDamage: 0,
        discardedDamage: 0,
      },
    ]);
    expect(shieldPoolsOf(subjectIn(byEn.units).appliedEffects)).toEqual({
      physical: 0,
      energy: 2000,
      untyped: 0,
    });

    // 物理攻撃は同じプールに届かず、全量がHPへ抜ける。タイプなしシールドとの
    // 違いはここにしか現れない。
    const byPhysical = strike(byEn.units, "PHYSICAL", 1, "B_LILY_SHIELD_PHYSICAL");
    expect(byPhysical.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 500,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 0,
        subUnitAbsorbed: 0,
        hitPointDamage: 500,
        discardedDamage: 0,
      },
    ]);
    expect(shieldPoolsOf(subjectIn(byPhysical.units).appliedEffects).energy).toBe(2000);

    // 残量2000をちょうど削り切るEN攻撃。枯渇でシールドが失効し、連動グループの子
    // （攻撃力バフ）も同時に消えて攻撃力が素の1000へ戻る（R-EFF-09）。
    const depleting = strike(byPhysical.units, "EN", 4, "B_LILY_SHIELD_DEPLETED");
    // 巻き添えの子は親より**先**に通知される（R-EFF-09の通知順序）。
    expect(depleting.expirations).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: PS2_ATK_UP,
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      },
      {
        unitId: "ally:subject",
        effectActionDefinitionId: PS2_SHIELD,
        reason: "SHIELD_DEPLETED",
        cascaded: false,
      },
    ]);
    expect(subjectIn(depleting.units).appliedEffects).toEqual([]);
    expect(subjectIn(depleting.units).combatStats.attack).toBe(1000);
  });

  it("IT-UNIT-LILY-SINGER-007 [R-CRT-04] (R-CRT-04): EXの「自身の現在HP×75%のダメージを与えるEN攻撃」は会心判定を行わない — AS2の威力ベース攻撃は従来どおり会心する", () => {
    const probe = (effectActionDefinitionId: string, skillDefinitionId: string) =>
      observeHitPointRatioCritical({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        effectActionDefinitionId,
        skillDefinitionId,
        attackerHoldsCriticalGuarantee: false,
        battleId: `B_LILY_SINGER_CRT04_${effectActionDefinitionId}`,
      });

    // 会心率100%の盤面。結末を分けるのはCatalogの `critical.mode` 宣言だけである。
    const ruled = probe("ACT_LILY_SINGER_EX_DAMAGE", "SKL_LILY_SINGER_EX");
    const control = probe("ACT_LILY_SINGER_AS2_DAMAGE", "SKL_LILY_SINGER_AS2");

    expect(ruled.criticalMode).toBe("PREVENTED");
    expect(ruled.isCritical).toBe(false);
    expect(ruled.criticalMultiplier).toBe(1);
    expect(control.criticalMode).toBe("NORMAL");
    expect(control.isCritical).toBe(true);
    expect(control.criticalMultiplier).toBeGreaterThan(1);
    // 会心判定を行った側だけが抽選を1本多く消費する。
    expect(control.randomDraws - ruled.randomDraws).toBe(1);
  });
});
