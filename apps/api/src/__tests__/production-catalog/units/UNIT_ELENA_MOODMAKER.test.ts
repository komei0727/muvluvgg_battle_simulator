import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  selectedActiveSkill,
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { applyDamageAction } from "../../../domain/battle/combat/damage-application-service.js";
import {
  skillUseCompleted,
  unitDefeated,
} from "../../../testing/production-unit/trigger-events.js";
import type { BattleDomainEvent } from "../../../domain/battle/events/domain-event.js";
import { EventRecorder } from "../../../domain/battle/events/event-recorder.js";
import { resolveSkillUse } from "../../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { applyStateDelta } from "../../../domain/battle/lifecycle/state-delta-reducer.js";
import type { BattleDefinitions } from "../../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../../domain/battle/model/battle-unit.js";
import {
  createEffectActionDefinitionId,
  createTargetBindingId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../../domain/catalog/definitions/skill-definition.js";
import type { TargetReference } from "../../../domain/catalog/definitions/references.js";
import type { TargetSelectorDefinition } from "../../../domain/catalog/definitions/target-selector-definition.js";
import { createActionId } from "../../../domain/shared/event-ids.js";
import { createBattleId } from "../../../domain/shared/ids.js";
import {
  definitionsWith,
  effectActionFrom,
  initialSnapshotFor,
  noMissNoCrit,
  skillFrom,
  testBattleUnit,
} from "../../../testing/fixtures/index.js";
import { STAND_IN_UNIT_ID } from "../../../testing/production-unit/skill-behaviour.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_ELENA_MOODMAKER`（【心色見つめるムードメーカー】エレーナ・パステルコワ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 *
 * 変化しなかった観測項目はキーごと落ちるため、`toEqual` の完全一致が
 * 「宣言した振る舞いが起きること」と「余計なことを起こさないこと」を同時に固定する。
 */

const UNIT_DEFINITION_ID = "UNIT_ELENA_MOODMAKER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const EX_SKILL_ID = "SKL_ELENA_MOODMAKER_EX";
const EX_BONUS_DAMAGE_ID = "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE";
/**
 * 追加ダメージの加算を測る担ぎ手のヒット。エレーナ自身のDAMAGEは
 * `MIN(対象の現在HP12.5%, 攻撃力50%)` で上限に張り付き、加算が差分に出ないため、
 * 検証対象（追加ダメージ）ではない担ぎ手側は最小の合成DAMAGEにする。
 */
const BONUS_VEHICLE_DAMAGE_ID = "ACT_TEST_ELENA_BONUS_VEHICLE";
const AS1_SKILL_ID = "SKL_ELENA_MOODMAKER_AS1";
const AS1_HEAL_ID = "ACT_ELENA_MOODMAKER_AS1_HEAL";
const AS1_HEALING_LINK_ID = "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK";

/**
 * AS1の回復リンク（R-HEAL-04）を観測するための盤面。AS1自身の発動条件
 * （自身のHP割合が下限ちょうど・HP70%未満の味方が存在・自身以外の味方が生存）を
 * すべて満たす最小構成にする。
 */
const LINK_COMBAT_STATS = { maximumHp: 1000, attack: 100, defense: 0 };
const LINK_LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

const LINK_TRAITS: SkillDefinition["traits"] = {
  priorityAttack: false,
  simultaneousActivationLimited: false,
  exclusiveActivationGroupId: null,
  accuracy: { guaranteedHit: false },
  piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
};

/**
 * 実production定義の`ACT_ELENA_MOODMAKER_AS1_HEAL`だけを、指定の相手へ単体で撃つ
 * 合成AS。リンクは「付与後に別の回復が保持者へ届いたとき」にしか観測できないため、
 * 転送の検証にはAS1本体とは別の回復経路が要る。
 */
function healSkill(id: string, target: TargetReference): SkillDefinition {
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: "ENEMY",
    count: 1,
    filters: [],
    order: ["LOWEST_HP_RATIO"],
    includeDefeated: false,
  };
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings:
        target.kind === "SELF"
          ? []
          : [{ targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target,
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: LINK_TRAITS,
    metadata: { displayName: id, tags: [] },
  };
}

const LOWEST_ENEMY_HEAL_ID = "SKL_TEST_ELENA_HEAL_LOWEST_ENEMY";
const SELF_HEAL_ID = "SKL_TEST_ELENA_HEAL_SELF";

interface LinkBoard {
  readonly elena: BattleUnit;
  readonly woundedAlly: BattleUnit;
  readonly woundedEnemy: BattleUnit;
  readonly healthyEnemy: BattleUnit;
  readonly units: readonly BattleUnit[];
  readonly definitions: BattleDefinitions;
}

function linkBoard(): LinkBoard {
  const member = (
    battleUnitId: string,
    unitDefinitionId: string,
    side: "ALLY" | "ENEMY",
    column: "LEFT" | "CENTER" | "RIGHT",
    row: "FRONT" | "BACK",
    currentHp: number,
    extra: Partial<BattleUnit> = {},
  ): BattleUnit =>
    testBattleUnit({
      battleUnitId,
      unitDefinitionId,
      side,
      position: { column, row },
      combatStats: LINK_COMBAT_STATS,
      limits: LINK_LIMITS,
      overrides: { currentHp, ...extra },
    });

  // Elena 400/1000（HP割合40% = 発動条件の下限ちょうど）、味方 100/1000（70%未満）、
  // 敵 300/1000 と 900/1000（最もHP割合の低い敵は前者）。
  const elena = member("ally:elena", UNIT_DEFINITION_ID, "ALLY", "CENTER", "BACK", 400, {
    currentAp: LINK_LIMITS.maximumAp,
  });
  const woundedAlly = member("ally:peer", STAND_IN_UNIT_ID, "ALLY", "LEFT", "FRONT", 100);
  const woundedEnemy = member("enemy:wounded", STAND_IN_UNIT_ID, "ENEMY", "LEFT", "FRONT", 300);
  const healthyEnemy = member("enemy:healthy", STAND_IN_UNIT_ID, "ENEMY", "RIGHT", "FRONT", 900);
  return {
    elena,
    woundedAlly,
    woundedEnemy,
    healthyEnemy,
    units: [elena, woundedAlly, woundedEnemy, healthyEnemy],
    definitions: definitionsWith(snapshot, {
      units: [STAND_IN_UNIT_ID],
      skills: [
        healSkill(LOWEST_ENEMY_HEAL_ID, {
          kind: "BINDING",
          targetBindingId: createTargetBindingId("TGT_LOWEST_ENEMY"),
        }),
        healSkill(SELF_HEAL_ID, { kind: "SELF" }),
      ],
    }),
  };
}

function unitOf(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const found = units.find((unit) => unit.battleUnitId === battleUnitId);
  if (found === undefined) {
    throw new Error(`unit "${battleUnitId}" is not on the board`);
  }
  return found;
}

/** 盤面へ1件のスキルを解決する。同じrecorderを使い回して因果の連続性を保つ。 */
function useSkill(
  board: LinkBoard,
  recorder: EventRecorder,
  actor: BattleUnit,
  skill: SkillDefinition,
  units: readonly BattleUnit[],
  actionIndex: number,
): ReturnType<typeof resolveSkillUse> {
  return resolveSkillUse(
    actor,
    skill,
    "AS",
    "AS",
    units,
    board.definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId(`B_ELENA:action:${actionIndex}`),
    recorder.nextResolutionScopeId(),
  );
}

/** 攻撃力が最も高い味方を一意にする盤面（EXの2つのbindingの解決先を分ける）。 */
const BONUS_BOARD: BoardOverrides = {
  subject: { position: { column: "CENTER", row: "BACK" } },
  allies: [
    {
      id: "ally:front",
      position: { column: "LEFT", row: "FRONT" },
      state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
    },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1",
    intent:
      "自身の現在HPの10%を消費し、最もHPの低い味方を回復。最もHP割合の低い敵と自身へ回復リンクを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1" },
    board: {
      subject: { position: { column: "CENTER", row: "BACK" }, state: { currentHp: 5000 } },
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 1000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 3000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEAL",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:front": 1175,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
          magnitude: 1,
          timeLimit: {
            unit: "ACTION",
            count: 1,
            owner: "EFFECT_SOURCE",
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS1_HEALING_LINK",
          magnitude: 1,
          timeLimit: {
            unit: "ACTION",
            count: 1,
            owner: "EFFECT_SOURCE",
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1",
    intent: "(不成立): 自身のHPが40%未満の場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1" },
    board: {
      subject: { position: { column: "CENTER", row: "BACK" }, state: { currentHp: 3000 } },
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 1000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1",
    intent: "(不成立): HPが70%未満の味方がいない場合は発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ELENA_MOODMAKER_AS1" },
    board: {
      subject: { position: { column: "CENTER", row: "BACK" }, state: { currentHp: 10000 } },
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 10000 },
        },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_AS2",
    intent: "敵単体へ対象の現在HP×12.5%のダメージ。ダメージは自身の攻撃力×50%を上限とする",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ELENA_MOODMAKER_AS2" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_AS2_DAMAGE",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS1",
    intent: "アクティブスキルを4回使用するたびに発動し、自身のHPを威力65で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ELENA_MOODMAKER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_ELENA_MOODMAKER_PS1")]: {
              [createRuntimeCounterId("SKL_ELENA_MOODMAKER_PS1_TRIGGER_COUNT")]: {
                value: 3,
                carry: 0,
              },
            },
          },
        },
      },
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS1_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 650,
      },
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS1",
    intent: "(不成立): 使用回数が4回に達していなければ発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ELENA_MOODMAKER_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_PS2",
    intent: "他の味方が敵に倒された際に発動し、自身の攻撃力+60%と敵全体へ威力46.8の攻撃",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ELENA_MOODMAKER_PS2",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_DAMAGE",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_DAMAGE",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -514,
        "enemy:left": -514,
        "enemy:back": -514,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_PS2_ATK_UP",
          magnitude: 0.6,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "PP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ELENA_MOODMAKER_EX",
    intent:
      "最も攻撃力が高い味方と最も低い味方へ、攻撃力+35%・与ダメージ+10%・攻撃時に攻撃力×15%の追加ダメージを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ELENA_MOODMAKER_EX" },
    board: {
      subject: { position: { column: "CENTER", row: "BACK" } },
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_HIGH",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
          targets: ["ally:front"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_LOW",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_LOW",
          magnitude: 0.35,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_LOW",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
          magnitude: 202.5,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_ATK_UP_HIGH",
          magnitude: 0.35,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_DMGUP_HIGH",
          magnitude: 0.1,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_ELENA_MOODMAKER_EX_BONUS_DAMAGE",
          magnitude: 202.5,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
    },
  },
];

describe("production Catalog UNIT_ELENA_MOODMAKER (【心色見つめるムードメーカー】エレーナ・パステルコワ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ELENA-MOODMAKER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ELENA-MOODMAKER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ELENA-MOODMAKER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。実行された
    // 集合そのものを閉包と突き合わせる。表をこのテスト内で回し直すのは、
    // 収集器がモジュール全域の状態であり、テストファイル間の isolation 設定に
    // 結果を依存させないため。
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

  // -004〜-006: 表で表現できない機構 — 回復リンク（R-HEAL-04）は「付与」と
  // 「以後の回復の転送」が別の時点で起こるため、単発のEffectAction観測では
  // 転送そのものが現れない。実スキルの対象選択と、リンク保持後の別経路の回復を通す。

  it("IT-UNIT-ELENA-MOODMAKER-004 (R-HEAL-04): the real SKL_ELENA_MOODMAKER_AS1 heals the lowest-HP ally and grants ACT_ELENA_MOODMAKER_AS1_HEALING_LINK to both the lowest-HP-ratio enemy and Elena herself, each resolving transferTo: SELF to Elena at grant time", () => {
    const board = linkBoard();
    // Catalog自身に対して、回復リンクが近似なしで表現されていることも確かめる。
    expect(effectActionFrom(snapshot, AS1_HEALING_LINK_ID)).toMatchObject({
      kind: "APPLY_HEALING_LINK",
      payload: {
        transferTo: { kind: "SELF" },
        transferRate: 1,
        duration: { timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" } },
      },
    });

    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const result = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );

    // CURRENT_HP_RATIO(SKILL_SOURCE) 0.235 × Elenaの400 = 94 が、最もHPの低い味方へ。
    const healApplied = recorder.getEvents().find((event) => event.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEAL_ID),
      targetUnitId: board.woundedAlly.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(unitOf(result.units, board.woundedAlly.battleUnitId).currentHp).toBe(194);
    // 付与時点では転送は起こらない（リンクは以後の回復にだけ作用する）。
    expect(recorder.getEvents().some((event) => event.eventType === "HealingTransferred")).toBe(
      false,
    );

    const linkGrants = recorder
      .getEvents()
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "EffectApplied" }> =>
          event.eventType === "EffectApplied" &&
          event.payload.effectActionDefinitionId === AS1_HEALING_LINK_ID,
      );
    expect(linkGrants.map((event) => event.payload.targetUnitId)).toEqual([
      board.woundedEnemy.battleUnitId,
      board.elena.battleUnitId,
    ]);
    for (const grant of linkGrants) {
      expect(grant.payload).toMatchObject({
        sourceUnitId: board.elena.battleUnitId,
        durationUnit: "ACTION",
        initialRemaining: 1,
        durationOwner: "EFFECT_SOURCE",
      });
    }
    // 最もHP割合の低い敵1体だけがリンクを受ける（900/1000の敵は対象外）。
    expect(unitOf(result.units, board.healthyEnemy.battleUnitId).appliedEffects).toHaveLength(0);
    for (const holderId of [board.woundedEnemy.battleUnitId, board.elena.battleUnitId]) {
      const holder = unitOf(result.units, holderId);
      expect(holder.appliedEffects).toHaveLength(1);
      expect(holder.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: AS1_HEALING_LINK_ID,
        healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 },
      });
    }

    // 独立Reducer: `EffectApplied`のStateDeltaだけから同じリンク（転送先・転送率を
    // 含む）を復元できる。
    let restored = initialSnapshotFor(board.units, { status: "READY" });
    for (const grant of linkGrants) {
      restored = applyStateDelta(restored, grant.stateDelta!);
    }
    expect(restored.units[board.woundedEnemy.battleUnitId]!.effects).toMatchObject([
      {
        effectDefinitionId: AS1_HEALING_LINK_ID,
        healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 },
        duration: { unit: "ACTION", remaining: 1 },
      },
    ]);
    expect(restored.units[board.elena.battleUnitId]!.effects).toMatchObject([
      { healingLink: { transferToUnitId: board.elena.battleUnitId, transferRate: 1 } },
    ]);
  });

  it("IT-UNIT-ELENA-MOODMAKER-005 (R-HEAL-04): once the enemy holds the AS1 link, healing that enemy transfers 100% to Elena — the enemy's HP does not move, HealingTransferred carries the causality and the HP StateDelta, and the independent Reducer restores the same HP", () => {
    const board = linkBoard();
    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const granted = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );

    const elenaBefore = unitOf(granted.units, board.elena.battleUnitId);
    expect(elenaBefore.currentHp).toBe(400);
    const eventsBefore = recorder.getEvents().length;

    const healSkillDefinition = board.definitions.skillDefinitions.get(
      createSkillDefinitionId(LOWEST_ENEMY_HEAL_ID),
    )!;
    const healed = useSkill(board, recorder, elenaBefore, healSkillDefinition, granted.units, 2);

    const newEvents = recorder.getEvents().slice(eventsBefore);
    const healApplied = newEvents.find((event) => event.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      targetUnitId: board.woundedEnemy.battleUnitId,
      healAmount: 94,
      transferredAmount: 94,
      appliedAmount: 0,
      discardedAmount: 0,
    });
    // 転送された分は保持者のHP変化ではないため、`HealApplied`はStateDeltaを持たない。
    expect(healApplied.stateDelta).toBeUndefined();

    const transferred = newEvents.find(
      (event): event is Extract<BattleDomainEvent, { eventType: "HealingTransferred" }> =>
        event.eventType === "HealingTransferred",
    )!;
    expect(transferred.category).toBe("FACT");
    expect(transferred.parentEventId).toBe(healApplied.eventId);
    expect(transferred.rootEventId).toBe(healApplied.rootEventId);
    expect(transferred.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId(AS1_HEALING_LINK_ID),
      fromUnitId: board.woundedEnemy.battleUnitId,
      toUnitId: board.elena.battleUnitId,
      transferRate: 1,
      transferredAmount: 94,
      appliedAmount: 94,
      discardedAmount: 0,
      hpBefore: 400,
      hpAfter: 494,
    });
    // 転送は1回だけ（Elena自身も同じリンクを持つが、転送によって生じた回復から
    // さらに転送は起こらない — R-HEAL-04の再リンク禁止）。
    expect(newEvents.filter((event) => event.eventType === "HealingTransferred")).toHaveLength(1);

    expect(unitOf(healed.units, board.woundedEnemy.battleUnitId).currentHp).toBe(300);
    expect(unitOf(healed.units, board.elena.battleUnitId).currentHp).toBe(494);

    const restored = applyStateDelta(
      initialSnapshotFor(granted.units, { status: "READY" }),
      transferred.stateDelta!,
    );
    expect(restored.units[board.elena.battleUnitId]!.hp).toBe(494);
    expect(restored.units[board.woundedEnemy.battleUnitId]!.hp).toBe(300);
  });

  it("IT-UNIT-ELENA-MOODMAKER-006 (BOUNDARY, R-HEAL-04): the link AS1 also grants to Elena herself is the identity — healing Elena keeps the whole amount with her and emits no HealingTransferred", () => {
    const board = linkBoard();
    const recorder = new EventRecorder(createBattleId("B_ELENA"));
    const granted = useSkill(
      board,
      recorder,
      board.elena,
      skillFrom(snapshot, AS1_SKILL_ID),
      board.units,
      1,
    );
    const elenaBefore = unitOf(granted.units, board.elena.battleUnitId);
    expect(elenaBefore.appliedEffects[0]!.healingLink).toMatchObject({
      transferToUnitId: board.elena.battleUnitId,
    });
    const eventsBefore = recorder.getEvents().length;

    const selfHeal = board.definitions.skillDefinitions.get(createSkillDefinitionId(SELF_HEAL_ID))!;
    const healed = useSkill(board, recorder, elenaBefore, selfHeal, granted.units, 2);

    const newEvents = recorder.getEvents().slice(eventsBefore);
    expect(newEvents.find((event) => event.eventType === "HealApplied")!.payload).toMatchObject({
      targetUnitId: board.elena.battleUnitId,
      healAmount: 94,
      transferredAmount: 0,
      appliedAmount: 94,
    });
    expect(newEvents.some((event) => event.eventType === "HealingTransferred")).toBe(false);
    expect(unitOf(healed.units, board.elena.battleUnitId).currentHp).toBe(494);
  });

  // -007〜-008: 追加ダメージ（`APPLY_ATTACK_DAMAGE_BONUS`）は「付与」と「以後の
  // 攻撃への加算」が別のスキル使用で起きるため、表の1行では加算そのものが現れない。
  // 機能軸の `attack-damage-bonus-production-catalog.test.ts` が持っていた検証を
  // ここへ移した（付与そのものと`magnitude`の観測は `-001` のEX行が持つ）。

  /** 保持者が実AS2のDAMAGEを1ヒット当てたときの、切り捨て前ダメージ。 */
  function preTruncationDamageOf(attacker: BattleUnit, target: BattleUnit): number {
    const damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }> = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(BONUS_VEHICLE_DAMAGE_ID),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount: 1,
        critical: { mode: "PREVENTED" },
        accuracy: { mode: "GUARANTEED" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const recorder = new EventRecorder(createBattleId("B_ELENA_BONUS_HIT"));
    const resolutionScopeId = recorder.nextResolutionScopeId();
    const seed = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId,
      payload: { turnNumber: 1 },
    });
    applyDamageAction(
      attacker,
      [
        {
          targetUnitId: target.battleUnitId,
          effectActionDefinitionId: damageAction.effectActionDefinitionId,
          hitIndex: 1,
        },
      ],
      damageAction,
      [attacker, target],
      noMissNoCrit(),
      {
        recorder,
        turnNumber: 1,
        cycleNumber: 1,
        actionId: recorder.nextActionId(),
        skillUseId: recorder.nextSkillUseId(),
        resolutionScopeId,
        rootEventId: seed.eventId,
        parentEventId: seed.eventId,
        skillDefinitionId: createSkillDefinitionId(EX_SKILL_ID),
      },
    );
    return recorder
      .getEvents()
      .find(
        (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
          event.eventType === "DamageCalculated",
      )!.payload.preTruncationDamage;
  }

  /**
   * 実EXを実ライフサイクルへ通し、追加ダメージを受け取ったエレーナ自身を返す。
   * 盤面は `-001` のEX行と同じ「攻撃力が最も高い味方が一意」な形にする — 全員同値だと
   * `HIGHEST_ATTACK`/`LOWEST_ATTACK` の双方がエレーナへ解決し、追加ダメージを2つ
   * 受け取ってしまうため。
   */
  function grantBonusToElena(): { readonly holder: BattleUnit; readonly enemy: BattleUnit } {
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID, BONUS_BOARD);
    const recorder = new EventRecorder(createBattleId("B_ELENA_BONUS"));
    const resolved = resolveSkillUse(
      board.subject,
      skillFrom(snapshot, EX_SKILL_ID),
      "EX",
      "EX",
      board.units,
      board.definitions,
      noMissNoCrit(),
      recorder,
      1,
      0,
      createActionId("B_ELENA_BONUS:action:1"),
      recorder.nextResolutionScopeId(),
    );
    return {
      holder: unitOf(resolved.units, board.subject.battleUnitId),
      enemy: unitOf(resolved.units, "enemy:front"),
    };
  }

  it("IT-UNIT-ELENA-MOODMAKER-007 (Q-DMG-01): the granted attack damage bonus reaches a real DAMAGE hit — the holder's hit adds exactly the granted magnitude on top of the same hit without the bonus", () => {
    const { holder, enemy } = grantBonusToElena();
    const bonus = holder.appliedEffects.find((effect) => effect.isAttackDamageBonus === true);
    expect(bonus?.effectActionDefinitionId).toBe(EX_BONUS_DAMAGE_ID);
    expect(bonus!.magnitude).toBeGreaterThan(0);

    // 対照実行は追加ダメージ効果**だけ**を外した同じ攻撃側にする（攻撃力バフ・
    // 与ダメージ補正は残すため、差分は追加ダメージの寄与だけになる）。
    const withoutBonus: BattleUnit = {
      ...holder,
      appliedEffects: holder.appliedEffects.filter((effect) => effect.isAttackDamageBonus !== true),
    };
    expect(
      holder.appliedEffects.filter((effect) => effect.isAttackDamageBonus === true),
    ).toHaveLength(1);

    // Q-DMG-01: 追加ダメージは切り捨て前の値へ加算する。
    expect(
      preTruncationDamageOf(holder, enemy) - preTruncationDamageOf(withoutBonus, enemy),
    ).toBeCloseTo(bonus!.magnitude, 6);
  });

  it("IT-UNIT-ELENA-MOODMAKER-008 (BOUNDARY): the bonus is a grant-time snapshot — raising the holder's ATTACK afterwards does not change what the hit adds", () => {
    const { holder, enemy } = grantBonusToElena();
    const magnitude = holder.appliedEffects.find(
      (effect) => effect.isAttackDamageBonus === true,
    )!.magnitude;
    const strengthened: BattleUnit = {
      ...holder,
      combatStats: { ...holder.combatStats, attack: holder.combatStats.attack * 10 },
    };
    const withoutBonus: BattleUnit = {
      ...strengthened,
      appliedEffects: strengthened.appliedEffects.filter(
        (effect) => effect.isAttackDamageBonus !== true,
      ),
    };

    expect(
      preTruncationDamageOf(strengthened, enemy) - preTruncationDamageOf(withoutBonus, enemy),
    ).toBeCloseTo(magnitude, 6);
  });

  it("IT-UNIT-ELENA-MOODMAKER-009 (R-ACT-02): AS1の実 AND(TARGET_SET_COUNT×2, TARGET_STATE) は行動選択層で評価され、いずれか1つでも崩れるとAS1は候補から外れて宣言順の次のAS2が選ばれる", () => {
    // 既定盤面は3つの条件がすべて成立する（味方は全員HP半減＝70%未満、自身以外の
    // 味方が2体、自身のHP割合50%≧40%）。
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_ELENA_MOODMAKER_AS1",
    );

    // HPが70%未満の味方がいない（自身もALLY側の母数に入るため満タンにする）。
    // 2つの `TARGET_SET_COUNT` はどちらもこのスキル自身のbindingを見るため、
    // 集合が空になる不成立はR-TGT-01 #4（空bindingは常に発動不能）とも重なる。
    // 条件評価パイプラインがそこでスローせず候補除外として扱われることの証跡。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: {
          subject: { state: { currentHp: 10000 } },
          allies: [
            {
              id: "ally:front",
              position: { column: "LEFT", row: "FRONT" },
              state: { currentHp: 10000 },
            },
            {
              id: "ally:back",
              position: { column: "CENTER", row: "BACK" },
              state: { currentHp: 10000 },
            },
          ],
        },
      }),
    ).toBe("SKL_ELENA_MOODMAKER_AS2");

    // 自身のHP割合が40%未満。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { subject: { state: { currentHp: 3000 } } },
      }),
    ).toBe("SKL_ELENA_MOODMAKER_AS2");

    // 自身以外に生存している味方がいない（`TGT_OTHER_ALLIES` が空になる）。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { allies: [] },
      }),
    ).toBe("SKL_ELENA_MOODMAKER_AS2");
  });
});
