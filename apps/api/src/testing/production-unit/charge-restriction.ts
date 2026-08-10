import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import {
  resolveChargeRelease,
  resolveChargeStart,
} from "../../domain/battle/lifecycle/action-charge-resolver.js";
import { resolveSkillUse } from "../../domain/battle/lifecycle/action-skill-use-resolver.js";
import { PassiveActivationRuntime } from "../../domain/battle/lifecycle/passive-activation-service.js";
import { createEmptyPassiveActivationGuard } from "../../domain/battle/triggering/passive-activation-guard.js";
import { detectPassiveCandidates } from "../../domain/battle/triggering/passive-trigger-matcher.js";
import { reconfirmPassiveCandidate } from "../../domain/battle/triggering/reconfirm-passive-candidate.js";
import type { TriggerCandidateEvent } from "../../domain/battle/triggering/trigger-event.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import { createBattleId } from "../../domain/shared/ids.js";
import {
  definitionsWith,
  initialSnapshotFor,
  testBattleUnit,
  testUnitDefinition,
} from "../fixtures/index.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";

/**
 * 「チャージ中の回避・PS制限」（`R-SKL-05`／`R-HIT-02`／`R-HIT-04`／`R-PS-04`）を
 * ユニット効果軸から観測するためのハーネス。
 *
 * この機構は**どの単一定義にも帰属しない** — 抑止する側（`resolution.kind: CHARGE`
 * のスキル）と抑止される側（回避効果を配るスキル）が別ユニットにあるため、
 * `12_テスト戦略.md`「`IT-CAP-*` の retire 基準」3に従い関係する全ユニットの
 * ファイルから同じ観測を呼ぶ。観測の組み立てをここへ集約して重複を宣言だけに留める。
 *
 * 回避効果の付与は必ず「チャージ中のユニット以外の味方」から行う — `R-EFF-01` の
 * 行動単位期間は付与対象自身の行動終了時に減るため、チャージ中ユニット自身に行動を
 * 取らせるとチャージ開始行動の終了で `ACTION(1)` の回避が失効し、回避不発の原因が
 * 「チャージ中」か「失効済み」か区別できなくなる。
 */

const SUPPORT_UNIT_ID = "UNIT_TEST_CHARGE_SUPPORT";
const ATTACKER_UNIT_ID = "UNIT_TEST_CHARGE_ATTACKER";
const ATTACK_EFFECT_ID = "ACT_TEST_CHARGE_ATTACK";
const GRANT_SKILL_ID = "SKL_TEST_GRANT_EVASION_TO_ALLIES";
const ATTACK_SKILL_ID = "SKL_TEST_CHARGE_ATTACKER";

const LIMITS = { maximumAp: 3, maximumPp: 4, maximumExtraGauge: 100 };

const COMBAT_STATS = {
  maximumHp: 200,
  attack: 50,
  defense: 0,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function actorFor(
  battleUnitId: string,
  unitDefinitionId: string,
  side: Side,
  position: FormationPosition,
): BattleUnit {
  return testBattleUnit({
    battleUnitId,
    unitDefinitionId,
    side,
    position,
    combatStats: COMBAT_STATS,
    limits: LIMITS,
    overrides: { currentAp: LIMITS.maximumAp, currentPp: LIMITS.maximumPp },
  });
}

/** PSを一切持たない補助ユニット定義（付与役・攻撃役）。 */
function plainUnitDefinition(id: string): UnitDefinition {
  return testUnitDefinition(id, {
    baseStats: {
      ...COMBAT_STATS,
      maximumAp: LIMITS.maximumAp,
      maximumPp: LIMITS.maximumPp,
    },
    extraGaugeMaximum: LIMITS.maximumExtraGauge,
  });
}

/**
 * 実production EffectActionDefinitionだけを味方全体へ適用する最小限の合成AS。
 * `SKL_ANIS_TROUBLEMAKER_EX` の `TGT_ALL_ALLIES`（`side: ALLY, count: ALL`）と
 * 同じ対象形で、チャージ中の味方にも回避効果が届く形を再現する。
 */
function allyGrantSkill(effectActionId: string): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(GRANT_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_ALL_ALLIES"),
          selector: {
            kind: "SELECT",
            side: "ALLY",
            count: "ALL",
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
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_ALL_ALLIES") },
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
    metadata: { displayName: GRANT_SKILL_ID, tags: [] },
  };
}

/** 通常命中（`accuracy.mode: NORMAL`）の2ヒット攻撃を、指定した1体へ撃つ合成AS。 */
function attackerSkill(): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(ATTACK_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: createTargetBindingId("TGT_1"),
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
          target: { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
          actions: [{ effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID) }],
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
    metadata: { displayName: ATTACK_SKILL_ID, tags: [] },
  };
}

function twoHitAttack(): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(ATTACK_EFFECT_ID),
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount: 2,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

interface Fixture {
  readonly definitions: BattleDefinitions;
  readonly recorder: EventRecorder;
  readonly skillOf: (skillDefinitionId: string) => SkillDefinition;
}

/**
 * 渡された実 `catalog/` スナップショットへ、合成の付与AS・攻撃AS・補助ユニット定義
 * だけを足す。production定義（unit/skill/effectAction）は一切書き換えない。
 */
function fixture(snapshot: BattleCatalogSnapshot, grantEffectActionId?: string): Fixture {
  const attack = twoHitAttack();
  const effectActions = new Map(snapshot.effectActions);
  effectActions.set(attack.effectActionDefinitionId, attack);

  const definitions = definitionsWith(snapshot, {
    units: [plainUnitDefinition(SUPPORT_UNIT_ID), plainUnitDefinition(ATTACKER_UNIT_ID)],
    skills: [
      attackerSkill(),
      ...(grantEffectActionId === undefined ? [] : [allyGrantSkill(grantEffectActionId)]),
    ],
    overrides: { effectActions },
  });

  return {
    definitions,
    recorder: new EventRecorder(createBattleId("B_CHARGE")),
    skillOf: (skillDefinitionId) =>
      definitions.skillDefinitions.get(createSkillDefinitionId(skillDefinitionId))!,
  };
}

function unitIn(units: readonly BattleUnit[], target: BattleUnit): BattleUnit {
  return units.find((unit) => unit.battleUnitId === target.battleUnitId)!;
}

/** 攻撃後もチャージ側が保持している回避効果。剥がれていれば `null`。 */
export interface ObservedEvasionHolding {
  readonly statusKind: string;
  /** `EVASION` の発動確率（`statusDetails.probability`）。 */
  readonly probability?: number;
  /** `HIT_EVASION` の残り被ヒット消費（`duration.consumptionRemaining`）。 */
  readonly consumptionRemaining?: number;
}

export interface ChargeEvasionObservation {
  /** 攻撃を受ける直前のチャージ状態（保持中のスキルID。していなければ `null`）。 */
  readonly charge: string | null;
  /** 攻撃後に対象が保持している回避効果。回避が成立して消費し切ると `null`。 */
  readonly heldEvasion: ObservedEvasionHolding | null;
  readonly evasionActivated: number;
  readonly hitConfirmed: number;
  readonly damaged: boolean;
}

export interface ObserveChargeEvasionOptions {
  /** チャージ側ユニットと回避効果側ユニットの両方を含む実 `catalog/` スナップショット。 */
  readonly snapshot: BattleCatalogSnapshot;
  readonly chargerUnitDefinitionId: string;
  readonly chargeSkillDefinitionId: string;
  /** 実production の回避 EffectAction（`EVASION` / `HIT_EVASION`）。 */
  readonly evasionEffectActionId: string;
  /** `false` なら同一手順からチャージ開始だけを抜いた対照を観測する。 */
  readonly charging: boolean;
}

/**
 * 実チャージASでチャージ状態を作り（`charging`）、その後で味方が実production回避効果を
 * 味方全体へ配り、最後に敵が2ヒット攻撃を撃つ。チャージ有無だけが違う2回の観測を
 * 突き合わせると、回避が不発になった原因がチャージ状態だけであることが読める。
 */
export function observeChargeEvasion(
  options: ObserveChargeEvasionOptions,
): ChargeEvasionObservation {
  const { definitions, recorder, skillOf } = fixture(
    options.snapshot,
    options.evasionEffectActionId,
  );
  const chargeSkill = skillOf(options.chargeSkillDefinitionId);
  const grantSkill = skillOf(GRANT_SKILL_ID);
  const attackSkill = skillOf(ATTACK_SKILL_ID);

  const charger = actorFor("B_CHARGE:unit:1", options.chargerUnitDefinitionId, "ALLY", {
    column: "CENTER",
    row: "FRONT",
  });
  const support = actorFor("B_CHARGE:unit:2", SUPPORT_UNIT_ID, "ALLY", {
    column: "LEFT",
    row: "BACK",
  });
  const attacker = actorFor("B_CHARGE:unit:3", ATTACKER_UNIT_ID, "ENEMY", {
    column: "CENTER",
    row: "FRONT",
  });

  let units: readonly BattleUnit[] = [charger, support, attacker];
  if (options.charging) {
    units = resolveChargeStart(
      charger,
      chargeSkill,
      "AS",
      "AS",
      units,
      definitions,
      new SequenceRandomSource([]),
      recorder,
      1,
      0,
      createActionId("B_CHARGE:action:1"),
      recorder.nextResolutionScopeId(),
    ).units;
  }
  const chargeBeforeAttack = unitIn(units, charger).charge;

  units = resolveSkillUse(
    unitIn(units, support),
    grantSkill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:2"),
    recorder.nextResolutionScopeId(),
  ).units;

  const eventsBeforeAttack = recorder.getEvents().length;
  units = resolveSkillUse(
    unitIn(units, attacker),
    attackSkill,
    "AS",
    "AS",
    units,
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:3"),
    recorder.nextResolutionScopeId(),
  ).units;
  const eventsDuringAttack = recorder.getEvents().slice(eventsBeforeAttack);

  const chargerAfterAttack = unitIn(units, charger);
  const evasion = chargerAfterAttack.appliedEffects.find(
    (effect) => effect.effectActionDefinitionId === options.evasionEffectActionId,
  );

  return {
    charge: chargeBeforeAttack === undefined ? null : chargeBeforeAttack.skill.skillDefinitionId,
    heldEvasion:
      evasion === undefined
        ? null
        : {
            statusKind: evasion.statusKind!,
            ...(typeof evasion.statusDetails?.probability === "number"
              ? { probability: evasion.statusDetails.probability }
              : {}),
            ...(evasion.duration.consumptionRemaining === undefined
              ? {}
              : { consumptionRemaining: evasion.duration.consumptionRemaining }),
          },
    evasionActivated: countOf(eventsDuringAttack, "EvasionActivated"),
    hitConfirmed: countOf(eventsDuringAttack, "HitConfirmed"),
    damaged: chargerAfterAttack.currentHp < charger.currentHp,
  };
}

function countOf(events: readonly BattleDomainEvent[], eventType: string): number {
  return events.filter((event) => event.eventType === eventType).length;
}

export interface ChargeLifecycleObservation {
  /**
   * Catalog契約: 開始側はEffectSequenceを持たない（`targetBindings` だけが
   * `activationCondition` のスコープとして意味を持つ）。解放側は必ず持つ。
   */
  readonly startSteps: number;
  readonly releaseSteps: number;
  /**
   * 「チャージ中」を表す `APPLY_MARKER` は `charge` 状態と重複する変換由来の定義
   * だったため除去済み。実カタログのどこからも参照されない。
   */
  readonly chargeMarkerEffectActionIds: readonly string[];
  /** チャージ開始が実際に置いた状態。開始はEffectSequenceを一切解決しない。 */
  readonly afterStart: {
    readonly charge: string | null;
    readonly markerStates: number;
    readonly appliedEffects: number;
  };
  /** チャージ開始で発行されたイベント種別（発生順）。 */
  readonly startEventTypes: readonly string[];
  /** `ChargeStarted` の payload と `StateDelta` の `charge` 欄。 */
  readonly chargeStarted: {
    readonly skillDefinitionId: string;
    readonly chargeDelta: unknown;
  };
  /** 開始前スナップショットへ公開差分だけを当て直した独立Reducerの `charge`。 */
  readonly replayedChargeAfterStart: unknown;
  /** 解放後のチャージ状態。 */
  readonly chargeAfterRelease: string | null;
  /** チャージ終了差分（`charge.after === undefined`）を所有するイベント種別。 */
  readonly chargeClearingEventTypes: readonly string[];
  readonly replayedChargeAfterRelease: unknown;
}

export interface ObserveChargeLifecycleOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly chargerUnitDefinitionId: string;
  readonly chargeSkillDefinitionId: string;
}

/**
 * 実チャージASの開始→保留中→解放を一巡させ、Catalog契約・実状態・`StateDelta`・
 * 独立Reducer復元をひとつの観測へまとめる。
 */
export function observeChargeLifecycle(
  options: ObserveChargeLifecycleOptions,
): ChargeLifecycleObservation {
  const { definitions, recorder, skillOf } = fixture(options.snapshot);
  const chargeSkill = skillOf(options.chargeSkillDefinitionId);

  const charger = actorFor("B_CHARGE:unit:1", options.chargerUnitDefinitionId, "ALLY", {
    column: "CENTER",
    row: "FRONT",
  });
  const enemy = actorFor("B_CHARGE:unit:2", ATTACKER_UNIT_ID, "ENEMY", {
    column: "CENTER",
    row: "FRONT",
  });
  const initialSnapshot = initialSnapshotFor([charger, enemy]);

  const started = resolveChargeStart(
    charger,
    chargeSkill,
    "AS",
    "AS",
    [charger, enemy],
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
  const chargerAfterStart = unitIn(started, charger);
  // `getEvents()` は内部配列をそのまま返すため、解放前の状態はここでコピーして残す。
  const startEvents = [...recorder.getEvents()];
  const chargeStarted = startEvents.find((event) => event.eventType === "ChargeStarted") as Extract<
    BattleDomainEvent,
    { eventType: "ChargeStarted" }
  >;

  const released = resolveChargeRelease(
    chargerAfterStart,
    "AS",
    started,
    definitions,
    // 解放効果は会心判定でRandomSourceを消費する。会心率0のユニットでも判定自体は
    // 行われるため、常に非会心になる十分な数の固定値を与える。
    new SequenceRandomSource(Array.from({ length: 64 }, () => 0.99)),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:2"),
    recorder.nextResolutionScopeId(),
  ).units;
  const chargerAfterRelease = unitIn(released, charger);

  return {
    startSteps: chargeSkill.resolution.steps.length,
    releaseSteps:
      chargeSkill.resolution.kind === "CHARGE"
        ? chargeSkill.resolution.chargeRelease.steps.length
        : -1,
    chargeMarkerEffectActionIds: [...definitions.effectActions.keys()].filter((id) =>
      id.endsWith("_CHARGE_MARKER"),
    ),
    afterStart: {
      charge: chargerAfterStart.charge?.skill.skillDefinitionId ?? null,
      markerStates: chargerAfterStart.markerStates.length,
      appliedEffects: chargerAfterStart.appliedEffects.length,
    },
    startEventTypes: startEvents.map((event) => event.eventType),
    chargeStarted: {
      skillDefinitionId: chargeStarted.payload.skillDefinitionId,
      chargeDelta: chargeStarted.stateDelta!.units![charger.battleUnitId]!.charge,
    },
    replayedChargeAfterStart: replayedCharge(
      initialSnapshot,
      recorder,
      charger,
      startEvents.length,
    ),
    chargeAfterRelease: chargerAfterRelease.charge?.skill.skillDefinitionId ?? null,
    chargeClearingEventTypes: recorder
      .getEvents()
      .filter(
        (event) =>
          event.stateDelta?.units?.[charger.battleUnitId]?.charge !== undefined &&
          event.stateDelta.units[charger.battleUnitId]!.charge!.after === undefined,
      )
      .map((event) => event.eventType),
    replayedChargeAfterRelease: replayedCharge(initialSnapshot, recorder, charger),
  };
}

/**
 * 開始前スナップショットへ公開差分だけを当て直した独立Reducerの `charge`。
 * `eventCount` を渡すと、その件数までの差分だけを当てた途中状態を見る
 * （開始直後と解放後を同じ1本のイベント列から読み分けるため）。
 */
function replayedCharge(
  initialSnapshot: BattleStateSnapshot,
  recorder: EventRecorder,
  charger: BattleUnit,
  eventCount?: number,
): unknown {
  const events = recorder.getEvents();
  const deltas = (eventCount === undefined ? events : events.slice(0, eventCount)).flatMap(
    (event) => (event.stateDelta === undefined ? [] : [event.stateDelta]),
  );
  return reduceStateDeltas(initialSnapshot, deltas).units[charger.battleUnitId]!.charge ?? null;
}

export interface OwnerChargingObservation {
  /** チャージしていない所有者での候補数と発動直前確認の結果。 */
  readonly idle: { readonly candidates: number; readonly reconfirm: unknown };
  /** チャージ中の所有者での候補数と、同じ候補を再確認したときの結果。 */
  readonly charging: { readonly candidates: number; readonly reconfirm: unknown };
  /** チャージ解放後に制限が解けること。 */
  readonly afterRelease: { readonly candidates: number; readonly reconfirm: unknown };
  /** 実 `PassiveActivationRuntime` を通したときに `PassiveActivated` が出たか。 */
  readonly runtimeActivated: { readonly idle: boolean; readonly charging: boolean };
}

export interface ObserveOwnerChargingOptions {
  readonly snapshot: BattleCatalogSnapshot;
  readonly chargerUnitDefinitionId: string;
  readonly chargeSkillDefinitionId: string;
  /** チャージ中は候補にならないことを見るPS。`TurnStarted` 契機であること。 */
  readonly passiveSkillDefinitionId: string;
}

/**
 * `R-PS-04`「発動直前確認」の「所有者がチャージ中でない」を、実PS・実CHARGE定義で観測する。
 * 候補判定（`R-PS-01`）側の除外と、発動直前確認の `OWNER_CHARGING` 破棄の両方を見る。
 */
export function observeOwnerCharging(
  options: ObserveOwnerChargingOptions,
): OwnerChargingObservation {
  const { definitions, recorder, skillOf } = fixture(options.snapshot);
  const chargeSkill = skillOf(options.chargeSkillDefinitionId);

  const owner = actorFor("B_CHARGE:unit:1", options.chargerUnitDefinitionId, "ALLY", {
    column: "CENTER",
    row: "FRONT",
  });
  const enemy = actorFor("B_CHARGE:unit:2", ATTACKER_UNIT_ID, "ENEMY", {
    column: "CENTER",
    row: "FRONT",
  });

  const charged = resolveChargeStart(
    owner,
    chargeSkill,
    "AS",
    "AS",
    [owner, enemy],
    definitions,
    new SequenceRandomSource([]),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:1"),
    recorder.nextResolutionScopeId(),
  ).units;
  const chargingOwner = unitIn(charged, owner);

  const released = resolveChargeRelease(
    chargingOwner,
    "AS",
    charged,
    definitions,
    new SequenceRandomSource(Array.from({ length: 64 }, () => 0.99)),
    recorder,
    1,
    0,
    createActionId("B_CHARGE:action:2"),
    recorder.nextResolutionScopeId(),
  ).units;
  const releasedOwner = unitIn(released, owner);

  const turnStartedEvent: TriggerCandidateEvent = {
    eventType: "TurnStarted",
    category: "FACT",
    sourceUnitId: owner.battleUnitId,
    targetUnitIds: [owner.battleUnitId],
    payload: { turnNumber: 2 },
  };
  const guard = createEmptyPassiveActivationGuard();
  const detectFor = (candidateOwner: BattleUnit) =>
    detectPassiveCandidates({
      event: turnStartedEvent,
      units: [candidateOwner, enemy],
      unitDefinitions: definitions.unitDefinitions,
      skillDefinitions: definitions.skillDefinitions,
      activationGuard: guard,
    }).filter(
      (candidate) =>
        candidate.skillDefinition.skillDefinitionId === options.passiveSkillDefinitionId,
    );

  const idleCandidates = detectFor(owner);
  // チャージ中の再確認は「候補化された後にチャージへ入った」場合を表すため、
  // idle で得た同じ候補を最新状態（チャージ中）で確認し直す。
  const reconfirmWith = (state: BattleUnit) =>
    idleCandidates.length === 0
      ? null
      : reconfirmPassiveCandidate(idleCandidates[0]!, state, turnStartedEvent, guard);

  return {
    idle: { candidates: idleCandidates.length, reconfirm: reconfirmWith(owner) },
    charging: {
      candidates: detectFor(chargingOwner).length,
      reconfirm: reconfirmWith(chargingOwner),
    },
    afterRelease: {
      candidates: detectFor(releasedOwner).length,
      reconfirm: reconfirmWith(releasedOwner),
    },
    runtimeActivated: {
      idle: runtimeEmitsPassiveActivated(definitions, owner, enemy),
      charging: runtimeEmitsPassiveActivated(definitions, chargingOwner, enemy),
    },
  };
}

function runtimeEmitsPassiveActivated(
  definitions: BattleDefinitions,
  owner: BattleUnit,
  enemy: BattleUnit,
): boolean {
  const recorder = new EventRecorder(createBattleId("B_CHARGE_PS"));
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 2,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 2 },
  });
  new PassiveActivationRuntime(
    {
      definitions,
      random: new SequenceRandomSource(Array.from({ length: 64 }, () => 0.99)),
      recorder,
      turnNumber: 2,
      cycleNumber: 0,
      resolutionScopeId: turnStarted.resolutionScopeId,
      rootEventId: turnStarted.eventId,
    },
    [owner, enemy],
  ).onFactEvent(turnStarted, [owner, enemy]);
  return recorder.getEvents().some((event) => event.eventType === "PassiveActivated");
}
