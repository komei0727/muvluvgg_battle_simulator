import { resolveSkillUse } from "../../domain/battle/resolution/action-skill-use-resolver.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";

const RIDE_AS_ID = "SKL_TEST_FOLLOW_UP_RIDE_AS";
const RIDE_DAMAGE_ID = "ACT_TEST_FOLLOW_UP_RIDE_DAMAGE";
const NON_ATTACK_AS_ID = "SKL_TEST_NON_ATTACK_AS";
const NON_ATTACK_DEBUFF_ID = "ACT_TEST_NON_ATTACK_DEFENSE_DOWN";

/** 攻撃力1000 - 防御力500 = 500ダメージの、相乗り検証専用の最小DAMAGE定義（会心なし・必中なし）。 */
function rideDamageAction(): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(RIDE_DAMAGE_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/** 敵単体の防御力を下げるだけの、ダメージを含まないEffectAction。 */
function nonAttackDebuffAction(): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(NON_ATTACK_DEBUFF_ID),
    metadata: { tags: [] },
    payload: {
      stat: "DEFENSE",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: -0.1 },
      stacking: { mode: "STACKABLE", max: null },
      duration: {
        timeLimit: { unit: "ACTION", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/** 敵単体（既定順）へ`effectActionId`を1回適用する最小AS。 */
function standInEnemySingleSkill(skillId: string, effectActionId: string): SkillDefinition {
  const binding = createTargetBindingId("TGT_TEST_FOLLOW_UP_RIDE");
  return {
    skillDefinitionId: createSkillDefinitionId(skillId),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: binding,
          selector: {
            kind: "SELECT",
            side: "ENEMY",
            count: 1,
            filters: [],
            order: ["DEFAULT"],
            includeDefeated: false,
          },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: binding },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: skillId, tags: [] },
  };
}

export interface RideStandInAttackOptions {
  /** 追撃バフを保持している味方（この関数がAP1を明示してAS使用者にする）。 */
  readonly attackerUnitId: string;
  /** バフ付与済みの盤面全体。 */
  readonly units: readonly BattleUnit[];
  /** 実productionのEffectAction群を含む定義グラフ（合成ASはこの上へ重ねる）。 */
  readonly definitions: BattleDefinitions;
  readonly battleId: string;
  /** 既定は乱数を一切消費しない前提（会心PREVENTED・回避なし）。 */
  readonly random?: readonly number[];
}

/**
 * R-FUP-01（Issue #474）: 追撃バフを保持した味方に、合成の最小AS（敵単体1ヒット・
 * 会心なし）を実際に使わせる。PS発動（バフ付与）までは各ユニットの`-001`表が固定する
 * ため、このヘルパは「そのバフが当該攻撃にどう相乗りするか」だけを実`resolveSkillUse`
 * 経路で観測する。
 */
export function rideStandInAttack(options: RideStandInAttackOptions): {
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
} {
  return useStandInSkill(
    options,
    standInEnemySingleSkill(RIDE_AS_ID, RIDE_DAMAGE_ID),
    rideDamageAction(),
  );
}

/**
 * R-ATM-02（`SkillUseStarting.isAttack`）: 敵単体を対象に取るが`DAMAGE`を含まない
 * 合成AS（防御力低下だけ）を実`resolveSkillUse`経路で使わせる。「アクティブスキルで
 * 攻撃する前」のPSが、敵を対象に取る非攻撃ASで発動しないことを観測するために使う。
 */
export function useStandInNonAttackSkill(options: RideStandInAttackOptions): {
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
} {
  return useStandInSkill(
    options,
    standInEnemySingleSkill(NON_ATTACK_AS_ID, NON_ATTACK_DEBUFF_ID),
    nonAttackDebuffAction(),
  );
}

function useStandInSkill(
  options: RideStandInAttackOptions,
  skill: SkillDefinition,
  effectAction: EffectActionDefinition,
): {
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
} {
  const attackerUnitId = createBattleUnitId(options.attackerUnitId);
  const attackerBase = options.units.find((unit) => unit.battleUnitId === attackerUnitId);
  if (attackerBase === undefined) {
    throw new Error(`attacker "${options.attackerUnitId}" is not on the board`);
  }
  const attacker: BattleUnit = { ...attackerBase, currentAp: 1 };
  const roster = options.units.map((unit) =>
    unit.battleUnitId === attackerUnitId ? attacker : unit,
  );
  const definitions: BattleDefinitions = {
    ...options.definitions,
    skillDefinitions: new Map(options.definitions.skillDefinitions).set(
      skill.skillDefinitionId,
      skill,
    ),
    effectActions: new Map(options.definitions.effectActions).set(
      effectAction.effectActionDefinitionId,
      effectAction,
    ),
  };
  const recorder = new EventRecorder(createBattleId(options.battleId));
  const result = resolveSkillUse(
    attacker,
    skill,
    "AS",
    "AS",
    roster,
    definitions,
    new SequenceRandomSource([...(options.random ?? [])]),
    recorder,
    1,
    0,
    createActionId(`${options.battleId}:action:1`),
    recorder.nextResolutionScopeId(),
  );
  return { units: result.units, recorder };
}
