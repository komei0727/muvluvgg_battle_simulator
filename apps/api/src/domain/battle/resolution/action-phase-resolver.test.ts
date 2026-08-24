import { describe, expect, it } from "vitest";
import { resolveActionPhase } from "./action-phase-resolver.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleStateSnapshot } from "../lifecycle/battle-state-snapshot.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { reduceStateDeltas } from "../events/state-delta-reducer.js";
import { createActionPoint, createExtraGauge, createHitPoint } from "../model/resource-gauge.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
  type UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { Cooldown, SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DefaultUnitDefinitionMap } from "../../../testing/fixtures/default-unit-definition-map.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

function unit(
  id: string,
  side: Side,
  overrides: {
    unitDefinitionId?: string;
    attack?: number;
    defense?: number;
    maximumHp?: number;
    actionSpeed?: number;
    limits?: Partial<BattleUnitResourceLimits>;
    currentAp?: number;
    currentExtraGauge?: number;
    currentHp?: number;
  } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId(overrides.unitDefinitionId ?? "UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 30,
      defense: overrides.defense ?? 10,
      criticalRate: 0,
      actionSpeed: overrides.actionSpeed ?? 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const limits: BattleUnitResourceLimits = {
    maximumAp: 1,
    maximumPp: 3,
    maximumExtraGauge: 100,
    ...overrides.limits,
  };
  const built = createBattleUnit(member, side, limits);
  return {
    ...built,
    currentAp: createActionPoint(overrides.currentAp ?? limits.maximumAp, limits.maximumAp),
    currentExtraGauge: createExtraGauge(overrides.currentExtraGauge ?? 0, limits.maximumExtraGauge),
    currentHp: createHitPoint(
      overrides.currentHp ?? member.combatStats.maximumHp,
      member.combatStats.maximumHp,
    ),
  };
}

/**
 * R-STS-01/02/03: a minimal STUN/FREEZE `AppliedEffect` fixture for
 * resolver-level tests. `holderId` must be the owning unit's own
 * `battleUnitId` (`timeLimit.owner` defaults to `EFFECT_TARGET`, resolved via
 * `targetUnitId` — R-EFF-04's own-action-end decrement only fires when this
 * matches the acting unit).
 */
function statusEffect(
  statusKind: "STUN" | "FREEZE",
  instanceId: string,
  remaining: number,
  holderId: BattleUnit["battleUnitId"],
): AppliedEffect {
  const definitionId = createEffectActionDefinitionId(`ACT_${statusKind}`);
  return {
    effectInstanceId: createEffectInstanceId(instanceId),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: holderId,
    targetUnitId: holderId,
    magnitude: 0,
    categories: ["BUFF"],
    statusKind,
    duration: {
      definition: {
        timeLimit: { unit: "ACTION", count: remaining },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      timeLimitRemaining: remaining,
    },
    appliedTurnNumber: 1,
  };
}

const ENEMY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

/** DEFAULT order picks the nearest enemy first; ties fall back to input array order (stable sort). */
const ENEMY_NEAREST: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: 1,
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

/** 単騎編成では候補0件になる「自分以外の味方1体」。 */
const OTHER_ALLY_ONE: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ALLY",
  count: 1,
  filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
  order: ["DEFAULT"],
  includeDefeated: false,
};

const ALLY_ALL: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ALLY",
  count: "ALL",
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function damageEffectAction(
  id: string,
  criticalMode: "NORMAL" | "GUARANTEED" | "PREVENTED" = "PREVENTED",
): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 1,
      critical: { mode: criticalMode },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/**
 * M7-005（Issue #184）で`HEAL`が実装されたため、「resolverが未対応kindを明確に
 * 拒否する」回帰テスト（UT-ACTION-PHASE-004）の題材を`APPLY_SHIELD`
 * （`CAP_SHIELD`は`PLANNED`、DMG-004/Issue #188）へ差し替える。
 */
function shieldEffectAction(id: string, amount = 10): EffectActionDefinition {
  return {
    kind: "APPLY_SHIELD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      formula: { kind: "CONSTANT", value: amount },
      duration: {
        timeLimit: { unit: "ACTION", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/**
 * DMG-006（`CAP_COVER`、`runtimeStatus: PLANNED`）: この resolver がまだ実装して
 * いないEffectAction kind。DMG-005（Issue #190）が`APPLY_SUBUNIT`を実装したため、
 * 「未実装kindは明確に失敗する」ことを確かめる証跡をこちらへ移した
 * （DMG-004が`APPLY_SHIELD`を実装したときと同じ移し替え）。
 */
function coverEffectAction(id: string): EffectActionDefinition {
  return {
    kind: "APPLY_COVER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      coverer: { kind: "SELF" },
      damageShareRate: 1,
      guardRate: 0,
      appliesTo: { actionKinds: ["ANY"] },
      duration: {
        timeLimit: { unit: "ACTION", count: 1 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

/** DMG-005（Issue #190、R-SUB-01/02）: 実ライフサイクルで付与されるサブユニット。 */
function subUnitEffectAction(id: string, durability = 10): EffectActionDefinition {
  return {
    kind: "APPLY_SUBUNIT",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      durability: { formula: { kind: "CONSTANT", value: durability } },
      additionalDamage: {
        formula: {
          kind: "SUBUNIT_ADDITIONAL_DAMAGE",
          ownerAttack: "CURRENT_ATTACK",
          providerAttack: "SOURCE_SNAPSHOT_ATTACK",
          skillMultiplier: 0.5,
          targetDefense: "TARGET_CURRENT_DEFENSE",
        },
      },
      duration: {
        timeLimit: { unit: "ACTION", count: 3 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function statModEffectAction(
  id: string,
  stat: "ATTACK" | "DEFENSE" | "ACTION_SPEED",
  valueType: "RATIO" | "FIXED",
  value: number,
): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      stat,
      valueType,
      formula: { kind: "CONSTANT", value },
      stacking: { mode: "STACKABLE", max: null },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function modifyResourceEffectAction(
  id: string,
  resource: "AP" | "EX_GAUGE",
  operation: "ADD" | "SET_TO_MAX",
  value = 0,
): EffectActionDefinition {
  return {
    kind: "MODIFY_RESOURCE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      resource,
      operation,
      // `SET_TO_MAX`はformulaを参照しないが、payloadの必須項目のため置く。
      formula: { kind: "CONSTANT", value },
      bounds: { min: 0, max: "CURRENT_MAX" },
    },
  };
}

/**
 * 1つのstepで複数のEffectActionを定義順に解決するAS。同じ1行動の中で対象の
 * 複数リソースを動かすために使う——リソース変更が別々の行動へ分かれると、
 * 各行動の後に走る`resolveReservationRemovals`が中間状態で適格性を判定して
 * しまい、「両方の変更を適用した後の状態」を予約の生存条件にできない。
 */
function multiEffectSkill(
  skillDefinitionId: string,
  effectActionIds: readonly string[],
  apCost = 1,
  selector: TargetSelectorDefinition = ENEMY_ALL,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(skillDefinitionId),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: effectActionIds.map((effectActionId) => ({
            effectActionDefinitionId: createEffectActionDefinitionId(effectActionId),
          })),
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
    metadata: { displayName: "MultiEffect", tags: [] },
  };
}

function attackSkill(
  effectActionId: string,
  apCost = 1,
  selector: TargetSelectorDefinition = ENEMY_ALL,
  cooldown: Cooldown = { unit: "ACTION", count: 0 },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_${effectActionId}`),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown,
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "Attack", tags: [] },
  };
}

function exSkill(
  effectActionId: string,
  gaugeAmount: number,
  selector: TargetSelectorDefinition = ENEMY_ALL,
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_EX_${effectActionId}`),
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount: gaugeAmount },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
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
    metadata: { displayName: "Ex", tags: [] },
  };
}

function chargeSkill(
  effectActionId: string,
  apCost = 1,
  selector: TargetSelectorDefinition = ENEMY_ALL,
  cooldown: Cooldown = { unit: "ACTION", count: 0 },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_CHARGE_${effectActionId}`),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "CHARGE",
      targetBindings: [],
      steps: [],
      chargeRelease: {
        targetBindings: [{ targetBindingId: createTargetBindingId("TGT_1"), selector }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
          },
        ],
      },
    },
    cooldown,
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "Charge", tags: [] },
  };
}

function cooldownManipulationEffectAction(
  id: string,
  targetSkillDefinitionId: string,
  operation: "RESET" | "REDUCE",
  amount?: number,
): EffectActionDefinition {
  return {
    kind: "COOLDOWN_MANIPULATION",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    metadata: { tags: [] },
    payload: {
      targetSkillDefinitionId: createSkillDefinitionId(targetSkillDefinitionId),
      operation,
      ...(amount !== undefined ? { amount } : {}),
    },
  };
}

/** SELF-targeted skill with no targetBindings, so it is always resolvable regardless of enemy presence. */
function cooldownManipulationSkill(
  effectActionId: string,
  apCost = 1,
  cooldown: Cooldown = { unit: "ACTION", count: 0 },
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(`SKL_${effectActionId}`),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(effectActionId) }],
        },
      ],
    },
    cooldown,
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    metadata: { displayName: "CooldownManipulation", tags: [] },
  };
}

function definitionsOf(
  activeSkillsByUnit: ReadonlyMap<UnitDefinitionId, readonly SkillDefinition[]>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  exSkillByUnit: ReadonlyMap<UnitDefinitionId, SkillDefinition> = new Map(),
): BattleDefinitions {
  return {
    activeSkillsByUnit,
    exSkillByUnit,
    effectActions,
    // PS trigger detection (Issue #34) requires every participating unit's
    // UnitDefinition to exist; this file's tests don't exercise PS, so fall
    // back to a definition with no passive skills for any unitDefinitionId.
    unitDefinitions: new DefaultUnitDefinitionMap(),
    skillDefinitions: new Map(),
  };
}

const NO_SKILLS: BattleDefinitions = definitionsOf(new Map(), new Map());

/**
 * `resolveActionPhase`は通常`advanceBattle`のTURN_STARTING（TurnStarted→
 * ResourcesRecovered）の後に呼ばれる。単体テストではその前提イベントを
 * 最小限再現し、recorder・turnNumber・親子連鎖の起点だけを提供する。
 */
function actionPhaseContext(turnNumber = 1) {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber },
  });
  return {
    recorder,
    turnNumber,
    turnRootEventId: turnStarted.eventId,
    turnScopeParentEventId: turnStarted.eventId,
  };
}

/**
 * 「使用可能なASがない」待機（`06_戦闘状態遷移.md` DECIDING優先順#7）へAP 0で
 * 到達する唯一の経路を組む（Issue #517）。ALLY_1は周回開始時にAP1・EXゲージ
 * 未満タンなのでAS予約され（予約種別はR-ORD-03により後から変わらない）、
 * 自分の手番より前にENEMY_1の1行動でAPを0にされ、同じ行動でEXゲージを満タンに
 * される。R-ORD-01の適格性はEXゲージ満タン側で保たれるため予約は除去されず、
 * AP 0ではすべてのASがコスト不足（R-ACT-03によりコストは1以上）で弾かれる。
 */
function apDrainedWithFullGaugeScenario(gaugeMaximum: number): WaitPathScenario {
  const victimDefinitionId = createUnitDefinitionId("UNIT_AP_DRAIN_VICTIM");
  const manipulatorDefinitionId = createUnitDefinitionId("UNIT_AP_DRAIN_MANIPULATOR");
  const victim = unit("ALLY_1", "ALLY", {
    unitDefinitionId: "UNIT_AP_DRAIN_VICTIM",
    actionSpeed: 10,
    limits: { maximumAp: 1, maximumExtraGauge: gaugeMaximum },
    currentAp: 1,
    currentExtraGauge: 0,
  });
  const manipulator = unit("ENEMY_1", "ENEMY", {
    unitDefinitionId: "UNIT_AP_DRAIN_MANIPULATOR",
    actionSpeed: 20,
    limits: { maximumAp: 1 },
  });
  const victimHit = damageEffectAction("ACT_VICTIM_HIT");
  const apDrain = modifyResourceEffectAction("ACT_AP_DRAIN", "AP", "ADD", -1);
  const gaugeFill = modifyResourceEffectAction("ACT_GAUGE_FILL", "EX_GAUGE", "SET_TO_MAX");
  return {
    allyUnits: [victim],
    enemyUnits: [manipulator],
    definitions: definitionsOf(
      new Map([
        [victimDefinitionId, [attackSkill("ACT_VICTIM_HIT", 1)]],
        [
          manipulatorDefinitionId,
          [multiEffectSkill("SKL_AP_DRAIN", ["ACT_AP_DRAIN", "ACT_GAUGE_FILL"], 1)],
        ],
      ]),
      new Map([
        [victimHit.effectActionDefinitionId, victimHit],
        [apDrain.effectActionDefinitionId, apDrain],
        [gaugeFill.effectActionDefinitionId, gaugeFill],
      ]),
    ),
  };
}

interface WaitPathScenario {
  allyUnits: readonly BattleUnit[];
  enemyUnits: readonly BattleUnit[];
  definitions: BattleDefinitions;
}

/** R-ACT-01 #1/#2の待機（気絶・凍結）。行動阻害の分岐は予約種別より前に処理される。 */
function stunnedOrFrozenWaitScenario(
  statusKind: "STUN" | "FREEZE",
  currentAp: number,
  currentExtraGauge: number,
): WaitPathScenario {
  return {
    allyUnits: [
      {
        ...unit("ALLY_1", "ALLY", {
          limits: { maximumAp: 1, maximumExtraGauge: 10 },
          currentAp,
          currentExtraGauge,
        }),
        appliedEffects: [
          statusEffect(statusKind, `${statusKind}-1`, 1, createBattleUnitId("ALLY_1")),
        ],
      },
    ],
    enemyUnits: [unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } })],
    definitions: NO_SKILLS,
  };
}

/**
 * R-ACT-01 #4の待機（EX予約だがEXを使用できない）。EXゲージは満タンで固定し
 * （そうでなければEX予約自体が生まれない、Q-EX-03）、AP残量だけを変える。
 *
 * 対象候補を0件にする手段として「敵の全滅」は使えない——AP消費の待機は同じ
 * ターンの次の周回まで続くのに対し、全滅は最初の1行動の後の勝敗判定
 * （R-END-01タイミング#1）で行動フェーズを打ち切ってしまう。単騎編成で
 * 「自分以外の味方」を要求させ、敵は生存させたまま候補0件にする。
 */
function unusableExWaitScenario(currentAp: number): WaitPathScenario {
  const unitDefinitionId = createUnitDefinitionId("UNIT_EX_UNUSABLE");
  return {
    allyUnits: [
      unit("ALLY_1", "ALLY", {
        unitDefinitionId: "UNIT_EX_UNUSABLE",
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp,
        currentExtraGauge: 10,
      }),
    ],
    enemyUnits: [unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } })],
    definitions: definitionsOf(
      new Map(),
      new Map(),
      new Map([[unitDefinitionId, exSkill("ACT_EX_UNUSABLE", 10, OTHER_ALLY_ONE)]]),
    ),
  };
}

/**
 * R-ACT-01 #5の待機（AS予約だが使用可能なASがない）をAPを残したまま起こす。
 * AP不足以外の理由で弾く必要があるため、対象候補0件（唯一の敵が戦闘不能、
 * R-TGT-01 #2）でASを発動不能にする。
 */
function noUsableActiveSkillWaitScenario(): WaitPathScenario {
  const unitDefinitionId = createUnitDefinitionId("UNIT_AS_TARGETLESS");
  const effectAction = damageEffectAction("ACT_TARGETLESS_HIT");
  return {
    allyUnits: [
      unit("ALLY_1", "ALLY", {
        unitDefinitionId: "UNIT_AS_TARGETLESS",
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 1,
        currentExtraGauge: 0,
      }),
    ],
    enemyUnits: [unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, currentHp: 0 })],
    definitions: definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_TARGETLESS_HIT", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    ),
  };
}

describe("resolveActionPhase", () => {
  it("UT-ACTION-PHASE-001: a unit with no active skills WAITs (consuming 1 AP) until it runs out of AP, leaving HP untouched", () => {
    const ally = unit("ALLY_1", "ALLY", { limits: { maximumAp: 2 } });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 2 } });
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      NO_SKILLS,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.result).toBeUndefined();
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.enemyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.currentHp).toBe(ally.currentHp);
    expect(result.enemyUnits[0]!.currentHp).toBe(enemy.currentHp);

    // 06_戦闘状態遷移.md「待機」#1: 実効行動WAIT確定後にActionWaitedを発行する。
    const waited = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId);
    expect(waited.length).toBeGreaterThan(0);
    expect(waited[0]!.payload).toEqual({
      actorUnitId: ally.battleUnitId,
      waitReason: "NO_USABLE_ACTIVE_SKILL",
      consumedResource: "AP",
      consumedAmount: 1,
    });
  });

  it("UT-R-ACT-03-007: a normal wait consumes 1 AP and increases the EX gauge by 1, recorded as two ResourceChanged events (consume, then increase)", () => {
    const ally = unit("ALLY_1", "ALLY", {
      limits: { maximumAp: 1, maximumExtraGauge: 10 },
      currentExtraGauge: 3,
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      NO_SKILLS,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.currentExtraGauge).toBe(4);

    const events = ctx.recorder.getEvents();
    const actionStarted = events.find(
      (e) => e.eventType === "ActionStarted" && e.sourceUnitId === ally.battleUnitId,
    )!;
    expect(actionStarted.stateDelta).toBeUndefined();

    const resourceChanged = events.filter(
      (e): e is Extract<typeof e, { eventType: "ResourceChanged" }> =>
        e.eventType === "ResourceChanged" && e.sourceUnitId === ally.battleUnitId,
    );
    expect(
      resourceChanged.map((e) => ({ resource: e.payload.resource, reason: e.payload.reason })),
    ).toEqual([
      { resource: "AP", reason: "WAIT_COST" },
      { resource: "EX_GAUGE", reason: "EX_GAIN" },
    ]);
    expect(resourceChanged[0]!.payload).toMatchObject({ before: 1, after: 0, delta: -1 });
    expect(resourceChanged[1]!.payload).toMatchObject({ before: 3, after: 4, delta: 1 });
  });

  it("UT-R-ACT-04-012 (G-05, M7-002 Issue #185, full stack): a held APPLY_RESOURCE_GAIN_MOD(EX_GAUGE, +100%) doubles a normal wait's EX gain, and ResourceChanged's baseDelta (the raw, pre-Modifier amount) differs from the final delta", () => {
    const gainModDefId = createEffectActionDefinitionId("ACT_EX_GAIN_BUFF");
    const gainModDef: EffectActionDefinition = {
      effectActionDefinitionId: gainModDefId,
      kind: "APPLY_RESOURCE_GAIN_MOD",
      payload: {
        resource: "EX_GAUGE",
        rateDelta: { kind: "CONSTANT", value: 1.0 },
        stacking: { mode: "STACKABLE" },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      metadata: { tags: [] },
    };
    const gainModEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("gain-mod-1"),
      effectActionDefinitionId: gainModDefId,
      kindKey: effectKindKeyFromDefinitionId(gainModDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ALLY_1"),
      targetUnitId: createBattleUnitId("ALLY_1"),
      magnitude: 1.0,
      categories: ["BUFF"],
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const ally = {
      ...unit("ALLY_1", "ALLY", {
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentExtraGauge: 3,
      }),
      appliedEffects: [gainModEffect],
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);
    const definitions = definitionsOf(new Map(), new Map([[gainModDefId, gainModDef]]));

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // Base EX gain (1, matching the AP consumed) doubled by the +100% rate to 2.
    expect(result.allyUnits[0]!.currentExtraGauge).toBe(5);

    const exResourceChanged = ctx.recorder
      .getEvents()
      .find(
        (e): e is Extract<typeof e, { eventType: "ResourceChanged" }> =>
          e.eventType === "ResourceChanged" &&
          e.sourceUnitId === ally.battleUnitId &&
          e.payload.resource === "EX_GAUGE",
      )!;
    expect(exResourceChanged.payload).toMatchObject({
      before: 3,
      after: 5,
      delta: 2,
      baseDelta: 1,
    });
  });

  it("UT-R-HEAL-03-002 (M7-005 Issue #184, full stack): a held APPLY_CONTINUOUS_HEAL heals its owner at the owner's own ActionStarted, and the HealApplied StateDelta reconstructs the same HP through the independent Reducer", () => {
    const hotDefId = createEffectActionDefinitionId("ACT_HOT");
    const hotDef: EffectActionDefinition = {
      effectActionDefinitionId: hotDefId,
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    const hotEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("hot-1"),
      effectActionDefinitionId: hotDefId,
      kindKey: effectKindKeyFromDefinitionId(hotDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ALLY_1"),
      targetUnitId: createBattleUnitId("ALLY_1"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
      },
      appliedTurnNumber: 1,
    };
    const ally = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 }, maximumHp: 100, currentHp: 40 }),
      appliedEffects: [hotEffect],
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);
    const definitions = definitionsOf(new Map(), new Map([[hotDefId, hotDef]]));

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // The unit has no usable AS, so it waits — but the continuous heal still
    // fires at its own ActionStarted (maximumHp 100 * 0.1 = 10).
    expect(result.allyUnits[0]!.currentHp).toBe(50);

    const healApplied = ctx.recorder
      .getEvents()
      .find(
        (e): e is Extract<typeof e, { eventType: "HealApplied" }> => e.eventType === "HealApplied",
      )!;
    expect(healApplied.payload).toMatchObject({
      effectActionDefinitionId: hotDefId,
      targetUnitId: ally.battleUnitId,
      healAmount: 10,
      appliedAmount: 10,
      hpBefore: 40,
      hpAfter: 50,
    });

    const restored = reduceStateDeltas(
      {
        status: "RUNNING",
        currentTurn: 1,
        units: {
          [ally.battleUnitId]: {
            ap: 1,
            pp: 3,
            hp: 40,
            extraGauge: 0,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: ally.combatStats,
            baseCombatStats: ally.combatStats,
            effects: [toEffectSnapshot(hotEffect, true)],
          },
          [enemy.battleUnitId]: {
            ap: 0,
            pp: 3,
            hp: 100,
            extraGauge: 0,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: enemy.combatStats,
            baseCombatStats: enemy.combatStats,
          },
        },
      },
      ctx.recorder
        .getEvents()
        .filter((e) => e.stateDelta !== undefined)
        .map((e) => e.stateDelta!),
    );
    expect(restored.units[ally.battleUnitId]!.hp).toBe(50);
  });

  it("UT-R-HEAL-03-005: the HealApplied a continuous heal emits during a WAIT reaches the PS chain, so a PS triggered by HealApplied activates on the wait path too — not only on the AS/EX path", () => {
    const hotDefId = createEffectActionDefinitionId("ACT_HOT");
    const hotDef: EffectActionDefinition = {
      effectActionDefinitionId: hotDefId,
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    const hotEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("hot-1"),
      effectActionDefinitionId: hotDefId,
      kindKey: effectKindKeyFromDefinitionId(hotDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ALLY_1"),
      targetUnitId: createBattleUnitId("ALLY_1"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
      },
      appliedTurnNumber: 1,
    };
    // The healed unit waits (no usable AS), so its continuous heal fires on the
    // WAIT path; a second ally holds a PS that triggers on HealApplied.
    const healed = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 }, maximumHp: 100, currentHp: 40 }),
      appliedEffects: [hotEffect],
    };
    const observerUnitDefinitionId = createUnitDefinitionId("UNIT_HEAL_OBSERVER");
    const observer = {
      ...unit("ALLY_2", "ALLY", {
        unitDefinitionId: "UNIT_HEAL_OBSERVER",
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });

    const buffActionId = createEffectActionDefinitionId("ACT_OBSERVER_SELF_BUFF");
    const buffAction = statModEffectAction("ACT_OBSERVER_SELF_BUFF", "ATTACK", "FIXED", 5);
    const observerPassive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_HEAL_APPLIED"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "HealApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: buffActionId }],
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
      metadata: { displayName: "OnHealApplied", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap();
    unitDefinitions.set(observerUnitDefinitionId, {
      ...unitDefinitions.get(observerUnitDefinitionId)!,
      passiveSkillDefinitionIds: [observerPassive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [hotDefId, hotDef],
        [buffActionId, buffAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[observerPassive.skillDefinitionId, observerPassive]]),
    };

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [healed, observer],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits.find((u) => u.battleUnitId === healed.battleUnitId)!.currentHp).toBe(
      50,
    );
    const healApplied = ctx.recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    const passiveActivated = ctx.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "PassiveActivated" &&
          (e.payload as { skillDefinitionId: string }).skillDefinitionId ===
            observerPassive.skillDefinitionId,
      );
    expect(passiveActivated, "the PS must activate from the wait-path HealApplied").toBeDefined();
    expect(passiveActivated!.payload).toMatchObject({ triggerEventId: healApplied.eventId });
  });

  it("UT-R-DOT-01-005 (DMG-008 Issue #189, full stack): a held APPLY_CONTINUOUS_DAMAGE damages its owner at the owner's own ActionStarted, and the ContinuousDamageApplied StateDelta reconstructs the same HP through the independent Reducer", () => {
    const dotDefId = createEffectActionDefinitionId("ACT_DOT");
    const dotDef: EffectActionDefinition = {
      effectActionDefinitionId: dotDefId,
      kind: "APPLY_CONTINUOUS_DAMAGE",
      payload: {
        continuousDamageKind: "FIXED",
        damageType: "PHYSICAL",
        formula: {
          kind: "STAT_RATIO",
          source: { kind: "SKILL_SOURCE" },
          stat: "ATTACK",
          ratio: 0.3,
        },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    // R-DOT-01: 付与時の付与者攻撃力（100）× 30% = 30 を付与時に焼き込んである。
    const dotEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("dot-1"),
      effectActionDefinitionId: dotDefId,
      kindKey: effectKindKeyFromDefinitionId(dotDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ENEMY_1"),
      targetUnitId: createBattleUnitId("ALLY_1"),
      magnitude: 30,
      categories: ["DEBUFF"],
      continuousDamage: { continuousDamageKind: "FIXED", damageType: "PHYSICAL" },
      snapshot: { sourceAttack: 100 },
      duration: {
        definition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
      },
      appliedTurnNumber: 1,
    };
    const ally = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 }, maximumHp: 100, currentHp: 80 }),
      appliedEffects: [dotEffect],
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);
    const definitions = definitionsOf(new Map(), new Map([[dotDefId, dotDef]]));

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // 使えるASが無いので待機するが、継続ダメージは保持者自身のActionStartedで発生する。
    expect(result.allyUnits[0]!.currentHp).toBe(50);

    const applied = ctx.recorder
      .getEvents()
      .find(
        (e): e is Extract<typeof e, { eventType: "ContinuousDamageApplied" }> =>
          e.eventType === "ContinuousDamageApplied",
      )!;
    expect(applied.payload).toMatchObject({
      effectActionDefinitionId: dotDefId,
      continuousDamageKind: "FIXED",
      targetUnitId: ally.battleUnitId,
      snapshotAttack: 100,
      calculatedDamage: 30,
      hitPointDamage: 30,
      hpBefore: 80,
      hpAfter: 50,
      defeated: false,
    });
    // 攻撃ダメージとは別種別のイベントとして記録する（R-STS-03の区別）。
    expect(ctx.recorder.getEvents().some((e) => e.eventType === "DamageApplied")).toBe(false);

    const restored = reduceStateDeltas(
      {
        status: "RUNNING",
        currentTurn: 1,
        units: {
          [ally.battleUnitId]: {
            ap: 1,
            pp: 3,
            hp: 80,
            extraGauge: 0,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: ally.combatStats,
            baseCombatStats: ally.combatStats,
            effects: [toEffectSnapshot(dotEffect, true)],
          },
          [enemy.battleUnitId]: {
            ap: 0,
            pp: 3,
            hp: 100,
            extraGauge: 0,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: enemy.combatStats,
            baseCombatStats: enemy.combatStats,
          },
        },
      },
      ctx.recorder
        .getEvents()
        .filter((e) => e.stateDelta !== undefined)
        .map((e) => e.stateDelta!),
    );
    expect(restored.units[ally.battleUnitId]!.hp).toBe(50);
  });

  it("UT-R-HEAL-03-006 (START_EVENT #4): when a PS chained off the start-of-action HealApplied defeats the actor, the action body is skipped and the action proceeds straight to COMPLETING", () => {
    const hotDefId = createEffectActionDefinitionId("ACT_HOT");
    const hotDef: EffectActionDefinition = {
      effectActionDefinitionId: hotDefId,
      kind: "APPLY_CONTINUOUS_HEAL",
      payload: {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
      metadata: { tags: [] },
    };
    const hotEffect: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("hot-1"),
      effectActionDefinitionId: hotDefId,
      kindKey: effectKindKeyFromDefinitionId(hotDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ALLY_1"),
      targetUnitId: createBattleUnitId("ALLY_1"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 2,
      },
      appliedTurnNumber: 1,
    };
    // The acting ally holds the continuous heal and has no usable AS, so it
    // would normally wait. An enemy PS triggered by HealApplied kills it first.
    const healed = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 }, maximumHp: 100, currentHp: 40 }),
      appliedEffects: [hotEffect],
    };
    const killerUnitDefinitionId = createUnitDefinitionId("UNIT_HEAL_PUNISHER");
    const killer = {
      ...unit("ENEMY_1", "ENEMY", {
        unitDefinitionId: "UNIT_HEAL_PUNISHER",
        attack: 10000,
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };

    const killActionId = createEffectActionDefinitionId("ACT_PUNISH_HEAL");
    const killAction = damageEffectAction("ACT_PUNISH_HEAL");
    const killerPassive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_PUNISH_HEAL"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "HealApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_ENEMY"), selector: ENEMY_NEAREST },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ENEMY") },
            actions: [{ effectActionDefinitionId: killActionId }],
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
      metadata: { displayName: "PunishHeal", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap();
    unitDefinitions.set(killerUnitDefinitionId, {
      ...unitDefinitions.get(killerUnitDefinitionId)!,
      passiveSkillDefinitionIds: [killerPassive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [hotDefId, hotDef],
        [killActionId, killAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[killerPassive.skillDefinitionId, killerPassive]]),
    };

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [healed],
      [killer],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "HealApplied")).toBe(true);
    expect(
      events.some(
        (e) => e.eventType === "UnitDefeated" && e.payload.unitId === healed.battleUnitId,
      ),
      "the chained PS must actually defeat the actor",
    ).toBe(true);
    // START_EVENT #4: the body (`ActionWaited`) must not run, but the action
    // must still be completed rather than left dangling.
    expect(
      events.some((e) => e.eventType === "ActionWaited"),
      "the action body must be skipped once the actor is defeated at start of action",
    ).toBe(false);
    expect(events.some((e) => e.eventType === "ActionCompleted")).toBe(true);
  });

  it("UT-ACTION-PHASE-002: a usable AS skill consumes its AP cost and applies DAMAGE to the target", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.enemyUnits[0]!.currentHp).toBe(80);
    expect(result.result).toBeUndefined();
  });

  it("UT-R-DMG-05-007 (R-DMG-05 #2/#3): an AS DAMAGE's own HitConfirmed and CriticalCheckResolved reach the PS chain, so a PS triggered by them activates during the real AS path (production例: SKL_LAYLA_ENTREPRENEUR_PS2 / SKL_EVIE_KYONSHI_PS1 / SKL_SAYA_BUNNY_PS1)", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_CRIT_ATTACKER");
    const observerUnitDefinitionId = createUnitDefinitionId("UNIT_CRIT_OBSERVER");
    const attackAction = damageEffectAction("ACT_CRIT_ATTACK", "GUARANTEED");
    const buffActionId = createEffectActionDefinitionId("ACT_CRIT_OBSERVER_BUFF");
    const buffAction = statModEffectAction("ACT_CRIT_OBSERVER_BUFF", "ATTACK", "FIXED", 5);

    const observerPassiveOf = (
      skillDefinitionId: string,
      eventType: "HitConfirmed" | "CriticalCheckResolved",
    ): SkillDefinition => ({
      skillDefinitionId: createSkillDefinitionId(skillDefinitionId),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType,
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      // `SKL_LAYLA_ENTREPRENEUR_PS2`と同じ形のSKILL_RUNTIME counter — PS発動とは
      // 別機構だが、同じ`PassiveActivationRuntime.onFactEvent`経由で検出されるため
      // 原因イベントが連鎖へ届かないと同様に更新されない。
      counterUpdates:
        eventType === "CriticalCheckResolved"
          ? [
              {
                kind: "INCREMENT",
                counter: createRuntimeCounterId("CRIT_TRIGGER_COUNT"),
                scope: "SKILL_RUNTIME",
                trigger: {
                  eventType,
                  category: "FACT",
                  sourceSelector: "ANY",
                  targetSelector: "ANY",
                  condition: { kind: "TRUE" },
                },
                amount: 1,
              },
            ]
          : [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: buffActionId }],
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
      metadata: { displayName: eventType, tags: [] },
    });
    const onHitConfirmed = observerPassiveOf("SKL_PS_ON_HIT_CONFIRMED", "HitConfirmed");
    const onCriticalCheckResolved = observerPassiveOf(
      "SKL_PS_ON_CRITICAL_CHECK_RESOLVED",
      "CriticalCheckResolved",
    );

    const attacker = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CRIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const observer = {
      ...unit("ALLY_2", "ALLY", {
        unitDefinitionId: "UNIT_CRIT_OBSERVER",
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 500,
      limits: { maximumAp: 0 },
    });

    const unitDefinitions = new DefaultUnitDefinitionMap();
    unitDefinitions.set(observerUnitDefinitionId, {
      ...unitDefinitions.get(observerUnitDefinitionId)!,
      passiveSkillDefinitionIds: [
        onHitConfirmed.skillDefinitionId,
        onCriticalCheckResolved.skillDefinitionId,
      ],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([
        [attackerUnitDefinitionId, [attackSkill("ACT_CRIT_ATTACK", 1)]],
      ]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [attackAction.effectActionDefinitionId, attackAction],
        [buffActionId, buffAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([
        [onHitConfirmed.skillDefinitionId, onHitConfirmed],
        [onCriticalCheckResolved.skillDefinitionId, onCriticalCheckResolved],
      ]),
    };

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [attacker, observer],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const activatedFor = (skill: SkillDefinition): (typeof events)[number] | undefined =>
      events.find(
        (event) =>
          event.eventType === "PassiveActivated" &&
          (event.payload as { skillDefinitionId: string }).skillDefinitionId ===
            skill.skillDefinitionId,
      );

    const hitConfirmed = events.find((event) => event.eventType === "HitConfirmed")!;
    const criticalCheckResolved = events.find(
      (event) => event.eventType === "CriticalCheckResolved",
    )!;
    expect(
      activatedFor(onHitConfirmed),
      "a PS triggered by the DAMAGE's own HitConfirmed must activate on the AS path",
    ).toBeDefined();
    expect(activatedFor(onHitConfirmed)!.payload).toMatchObject({
      triggerEventId: hitConfirmed.eventId,
    });
    expect(
      activatedFor(onCriticalCheckResolved),
      "a PS triggered by the DAMAGE's own CriticalCheckResolved must activate on the AS path",
    ).toBeDefined();
    expect(activatedFor(onCriticalCheckResolved)!.payload).toMatchObject({
      triggerEventId: criticalCheckResolved.eventId,
    });
    // Laylaの`SKL_LAYLA_ENTREPRENEUR_PS2_TRIGGER_COUNT`と同じSKILL_RUNTIME counter。
    expect(
      events.find(
        (event) =>
          event.eventType === "RuntimeCounterChanged" &&
          (event.payload as { counter: string }).counter ===
            createRuntimeCounterId("CRIT_TRIGGER_COUNT"),
      ),
      "a SKILL_RUNTIME counter keyed off CriticalCheckResolved must update on the AS path",
    ).toBeDefined();
  });

  /**
   * R-ATM-01「検出は各イベント発行時点の状態で照合する」+ R-PS-04の発動直前確認:
   * 保留キューから発動する候補のtrigger条件`RUNTIME_COUNTER`は候補検出時点の値で
   * 判定する。`SKL_LAYLA_ENTREPRENEUR_PS2`と同じ形（`CriticalCheckResolved`で
   * SKILL_RUNTIME counterを加算し、N到達をtrigger条件のゲートにする）を多段ヒットの
   * 全ヒット会心で流す。保留中もcounter加算は即時に確定する（R-ATM-01の状態保守）
   * ため、N到達が最後の会心でない限り再確認時の最新値はゲートを外れる。
   */
  const resolveGuaranteedCriticalHits = (
    hitCount: number,
    gate: number,
  ): {
    readonly events: readonly ReturnType<EventRecorder["record"]>[];
    readonly observerPassive: SkillDefinition;
  } => {
    const counterId = createRuntimeCounterId("CRIT_TRIGGER_COUNT");
    const attackActionId = "ACT_CRIT_MULTI_HIT";
    const attackAction: EffectActionDefinition = {
      kind: "DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(attackActionId),
      metadata: { tags: [] },
      payload: {
        damageType: "PHYSICAL",
        formula: { kind: "SKILL_POWER", power: 1 },
        hitCount,
        critical: { mode: "GUARANTEED" },
        accuracy: { mode: "NORMAL" },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
        damageModifiers: [],
        link: { enabled: false },
      },
    };
    const buffActionId = createEffectActionDefinitionId("ACT_CRIT_OBSERVER_BUFF");
    const buffAction = statModEffectAction("ACT_CRIT_OBSERVER_BUFF", "ATTACK", "FIXED", 5);
    const criticalTrigger = {
      eventType: "CriticalCheckResolved",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
      condition: { kind: "TRUE" },
    } as const;
    const observerPassive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_PS_ON_NTH_CRITICAL"),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          ...criticalTrigger,
          condition: { kind: "RUNTIME_COUNTER", counter: counterId, op: "EQ", value: gate },
        },
      ],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: criticalTrigger,
          amount: 1,
        },
      ],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: buffActionId }],
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
      metadata: { displayName: "NthCritical", tags: [] },
    };

    const attacker = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CRIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const observer = {
      ...unit("ALLY_2", "ALLY", {
        unitDefinitionId: "UNIT_CRIT_OBSERVER",
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 2000,
      limits: { maximumAp: 0 },
    });

    const unitDefinitions = new DefaultUnitDefinitionMap();
    const observerUnitDefinitionId = createUnitDefinitionId("UNIT_CRIT_OBSERVER");
    unitDefinitions.set(observerUnitDefinitionId, {
      ...unitDefinitions.get(observerUnitDefinitionId)!,
      passiveSkillDefinitionIds: [observerPassive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([
        [createUnitDefinitionId("UNIT_CRIT_ATTACKER"), [attackSkill(attackActionId, 1)]],
      ]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [attackAction.effectActionDefinitionId, attackAction],
        [buffActionId, buffAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[observerPassive.skillDefinitionId, observerPassive]]),
    };

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [attacker, observer],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );
    return { events: ctx.recorder.getEvents(), observerPassive };
  };

  const expectActivatedOnNthCritical = (hitCount: number, gate: number): void => {
    const { events, observerPassive } = resolveGuaranteedCriticalHits(hitCount, gate);
    const criticalChecks = events.filter((event) => event.eventType === "CriticalCheckResolved");
    expect(criticalChecks).toHaveLength(hitCount);
    const activations = events.filter(
      (event) =>
        event.eventType === "PassiveActivated" &&
        (event.payload as { skillDefinitionId: string }).skillDefinitionId ===
          observerPassive.skillDefinitionId,
    );
    expect(
      activations,
      "a pending candidate gated on the Nth critical must activate even when later criticals moved the counter past N",
    ).toHaveLength(1);
    expect(activations[0]!.payload).toMatchObject({
      triggerEventId: criticalChecks[gate - 1]!.eventId,
    });
  };

  it("UT-R-ATM-01-008 (R-PS-04): a pending PS gated on RUNTIME_COUNTER EQ N activates when N is reached on the 2nd of 4 guaranteed-critical hits (production例: SKL_LAYLA_ENTREPRENEUR_PS2 + 四連突)", () => {
    expectActivatedOnNthCritical(4, 2);
  });

  it("UT-R-ATM-01-009 (R-PS-04): a pending PS gated on RUNTIME_COUNTER EQ N activates when N is reached on the 4th of 5 guaranteed-critical hits", () => {
    expectActivatedOnNthCritical(5, 4);
  });

  /**
   * `HitConfirmed`/`CriticalCheckResolved`の子連鎖が対象を
   * 倒した場合、親ヒットは「次の判定・イベントへ進む前に」終了しなければならない。
   * production例: `SKL_EVIE_KYONSHI_PS1`・`SKL_LAYLA_ENTREPRENEUR_PS2`はどちらも
   * `CriticalCheckResolved`起点でDAMAGEを行う。
   */
  function lethalObserverChainSetup(triggerEventType: "HitConfirmed" | "CriticalCheckResolved") {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_LETHAL_ATTACKER");
    const observerUnitDefinitionId = createUnitDefinitionId("UNIT_LETHAL_OBSERVER");
    const attackAction = damageEffectAction("ACT_LETHAL_PARENT_ATTACK", "GUARANTEED");
    const observerAction = damageEffectAction("ACT_LETHAL_OBSERVER_DAMAGE", "PREVENTED");

    const observerPassive: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId(`SKL_PS_LETHAL_ON_${triggerEventType}`),
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: triggerEventType,
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_LETHAL"), selector: ENEMY_ALL },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_LETHAL") },
            actions: [{ effectActionDefinitionId: observerAction.effectActionDefinitionId }],
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
      metadata: { displayName: `Lethal on ${triggerEventType}`, tags: [] },
    };

    const attacker = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_LETHAL_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const observer = {
      ...unit("ALLY_2", "ALLY", {
        unitDefinitionId: "UNIT_LETHAL_OBSERVER",
        attack: 999,
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 40,
      limits: { maximumAp: 0 },
    });

    const unitDefinitions = new DefaultUnitDefinitionMap();
    unitDefinitions.set(observerUnitDefinitionId, {
      ...unitDefinitions.get(observerUnitDefinitionId)!,
      passiveSkillDefinitionIds: [observerPassive.skillDefinitionId],
    });
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([
        [attackerUnitDefinitionId, [attackSkill("ACT_LETHAL_PARENT_ATTACK", 1)]],
      ]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [attackAction.effectActionDefinitionId, attackAction],
        [observerAction.effectActionDefinitionId, observerAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[observerPassive.skillDefinitionId, observerPassive]]),
    };

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [attacker, observer],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );
    // `CriticalCheckResolved`のpayloadは`effectActionDefinitionId`を持たないため、
    // 親（ALLY_1のAS）と子（ALLY_2のPS）の区別は`sourceUnitId`で行う。
    const eventsOfParent = (eventType: string): number =>
      ctx.recorder
        .getEvents()
        .filter(
          (event) =>
            event.eventType === eventType && event.sourceUnitId === createBattleUnitId("ALLY_1"),
        ).length;
    return { ctx, result, eventsOfParent };
  }

  it("UT-R-DMG-05-008 (R-ATM-01): a PS reacting to an AS DAMAGE's CriticalCheckResolved no longer cancels the parent hit — the hit runs its full R-DMG-05 sequence and the reacting PS lands after SkillUseCompleted (production shape: SKL_EVIE_KYONSHI_PS1 / SKL_LAYLA_ENTREPRENEUR_PS2 deal DAMAGE from CriticalCheckResolved)", () => {
    const { ctx, result, eventsOfParent } = lethalObserverChainSetup("CriticalCheckResolved");

    // 旧仕様では会心判定の直後にPSが割り込んで対象を倒し、親のヒットが
    // `DamageWillBeApplied`へ到達しなかった。R-ATM-01の保留方式ではその経路が消え、
    // 親のヒットは最後まで解決する。
    expect(eventsOfParent("CriticalCheckResolved")).toBe(1);
    expect(eventsOfParent("DamageWillBeApplied")).toBe(1);
    expect(eventsOfParent("DamageCalculated")).toBe(1);
    expect(eventsOfParent("DamageApplied")).toBe(1);

    const events = ctx.recorder.getEvents();
    const completedIndex = events.findIndex((event) => event.eventType === "SkillUseCompleted");
    const observerActivatedIndex = events.findIndex(
      (event) =>
        event.eventType === "PassiveActivated" &&
        event.sourceUnitId === createBattleUnitId("ALLY_2"),
    );
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(observerActivatedIndex).toBeGreaterThan(completedIndex);
    expect(events.filter((event) => event.eventType === "UnitDefeated")).toHaveLength(1);
    expect(result.enemyUnits[0]!.currentHp).toBe(0);
  });

  it("UT-R-DMG-05-009 (R-ATM-01): a PS reacting to an AS DAMAGE's HitConfirmed no longer cancels the parent hit — the critical check and the rest of R-DMG-05 still run for it", () => {
    const { ctx, result, eventsOfParent } = lethalObserverChainSetup("HitConfirmed");

    expect(eventsOfParent("HitConfirmed")).toBe(1);
    expect(eventsOfParent("CriticalCheckResolved")).toBe(1);
    expect(eventsOfParent("DamageWillBeApplied")).toBe(1);
    expect(eventsOfParent("DamageApplied")).toBe(1);

    const events = ctx.recorder.getEvents();
    const completedIndex = events.findIndex((event) => event.eventType === "SkillUseCompleted");
    const observerActivatedIndex = events.findIndex(
      (event) =>
        event.eventType === "PassiveActivated" &&
        event.sourceUnitId === createBattleUnitId("ALLY_2"),
    );
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(observerActivatedIndex).toBeGreaterThan(completedIndex);
    expect(events.filter((event) => event.eventType === "UnitDefeated")).toHaveLength(1);
    expect(result.enemyUnits[0]!.currentHp).toBe(0);
  });

  it("UT-R-ACT-03-005: an AS use increases the EX gauge by the same amount as the AP consumed", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1, maximumExtraGauge: 100 },
      currentExtraGauge: 10,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.currentExtraGauge).toBe(11);
  });

  it("UT-R-ACT-04-001: ActionStarted no longer owns the AP/EX stateDelta directly; ResourceChanged owns it instead (consume-then-increase order), and reduceStateDeltas still restores the exact same finalState", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 1, maximumExtraGauge: 100 },
      currentExtraGauge: 10,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const actionStarted = events.find(
      (e) => e.eventType === "ActionStarted" && e.sourceUnitId === ally.battleUnitId,
    )!;
    expect(actionStarted.stateDelta).toBeUndefined();

    const resourceChanged = events.filter(
      (e): e is Extract<typeof e, { eventType: "ResourceChanged" }> =>
        e.eventType === "ResourceChanged" && e.sourceUnitId === ally.battleUnitId,
    );
    expect(
      resourceChanged.map((e) => ({ resource: e.payload.resource, reason: e.payload.reason })),
    ).toEqual([
      { resource: "AP", reason: "SKILL_COST" },
      { resource: "EX_GAUGE", reason: "EX_GAIN" },
    ]);
    expect(resourceChanged[0]!.payload).toMatchObject({ before: 1, after: 0, delta: -1 });
    expect(resourceChanged[1]!.payload).toMatchObject({ before: 10, after: 11, delta: 1 });
    expect(resourceChanged[0]!.stateDelta).toEqual({
      units: { [ally.battleUnitId]: { ap: { before: 1, after: 0 } } },
    });
    expect(resourceChanged[1]!.stateDelta).toEqual({
      units: { [ally.battleUnitId]: { extraGauge: { before: 10, after: 11 } } },
    });

    const stateTransitions = events
      .filter((e) => e.stateDelta !== undefined)
      .map((e) => e.stateDelta!);
    const restored = reduceStateDeltas(
      {
        status: "RUNNING",
        currentTurn: 1,
        units: {
          [ally.battleUnitId]: {
            ap: 1,
            pp: 3,
            hp: 100,
            extraGauge: 10,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: ally.combatStats,
            baseCombatStats: ally.combatStats,
          },
          [enemy.battleUnitId]: {
            ap: 0,
            pp: 3,
            hp: 100,
            extraGauge: 0,
            maximumAp: 3,
            maximumPp: 3,
            maximumExtraGauge: 10,
            combatStats: enemy.combatStats,
            baseCombatStats: enemy.combatStats,
          },
        },
      },
      stateTransitions,
    );
    expect(restored.units[ally.battleUnitId]!.ap).toBe(0);
    expect(restored.units[ally.battleUnitId]!.extraGauge).toBe(11);
    expect(restored.units[enemy.battleUnitId]!.hp).toBe(80);
  });

  it("UT-R-ACT-04-002: an AS's EX gain that would overflow the max is clamped, and ExtraGaugeOverflowDiscarded reports the requested/actual/discarded split", () => {
    // EX gauge must stay below max *before* the action starts, otherwise
    // `reservedActionKindOf` (action-queue.ts) reserves EX instead of AS for
    // this unit (R-ORD-03) — so a full-overflow-to-zero-actual-increase case
    // can't be reached through an AS's own EX gain; that zero-delta path is
    // covered at the resource-consumption helper's unit level instead.
    // The enemy has just enough HP to be defeated by this single hit, so the
    // gauge reaching max (which would otherwise re-queue the ally for an EX
    // action next cycle, per R-ORD-03) never gets a chance to matter here.
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 30,
      limits: { maximumAp: 3, maximumExtraGauge: 5 },
      currentAp: 3,
      currentExtraGauge: 4,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 20,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 3)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(5);

    const events = ctx.recorder.getEvents();
    const exResourceChanged = events.find(
      (e) =>
        e.eventType === "ResourceChanged" &&
        e.sourceUnitId === ally.battleUnitId &&
        e.payload.resource === "EX_GAUGE",
    )!;
    expect(exResourceChanged.payload).toMatchObject({ before: 4, after: 5, delta: 1 });

    const overflowDiscarded = events.find(
      (e) => e.eventType === "ExtraGaugeOverflowDiscarded" && e.sourceUnitId === ally.battleUnitId,
    )!;
    expect(overflowDiscarded.payload).toEqual({
      battleUnitId: ally.battleUnitId,
      baseDelta: 3,
      requestedAmount: 3,
      actualAmount: 1,
      discardedAmount: 2,
    });
  });

  it("UT-ACTION-PHASE-003 (R-END-01 timing #1): resolving victory mid-phase stops processing the remaining queue immediately", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER");
    // ALLY_1 acts first (higher actionSpeed) and one-shots the only enemy; ALLY_2 must never get to act.
    const allyFast = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    const allySlow = unit("ALLY_2", "ALLY", { actionSpeed: 5, limits: { maximumAp: 1 } });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 10, limits: { maximumAp: 0 } });
    const effectAction = damageEffectAction("ACT_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [allyFast, allySlow],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.result).toEqual({ outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" });
    const updatedSlowAlly = result.allyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ALLY_2"),
    )!;
    expect(updatedSlowAlly.currentAp).toBe(1); // untouched: the phase stopped before ALLY_2's turn.
  });

  it("UT-R-ORD-04-001 (real lifecycle wiring): when an action's APPLY_STAT_MOD changes a remaining unit's actionSpeed, the queue reorders and emits ActionQueueReordered with the before/after speeds", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SPEED_BUFFER");
    // ALLY_1 acts first (faster) and buffs every ally's ACTION_SPEED, including
    // ALLY_2's — the only unit still waiting in this cycle's queue.
    const allyFast = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SPEED_BUFFER",
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    const allySlow = unit("ALLY_2", "ALLY", { actionSpeed: 5, limits: { maximumAp: 1 } });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const speedBuff = statModEffectAction("ACT_SPEED_BUFF", "ACTION_SPEED", "FIXED", 50);
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_SPEED_BUFF", 1, ALLY_ALL)]]]),
      new Map([[speedBuff.effectActionDefinitionId, speedBuff]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [allyFast, allySlow],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedSlowAlly = result.allyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ALLY_2"),
    )!;
    expect(updatedSlowAlly.combatStats.actionSpeed).toBe(55);

    const reordered = ctx.recorder.getEvents().find((e) => e.eventType === "ActionQueueReordered")!;
    expect(reordered.payload).toEqual({
      before: [{ battleUnitId: allySlow.battleUnitId, actionSpeed: 5 }],
      after: [{ battleUnitId: allySlow.battleUnitId, actionSpeed: 55 }],
    });
  });

  // DMG-006（Issue #188）: `APPLY_COVER`は`UT-ACTION-PHASE-004`が「このresolverが
  // まだ実装していないkind」の代表として使っていたが、R-INT-01〜03の配線で実装済みに
  // なった。同じ定義を使い、実ライフサイクルで`AppliedEffect.cover`が付与されることを
  // 検証するテストへ置き換える（`EFFECT_ACTION_KINDS`はこれで全kindが実装済みになり、
  // 未実装kindを表せる定義自体が存在しなくなった）。
  it("UT-R-INT-02-001 (DMG-006, Issue #188): grants APPLY_COVER as an AppliedEffect carrying the coverer resolved at grant time through the real action lifecycle", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_COVERER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_COVERER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const effectAction = coverEffectAction("ACT_COVER");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_COVER", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const holder = result.enemyUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(1);
    // `coverer: SELF`は付与時点で使用者（ALLY_1）へ解決して焼き込む。
    expect(holder.appliedEffects[0]!.cover).toEqual({
      covererUnitId: ally.battleUnitId,
      damageShareRate: 1,
      guardRate: 0,
      actionKinds: ["ANY"],
    });
    // R-INT-01/02: 攻撃側が保持する介入状態はデバフに分類する。
    expect(holder.appliedEffects[0]!.categories).toEqual(["DEBUFF"]);
  });

  it("UT-R-SHD-01-010 (DMG-004, Issue #194): grants APPLY_SHIELD as an AppliedEffect carrying an untyped pool through the real action lifecycle", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SHIELDER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SHIELDER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const effectAction = shieldEffectAction("ACT_SHIELD");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_SHIELD", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const shielded = result.enemyUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(shielded.appliedEffects).toHaveLength(1);
    expect(shielded.appliedEffects[0]!.shield).toEqual({ shieldType: null, remaining: 10 });
    expect(shielded.appliedEffects[0]!.magnitude).toBe(10);
  });

  it("UT-R-SUB-01-006 (DMG-005, Issue #190): grants APPLY_SUBUNIT as an AppliedEffect carrying durability and the provider attack snapshot through the real action lifecycle", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SUBUNITER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SUBUNITER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const effectAction = subUnitEffectAction("ACT_SUBUNIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_SUBUNIT", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const holder = result.enemyUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(1);
    expect(holder.appliedEffects[0]!.subUnit?.durability).toBe(10);
    expect(holder.appliedEffects[0]!.magnitude).toBe(10);
    // R-SUB-02: 付与者（使用者）の付与時攻撃力をsnapshotとして焼き込む。
    expect(holder.appliedEffects[0]!.snapshot?.[SUBUNIT_PROVIDER_ATTACK_KEY]).toBe(
      ally.combatStats.attack,
    );
    expect(holder.appliedEffects[0]!.categories).toContain("SUBUNIT");
  });

  it("UT-R-SUB-01-007 (DMG-005, Issue #190, R-SUB-01): a subunit whose granted durability truncates to zero expires immediately instead of lingering", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SUBUNITER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SUBUNITER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const effectAction = subUnitEffectAction("ACT_SUBUNIT", 0.5);
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_SUBUNIT", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const holder = result.enemyUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(holder.appliedEffects).toHaveLength(0);
    const expired = ctx.recorder.getEvents().filter((event) => event.eventType === "EffectExpired");
    expect(expired.map((event) => event.payload.reason)).toEqual(["SUBUNIT_DEPLETED"]);
  });

  it("UT-R-SHD-01-014 (R-SHD-01第3項): a shield whose granted amount truncates to zero expires immediately instead of lingering as a zero-remaining instance", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SHIELDER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SHIELDER",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    // Formula結果が0.5 → R-NUM-02の切り捨てで0になる（負値も同じ扱い）。
    const effectAction = shieldEffectAction("ACT_SHIELD", 0.5);
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_SHIELD", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      new SequenceRandomSource([]),
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const shielded = result.enemyUnits.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    // 残量0のインスタンスは残さない（吸収も漸減も`remaining <= 0`を対象外にするため、
    // 残すと期間満了まで枯渇契機が訪れずlinked groupごと居座る）。
    expect(shielded.appliedEffects).toEqual([]);

    // 監査証跡としての`EffectApplied`は発行し、直後に`SHIELD_DEPLETED`で失効させる。
    const events = ctx.recorder.getEvents();
    const applied = events.find((event) => event.eventType === "EffectApplied")!;
    expect(applied.payload).toMatchObject({ magnitude: 0 });
    const expired = events.find((event) => event.eventType === "EffectExpired")!;
    expect(expired.payload).toMatchObject({
      effectInstanceId: (applied.payload as { effectInstanceId: string }).effectInstanceId,
      reason: "SHIELD_DEPLETED",
      cascaded: false,
    });
    expect(events.indexOf(applied)).toBeLessThan(events.indexOf(expired));
  });

  it("UT-ACTION-PHASE-005 (R-ACT-01 #4 / R-ACT-03 EX行): a reserved EX skill consumes the full EX gauge (not AP) and applies DAMAGE to the target", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_ATTACKER",
      attack: 30,
      limits: { maximumAp: 0, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 10,
      maximumHp: 100,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_EX_ATTACK");
    const definitions = definitionsOf(
      new Map(),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
      new Map([[unitDefinitionId, exSkill("ACT_EX_ATTACK", 50)]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0); // EX does not consume AP (R-ACT-03).
    expect(result.enemyUnits[0]!.currentHp).toBe(80);

    const actionStarted = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionStarted" && e.sourceUnitId === ally.battleUnitId)!;
    expect(actionStarted.payload).toMatchObject({
      reservedActionType: "EX",
      effectiveActionType: "EX",
      exBefore: 50,
      exAfter: 0,
    });
  });

  it("UT-ACTION-PHASE-021 (Q-EX-04 / R-ORD-03: Queue再生成後の予約種別切り替え): a unit with AP still remaining after EX drains the gauge requeues next cycle with an AS reservation and actually uses it", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_THEN_AS");
    // AP is 1 (not consumed by EX) and the EX gauge starts full: cycle 1 must
    // reserve EX (R-ORD-03), and only after the gauge drains does cycle 2's
    // fresh queue re-evaluate the reservation as AS (Q-EX-04: EX使用後にAPが
    // 残れば次の行動順QueueでASを使用できる).
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_THEN_AS",
      attack: 30,
      limits: { maximumAp: 1, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const exEffectAction = damageEffectAction("ACT_EX_ATTACK");
    const asEffectAction = damageEffectAction("ACT_AS_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_AS_ATTACK", 1)]]]),
      new Map([
        [exEffectAction.effectActionDefinitionId, exEffectAction],
        [asEffectAction.effectActionDefinitionId, asEffectAction],
      ]),
      new Map([[unitDefinitionId, exSkill("ACT_EX_ATTACK", 50)]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // R-ACT-03: the cycle-2 AS use (apCost 1) increases the EX gauge by the
    // same amount, so it doesn't stay drained at 0 (added by #34).
    expect(result.allyUnits[0]!.currentExtraGauge).toBe(1);
    expect(result.allyUnits[0]!.currentAp).toBe(0); // consumed by the AS use in cycle 2.
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 30 - 30); // one EX hit + one AS hit.

    const events = ctx.recorder.getEvents();

    const queuesCreated = events.filter((e) => e.eventType === "ActionQueueCreated");
    expect(queuesCreated.map((e) => e.payload.cycleNumber)).toEqual([1, 2]);
    expect(
      queuesCreated.map(
        (e) =>
          e.payload.reservations.find((r) => r.battleUnitId === ally.battleUnitId)
            ?.reservedActionKind,
      ),
    ).toEqual(["EX", "AS"]);

    const actionsStarted = events
      .filter((e) => e.eventType === "ActionStarted")
      .filter((e) => e.sourceUnitId === ally.battleUnitId);
    expect(
      actionsStarted.map((e) => ({
        cycleNumber: e.cycleNumber,
        reservedActionType: e.payload.reservedActionType,
        effectiveActionType: e.payload.effectiveActionType,
      })),
    ).toEqual([
      { cycleNumber: 1, reservedActionType: "EX", effectiveActionType: "EX" },
      { cycleNumber: 2, reservedActionType: "AS", effectiveActionType: "AS" },
    ]);
  });

  it("UT-ACTION-PHASE-006 (Q-BTL-06): a reserved EX skill with no resolvable target WAITs, draining the full EX gauge instead of AP", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_EX_LONELY");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_EX_LONELY",
      limits: { maximumAp: 0, maximumExtraGauge: 50 },
      currentExtraGauge: 50,
    });
    // The only enemy is already defeated, so the EX skill's enemy-target
    // selector (R-TGT-01 #2 excludes defeated units) resolves to zero candidates.
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, currentHp: 0 });
    const definitions = definitionsOf(
      new Map(),
      new Map(),
      new Map([[unitDefinitionId, exSkill("ACT_EX_UNUSED", 50)]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0);

    const waited = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId)!;
    expect(waited.payload).toEqual({
      actorUnitId: ally.battleUnitId,
      waitReason: "EX_UNUSABLE",
      consumedResource: "EX_GAUGE",
      consumedAmount: 50,
    });
  });

  it("UT-ACTION-PHASE-019 (Q-BTL-06 / R-ORD-01, Issue #517): an AS reservation whose AP is drained to 0 while its EX gauge fills in the same preceding action keeps its queue eligibility, and its NO_USABLE_ACTIVE_SKILL wait drains the full EX gauge instead of driving AP to -1", () => {
    const scenario = apDrainedWithFullGaugeScenario(10);
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      scenario.allyUnits,
      scenario.enemyUnits,
      scenario.definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const victimId = createBattleUnitId("ALLY_1");
    const events = ctx.recorder.getEvents();

    // 周回開始時点のEXゲージ（0）で予約種別はASに固定される（R-ORD-03）。
    const queuesCreated = events.filter((e) => e.eventType === "ActionQueueCreated");
    expect(
      queuesCreated[0]!.payload.reservations.find((r) => r.battleUnitId === victimId)
        ?.reservedActionKind,
    ).toBe("AS");
    // R-ORD-01: AP 0でもEXゲージ満タンなら適格のままなので、予約は除去されない。
    expect(
      events.some((e) => e.eventType === "ActionReservationRemoved" && e.sourceUnitId === victimId),
    ).toBe(false);

    const waited = events.find(
      (e) => e.eventType === "ActionWaited" && e.sourceUnitId === victimId,
    )!;
    expect(waited.payload).toEqual({
      actorUnitId: victimId,
      waitReason: "NO_USABLE_ACTIVE_SKILL",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
    });

    const victim = result.allyUnits.find((u) => u.battleUnitId === victimId)!;
    expect(victim.currentAp).toBe(0);
    expect(victim.currentExtraGauge).toBe(0);

    // AP 0・EXゲージ0になったユニットはR-ORD-01で次の周回のキューへ入らない。
    // 周回はキューが空になったこと（`maxCyclesPerTurn`の安全弁ではない）で終わる。
    expect(queuesCreated.map((e) => e.payload.cycleNumber)).toEqual([1]);
    expect(
      events.filter((e) => e.eventType === "ActionWaited" && e.sourceUnitId === victimId),
    ).toHaveLength(1);
  });

  it.each([
    // AP 0側（EXゲージ全量消費）。R-ORD-01により、AP 0で行動機会が回るのは
    // EXゲージ満タンのときだけなので、4経路ともEXゲージ満タンで組む。
    {
      waitReason: "STUNNED",
      apLabel: "AP 0",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
      build: () => stunnedOrFrozenWaitScenario("STUN", 0, 10),
    },
    {
      waitReason: "FROZEN",
      apLabel: "AP 0",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
      build: () => stunnedOrFrozenWaitScenario("FREEZE", 0, 10),
    },
    {
      waitReason: "EX_UNUSABLE",
      apLabel: "AP 0",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
      build: () => unusableExWaitScenario(0),
    },
    {
      waitReason: "NO_USABLE_ACTIVE_SKILL",
      apLabel: "AP 0",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
      build: () => apDrainedWithFullGaugeScenario(10),
    },
    // AP 1以上側（通常の待機＝AP1消費）。待機の理由が同じでもAP残量だけで
    // 消費リソースが変わることを、同じ4経路の対で固定する。
    {
      waitReason: "STUNNED",
      apLabel: "AP 1",
      consumedResource: "AP",
      consumedAmount: 1,
      build: () => stunnedOrFrozenWaitScenario("STUN", 1, 0),
    },
    {
      waitReason: "FROZEN",
      apLabel: "AP 1",
      consumedResource: "AP",
      consumedAmount: 1,
      build: () => stunnedOrFrozenWaitScenario("FREEZE", 1, 0),
    },
    {
      waitReason: "EX_UNUSABLE",
      apLabel: "AP 1",
      consumedResource: "AP",
      consumedAmount: 1,
      build: () => unusableExWaitScenario(1),
    },
    {
      waitReason: "NO_USABLE_ACTIVE_SKILL",
      apLabel: "AP 1",
      consumedResource: "AP",
      consumedAmount: 1,
      build: () => noUsableActiveSkillWaitScenario(),
    },
  ])(
    "UT-R-ACT-03-008 (R-ACT-03 / Q-BTL-06 / 01_ユビキタス言語.md「待機」): the wait resource is decided by the remaining AP, not by the wait reason — a $waitReason wait at $apLabel consumes $consumedResource on every one of the four wait paths",
    ({ waitReason, consumedResource, consumedAmount, build }) => {
      const scenario = build();
      const random = new SequenceRandomSource([]);

      const ctx = actionPhaseContext();
      resolveActionPhase(
        scenario.allyUnits,
        scenario.enemyUnits,
        scenario.definitions,
        random,
        ctx.recorder,
        ctx.turnNumber,
        ctx.turnRootEventId,
        ctx.turnScopeParentEventId,
      );

      const waiterId = createBattleUnitId("ALLY_1");
      // AP消費側は同じターンで次の周回の待機が続き得るため、最初の1件だけを見る。
      const waited = ctx.recorder
        .getEvents()
        .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === waiterId)!;
      expect(waited.payload).toEqual({
        actorUnitId: waiterId,
        waitReason,
        consumedResource,
        consumedAmount,
      });
    },
  );

  it("UT-ACTION-PHASE-020 (R-ACT-03 / Q-BTL-06 / Q-EX-03, Issue #517 review): an EX reservation that turns out to be unusable while its holder still has AP consumes 1 AP and keeps the gauge, and only the following cycle — which re-reserves EX because the gauge is still full — drains it at AP 0", () => {
    const scenario = unusableExWaitScenario(1);
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      scenario.allyUnits,
      scenario.enemyUnits,
      scenario.definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const waiterId = createBattleUnitId("ALLY_1");
    const events = ctx.recorder.getEvents();

    // Q-EX-03: 予約種別は周回ごとにその時点のEXゲージで決まる。1周回目のAP消費
    // ではゲージが満タンのまま残るため、2周回目も再びEX予約になる。
    const queuesCreated = events.filter((e) => e.eventType === "ActionQueueCreated");
    expect(
      queuesCreated.map(
        (e) => e.payload.reservations.find((r) => r.battleUnitId === waiterId)?.reservedActionKind,
      ),
    ).toEqual(["EX", "EX"]);

    expect(
      events
        .filter((e) => e.eventType === "ActionWaited" && e.sourceUnitId === waiterId)
        .map((e) => e.payload),
    ).toEqual([
      {
        actorUnitId: waiterId,
        waitReason: "EX_UNUSABLE",
        consumedResource: "AP",
        consumedAmount: 1,
      },
      {
        actorUnitId: waiterId,
        waitReason: "EX_UNUSABLE",
        consumedResource: "EX_GAUGE",
        consumedAmount: 10,
      },
    ]);

    const waiter = result.allyUnits.find((u) => u.battleUnitId === waiterId)!;
    expect(waiter.currentAp).toBe(0);
    expect(waiter.currentExtraGauge).toBe(0);
  });

  it("UT-ACTION-PHASE-007 (Q-BTL-04/06_戦闘状態遷移.md 戦闘不能者の除去): a reservation for a unit defeated earlier in the same queue is skipped, not processed, and emits ActionReservationRemoved", () => {
    const attackerDefId = createUnitDefinitionId("UNIT_ATTACKER");
    // ALLY_1 acts first (highest actionSpeed) and one-shots ENEMY_1, whose own
    // reservation (also an attacker) comes later in the same queue. ENEMY_2
    // survives so the phase does not stop early on a victory check.
    const allyFast = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    const enemyDoomed = unit("ENEMY_1", "ENEMY", {
      unitDefinitionId: "UNIT_ATTACKER",
      attack: 999,
      defense: 0,
      maximumHp: 10,
      actionSpeed: 15,
      limits: { maximumAp: 1 },
    });
    const enemySurvivor = unit("ENEMY_2", "ENEMY", { actionSpeed: 10, limits: { maximumAp: 0 } });
    const effectAction = damageEffectAction("ACT_ATTACK");
    // ALLY_1 targets only the nearest enemy (ENEMY_1, first in the enemyUnits
    // array) so ENEMY_2 survives and the phase does not end on a victory check.
    const definitions = definitionsOf(
      new Map([[attackerDefId, [attackSkill("ACT_ATTACK", 1, ENEMY_NEAREST)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [allyFast],
      [enemyDoomed, enemySurvivor],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedAlly = result.allyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ALLY_1"),
    )!;
    // ENEMY_1 was defeated before its own reservation was reached, so it never got to attack.
    expect(updatedAlly.currentHp).toBe(allyFast.currentHp);
    const updatedDoomed = result.enemyUnits.find(
      (u) => u.battleUnitId === createBattleUnitId("ENEMY_1"),
    )!;
    // The reservation was discarded outright, not consumed as a WAIT either.
    expect(updatedDoomed.currentAp).toBe(1);

    // 06_戦闘状態遷移.md「戦闘不能者の除去」: 除去はActionCompleted直後に即時発行される。
    const removed = ctx.recorder
      .getEvents()
      .find(
        (e) =>
          e.eventType === "ActionReservationRemoved" &&
          e.sourceUnitId === createBattleUnitId("ENEMY_1"),
      )!;
    expect(removed.payload).toEqual({
      battleUnitId: createBattleUnitId("ENEMY_1"),
      reason: "DEFEATED",
    });
  });

  it("UT-ACTION-PHASE-008 (defense-in-depth: R-ACT-03 now forbids cost 0 at Catalog validation, but this constructs a BattleDefinitions directly, bypassing createCost/JSON Schema): a 0-AP-cost AS that never depletes its user's AP is bounded by a cycle-count safety guard instead of looping until the (very large) target HP is exhausted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_FREE_ATTACKER");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_FREE_ATTACKER",
      attack: 1,
      limits: { maximumAp: 1 },
    });
    // HP large enough that natural HP-based termination would take far more
    // cycles than the safety guard's bound (maximumAp total + 1 = 3 here).
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1_000_000 });
    const effectAction = damageEffectAction("ACT_FREE_ATTACK");
    // apCost: 0 -> consumeAp is a no-op, so this unit is re-queued every cycle.
    // A valid Catalog can no longer produce this (createCost/JSON Schema now
    // require amount >= 1), so this test exercises the resolver's own
    // defensive guard directly via a hand-built SkillDefinition.
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_FREE_ATTACK", 0)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    expect(() =>
      resolveActionPhase(
        [ally],
        [enemy],
        definitions,
        random,
        ctx.recorder,
        ctx.turnNumber,
        ctx.turnRootEventId,
        ctx.turnScopeParentEventId,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-ACTION-PHASE-009 (R-SKL-04): using a skill with an ACTION-unit cooldown sets it, and CooldownStarted is not emitted for the default count-0 fixture skills", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_COOLDOWN");
    const skill = attackSkill("ACT_CD_ATTACK", 1, ENEMY_ALL, { unit: "ACTION", count: 2 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_COOLDOWN",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0 });
    const effectAction = damageEffectAction("ACT_CD_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 2 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");

    const started = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownStarted" && e.sourceUnitId === ally.battleUnitId);
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      unit: "ACTION",
      initialRemaining: 2,
    });
    // The setting scope (setActionId, matching
    // R-SKL-04's "same action" decrement rule) must ride along in the
    // stateDelta itself so `stateTransitions` alone (independent of any
    // logLevel-filtered `events[]`) can restore it.
    expect(
      started[0]!.stateDelta?.units?.[ally.battleUnitId]?.cooldowns?.[skill.skillDefinitionId],
    ).toMatchObject({ setActionId: cooldownEntry!.setActionId });
  });

  it("UT-ACTION-PHASE-010 (R-SKL-04): does not emit CooldownStarted for a skill whose cooldown.count is 0", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_NO_COOLDOWN");
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_NO_COOLDOWN",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0 });
    const effectAction = damageEffectAction("ACT_NO_CD_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [attackSkill("ACT_NO_CD_ATTACK", 1)]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.cooldowns).toEqual({});
    expect(ctx.recorder.getEvents().filter((e) => e.eventType === "CooldownStarted")).toHaveLength(
      0,
    );
  });

  it("UT-ACTION-PHASE-011 (R-SKL-04): does not decrement a cooldown set during the same action, but decrements it at the end of the actor's next own action", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_COOLDOWN_DECREMENT");
    // apCost 2 with 3 starting AP: cycle 1 affords the skill (sets
    // remaining=1, no decrement this same action). Cycle 2 only has 1 AP
    // left, so the skill (cooldown gating is M7 scope; this is purely an AP
    // shortfall) is unaffordable and the unit WAITs instead - but
    // ActionCompleting still runs the decrement for the actor's own
    // cooldowns regardless of what action they took this cycle.
    const skill = attackSkill("ACT_CD2_ATTACK", 2, ENEMY_ALL, { unit: "ACTION", count: 1 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_COOLDOWN_DECREMENT",
      limits: { maximumAp: 3 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_CD2_ATTACK");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 0 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");

    const reduced = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownReduced" && e.sourceUnitId === ally.battleUnitId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      before: 1,
      after: 0,
    });
    expect(
      ctx.recorder
        .getEvents()
        .filter((e) => e.eventType === "CooldownCompleted" && e.sourceUnitId === ally.battleUnitId),
    ).toHaveLength(1);
  });

  it("UT-ACTION-PHASE-012 (R-SKL-05): selecting a CHARGE skill starts a charge (consumes cost, no effects yet) as one action, and the next action opportunity releases it as a separate action with distinct ActionIds", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const skill = chargeSkill("ACT_CHARGE_HIT", 1);
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_CHARGE_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // Cost consumed once at charge start; release consumes nothing.
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.charge).toBeUndefined();
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 30);

    const events = ctx.recorder.getEvents();
    const chargeStarted = events.filter((e) => e.eventType === "ChargeStarted");
    const chargeReleased = events.filter((e) => e.eventType === "ChargeReleased");
    expect(chargeStarted).toHaveLength(1);
    expect(chargeReleased).toHaveLength(1);
    expect(chargeStarted[0]!.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
    });
    expect(chargeReleased[0]!.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: skill.skillDefinitionId,
    });

    // Charge start and release are distinct actions (R-SKL-05: "チャージ開始とは別の一つの行動").
    const startActionId = chargeStarted[0]!.actionId;
    const releaseActionId = chargeReleased[0]!.actionId;
    expect(startActionId).toBeDefined();
    expect(releaseActionId).toBeDefined();
    expect(startActionId).not.toBe(releaseActionId);

    const actionsCompleted = events
      .filter((e) => e.eventType === "ActionCompleted")
      .filter((e) => e.sourceUnitId === ally.battleUnitId);
    expect(actionsCompleted.map((e) => e.payload.effectiveActionType)).toEqual([
      "AS",
      "CHARGE_RELEASE",
    ]);
  });

  it("UT-ACTION-PHASE-022 (06_戦闘状態遷移.md「チャージ効果発動」#1-5): the charge-clearing StateDelta is observed after effect resolution, not on ChargeReleased itself — ChargeReleased carries no delta of its own, and the terminating delta is owned by the ChargeReleaseCompleted that follows DamageApplied", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CHARGER");
    const skill = chargeSkill("ACT_CHARGE_HIT", 1);
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_CHARGE_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const chargeStarted = events.find((e) => e.eventType === "ChargeStarted")!;
    const chargeReleased = events.find((e) => e.eventType === "ChargeReleased")!;
    expect(chargeReleased.stateDelta).toBeUndefined();
    expect(chargeReleased.stateVersionBefore).toBe(chargeReleased.stateVersionAfter);

    const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;
    // 「チャージ効果発動」#5（`ChargeReleaseCompleted`）がチャージ終了差分を所有する。
    // 後続の `ActionCompleting` へ持たせると、公開差分を順に当て直す独立Reducerでは
    // 完了イベントの時点でまだチャージ中に見えてしまう。
    const chargeDeltaOwners = events.filter(
      (e) => e.stateDelta?.units?.[ally.battleUnitId]?.charge !== undefined,
    );
    expect(chargeDeltaOwners.map((e) => e.eventType)).toEqual([
      "ChargeStarted",
      "ChargeReleaseCompleted",
    ]);
    const closingCompleting = chargeDeltaOwners.at(-1)!;
    expect(closingCompleting.stateDelta).toEqual({
      units: {
        [ally.battleUnitId]: {
          charge: {
            before: {
              skillDefinitionId: skill.skillDefinitionId,
              startedActionId: chargeStarted.actionId,
            },
            after: undefined,
          },
        },
      },
    });
    // Observed strictly after the damage effect it guarded (06_戦闘状態遷移.md
    // 「チャージ効果発動」: 効果解決→PS解決の後にチャージ状態を終了する).
    expect(closingCompleting.stateVersionBefore).toBeGreaterThanOrEqual(
      damageApplied.stateVersionAfter,
    );
  });

  it("UT-R-ACT-01-001 (R-ACT-01 #1, R-STS-02): a stunned unit WAITs instead of using an otherwise-usable AS", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_STUNNED");
    const skill = attackSkill("ACT_STUNNED_HIT");
    const ally = {
      ...unit("ALLY_1", "ALLY", { unitDefinitionId: "UNIT_STUNNED" }),
      appliedEffects: [statusEffect("STUN", "stun-1", 1, createBattleUnitId("ALLY_1"))],
    };
    const enemy = unit("ENEMY_1", "ENEMY");
    const effectAction = damageEffectAction("ACT_STUNNED_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.enemyUnits[0]!.currentHp).toBe(enemy.currentHp);
    const waited = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId);
    expect(waited?.payload).toMatchObject({ waitReason: "STUNNED" });
    expect(ctx.recorder.getEvents().some((e) => e.eventType === "SkillUseStarting")).toBe(false);
  });

  it("UT-R-ACT-01-002 (R-STS-02): a stunned unit with AP 0 and a full EX gauge WAITs consuming the EX gauge fully, not AP", () => {
    const ally = {
      ...unit("ALLY_1", "ALLY", {
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 10,
      }),
      appliedEffects: [statusEffect("STUN", "stun-1", 1, createBattleUnitId("ALLY_1"))],
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 } });
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      NO_SKILLS,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentExtraGauge).toBe(0);
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    const waited = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId);
    expect(waited?.payload).toMatchObject({
      waitReason: "STUNNED",
      consumedResource: "EX_GAUGE",
      consumedAmount: 10,
    });
  });

  it("UT-R-ACT-01-003 (R-ACT-01 #2, R-STS-03 consequence): a frozen unit with no pending charge WAITs instead of using an otherwise-usable AS", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_FROZEN");
    const skill = attackSkill("ACT_FROZEN_HIT");
    const ally = {
      ...unit("ALLY_1", "ALLY", { unitDefinitionId: "UNIT_FROZEN" }),
      appliedEffects: [statusEffect("FREEZE", "freeze-1", 1, createBattleUnitId("ALLY_1"))],
    };
    const enemy = unit("ENEMY_1", "ENEMY");
    const effectAction = damageEffectAction("ACT_FROZEN_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.enemyUnits[0]!.currentHp).toBe(enemy.currentHp);
    const waited = ctx.recorder
      .getEvents()
      .find((e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId);
    expect(waited?.payload).toMatchObject({ waitReason: "FROZEN" });
    expect(ctx.recorder.getEvents().some((e) => e.eventType === "ChargeHeldByFreeze")).toBe(false);
  });

  it("UT-R-ACT-01-004 (R-ACT-01 #2, R-SKL-05 '凍結中はチャージを維持し'): a frozen unit with a pending charge WAITs (recording ChargeHeldByFreeze) instead of releasing it while frozen remains active, then releases it once freeze naturally expires", () => {
    const chargedSkill = chargeSkill("ACT_RELEASE_HIT");
    const startedActionId = createActionId("B_TEST:action:1");
    const ally = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 } }),
      appliedEffects: [statusEffect("FREEZE", "freeze-1", 1, createBattleUnitId("ALLY_1"))],
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_RELEASE_HIT");
    const definitions = definitionsOf(
      new Map(),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // FREEZE's ACTION-unit remaining count is 1: it expires after this one
    // frozen WAIT, so the charge is released naturally on the next cycle
    // (R-SKL-05 「解除後の次の行動機会に発動する」) — the final state has no
    // charge left, but it must not have been released *while still frozen*.
    expect(result.allyUnits[0]!.charge).toBeUndefined();
    const events = ctx.recorder.getEvents();
    const held = events.find((e) => e.eventType === "ChargeHeldByFreeze") as Extract<
      BattleDomainEvent,
      { eventType: "ChargeHeldByFreeze" }
    >;
    expect(held).toBeDefined();
    expect(held.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: chargedSkill.skillDefinitionId,
      startedActionId,
      freezeEffectInstanceId: ally.appliedEffects[0]!.effectInstanceId,
    });
    const released = events.find((e) => e.eventType === "ChargeReleased")!;
    expect(released.sequence).toBeGreaterThan(held.sequence);
    const waited = events.find(
      (e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId,
    )!;
    expect(waited.payload).toMatchObject({ waitReason: "FROZEN" });
    expect(waited.sequence).toBeLessThan(released.sequence);

    // `ChargeHeldByFreeze`は`ActionWaited`の直接の子として、
    // 同じ行動の`ActionCompleting`より前（`PassiveActivationRuntime`の連鎖
    // 経路上）に記録される——完了後に切り離して記録するのではない。
    expect(held.parentEventId).toBe(waited.eventId);
    const actionCompletingForWait = events.find(
      (e) =>
        e.eventType === "ActionCompleting" &&
        e.sourceUnitId === ally.battleUnitId &&
        e.sequence > waited.sequence &&
        e.sequence < released.sequence,
    )!;
    expect(actionCompletingForWait).toBeDefined();
    expect(held.sequence).toBeLessThan(actionCompletingForWait.sequence);
  });

  it("UT-R-ACT-01-006: if an ally's PS reacts to the frozen unit's ActionWaited and cancels its charge mid-resolution (STUN), ChargeHeldByFreeze is NOT recorded — the hook re-reads the post-chain state, not a stale pre-wait snapshot", () => {
    // The frozen unit itself can't hold a reacting PS here (R-STS-03: a frozen
    // owner can't newly activate PS either, `OWNER_FROZEN` in
    // reconfirm-passive-candidate.ts) — a separate, unfrozen ally's PS reacts
    // to the frozen unit's own ActionWaited instead, targeting it via
    // EXCLUDE_RESOLVED_UNIT(SELF) (the only other ally on the field).
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_STUN_FROZEN_ALLY_ON_WAIT");
    const stunActionId = createEffectActionDefinitionId("ACT_STUN_FROZEN_ALLY_ON_WAIT");
    const chargedSkill = chargeSkill("ACT_WOULD_HAVE_HELD");
    const startedActionId = createActionId("B_TEST:action:1");

    const frozenAlly = {
      ...unit("ALLY_FROZEN", "ALLY", { limits: { maximumAp: 1 } }),
      appliedEffects: [statusEffect("FREEZE", "freeze-1", 5, createBattleUnitId("ALLY_FROZEN"))],
      charge: { skill: chargedSkill, startedActionId },
    };
    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER",
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY");

    const stunAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionWaited",
          category: "FACT",
          sourceSelector: "ALLY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: createTargetBindingId("TGT_FROZEN_ALLY"),
            selector: {
              kind: "SELECT",
              side: "ALLY",
              count: 1,
              filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
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
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_FROZEN_ALLY") },
            actions: [{ effectActionDefinitionId: stunActionId }],
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
      metadata: { displayName: "SKL_PS_STUN_FROZEN_ALLY_ON_WAIT", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        stunnerUnitDefinitionId,
        {
          unitDefinitionId: stunnerUnitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 10,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 10,
            maximumAp: 0,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "AllyStunner",
            characterName: "AllyStunner",
            characterId: "CHAR_ALLY_STUNNER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map([[stunActionId, stunAction]]),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [frozenAlly, stunnerAlly],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // The ally's PS (triggered by the frozen unit's own ActionWaited) applied
    // STUN before the onWaitEstablished hook ran, cancelling the charge — so
    // no ChargeHeldByFreeze is recorded, and the charge stays cleared.
    const frozenResult = result.allyUnits.find((u) => u.battleUnitId === frozenAlly.battleUnitId)!;
    expect(frozenResult.charge).toBeUndefined();
    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "ChargeHeldByFreeze")).toBe(false);
    expect(events.some((e) => e.eventType === "ChargeCancelled")).toBe(true);
  });

  it("UT-R-ORD-01-001 (R-ORD-01 '凍結などで阻害されていないチャージ効果が発動待ち'): a frozen unit with AP 0 and a non-full EX gauge is NOT queued despite a pending charge — freeze impedes the charge, so it doesn't count toward R-ORD-01 eligibility", () => {
    const chargedSkill = chargeSkill("ACT_HELD_HIT");
    const startedActionId = createActionId("B_TEST:action:1");
    const ally = {
      ...unit("ALLY_1", "ALLY", {
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
      }),
      appliedEffects: [statusEffect("FREEZE", "freeze-1", 1, createBattleUnitId("ALLY_1"))],
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      NO_SKILLS,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // Neither unit is queue-eligible (ally: AP 0, EX not full, and its charge
    // is impeded by freeze; enemy: AP 0, EX not full, no charge) — the phase
    // drains immediately without ever creating a queue.
    expect(ctx.recorder.getEvents().some((e) => e.eventType === "ActionQueueCreated")).toBe(false);
    expect(result.allyUnits[0]!.charge).toEqual({ skill: chargedSkill, startedActionId });
    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.allyUnits[0]!.currentExtraGauge).toBe(3);
  });

  it("UT-R-ORD-01-002 (R-ORD-01 counterpart): once freeze clears, the same AP-0/non-full-EX unit becomes queue-eligible again via its pending charge alone and releases it", () => {
    const chargedSkill = chargeSkill("ACT_HELD_HIT_2");
    const startedActionId = createActionId("B_TEST:action:1");
    const ally = {
      ...unit("ALLY_1", "ALLY", {
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
      }),
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_HELD_HIT_2");
    const definitions = definitionsOf(
      new Map(),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(ctx.recorder.getEvents().some((e) => e.eventType === "ActionQueueCreated")).toBe(true);
    expect(ctx.recorder.getEvents().some((e) => e.eventType === "ChargeReleased")).toBe(true);
    expect(result.allyUnits[0]!.charge).toBeUndefined();
  });

  it("UT-R-ORD-01-003 (R-ORD-01): a reservation queued via its charge alone is removed (INELIGIBLE) and never executes if a preceding same-cycle action cancels that charge (via STUN)", () => {
    const stunActionIdString = "ACT_STUN_ALLY_ORD";
    const chargedSkill = chargeSkill("ACT_WOULD_BE_SKIPPED");
    const startedActionId = createActionId("B_TEST:action:1");
    const ALLY_OTHER_SELECTOR: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const stunSkill = attackSkill(stunActionIdString, 1, ALLY_OTHER_SELECTOR);
    const stunActionId = createEffectActionDefinitionId(stunActionIdString);
    const stunAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };

    // Acts first in the cycle (higher actionSpeed): stuns the other ally.
    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER_ORD",
        actionSpeed: 20,
        limits: { maximumAp: 1 },
      }),
    };
    // Queue-eligible via its pending charge alone (AP 0, EX not full); acts
    // second in the cycle (lower actionSpeed) — by then, the stunner's action
    // has already cancelled this charge, so R-ORD-01 no longer holds.
    const chargingAlly = {
      ...unit("ALLY_CHARGING", "ALLY", {
        actionSpeed: 5,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
      }),
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD"), [stunSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([[stunActionId, stunAction]]),
      unitDefinitions: new DefaultUnitDefinitionMap(),
      skillDefinitions: new Map(),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [stunnerAlly, chargingAlly],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    // Both were queued for cycle 1 (stunner via AP, charging via its then-unimpeded charge).
    const firstQueue = events.find((e) => e.eventType === "ActionQueueCreated") as Extract<
      BattleDomainEvent,
      { eventType: "ActionQueueCreated" }
    >;
    expect(
      firstQueue?.payload.reservations.some(
        (entry) => entry.battleUnitId === chargingAlly.battleUnitId,
      ),
    ).toBe(true);
    // The charging unit's reservation was removed as INELIGIBLE, never executed:
    // no ActionStarted/ActionWaited/ChargeReleased for it, and its EX gauge
    // (3, not full) was never consumed by a wrongful STUNNED-branch WAIT.
    const removed = events.find(
      (e) =>
        e.eventType === "ActionReservationRemoved" && e.sourceUnitId === chargingAlly.battleUnitId,
    );
    expect(removed?.payload).toMatchObject({
      battleUnitId: chargingAlly.battleUnitId,
      reason: "INELIGIBLE",
    });
    expect(
      events.some(
        (e) => e.eventType === "ActionStarted" && e.sourceUnitId === chargingAlly.battleUnitId,
      ),
    ).toBe(false);
    expect(events.some((e) => e.eventType === "ChargeReleased")).toBe(false);
    const chargingResult = result.allyUnits.find(
      (u) => u.battleUnitId === chargingAlly.battleUnitId,
    )!;
    expect(chargingResult.currentExtraGauge).toBe(3);
    expect(chargingResult.charge).toBeUndefined();
  });

  it("UT-R-ORD-01-004: an ActionReservationRemoved(reason INELIGIBLE) is itself a real PS/Memory trigger — an ally's PS reacting to it activates, with triggerEventId pointing at that same removal event", () => {
    const stunActionIdString = "ACT_STUN_ALLY_ORD_2";
    const chargedSkill = chargeSkill("ACT_WOULD_BE_SKIPPED_2");
    const startedActionId = createActionId("B_TEST:action:1");
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD_2");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_RESERVATION_REMOVED");
    const ALLY_OTHER_SELECTOR: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [{ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } }],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const stunSkill = attackSkill(stunActionIdString, 1, ALLY_OTHER_SELECTOR);
    const stunActionId = createEffectActionDefinitionId(stunActionIdString);
    const stunAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const buffAction = statModEffectAction("ACT_PS_ON_REMOVAL_BUFF", "ATTACK", "FIXED", 5);
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionReservationRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: buffAction.effectActionDefinitionId }],
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
      metadata: { displayName: "SKL_PS_ON_RESERVATION_REMOVED", tags: [] },
    };

    // Acts first in the cycle (higher actionSpeed): stuns the other ally, and
    // separately holds a PS that reacts to ActionReservationRemoved.
    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER_ORD_2",
        actionSpeed: 20,
        limits: { maximumAp: 1, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const chargingAlly = {
      ...unit("ALLY_CHARGING", "ALLY", {
        actionSpeed: 5,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
      }),
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        stunnerUnitDefinitionId,
        {
          unitDefinitionId: stunnerUnitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 10,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 20,
            maximumAp: 1,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "AllyStunnerWithPS",
            characterName: "AllyStunnerWithPS",
            characterId: "CHAR_ALLY_STUNNER_WITH_PS",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);
    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[stunnerUnitDefinitionId, [stunSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [stunActionId, stunAction],
        [buffAction.effectActionDefinitionId, buffAction],
      ]),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    resolveActionPhase(
      [stunnerAlly, chargingAlly],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const removed = events.find(
      (e) =>
        e.eventType === "ActionReservationRemoved" && e.sourceUnitId === chargingAlly.battleUnitId,
    )!;
    const activated = events.find(
      (e) => e.eventType === "PassiveActivated" && e.sourceUnitId === stunnerAlly.battleUnitId,
    ) as Extract<BattleDomainEvent, { eventType: "PassiveActivated" }>;
    expect(activated).toBeDefined();
    expect(activated.payload).toMatchObject({
      skillDefinitionId: passiveSkillDefinitionId,
      triggerEventId: removed.eventId,
    });
  });

  it("UT-R-ORD-01-005: re-evaluates remaining reservations after each removal's own PS/Memory chain — a unit newly stunned by that reaction is also removed instead of executing on a stale precomputed list", () => {
    const startedActionIdB = createActionId("B_TEST:action:1");
    const startedActionIdD = createActionId("B_TEST:action:2");
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD_5");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_STUN_D_ON_REMOVAL");
    const stunBActionId = createEffectActionDefinitionId("ACT_STUN_B_ORD_5");
    const stunDActionId = createEffectActionDefinitionId("ACT_STUN_D_ORD_5");

    // B and D are otherwise identical (AP 0, EX not full, an unimpeded
    // pending charge) except for HP ratio, used only so each skill's
    // selector can deterministically pick one and not the other (all units
    // in this fixture share the same board position).
    const highHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "GTE", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const lowHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "LT", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    // Stuns B (high HP ratio) only — D is untouched by this action.
    const stunBSkill = attackSkill(stunBActionId.toString(), 1, highHpSelector);
    const stunBAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunBActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    // Reacts to ActionReservationRemoved by stunning D (low HP ratio) —
    // this is what newly makes D ineligible (cancels D's charge), *after*
    // B's own removal has already been decided and recorded.
    const stunDAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunDActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionReservationRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_D"), selector: lowHpSelector },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_D") },
            actions: [{ effectActionDefinitionId: stunDActionId }],
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
      metadata: { displayName: "SKL_PS_STUN_D_ON_REMOVAL", tags: [] },
    };

    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER_ORD_5",
        actionSpeed: 20,
        limits: { maximumAp: 1, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    // B: high HP ratio (1.0); stunned directly by the stunner's own action.
    const allyB = {
      ...unit("ALLY_B", "ALLY", {
        actionSpeed: 10,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 100,
      }),
      charge: { skill: chargeSkill("ACT_B_UNUSED"), startedActionId: startedActionIdB },
    };
    // D: low HP ratio (0.5); still eligible (unimpeded charge) when the
    // cycle's queue is built, only stunned reactively once B is removed.
    const allyD = {
      ...unit("ALLY_D", "ALLY", {
        actionSpeed: 5,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 50,
      }),
      charge: { skill: chargeSkill("ACT_D_UNUSED"), startedActionId: startedActionIdD },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[stunnerUnitDefinitionId, [stunBSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [stunBActionId, stunBAction],
        [stunDActionId, stunDAction],
      ]),
      unitDefinitions: new DefaultUnitDefinitionMap([
        [
          stunnerUnitDefinitionId,
          {
            unitDefinitionId: stunnerUnitDefinitionId,
            category: "PLAYABLE",
            attribute: "AGGRESSIVE",
            unitType: "PHYSICAL",
            role: "PHYSICAL_ATTACKER",
            positionAptitudes: ["FRONT", "BACK"],
            baseStats: {
              maximumHp: 100,
              attack: 10,
              defense: 10,
              criticalRate: 0,
              criticalDamageBonus: 0.5,
              affinityBonus: 0,
              actionSpeed: 20,
              maximumAp: 1,
              maximumPp: 3,
            },
            extraGaugeMaximum: 10,
            activeSkillDefinitionIds: [],
            passiveSkillDefinitionIds: [passiveSkillDefinitionId],
            extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
            metadata: {
              displayName: "AllyStunnerChain",
              characterName: "AllyStunnerChain",
              characterId: "CHAR_ALLY_STUNNER_CHAIN",
              affiliations: [],
              tags: [],
            },
          },
        ],
      ]),
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [stunnerAlly, allyB, allyD],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const removedEvents = events.filter((e) => e.eventType === "ActionReservationRemoved");
    // Both B (stunned directly) and D (stunned reactively, only after B's
    // removal was already decided) are removed as INELIGIBLE — D is caught
    // by re-evaluating `remaining` after B's removal chain, not by a stale
    // precomputed list from before that chain ran.
    expect(removedEvents.map((e) => e.sourceUnitId).sort()).toEqual(
      [allyB.battleUnitId, allyD.battleUnitId].sort(),
    );
    for (const event of removedEvents) {
      expect(event.payload).toMatchObject({ reason: "INELIGIBLE" });
    }
    // D never executed: no wrongful STUNNED-branch WAIT that would have
    // drained its non-full (3 of 10) EX gauge (R-STS-02/Q-BTL-06 only allow
    // full-gauge consumption).
    expect(
      events.some((e) => e.eventType === "ActionStarted" && e.sourceUnitId === allyD.battleUnitId),
    ).toBe(false);
    const dResult = result.allyUnits.find((u) => u.battleUnitId === allyD.battleUnitId)!;
    expect(dResult.currentExtraGauge).toBe(3);
    expect(dResult.charge).toBeUndefined();
    // Issue #251: D's removal parentEventId must reflect the true terminus
    // of B's removal reaction chain (the last event recorded before D's own
    // removal — here, the stunner PS's PassiveResolved), not B's bare
    // ActionReservationRemoved event id.
    const bRemovedEvent = removedEvents.find((e) => e.sourceUnitId === allyB.battleUnitId)!;
    const dRemovedEvent = removedEvents.find((e) => e.sourceUnitId === allyD.battleUnitId)!;
    const dRemovedIndex = events.indexOf(dRemovedEvent);
    expect(dRemovedEvent.parentEventId).toBe(events[dRemovedIndex - 1]!.eventId);
    expect(dRemovedEvent.parentEventId).not.toBe(bRemovedEvent.eventId);
    // Issue #251: 除去1件ごとに新しい`resolutionScopeId`と
    // 独立した`PassiveActivationRuntime`を発行する——除去をまとめて1つの
    // スコープで処理すると、R-PS-07「1解決スコープ1回」により、同じPSがBの
    // 除去には反応できてもDの除去には（既にそのスコープで発動済みとして）
    // 反応できなくなってしまう。
    expect(dRemovedEvent.resolutionScopeId).not.toBe(bRemovedEvent.resolutionScopeId);
    expect(bRemovedEvent.rootEventId).toBe(dRemovedEvent.rootEventId);
  });

  it("UT-R-ORD-01-007 (Issue #251): a removal's own reaction chain can incapacitate (not just make ineligible) another reservation — the second removal is recorded DEFEATED, with the correct reason re-derived from the post-chain state rather than reused from the stale pre-chain evaluation", () => {
    const startedActionIdB = createActionId("B_TEST:action:1");
    const startedActionIdD = createActionId("B_TEST:action:2");
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD_7");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_KILL_D_ON_REMOVAL");
    const stunBActionId = createEffectActionDefinitionId("ACT_STUN_B_ORD_7");
    const killDActionId = createEffectActionDefinitionId("ACT_KILL_D_ORD_7");

    const highHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "GTE", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const lowHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "LT", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    // Stuns B (high HP ratio) only — D is untouched by this action.
    const stunBSkill = attackSkill(stunBActionId.toString(), 1, highHpSelector);
    const stunBAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunBActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    // Reacts to ActionReservationRemoved by DAMAGE-ing D (low HP ratio) for
    // more than D's remaining HP — D is incapacitated by the reaction chain
    // itself, not merely made R-ORD-01-ineligible.
    const killDAction = damageEffectAction(killDActionId.toString());
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionReservationRemoved",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_D"), selector: lowHpSelector },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_D") },
            actions: [{ effectActionDefinitionId: killDActionId }],
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
      metadata: { displayName: "SKL_PS_KILL_D_ON_REMOVAL", tags: [] },
    };

    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER_ORD_7",
        actionSpeed: 20,
        attack: 30,
        limits: { maximumAp: 1, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    // B: high HP ratio (1.0); stunned directly by the stunner's own action —
    // removed INELIGIBLE.
    const allyB = {
      ...unit("ALLY_B", "ALLY", {
        actionSpeed: 10,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 100,
      }),
      charge: { skill: chargeSkill("ACT_B_UNUSED_ORD_7"), startedActionId: startedActionIdB },
    };
    // D: low HP ratio and low absolute HP (10), so the PS reaction's DAMAGE
    // (attack 30 - defense 10 = 20 damage) kills it outright rather than
    // merely canceling its charge.
    const allyD = {
      ...unit("ALLY_D", "ALLY", {
        actionSpeed: 5,
        defense: 10,
        maximumHp: 100,
        currentHp: 10,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
      }),
      charge: { skill: chargeSkill("ACT_D_UNUSED_ORD_7"), startedActionId: startedActionIdD },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[stunnerUnitDefinitionId, [stunBSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [stunBActionId, stunBAction],
        [killDActionId, killDAction],
      ]),
      unitDefinitions: new DefaultUnitDefinitionMap([
        [
          stunnerUnitDefinitionId,
          {
            unitDefinitionId: stunnerUnitDefinitionId,
            category: "PLAYABLE",
            attribute: "AGGRESSIVE",
            unitType: "PHYSICAL",
            role: "PHYSICAL_ATTACKER",
            positionAptitudes: ["FRONT", "BACK"],
            baseStats: {
              maximumHp: 100,
              attack: 30,
              defense: 10,
              criticalRate: 0,
              criticalDamageBonus: 0.5,
              affinityBonus: 0,
              actionSpeed: 20,
              maximumAp: 1,
              maximumPp: 3,
            },
            extraGaugeMaximum: 10,
            activeSkillDefinitionIds: [],
            passiveSkillDefinitionIds: [passiveSkillDefinitionId],
            extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
            metadata: {
              displayName: "AllyStunnerKillChain",
              characterName: "AllyStunnerKillChain",
              characterId: "CHAR_ALLY_STUNNER_KILL_CHAIN",
              affiliations: [],
              tags: [],
            },
          },
        ],
      ]),
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [stunnerAlly, allyB, allyD],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const removedEvents = events.filter((e) => e.eventType === "ActionReservationRemoved");
    expect(removedEvents.map((e) => e.sourceUnitId).sort()).toEqual(
      [allyB.battleUnitId, allyD.battleUnitId].sort(),
    );
    const bRemoved = removedEvents.find((e) => e.sourceUnitId === allyB.battleUnitId)!;
    const dRemoved = removedEvents.find((e) => e.sourceUnitId === allyD.battleUnitId)!;
    expect(bRemoved.payload).toMatchObject({ reason: "INELIGIBLE" });
    // D's removal reason is re-derived from the post-reaction-chain state
    // (defeated), not carried over from any earlier INELIGIBLE evaluation.
    expect(dRemoved.payload).toMatchObject({ reason: "DEFEATED" });
    expect(
      events.some((e) => e.eventType === "ActionStarted" && e.sourceUnitId === allyD.battleUnitId),
    ).toBe(false);
    const dResult = [...result.allyUnits, ...result.enemyUnits].find(
      (u) => u.battleUnitId === allyD.battleUnitId,
    )!;
    expect(dResult.currentHp).toBe(0);
  });

  it("UT-R-ORD-01-006: re-evaluates remaining reservations after finalizeResolutionScope's own RuntimeCounterReset chain, not just after each removal's immediate PS chain", () => {
    const startedActionIdB = createActionId("B_TEST:action:1");
    const startedActionIdD = createActionId("B_TEST:action:2");
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD_6");
    const counterSkillDefinitionId = createSkillDefinitionId("SKL_PS_COUNTER_ON_REMOVAL_ORD_6");
    const stunOnResetSkillDefinitionId = createSkillDefinitionId("SKL_PS_STUN_D_ON_RESET_ORD_6");
    const counterId = createRuntimeCounterId("RUNTIME_COUNTER_REMOVAL_TRACKER_ORD_6");
    const stunBActionId = createEffectActionDefinitionId("ACT_STUN_B_ORD_6");
    const stunDActionId = createEffectActionDefinitionId("ACT_STUN_D_ORD_6");

    // Same B/D setup as UT-R-ORD-01-005: both otherwise-identical except HP
    // ratio (used only to let selectors deterministically pick one and not
    // the other), both AP 0 / EX not full / an unimpeded pending charge.
    const highHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "GTE", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const lowHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "LT", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    // Stuns B (high HP ratio) only — D is untouched by this action.
    const stunBSkill = attackSkill(stunBActionId.toString(), 1, highHpSelector);
    const stunBAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunBActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    // This PS never activates on its own (no triggers) — it exists purely to
    // register a SKILL_RUNTIME counter that increments whenever any
    // ActionReservationRemoved fires, and discards (emitting
    // RuntimeCounterReset) only once `finalizeResolutionScope()` runs.
    const counterSkill: SkillDefinition = {
      skillDefinitionId: counterSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [
        {
          kind: "INCREMENT",
          counter: counterId,
          scope: "SKILL_RUNTIME",
          trigger: {
            eventType: "ActionReservationRemoved",
            category: "FACT",
            sourceSelector: "ANY",
            targetSelector: "ANY",
            condition: { kind: "TRUE" },
          },
          amount: 1,
          resetScope: "RESOLUTION_SCOPE",
        },
      ],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: "SKL_PS_COUNTER_ON_REMOVAL_ORD_6", tags: [] },
    };
    // Reacts to RuntimeCounterReset (only emitted by finalizeResolutionScope
    // discarding the counter above) by stunning D (low HP ratio) — this is
    // what newly makes D ineligible, and only after the inner removal loop
    // has already settled on "no more direct candidates" for B alone.
    const stunDAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunDActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const stunOnResetSkill: SkillDefinition = {
      skillDefinitionId: stunOnResetSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "RuntimeCounterReset",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_D"), selector: lowHpSelector },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_D") },
            actions: [{ effectActionDefinitionId: stunDActionId }],
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
      metadata: { displayName: "SKL_PS_STUN_D_ON_RESET_ORD_6", tags: [] },
    };

    const stunnerAlly = {
      ...unit("ALLY_STUNNER", "ALLY", {
        unitDefinitionId: "UNIT_ALLY_STUNNER_ORD_6",
        actionSpeed: 20,
        limits: { maximumAp: 1, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    // B: high HP ratio (1.0); stunned directly by the stunner's own action.
    const allyB = {
      ...unit("ALLY_B", "ALLY", {
        actionSpeed: 10,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 100,
      }),
      charge: { skill: chargeSkill("ACT_B_UNUSED_ORD_6"), startedActionId: startedActionIdB },
    };
    // D: low HP ratio (0.5); still eligible (unimpeded charge) when the
    // cycle's queue is built and when B's own removal chain settles, only
    // stunned once finalizeResolutionScope's RuntimeCounterReset chain runs.
    const allyD = {
      ...unit("ALLY_D", "ALLY", {
        actionSpeed: 5,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 50,
      }),
      charge: { skill: chargeSkill("ACT_D_UNUSED_ORD_6"), startedActionId: startedActionIdD },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[stunnerUnitDefinitionId, [stunBSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [stunBActionId, stunBAction],
        [stunDActionId, stunDAction],
      ]),
      unitDefinitions: new DefaultUnitDefinitionMap([
        [
          stunnerUnitDefinitionId,
          {
            unitDefinitionId: stunnerUnitDefinitionId,
            category: "PLAYABLE",
            attribute: "AGGRESSIVE",
            unitType: "PHYSICAL",
            role: "PHYSICAL_ATTACKER",
            positionAptitudes: ["FRONT", "BACK"],
            baseStats: {
              maximumHp: 100,
              attack: 10,
              defense: 10,
              criticalRate: 0,
              criticalDamageBonus: 0.5,
              affinityBonus: 0,
              actionSpeed: 20,
              maximumAp: 1,
              maximumPp: 3,
            },
            extraGaugeMaximum: 10,
            activeSkillDefinitionIds: [],
            passiveSkillDefinitionIds: [counterSkillDefinitionId, stunOnResetSkillDefinitionId],
            extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
            metadata: {
              displayName: "AllyStunnerResetChain",
              characterName: "AllyStunnerResetChain",
              characterId: "CHAR_ALLY_STUNNER_RESET_CHAIN",
              affiliations: [],
              tags: [],
            },
          },
        ],
      ]),
      skillDefinitions: new Map([
        [counterSkillDefinitionId, counterSkill],
        [stunOnResetSkillDefinitionId, stunOnResetSkill],
      ]),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [stunnerAlly, allyB, allyD],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "RuntimeCounterReset")).toBe(true);
    const removedEvents = events.filter((e) => e.eventType === "ActionReservationRemoved");
    // Both B (stunned directly) and D (stunned only once
    // finalizeResolutionScope's own RuntimeCounterReset chain runs, strictly
    // after the inner removal loop already found no more direct candidates
    // from B's removal alone) are removed as INELIGIBLE.
    expect(removedEvents.map((e) => e.sourceUnitId).sort()).toEqual(
      [allyB.battleUnitId, allyD.battleUnitId].sort(),
    );
    for (const event of removedEvents) {
      expect(event.payload).toMatchObject({ reason: "INELIGIBLE" });
    }
    // Issue #180: Dの除去は、無関係な旧いBの
    // 除去イベントを親に持たない。また`RuntimeCounterReset`自身がPSを発動させ
    // （D自身へのSTUN付与とそれに伴う`ChargeCancelled`まで連鎖する）ため、
    // その連鎖より前の`RuntimeCounterReset`自身でもなく、連鎖まで含めた実際の
    // 終端イベント——すなわちDの除去イベントの直前に記録されたイベント——を
    // 親に持つ。この「直前に記録されたイベントと一致する」という不変条件は、
    // `finalizeResolutionScope`が返す`lastEventId`がPS連鎖の終端まで正しく
    // 反映していない限り成立しない。
    const bRemovedEvent = removedEvents.find((e) => e.sourceUnitId === allyB.battleUnitId)!;
    const dRemovedEvent = removedEvents.find((e) => e.sourceUnitId === allyD.battleUnitId)!;
    const resetEvent = events.find((e) => e.eventType === "RuntimeCounterReset")!;
    const dRemovedIndex = events.indexOf(dRemovedEvent);
    expect(dRemovedEvent.parentEventId).toBe(events[dRemovedIndex - 1]!.eventId);
    expect(dRemovedEvent.parentEventId).not.toBe(resetEvent.eventId);
    expect(dRemovedEvent.parentEventId).not.toBe(bRemovedEvent.eventId);
    // D never executed: no wrongful STUNNED-branch WAIT that would have
    // drained its non-full (3 of 10) EX gauge (R-STS-02/Q-BTL-06 only allow
    // full-gauge consumption).
    expect(
      events.some((e) => e.eventType === "ActionStarted" && e.sourceUnitId === allyD.battleUnitId),
    ).toBe(false);
    const dResult = result.allyUnits.find((u) => u.battleUnitId === allyD.battleUnitId)!;
    expect(dResult.currentExtraGauge).toBe(3);
    expect(dResult.charge).toBeUndefined();
    // Issue #251 (resolutionScopeId/rootEventId境界の明示テスト): Dの除去は
    // finalizeResolutionScope()が開いた新しい除去スコープに属するため、Bの
    // 除去とは異なるresolutionScopeIdを持つ（終了済みのruntimeは再利用しない）。
    // 一方rootEventIdは、この除去群全体を引き起こした行動のまま、B・D双方の
    // 除去イベントおよびその間の反応連鎖イベント全てで変わらない
    // （`08_ドメインイベント.md`「rootEventId」: 除去群を引き起こした行動を維持）。
    expect(dRemovedEvent.resolutionScopeId).not.toBe(bRemovedEvent.resolutionScopeId);
    const removalGroupEvents = events.slice(events.indexOf(bRemovedEvent));
    const rootEventIds = new Set(removalGroupEvents.map((e) => e.rootEventId));
    expect(rootEventIds.size).toBe(1);
    expect(bRemovedEvent.rootEventId).toBe(dRemovedEvent.rootEventId);
  });

  it("UT-R-ORD-04-002 (Issue #180): when a removal's own finalizeResolutionScope() has nothing to reset (the common case — no resetScope: RESOLUTION_SCOPE counters involved), the causal cursor for a later ActionQueueReordered in the same cycle is the removal event itself, not rolled back to an earlier root event", () => {
    const stunnerUnitDefinitionId = createUnitDefinitionId("UNIT_ALLY_STUNNER_ORD_04_002");
    const stunActionId = createEffectActionDefinitionId("ACT_STUN_ORD_04_002");
    const speedBuffActionId = createEffectActionDefinitionId("ACT_SPEED_BUFF_ORD_04_002");

    // No PS/counterUpdates anywhere in this fixture — finalizeResolutionScope()
    // always finds nothing to reset (the overwhelmingly common production
    // case), so its lastEventId must be undefined and must not roll the
    // causal cursor back.
    const highHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "GTE", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const lowHpSelector: TargetSelectorDefinition = {
      kind: "SELECT",
      side: "ALLY",
      count: 1,
      filters: [
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
        { kind: "HP_RATIO", op: "LT", value: 0.9 },
      ],
      order: ["DEFAULT"],
      includeDefeated: false,
    };
    const stunAction: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunActionId,
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const speedBuffAction = statModEffectAction(
      speedBuffActionId.toString(),
      "ACTION_SPEED",
      "FIXED",
      50,
    );
    // A single AS both stuns allyRemoved (high HP ratio) — making its
    // reservation INELIGIBLE — and buffs allySpeedTarget's (low HP ratio)
    // actionSpeed, which is what causes a later ActionQueueReordered.
    const stunAndBuffSkill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_STUN_AND_BUFF_ORD_04_002"),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: createTargetBindingId("TGT_REMOVED"), selector: highHpSelector },
          { targetBindingId: createTargetBindingId("TGT_SPEED"), selector: lowHpSelector },
        ],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_REMOVED") },
            actions: [{ effectActionDefinitionId: stunActionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_SPEED") },
            actions: [{ effectActionDefinitionId: speedBuffActionId }],
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
      metadata: { displayName: "SKL_STUN_AND_BUFF_ORD_04_002", tags: [] },
    };

    const stunnerAlly = unit("ALLY_STUNNER", "ALLY", {
      unitDefinitionId: "UNIT_ALLY_STUNNER_ORD_04_002",
      actionSpeed: 20,
      limits: { maximumAp: 1 },
    });
    // High HP ratio (1.0); becomes INELIGIBLE once stunned (its unimpeded
    // pending charge is cancelled).
    const allyRemoved = {
      ...unit("ALLY_REMOVED", "ALLY", {
        actionSpeed: 10,
        limits: { maximumAp: 1, maximumExtraGauge: 10 },
        currentAp: 0,
        currentExtraGauge: 3,
        currentHp: 100,
      }),
      charge: {
        skill: chargeSkill("ACT_REMOVED_UNUSED_ORD_04_002"),
        startedActionId: createActionId("B_TEST:action:1"),
      },
    };
    // Low HP ratio (0.5); remains eligible via AP, but its actionSpeed
    // changes — the only remaining reservation once allyRemoved is removed.
    const allySpeedTarget = unit("ALLY_SPEED_TARGET", "ALLY", {
      actionSpeed: 5,
      limits: { maximumAp: 1 },
      currentHp: 50,
    });
    const enemy = unit("ENEMY_1", "ENEMY", { limits: { maximumAp: 0 }, maximumHp: 1000 });

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[stunnerUnitDefinitionId, [stunAndBuffSkill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([
        [stunActionId, stunAction],
        [speedBuffActionId, speedBuffAction],
      ]),
      unitDefinitions: new DefaultUnitDefinitionMap([
        [
          stunnerUnitDefinitionId,
          {
            unitDefinitionId: stunnerUnitDefinitionId,
            category: "PLAYABLE",
            attribute: "AGGRESSIVE",
            unitType: "PHYSICAL",
            role: "PHYSICAL_ATTACKER",
            positionAptitudes: ["FRONT", "BACK"],
            baseStats: {
              maximumHp: 100,
              attack: 10,
              defense: 10,
              criticalRate: 0,
              criticalDamageBonus: 0.5,
              affinityBonus: 0,
              actionSpeed: 20,
              maximumAp: 1,
              maximumPp: 3,
            },
            extraGaugeMaximum: 10,
            activeSkillDefinitionIds: [],
            passiveSkillDefinitionIds: [],
            extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
            metadata: {
              displayName: "AllyStunnerAndBuffer",
              characterName: "AllyStunnerAndBuffer",
              characterId: "CHAR_ALLY_STUNNER_AND_BUFFER",
              affiliations: [],
              tags: [],
            },
          },
        ],
      ]),
      skillDefinitions: new Map(),
    };
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    resolveActionPhase(
      [stunnerAlly, allyRemoved, allySpeedTarget],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "RuntimeCounterReset")).toBe(false);
    const removedEvent = events.find(
      (e) =>
        e.eventType === "ActionReservationRemoved" && e.sourceUnitId === allyRemoved.battleUnitId,
    )!;
    const reordered = events.find((e) => e.eventType === "ActionQueueReordered")!;
    expect(reordered.parentEventId).toBe(removedEvent.eventId);
    expect(reordered.parentEventId).not.toBe(ctx.turnRootEventId);
    expect(reordered.parentEventId).not.toBe(ctx.turnScopeParentEventId);
  });

  it("UT-R-ACT-01-005 (R-ACT-01 branch order): a stunned unit that (defensively) still carries a pending charge takes the STUN branch first — WAITs without releasing the charge while stunned remains active", () => {
    const chargedSkill = chargeSkill("ACT_RELEASE_HIT_2");
    const startedActionId = createActionId("B_TEST:action:1");
    const ally = {
      ...unit("ALLY_1", "ALLY", { limits: { maximumAp: 1 } }),
      appliedEffects: [statusEffect("STUN", "stun-1", 1, createBattleUnitId("ALLY_1"))],
      charge: { skill: chargedSkill, startedActionId },
    };
    const enemy = unit("ENEMY_1", "ENEMY", { maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_RELEASE_HIT_2");
    const definitions = definitionsOf(
      new Map(),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const waited = events.find(
      (e) => e.eventType === "ActionWaited" && e.sourceUnitId === ally.battleUnitId,
    )!;
    expect(waited.payload).toMatchObject({ waitReason: "STUNNED" });
    // STUN's 1-remaining ACTION-unit duration expires after this WAIT, so the
    // charge (untouched while stunned) releases on the following cycle —
    // it must not have released while the STUN branch was still active.
    const released = events.find((e) => e.eventType === "ChargeReleased")!;
    expect(released).toBeDefined();
    expect(waited.sequence).toBeLessThan(released.sequence);
  });

  it("UT-ACTION-PHASE-013 (R-SKL-05): charge start sets the original skill's cooldown, scoped to the charge-start action; the release action (a later action for this actor) then decrements it like any other own-action-end", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CHARGER_CD");
    const skill = chargeSkill("ACT_CHARGE_CD_HIT", 1, ENEMY_ALL, { unit: "ACTION", count: 2 });
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER_CD",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 0, maximumHp: 1000 });
    const effectAction = damageEffectAction("ACT_CHARGE_CD_HIT");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    const started = events.filter((e) => e.eventType === "CooldownStarted");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      unit: "ACTION",
      initialRemaining: 2,
    });
    // The charge-release action is itself a later own-action-end for this
    // actor, so it decrements the cooldown set during the earlier
    // charge-start action (R-SKL-04 COMPLETING runs on every action).
    const reduced = events.filter((e) => e.eventType === "CooldownReduced");
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      before: 2,
      after: 1,
    });
    const cooldownEntry = result.allyUnits[0]!.cooldowns[skill.skillDefinitionId];
    expect(cooldownEntry).toMatchObject({ unit: "ACTION", remaining: 1 });
    expect(typeof cooldownEntry?.setActionId).toBe("string");
  });

  it("UT-ACTION-PHASE-014 (R-SKL-05): repeated charge start+release cycles (2 cycles per AP spent, instead of 1) do not trip the cycle-count safety guard", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_REPEAT_CHARGER");
    // No cooldown, so the same CHARGE skill is immediately selectable again
    // after each release. 2 AP means 2 full charge/release pairs = 4 cycles,
    // which exceeds the pre-charge bound (maximumAp total + 1 = 3).
    const skill = chargeSkill("ACT_REPEAT_CHARGE", 1);
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_REPEAT_CHARGER",
      attack: 10,
      limits: { maximumAp: 2 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", {
      defense: 0,
      maximumHp: 1000,
      limits: { maximumAp: 0 },
    });
    const effectAction = damageEffectAction("ACT_REPEAT_CHARGE");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.currentAp).toBe(0);
    expect(result.enemyUnits[0]!.currentHp).toBe(1000 - 10 - 10);
    expect(ctx.recorder.getEvents().filter((e) => e.eventType === "ChargeReleased")).toHaveLength(
      2,
    );
  });

  it("UT-ACTION-PHASE-015 (Issue #129 COOLDOWN_MANIPULATION): RESET sets a cooling target skill's remaining to 0 and emits CooldownReduced+CooldownCompleted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CD_MANIP_RESET");
    const targetSkillDefinitionId = createSkillDefinitionId("SKL_TARGET_RESET");
    const skill = cooldownManipulationSkill("ACT_CD_RESET", 1);
    const effectAction = cooldownManipulationEffectAction(
      "ACT_CD_RESET",
      "SKL_TARGET_RESET",
      "RESET",
    );
    const allyBase = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CD_MANIP_RESET",
      limits: { maximumAp: 1 },
    });
    const ally: BattleUnit = {
      ...allyBase,
      cooldowns: { [targetSkillDefinitionId]: { unit: "ACTION", remaining: 3 } },
    };
    const enemy = unit("ENEMY_1", "ENEMY");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.cooldowns[targetSkillDefinitionId]).toMatchObject({
      unit: "ACTION",
      remaining: 0,
    });
    const reduced = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownReduced" && e.sourceUnitId === ally.battleUnitId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: targetSkillDefinitionId,
      before: 3,
      after: 0,
    });
    expect(
      ctx.recorder
        .getEvents()
        .filter((e) => e.eventType === "CooldownCompleted" && e.sourceUnitId === ally.battleUnitId),
    ).toHaveLength(1);
  });

  it("UT-ACTION-PHASE-016 (Issue #129 COOLDOWN_MANIPULATION): REDUCE decreases a target skill's remaining by the given amount without completing it", () => {
    // TURN-unit target skill: isolates REDUCE from R-SKL-04's own per-ACTION
    // natural decay (which only touches the actor's ACTION-unit cooldowns at
    // ActionCompleting and would otherwise also decrement this entry by 1).
    const unitDefinitionId = createUnitDefinitionId("UNIT_CD_MANIP_REDUCE");
    const targetSkillDefinitionId = createSkillDefinitionId("SKL_TARGET_REDUCE");
    const skill = cooldownManipulationSkill("ACT_CD_REDUCE", 1);
    const effectAction = cooldownManipulationEffectAction(
      "ACT_CD_REDUCE",
      "SKL_TARGET_REDUCE",
      "REDUCE",
      1,
    );
    const allyBase = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CD_MANIP_REDUCE",
      limits: { maximumAp: 1 },
    });
    const ally: BattleUnit = {
      ...allyBase,
      cooldowns: { [targetSkillDefinitionId]: { unit: "TURN", remaining: 4 } },
    };
    const enemy = unit("ENEMY_1", "ENEMY");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.cooldowns[targetSkillDefinitionId]).toMatchObject({
      unit: "TURN",
      remaining: 3,
    });
    const reduced = ctx.recorder
      .getEvents()
      .filter((e) => e.eventType === "CooldownReduced" && e.sourceUnitId === ally.battleUnitId);
    expect(reduced).toHaveLength(1);
    expect(reduced[0]!.payload).toMatchObject({ before: 4, after: 3 });
    expect(
      ctx.recorder
        .getEvents()
        .filter((e) => e.eventType === "CooldownCompleted" && e.sourceUnitId === ally.battleUnitId),
    ).toHaveLength(0);
  });

  it("UT-ACTION-PHASE-017 (Issue #129 COOLDOWN_MANIPULATION): manipulating a READY/unregistered target skill is a no-op and emits no CooldownReduced", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CD_MANIP_NOOP");
    const skill = cooldownManipulationSkill("ACT_CD_NOOP", 1);
    const effectAction = cooldownManipulationEffectAction(
      "ACT_CD_NOOP",
      "SKL_TARGET_NOT_REGISTERED",
      "RESET",
    );
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CD_MANIP_NOOP",
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    expect(result.allyUnits[0]!.cooldowns).toEqual({});
    expect(
      ctx.recorder
        .getEvents()
        .filter((e) => e.eventType === "CooldownReduced" && e.sourceUnitId === ally.battleUnitId),
    ).toHaveLength(0);
  });

  it("UT-ACTION-PHASE-018 (Issue #129 COOLDOWN_MANIPULATION): an independent Reducer replaying CooldownReduced/CooldownCompleted StateDelta from an initial snapshot reconstructs the same final cooldowns as the live engine", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_CD_MANIP_RESTORE");
    const targetSkillDefinitionId = createSkillDefinitionId("SKL_TARGET_RESTORE");
    const skill = cooldownManipulationSkill("ACT_CD_RESTORE", 1);
    const effectAction = cooldownManipulationEffectAction(
      "ACT_CD_RESTORE",
      "SKL_TARGET_RESTORE",
      "RESET",
    );
    const allyBase = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CD_MANIP_RESTORE",
      limits: { maximumAp: 1 },
    });
    const ally: BattleUnit = {
      ...allyBase,
      cooldowns: { [targetSkillDefinitionId]: { unit: "ACTION", remaining: 3 } },
    };
    const enemy = unit("ENEMY_1", "ENEMY");
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([[effectAction.effectActionDefinitionId, effectAction]]),
    );
    const random = new SequenceRandomSource([]);
    const ctx = actionPhaseContext();

    const initialState: BattleStateSnapshot = {
      status: "RUNNING",
      currentTurn: ctx.turnNumber,
      units: {
        [ally.battleUnitId]: {
          hp: ally.currentHp,
          ap: ally.currentAp,
          pp: ally.currentPp,
          extraGauge: ally.currentExtraGauge,
          maximumAp: ally.maximumAp,
          maximumPp: ally.maximumPp,
          maximumExtraGauge: ally.maximumExtraGauge,
          combatStats: ally.combatStats,
          baseCombatStats: ally.combatStats,
          cooldowns: { [targetSkillDefinitionId]: { unit: "ACTION", remaining: 3 } },
        },
        [enemy.battleUnitId]: {
          hp: enemy.currentHp,
          ap: enemy.currentAp,
          pp: enemy.currentPp,
          extraGauge: enemy.currentExtraGauge,
          maximumAp: enemy.maximumAp,
          maximumPp: enemy.maximumPp,
          maximumExtraGauge: enemy.maximumExtraGauge,
          combatStats: enemy.combatStats,
          baseCombatStats: enemy.combatStats,
        },
      },
    };

    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // Sanity check: this action does reach 0 and emits both events (the
    // scenario the review asked to prove StateDelta-restorable).
    expect(ctx.recorder.getEvents().filter((e) => e.eventType === "CooldownReduced")).toHaveLength(
      1,
    );
    expect(
      ctx.recorder.getEvents().filter((e) => e.eventType === "CooldownCompleted"),
    ).toHaveLength(1);

    const deltas = ctx.recorder
      .getEvents()
      .map((e) => e.stateDelta)
      .filter((delta): delta is NonNullable<typeof delta> => delta !== undefined);
    const restored = reduceStateDeltas(initialState, deltas);

    expect(restored.units[ally.battleUnitId]!.cooldowns).toEqual({
      [targetSkillDefinitionId]: { unit: "ACTION", remaining: 0 },
    });
    expect(restored.units[ally.battleUnitId]!.cooldowns![targetSkillDefinitionId]!.remaining).toBe(
      result.allyUnits[0]!.cooldowns[targetSkillDefinitionId]!.remaining,
    );
  });

  it("UT-R-SKL-02-001 (Issue #34 integration): an AS attack's DamageApplied triggers the defender's own PS (PP consumed, EX gauge increased) within the same action", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER_PS_INTEGRATION");
    const defenderUnitDefinitionId = createUnitDefinitionId("UNIT_DEFENDER_WITH_PS");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_DAMAGED");

    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_ATTACKER_PS_INTEGRATION",
      attack: 30,
      limits: { maximumAp: 1 },
    });
    const enemy = {
      ...unit("ENEMY_1", "ENEMY", {
        unitDefinitionId: "UNIT_DEFENDER_WITH_PS",
        defense: 10,
        maximumHp: 100,
        limits: { maximumAp: 0, maximumPp: 3, maximumExtraGauge: 10 },
      }),
      currentPp: 3,
    };

    const effectAction = damageEffectAction("ACT_ATTACK");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "DamageApplied",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "SELF",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: "SKL_PS_ON_DAMAGED", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        defenderUnitDefinitionId,
        {
          unitDefinitionId: defenderUnitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "TANK",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 10,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 10,
            maximumAp: 1,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "Defender",
            characterName: "Defender",
            characterId: "CHAR_DEFENDER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[attackerUnitDefinitionId, [attackSkill("ACT_ATTACK", 1)]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([[effectAction.effectActionDefinitionId, effectAction]]),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedEnemy = result.enemyUnits[0]!;
    expect(updatedEnemy.currentHp).toBe(80);
    expect(updatedEnemy.currentPp).toBe(2);
    expect(updatedEnemy.currentExtraGauge).toBe(1);

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "PassiveActivated")).toBe(true);
    expect(events.some((e) => e.eventType === "PassiveResolved")).toBe(true);
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: enemy.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
      ppBefore: 3,
      ppAfter: 2,
      exBefore: 0,
      exAfter: 1,
    });
  });

  it("UT-R-SKL-02-002 (Issue #143 fix: SkillUseCompleted now reaches PS candidate detection): an AS use's own SkillUseCompleted triggers the actor's own PS within the same action", () => {
    const attackerUnitDefinitionId = createUnitDefinitionId("UNIT_ATTACKER_SELF_PS");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_OWN_AS");

    const ally = {
      ...unit("ALLY_1", "ALLY", {
        unitDefinitionId: "UNIT_ATTACKER_SELF_PS",
        attack: 30,
        limits: { maximumAp: 1, maximumPp: 3, maximumExtraGauge: 10 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", { defense: 10, maximumHp: 100 });

    const effectAction = damageEffectAction("ACT_ATTACK_SELF_PS");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "SkillUseCompleted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "EVENT_PAYLOAD", field: "skillType", op: "EQ", value: "AS" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: "SKL_PS_ON_OWN_AS", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        attackerUnitDefinitionId,
        {
          unitDefinitionId: attackerUnitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 30,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 10,
            maximumAp: 1,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "Attacker",
            characterName: "Attacker",
            characterId: "CHAR_ATTACKER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([
        [attackerUnitDefinitionId, [attackSkill("ACT_ATTACK_SELF_PS", 1)]],
      ]),
      exSkillByUnit: new Map(),
      effectActions: new Map([[effectAction.effectActionDefinitionId, effectAction]]),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedAlly = result.allyUnits[0]!;
    expect(updatedAlly.currentPp).toBe(2);

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "PassiveActivated")).toBe(true);
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
    });
    const skillUseCompletedIndex = events.findIndex((e) => e.eventType === "SkillUseCompleted");
    const passiveActivatedIndex = events.findIndex((e) => e.eventType === "PassiveActivated");
    expect(skillUseCompletedIndex).toBeGreaterThanOrEqual(0);
    expect(passiveActivatedIndex).toBeGreaterThan(skillUseCompletedIndex);
  });

  it("UT-R-SKL-02-003: a WAIT action's own ActionWaited triggers the actor's own PS within the same resolution scope", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_WAITER_SELF_PS");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_OWN_WAIT");

    const ally = {
      ...unit("ALLY_1", "ALLY", {
        unitDefinitionId: "UNIT_WAITER_SELF_PS",
        limits: { maximumAp: 1, maximumPp: 3, maximumExtraGauge: 10 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY");

    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ActionWaited",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ANY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: "SKL_PS_ON_OWN_WAIT", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        unitDefinitionId,
        {
          unitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 10,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 10,
            maximumAp: 1,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "Waiter",
            characterName: "Waiter",
            characterId: "CHAR_WAITER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map(),
      exSkillByUnit: new Map(),
      effectActions: new Map(),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedAlly = result.allyUnits[0]!;
    expect(updatedAlly.currentPp).toBe(2);

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "ActionWaited")).toBe(true);
    expect(events.some((e) => e.eventType === "PassiveActivated")).toBe(true);
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: ally.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
    });
  });

  it("UT-R-SKL-02-004: a CHARGE skill's own ChargeStarted triggers an ally's PS within the same resolution scope (mirrors production Harriet PS2's sourceSelector/targetSelector: ALLY)", () => {
    const chargerUnitDefinitionId = createUnitDefinitionId("UNIT_CHARGER_PS_WIRING");
    const supporterUnitDefinitionId = createUnitDefinitionId("UNIT_SUPPORTER_PS_WIRING");
    const passiveSkillDefinitionId = createSkillDefinitionId("SKL_PS_ON_ALLY_CHARGE_START");

    const charger = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_CHARGER_PS_WIRING",
      limits: { maximumAp: 1 },
    });
    const supporter = {
      ...unit("ALLY_2", "ALLY", {
        unitDefinitionId: "UNIT_SUPPORTER_PS_WIRING",
        limits: { maximumAp: 0, maximumPp: 3 },
      }),
      currentPp: 3,
    };
    const enemy = unit("ENEMY_1", "ENEMY", { maximumHp: 1000 });

    const skill = chargeSkill("ACT_CHARGE_PS_WIRING", 1);
    const effectAction = damageEffectAction("ACT_CHARGE_PS_WIRING");
    const passiveSkill: SkillDefinition = {
      skillDefinitionId: passiveSkillDefinitionId,
      skillType: "PS",
      cost: { resource: "PP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [
        {
          eventType: "ChargeStarted",
          category: "FACT",
          sourceSelector: "ALLY",
          targetSelector: "ALLY",
          condition: { kind: "TRUE" },
        },
      ],
      counterUpdates: [],
      resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
      cooldown: { unit: "ACTION", count: 0 },
      traits: {
        priorityAttack: false,
        simultaneousActivationLimited: false,
        exclusiveActivationGroupId: null,
        accuracy: { guaranteedHit: false },
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      },
      metadata: { displayName: "SKL_PS_ON_ALLY_CHARGE_START", tags: [] },
    };

    const unitDefinitions = new DefaultUnitDefinitionMap([
      [
        supporterUnitDefinitionId,
        {
          unitDefinitionId: supporterUnitDefinitionId,
          category: "PLAYABLE",
          attribute: "AGGRESSIVE",
          unitType: "PHYSICAL",
          role: "PHYSICAL_ATTACKER",
          positionAptitudes: ["FRONT", "BACK"],
          baseStats: {
            maximumHp: 100,
            attack: 10,
            defense: 10,
            criticalRate: 0,
            criticalDamageBonus: 0.5,
            affinityBonus: 0,
            actionSpeed: 10,
            maximumAp: 0,
            maximumPp: 3,
          },
          extraGaugeMaximum: 10,
          activeSkillDefinitionIds: [],
          passiveSkillDefinitionIds: [passiveSkillDefinitionId],
          extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
          metadata: {
            displayName: "Supporter",
            characterName: "Supporter",
            characterId: "CHAR_SUPPORTER",
            affiliations: [],
            tags: [],
          },
        },
      ],
    ]);

    const definitions: BattleDefinitions = {
      activeSkillsByUnit: new Map([[chargerUnitDefinitionId, [skill]]]),
      exSkillByUnit: new Map(),
      effectActions: new Map([[effectAction.effectActionDefinitionId, effectAction]]),
      unitDefinitions,
      skillDefinitions: new Map([[passiveSkillDefinitionId, passiveSkill]]),
    };
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [charger, supporter],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const updatedSupporter = result.allyUnits.find(
      (u) => u.battleUnitId === supporter.battleUnitId,
    )!;
    expect(updatedSupporter.currentPp).toBe(2);

    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "ChargeStarted")).toBe(true);
    expect(events.some((e) => e.eventType === "PassiveActivated")).toBe(true);
    const passiveActivated = events.find((e) => e.eventType === "PassiveActivated")!;
    expect(passiveActivated.payload).toMatchObject({
      actorUnitId: supporter.battleUnitId,
      skillDefinitionId: passiveSkillDefinitionId,
    });
  });

  it("when the actor is defeated by their own skill's first step, the second step is skipped and SkillUseInterrupted is emitted instead of SkillUseCompleted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SELF_DESTRUCT");
    const selfDamage = damageEffectAction("ACT_SELF_DAMAGE");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_SELF_DESTRUCT"),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [{ targetBindingId: enemyBindingId, selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
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
      metadata: { displayName: "SelfDestruct", tags: [] },
    };
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SELF_DESTRUCT",
      currentHp: 10,
      maximumHp: 10,
      attack: 100,
      defense: 0,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([
        [selfDamage.effectActionDefinitionId, selfDamage],
        [enemyDamage.effectActionDefinitionId, enemyDamage],
      ]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    // The self-damage step defeats the actor, so the enemy step must never apply.
    expect(
      events.some(
        (e) =>
          e.eventType === "DamageApplied" &&
          e.sourceUnitId === ally.battleUnitId &&
          e.targetUnitIds?.includes(enemy.battleUnitId),
      ),
    ).toBe(false);
    expect(events.some((e) => e.eventType === "SkillUseInterrupted")).toBe(true);
    expect(events.some((e) => e.eventType === "SkillUseCompleted")).toBe(false);
    const interrupted = events.find((e) => e.eventType === "SkillUseInterrupted")!;
    expect(interrupted.payload).toMatchObject({
      skillDefinitionId: skill.skillDefinitionId,
      reason: "ACTOR_DEFEATED",
      // Issue #217 design point D2: unresolvedEffectCount is the exact
      // remainder of the currently-open ACTION step only (the self-damage
      // step resolved). The second top-level step was never entered, so it
      // contributes 0, not an estimate of its own hit count.
      resolvedEffectCount: 1,
      unresolvedEffectCount: 0,
    });
  });

  it("when the actor is defeated only by their own skill's LAST step (nothing left unresolved), SkillUseCompleted is emitted, not SkillUseInterrupted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SELF_DESTRUCT_LAST");
    const enemyDamage = damageEffectAction("ACT_ENEMY_DAMAGE");
    const selfDamage = damageEffectAction("ACT_SELF_DAMAGE");
    const enemyBindingId = createTargetBindingId("TGT_ENEMY");
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_SELF_DESTRUCT_LAST"),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [{ targetBindingId: enemyBindingId, selector: ENEMY_ALL }],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: enemyBindingId },
            actions: [{ effectActionDefinitionId: enemyDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
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
      metadata: { displayName: "SelfDestructLast", tags: [] },
    };
    const ally = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SELF_DESTRUCT_LAST",
      currentHp: 10,
      maximumHp: 10,
      attack: 100,
      defense: 0,
      limits: { maximumAp: 1 },
    });
    const enemy = unit("ENEMY_1", "ENEMY", { currentHp: 100, maximumHp: 100 });
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([
        [enemyDamage.effectActionDefinitionId, enemyDamage],
        [selfDamage.effectActionDefinitionId, selfDamage],
      ]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    resolveActionPhase(
      [ally],
      [enemy],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    const events = ctx.recorder.getEvents();
    // Both steps actually applied (enemy hit, then the fatal self hit); there
    // was nothing left unresolved when the actor ended up defeated.
    expect(
      events.some(
        (e) =>
          e.eventType === "DamageApplied" &&
          e.sourceUnitId === ally.battleUnitId &&
          e.targetUnitIds?.includes(enemy.battleUnitId),
      ),
    ).toBe(true);
    expect(events.some((e) => e.eventType === "SkillUseCompleted")).toBe(true);
    expect(events.some((e) => e.eventType === "SkillUseInterrupted")).toBe(false);
  });

  it("when the actor is defeated by the last hit of a DAMAGE group, a subsequent COOLDOWN_MANIPULATION group must not apply, and the skill use is reported as interrupted", () => {
    const unitDefinitionId = createUnitDefinitionId("UNIT_SELF_DESTRUCT_THEN_CD");
    const selfDamage = damageEffectAction("ACT_SELF_DAMAGE");
    const targetSkillDefinitionId = createSkillDefinitionId("SKL_TARGET_CD");
    const cdManipAction = cooldownManipulationEffectAction(
      "ACT_CD_RESET",
      "SKL_TARGET_CD",
      "RESET",
    );
    const skill: SkillDefinition = {
      skillDefinitionId: createSkillDefinitionId("SKL_SELF_DESTRUCT_THEN_CD"),
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      activationCondition: { kind: "TRUE" },
      triggers: [],
      counterUpdates: [],
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfDamage.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: cdManipAction.effectActionDefinitionId }],
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
      metadata: { displayName: "SelfDestructThenCooldownManip", tags: [] },
    };
    const allyBase = unit("ALLY_1", "ALLY", {
      unitDefinitionId: "UNIT_SELF_DESTRUCT_THEN_CD",
      currentHp: 10,
      maximumHp: 10,
      attack: 100,
      defense: 0,
      limits: { maximumAp: 1 },
    });
    const ally: BattleUnit = {
      ...allyBase,
      cooldowns: { [targetSkillDefinitionId]: { unit: "ACTION", remaining: 3 } },
    };
    const definitions = definitionsOf(
      new Map([[unitDefinitionId, [skill]]]),
      new Map([
        [selfDamage.effectActionDefinitionId, selfDamage],
        [cdManipAction.effectActionDefinitionId, cdManipAction],
      ]),
    );
    const random = new SequenceRandomSource([]);

    const ctx = actionPhaseContext();
    const result = resolveActionPhase(
      [ally],
      [],
      definitions,
      random,
      ctx.recorder,
      ctx.turnNumber,
      ctx.turnRootEventId,
      ctx.turnScopeParentEventId,
    );

    // The self-lethal hit defeats the actor, so the COOLDOWN_MANIPULATION
    // step's RESET must never apply (remaining would be 0 if it had run).
    // `ActionCompleting`'s unrelated natural per-action decay (R-SKL-04) still
    // reduces it by 1 regardless of how the action ended, so 2 (not 3) is the
    // correct unaffected-by-RESET value here.
    expect(result.allyUnits[0]!.cooldowns[targetSkillDefinitionId]).toEqual({
      unit: "ACTION",
      remaining: 2,
    });
    const events = ctx.recorder.getEvents();
    expect(events.some((e) => e.eventType === "SkillUseInterrupted")).toBe(true);
    expect(events.some((e) => e.eventType === "SkillUseCompleted")).toBe(false);
    const interrupted = events.find((e) => e.eventType === "SkillUseInterrupted")!;
    // Issue #217 design point D2: unresolvedEffectCount is the exact
    // remainder of the currently-open ACTION step only. The second top-level
    // step (COOLDOWN_MANIPULATION) was never entered, so it contributes 0.
    expect(interrupted.payload).toMatchObject({
      resolvedEffectCount: 1,
      unresolvedEffectCount: 0,
    });
  });
});
