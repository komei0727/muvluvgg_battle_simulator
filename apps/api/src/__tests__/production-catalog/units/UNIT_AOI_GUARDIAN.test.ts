import { describe, expect, it } from "vitest";
import { shieldPoolsOf } from "../../../domain/battle/combat/shield-policy.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  initialSnapshotFor,
  loadProductionSnapshot,
  reconstruct,
  unitFrom,
} from "../../../testing/fixtures/index.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeEffectImmunity } from "../../../testing/production-unit/effect-application.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, skillUseStarting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_AOI_GUARDIAN`（【厳格な規律の守護者】生駒葵）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_AOI_GUARDIAN";

/**
 * EXが配るのは「気絶無効」——`categories: [STATUS]` を種別 `STUN` だけへ絞った免疫
 * （R-EFF-03）である。絞り込みが効いていることは**弾かれる種別と弾かれない種別を
 * 同じ免疫へ通して**初めて分かるため、葵自身が配らない状態異常を実 production 定義で
 * 用意できるよう、供給元のユニットだけを併せて読み込む。`-002`／`-003` はこの
 * ユニットのSkill・EffectAction閉包だけを見るため、閉包の判定には影響しない。
 */
const STUN_SOURCE_UNIT_ID = "UNIT_LILY_HERO";
const FREEZE_SOURCE_UNIT_ID = "UNIT_NANAE_COMMANDER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  STUN_SOURCE_UNIT_ID,
  FREEZE_SOURCE_UNIT_ID,
]);

const AS1_SHIELD = "ACT_AOI_GUARDIAN_AS1_SHIELD";

function unitIn(units: readonly BattleUnit[]): BattleUnit {
  return units.find((unit) => unit.battleUnitId === "ally:subject")!;
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_EX",
    intent:
      "自身のHPを最大HPの60%回復し、2行動の間攻撃力を50%上昇させ（重複可）、気絶無効を付与する。さらに自身に攻撃力×150%までのダメージを防ぐシールドを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_SHIELD",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 5000,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_ATK_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_SHIELD",
          magnitude: 2250,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
    intent:
      "最もHP割合の低い味方単体に、攻撃力×120%までのダメージを防ぐシールドを付与する。さらに2行動の間、行動時に最大HPの5%を継続回復するバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS1" },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 2000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      // PS1（「自身がアクティブスキルを使用する直前に発動」）はASの使用開始そのものを
      // 契機に持つため、AS 1回の観測には必ずPS1の連鎖が含まれる。
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          magnitude: 1200,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（AS1=1 + PS1=1）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
    intent: "(対象): 自身が最もHP割合の低い味方なら、シールドと継続回復は自身へ向かう",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS1" },
    board: { subject: { state: { currentHp: 1000 } } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
      ],
      // 失ったHP 9000 の50%。回復後もHP割合は最低のまま（AS1の対象は変わらない）。
      hpDeltas: {
        "ally:subject": 4500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_SHIELD",
          magnitude: 1200,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS1_CONTINUOUS_HEAL",
          magnitude: 500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_AS1",
          remaining: 2,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_AOI_GUARDIAN_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
        "enemy:front": -1060,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "自身がアクティブスキルを使用する直前に発動。自身の失ったHPの50%を回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS1_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 2500,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "(不成立): EXスキルの使用直前では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
    intent: "(不成立): 味方のアクティブスキル使用では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS1",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent:
      "自身がアクティブスキルで攻撃された後に発動。攻撃してきた敵単体に対して受けたダメージの100%のダメージを与える反撃をし、1行動分の気絶を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_COUNTER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（PS2=2）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "さらに対象のHPをこのスキルによって30%以下にした場合、対象のPPを全て削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 3400 },
        },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_COUNTER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_PP_ZERO",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_AOI_GUARDIAN_PS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        // EX獲得量は使用したスキルの消費ポイントに等しい（PS2=2）。
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:front", resource: "PP", delta: -4 },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
          remaining: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "(不成立): パッシブスキルによるダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "PS" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
    intent: "(不成立): 味方が受けたダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_AOI_GUARDIAN_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_AOI_GUARDIAN (【厳格な規律の守護者】生駒葵)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-AOI-GUARDIAN-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-AOI-GUARDIAN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-AOI-GUARDIAN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-AOI-GUARDIAN-004 [R-EFF-03] (R-EFF-03): EXが配る「気絶無効」は `STATUS` カテゴリ全体ではなく気絶だけを拒否する。実 `ACT_LILY_HERO_AS2_STUN` は弾かれて同じ行動のstat debuffは通り、実 `ACT_NANAE_COMMANDER_EX_FREEZE` は同じ免疫を素通りする", () => {
    // `-001` のEX行は付与そのもの（`magnitude: 0`・2行動）までを固定する。
    // `EFFECT_IMMUNITY.statusKinds` の絞り込みは**以後に飛んでくる付与**を弾くか
    // 通すかにしか現れず、これは別のスキル使用に属する。弾かれる側だけを見ても
    // カテゴリ丸ごとの免疫と区別がつかないため、両側を同じ免疫へ通す。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const guarded = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY", target: "SELF" },
    ]);
    const screen = (effectActionDefinitionIds: readonly string[], battleId: string) => {
      const { applied, rejected, immunity } = observeEffectImmunity({
        definitions: board.definitions,
        units: guarded,
        holder: "ally:subject",
        from: "enemy:front",
        effectActionDefinitionIds,
        immunityEffectActionDefinitionId: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
        battleId,
      });
      return { applied, rejected, immunity };
    };

    // 指定した種別（気絶）は拒否され、同じ行動で配られたstat debuffは通る。
    expect(
      screen(["ACT_LILY_HERO_AS2_STUN", "ACT_LILY_HERO_AS2_SPEED_DOWN"], "B_AOI_STUN"),
    ).toEqual({
      applied: ["ACT_LILY_HERO_AS2_SPEED_DOWN"],
      rejected: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_AS2_STUN",
          reason: "IMMUNITY",
          statusKind: "STUN",
          // 拒否したのは実EXが配ったそのインスタンスである。
          blockedBy: "ACT_AOI_GUARDIAN_EX_STUN_IMMUNITY",
        },
      ],
      // 免疫自身は拒否回数を数える（`maxBlocks: null` なので失効はしない）。
      immunity: {
        categories: ["STATUS"],
        statusKinds: ["STUN"],
        blockedCount: 1,
        maxBlocks: null,
      },
    });

    // 同じ `STATUS` カテゴリでも種別が違えば通る。ここが無いとカテゴリ丸ごとの
    // 免疫との区別がつかない。
    expect(screen(["ACT_NANAE_COMMANDER_EX_FREEZE"], "B_AOI_FREEZE")).toEqual({
      applied: ["ACT_NANAE_COMMANDER_EX_FREEZE"],
      rejected: [],
      immunity: {
        categories: ["STATUS"],
        statusKinds: ["STUN"],
        blockedCount: 0,
        maxBlocks: null,
      },
    });
  });

  it("IT-UNIT-AOI-GUARDIAN-005 [R-SHD-02, R-SHD-03] (R-SHD-02/R-SHD-03): AS1が配る実シールドはタイプなしプールとして被ダメージを吸収し、プールを超えた分だけがHPへ抜ける。1ヒットの振り分け（シールド吸収・HPダメージ・超過破棄）の合計は常に計算ダメージと一致する", () => {
    // `-001` のAS1行は付与そのもの（`magnitude: 1200`＝攻撃力×120%・戦闘終了まで）
    // までを固定する。吸収は**以後に飛んでくる攻撃**＝別のスキル使用に属するため、
    // スキル使用1回の観測には載らない。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const shielded = applyPrecedingActions(board, [
      { effectActionDefinitionId: AS1_SHIELD, target: "SELF" },
    ]);
    const strike = (units: readonly BattleUnit[], power: number, battleId: string) =>
      observeLifecycleDamageProbe({
        definitions: board.definitions,
        units,
        attackerUnitId: "enemy:front",
        targetUnitId: "ally:subject",
        power,
        battleId,
      });

    // 攻撃力1000 - 防御力500 = 500。シールド1200が全量を受け、HPは1点も減らない。
    const absorbed = strike(shielded, 1, "B_AOI_SHIELD_ABSORB");
    expect(absorbed.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 500,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 500,
        subUnitAbsorbed: 0,
        hitPointDamage: 0,
        discardedDamage: 0,
      },
    ]);
    expect(absorbed.hpDeltas).toEqual({});
    expect(shieldPoolsOf(unitIn(absorbed.units).appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 700,
    });

    // 残量700を超える一撃（500×3＝1500）は、700をシールドが受けて残り800がHPへ抜ける。
    const overflowed = strike(absorbed.units, 3, "B_AOI_SHIELD_OVERFLOW");
    expect(overflowed.distributions).toEqual([
      {
        targetUnitId: "ally:subject",
        calculatedDamage: 1500,
        typedShieldAbsorbed: 0,
        untypedShieldAbsorbed: 700,
        subUnitAbsorbed: 0,
        hitPointDamage: 800,
        discardedDamage: 0,
      },
    ]);
    expect(overflowed.hpDeltas).toEqual({ "ally:subject": -800 });
    // 枯渇したインスタンスはその場で失効する（R-SHD-01第3項）。
    expect(overflowed.expirations).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: AS1_SHIELD,
        reason: "SHIELD_DEPLETED",
        cascaded: false,
      },
    ]);

    // `shieldType` を宣言しない定義なので、消費はタイプなしプールとして通知される。
    expect(
      [absorbed, overflowed].flatMap((observation) =>
        observation.recorder
          .getEvents()
          .filter(
            (event): event is Extract<BattleDomainEvent, { eventType: "ShieldConsumed" }> =>
              event.eventType === "ShieldConsumed",
          )
          .map((event) => ({
            reason: event.payload.reason,
            shieldType: event.payload.shieldType,
            before: event.payload.before,
            after: event.payload.after,
            absorbed: event.payload.absorbed,
          })),
      ),
    ).toEqual([
      { reason: "DAMAGE_ABSORPTION", shieldType: null, before: 1200, after: 700, absorbed: 500 },
      { reason: "DAMAGE_ABSORPTION", shieldType: null, before: 700, after: 0, absorbed: 700 },
    ]);

    // 開始前スナップショットへ公開差分だけを当てた結果を、**スナップショット全体**で
    // 突き合わせる。HPだけを見るとシールド残量（`EffectSnapshot.shield`）の差分が
    // 欠けていても通ってしまう。
    expect(
      reconstruct(
        initialSnapshotFor(absorbed.units, { include: ["effects"] }),
        overflowed.recorder,
      ),
    ).toEqual(initialSnapshotFor(overflowed.units, { include: ["effects"] }));
  });
});
