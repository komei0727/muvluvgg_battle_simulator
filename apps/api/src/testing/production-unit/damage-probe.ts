import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { applyEffectActionGroups } from "../../domain/battle/lifecycle/effect-action-group-resolver.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { resolveSkillOrder } from "../../domain/battle/skill/skill-resolution-service.js";
import type { CriticalMode, DamageType } from "../../domain/catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { RandomSource } from "../../domain/ports/random-source.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { effectActionGroupContext, noMissNoCrit, seedRecorder } from "../fixtures/index.js";

/**
 * ユニット効果軸の `-004` 以降が使う「1発だけ殴って、その1ヒットが実ダメージ
 * pipeline で何を通ったか」を観測するハーネス。
 *
 * `-001` の振る舞い表は**そのユニットのスキル使用1回**が起こしたことを見るため、
 * 保持している効果が**別のスキル使用（＝以後の攻撃）で**どう効くかを表せない。
 * `APPLY_DAMAGE_MOD` の与ダメージ／被ダメージ補正（R-DMG-04）と貫通（R-DMG-03）、
 * `APPLY_DAMAGE_LINK` の転送（R-LNK-01〜03）、防御介入（引き寄せ・肩代わり・反射・
 * 致死耐え、R-INT-01〜03）、混乱倍率（R-CFS-02）とダメージ→回復転換（R-DTH-01）は
 * どれもこの形の機構である。
 *
 * 観測は近似せず実 `applyDamageAction` を通す — `composeDamageModifiers` を直接
 * 呼ぶと `DamageCalculated` の集計欄・シールドへの振り分け・リンクの派生が
 * まるごと観測の外に落ちるためである。対象は `ResolvedEffectApplication` で
 * 名指しする（対象選択は `-001` の観測が持つ責務であり、ここでは「誰を殴るか」を
 * 前提として固定したい）。
 */

/**
 * 検証対象ユニットのものではない、この観測専用のDAMAGE定義ID。実定義を借りると
 * 「観測に使った一撃」が実行ベース網羅（`-003`）の実績へ混ざりうるため、必ず
 * 合成IDにする。既定（威力1）では盤面既定値の攻撃1000・防御500から500ダメージになる。
 */
const PROBE_ACTION_ID = "ACT_TEST_DAMAGE_PROBE";

export interface DamageProbeOptions {
  readonly units: readonly BattleUnit[];
  readonly attackerUnitId: string;
  readonly targetUnitId: string;
  /** `SKILL_POWER` の威力。既定1。 */
  readonly power?: number;
  /** 既定 `PHYSICAL`。盤面の属性相性は0のため倍率は常に1になる。 */
  readonly damageType?: DamageType;
  /** R-DMG-03の貫通3割合。既定はすべて0。 */
  readonly piercing?: {
    readonly defenseIgnoreRate?: number;
    readonly shieldIgnoreRate?: number;
    readonly damageReductionIgnoreRate?: number;
  };
  /**
   * 既定は `PREVENTED`（会心を観測から外す）。**会心率へ働く効果**が本当にその1発へ
   * 乗ったかを見たい場合だけ `NORMAL` にして、`random` で抽選値を挟む。
   */
  readonly critical?: CriticalMode;
  /** 既定は「命中・非会心」へ倒す固定列。`critical: NORMAL` のときだけ意味を持つ。 */
  readonly random?: RandomSource;
  readonly battleId?: string;
}

/** R-DMG-01/03/04が `DamageCalculated` へ載せる集計結果。 */
export interface ObservedDamageCalculation {
  readonly outgoingDamageMultiplier: number;
  readonly incomingDamageMultiplier: number;
  readonly shieldIgnoreRate: number;
  readonly damageReductionIgnoreRate: number;
  readonly preTruncationDamage: number;
  readonly finalDamage: number;
}

/** `DamageApplied` のうち、リンクの検証で意味を持つ欄だけ。 */
export interface ObservedDamageApplication {
  readonly targetUnitId: string;
  readonly calculatedDamage: number;
  readonly hitPointDamage: number;
  readonly untypedShieldAbsorbed: number;
  readonly isLinkedDamage: boolean;
}

/**
 * R-DMG-03の防御無視が**確定計算**まで届いたことを見る2欄。`DamageWillBeApplied`
 * のsnapshotにしか現れず実計算が静的値のまま、という配線漏れはここにしか出ない。
 */
export interface ObservedEffectiveDefense {
  readonly defenseIgnoreRate: number;
  readonly effectiveDefense: number;
}

/** `DamageRedirected` payload（`effectInstanceId`・`hitIndex` を除く）。 */
export interface ObservedRedirect {
  readonly reason: string;
  readonly originalTargetUnitId: string;
  readonly newTargetUnitId: string;
  readonly causeEffectActionDefinitionId: string;
  /** `reason: COVER` だけが持つR-INT-02の2率。 */
  readonly damageShareRate?: number;
  readonly guardRate?: number;
}

/** `ReflectedDamageGenerated` payload（`sourceDamageEventId`・`effectInstanceId` を除く）。 */
export interface ObservedReflectedDamage {
  readonly effectActionDefinitionId: string;
  readonly reflectedByUnitId: string;
  readonly reflectToUnitId: string;
  readonly sourceDamage: number;
  readonly reflectedDamage: number;
  readonly damageType: string;
}

/** `LethalDamageSurvived` payload（`effectInstanceId` を除く）。 */
export interface ObservedLethalSurvival {
  readonly effectActionDefinitionId: string;
  readonly battleUnitId: string;
  readonly lethalDamage: number;
  readonly hpBefore: number;
  readonly survivalHp: number;
}

/** 致死耐えの `healAfterSurvival` など、この1ヒットに付随して起きた回復。 */
export interface ObservedHeal {
  readonly effectActionDefinitionId: string;
  readonly targetUnitId: string;
  readonly healAmount: number;
  readonly hpBefore: number;
  readonly hpAfter: number;
}

/** `DamageConvertedToHeal` payload（`hitIndex` を除く）。 */
export interface ObservedDamageToHeal {
  readonly effectActionDefinitionId: string;
  readonly targetUnitId: string;
  readonly calculatedDamage: number;
  readonly healRate: number;
  readonly healAmount: number;
  readonly appliedHeal: number;
  readonly hpBefore: number;
  readonly hpAfter: number;
}

/** `LinkedDamageGenerated` payload（`sourceDamageEventId`・`effectInstanceId` を除く）。 */
export interface ObservedLinkedDamage {
  readonly effectActionDefinitionId: string;
  readonly linkedFromUnitId: string;
  readonly linkToUnitId: string;
  readonly sourceDamage: number;
  readonly linkRate: number;
  readonly linkedDamage: number;
  readonly damageType: string;
  readonly shieldApplicable: boolean;
}

export interface DamageProbeObservation {
  readonly units: readonly BattleUnit[];
  readonly recorder: EventRecorder;
  readonly calculated: ObservedDamageCalculation;
  /** R-DMG-03の防御無視の確定結果。`calculated` とは別欄にして既存の突き合わせを壊さない。 */
  readonly effectiveDefense: ObservedEffectiveDefense;
  /** R-CFS-02: 与ダメージ倍率とは別枠で公開される混乱倍率（混乱していなければ1）。 */
  readonly confusionDamageMultiplier: number;
  /** 元ダメージと、そこから派生したリンクダメージの適用を発生順に並べたもの。 */
  readonly applications: readonly ObservedDamageApplication[];
  readonly linked: readonly ObservedLinkedDamage[];
  /** R-INT-01/02: このヒットの防御側が差し替わった記録を発生順に並べたもの。 */
  readonly redirects: readonly ObservedRedirect[];
  /** R-INT-01 #4/R-INT-03: 元ダメージから派生した反射。 */
  readonly reflected: readonly ObservedReflectedDamage[];
  /** R-INT-01 #5: 致死耐え。成立すると同じ位置の `UnitDefeated` は発行されない。 */
  readonly survived: readonly ObservedLethalSurvival[];
  readonly heals: readonly ObservedHeal[];
  /** R-DTH-01: ダメージが回復へ変換された記録。 */
  readonly convertedToHeal: readonly ObservedDamageToHeal[];
  /** このヒットで戦闘不能になったユニット。 */
  readonly defeated: readonly string[];
  /** 変化したユニットだけのHP差分（減少が負）。 */
  readonly hpDeltas: Readonly<Record<string, number>>;
}

function probeAction(
  options: DamageProbeOptions,
): Extract<EffectActionDefinition, { kind: "DAMAGE" }> {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(PROBE_ACTION_ID),
    metadata: { tags: [] },
    payload: {
      damageType: options.damageType ?? "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: options.power ?? 1 },
      hitCount: 1,
      critical: { mode: options.critical ?? "PREVENTED" },
      accuracy: { mode: "GUARANTEED" },
      piercing: {
        defenseIgnoreRate: options.piercing?.defenseIgnoreRate ?? 0,
        shieldIgnoreRate: options.piercing?.shieldIgnoreRate ?? 0,
        damageReductionIgnoreRate: options.piercing?.damageReductionIgnoreRate ?? 0,
      },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

/**
 * 名指しした対象へ1ヒットだけ通し、`DamageCalculated`・`DamageApplied`・
 * `LinkedDamageGenerated` を観測へ載せる。
 *
 * `consumeEffectDuration` など `lifecycle/` が注入するフックは渡さない — この
 * ハーネスが固定したいのは補正の集計とリンクの派生であり、消費条件やPS連鎖まで
 * 混ぜると「何がその値を作ったか」が読めなくなる（消費は `-001` の観測が持つ）。
 * 消費・失効・致死耐え回復まで込みで見たい場合は
 * {@link observeLifecycleDamageProbe} を使う。
 */
export function observeDamageProbe(options: DamageProbeOptions): DamageProbeObservation {
  const recorder = new EventRecorder(createBattleId(options.battleId ?? "B_DAMAGE_PROBE"));
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const actionId = recorder.nextActionId();
  const seed = recorder.record({
    eventType: "ActionStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    actionId,
    resolutionScopeId,
    payload: {
      actorUnitId: createBattleUnitId(options.attackerUnitId),
      reservedActionType: "AS",
      effectiveActionType: "AS",
      apBefore: 1,
      apAfter: 0,
      exBefore: 0,
      exAfter: 0,
    },
  });
  const action = probeAction(options);
  const attacker = options.units.find((unit) => unit.battleUnitId === options.attackerUnitId);
  if (attacker === undefined) {
    throw new Error(`no attacker "${options.attackerUnitId}" on the board`);
  }
  const eventsBefore = recorder.getEvents().length;
  const result = applyDamageAction(
    attacker,
    [
      {
        targetUnitId: createBattleUnitId(options.targetUnitId),
        effectActionDefinitionId: action.effectActionDefinitionId,
        hitIndex: 1,
      },
    ],
    action,
    options.units,
    options.random ?? noMissNoCrit(),
    {
      recorder,
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      skillUseId: recorder.nextSkillUseId(),
      resolutionScopeId,
      rootEventId: seed.eventId,
      parentEventId: seed.eventId,
      skillDefinitionId: createSkillDefinitionId("SKL_TEST_DAMAGE_PROBE"),
      skillType: "AS",
    },
  );

  return probeObservation(recorder, eventsBefore, options.units, result.units);
}

/**
 * 実 `applyDamageAction` が出したイベント列から観測を組み立てる（直呼び経路と
 * `applyEffectActionGroups` 経由の経路で共有する）。
 */
function probeObservation(
  recorder: EventRecorder,
  eventsBefore: number,
  before: readonly BattleUnit[],
  after: readonly BattleUnit[],
): DamageProbeObservation {
  const emitted = recorder.getEvents().slice(eventsBefore);
  const calculated = emitted.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
      event.eventType === "DamageCalculated",
  );
  if (calculated === undefined) {
    throw new Error("the probe hit produced no DamageCalculated");
  }

  const hpBefore = new Map(before.map((unit) => [unit.battleUnitId, unit.currentHp]));
  const hpDeltas: Record<string, number> = {};
  for (const unit of after) {
    const previous = hpBefore.get(unit.battleUnitId);
    if (previous !== undefined && previous !== unit.currentHp) {
      hpDeltas[unit.battleUnitId] = unit.currentHp - previous;
    }
  }

  return {
    units: after,
    recorder,
    calculated: {
      outgoingDamageMultiplier: calculated.payload.outgoingDamageMultiplier,
      incomingDamageMultiplier: calculated.payload.incomingDamageMultiplier,
      shieldIgnoreRate: calculated.payload.shieldIgnoreRate,
      damageReductionIgnoreRate: calculated.payload.damageReductionIgnoreRate,
      preTruncationDamage: calculated.payload.preTruncationDamage,
      finalDamage: calculated.payload.finalDamage,
    },
    effectiveDefense: {
      defenseIgnoreRate: calculated.payload.defenseIgnoreRate,
      effectiveDefense: calculated.payload.effectiveDefense,
    },
    confusionDamageMultiplier: calculated.payload.confusionDamageMultiplier,
    applications: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "DamageApplied" }> =>
          event.eventType === "DamageApplied",
      )
      .map((event) => ({
        targetUnitId: event.payload.targetUnitId,
        calculatedDamage: event.payload.calculatedDamage,
        hitPointDamage: event.payload.hitPointDamage,
        untypedShieldAbsorbed: event.payload.untypedShieldAbsorbed,
        isLinkedDamage: event.payload.isLinkedDamage === true,
      })),
    linked: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "LinkedDamageGenerated" }> =>
          event.eventType === "LinkedDamageGenerated",
      )
      .map((event) => ({
        effectActionDefinitionId: event.payload.effectActionDefinitionId,
        linkedFromUnitId: event.payload.linkedFromUnitId,
        linkToUnitId: event.payload.linkToUnitId,
        sourceDamage: event.payload.sourceDamage,
        linkRate: event.payload.linkRate,
        linkedDamage: event.payload.linkedDamage,
        damageType: event.payload.damageType,
        shieldApplicable: event.payload.shieldApplicable,
      })),
    redirects: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "DamageRedirected" }> =>
          event.eventType === "DamageRedirected",
      )
      .map((event) => ({
        reason: event.payload.reason,
        originalTargetUnitId: event.payload.originalTargetUnitId,
        newTargetUnitId: event.payload.newTargetUnitId,
        causeEffectActionDefinitionId: event.payload.causeEffectActionDefinitionId,
        ...(event.payload.damageShareRate === undefined
          ? {}
          : { damageShareRate: event.payload.damageShareRate }),
        ...(event.payload.guardRate === undefined ? {} : { guardRate: event.payload.guardRate }),
      })),
    reflected: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "ReflectedDamageGenerated" }> =>
          event.eventType === "ReflectedDamageGenerated",
      )
      .map((event) => ({
        effectActionDefinitionId: event.payload.effectActionDefinitionId,
        reflectedByUnitId: event.payload.reflectedByUnitId,
        reflectToUnitId: event.payload.reflectToUnitId,
        sourceDamage: event.payload.sourceDamage,
        reflectedDamage: event.payload.reflectedDamage,
        damageType: event.payload.damageType,
      })),
    survived: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "LethalDamageSurvived" }> =>
          event.eventType === "LethalDamageSurvived",
      )
      .map((event) => ({
        effectActionDefinitionId: event.payload.effectActionDefinitionId,
        battleUnitId: event.payload.battleUnitId,
        lethalDamage: event.payload.lethalDamage,
        hpBefore: event.payload.hpBefore,
        survivalHp: event.payload.survivalHp,
      })),
    heals: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "HealApplied" }> =>
          event.eventType === "HealApplied",
      )
      .map((event) => ({
        effectActionDefinitionId: event.payload.effectActionDefinitionId,
        targetUnitId: event.payload.targetUnitId,
        healAmount: event.payload.healAmount,
        hpBefore: event.payload.hpBefore,
        hpAfter: event.payload.hpAfter,
      })),
    convertedToHeal: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "DamageConvertedToHeal" }> =>
          event.eventType === "DamageConvertedToHeal",
      )
      .map((event) => ({
        effectActionDefinitionId: event.payload.effectActionDefinitionId,
        targetUnitId: event.payload.targetUnitId,
        calculatedDamage: event.payload.calculatedDamage,
        healRate: event.payload.healRate,
        healAmount: event.payload.healAmount,
        appliedHeal: event.payload.appliedHeal,
        hpBefore: event.payload.hpBefore,
        hpAfter: event.payload.hpAfter,
      })),
    defeated: emitted
      .filter(
        (event): event is Extract<BattleDomainEvent, { eventType: "UnitDefeated" }> =>
          event.eventType === "UnitDefeated",
      )
      .map((event) => event.payload.unitId),
    hpDeltas,
  };
}

/** 盤面上の1体だけを一意に指す合成スキル用のID。 */
const PROBE_SKILL_ID = "SKL_TEST_DAMAGE_PROBE";
const PROBE_BINDING_ID = "TGT_TEST_DAMAGE_PROBE";

export interface LifecycleDamageProbeOptions extends DamageProbeOptions {
  /** 盤面の定義一式（`productionBoard(...).definitions`）。 */
  readonly definitions: BattleDefinitions;
}

/**
 * {@link observeDamageProbe} と同じ1発を、`applyEffectActionGroups` 経由で通す。
 *
 * R-EFF-07の消費（`consumeEffectDuration`）・枯渇インスタンスの失効・致死耐えの
 * `healAfterSurvival`（R-HEAL-01）はいずれも `combat/` が `lifecycle/` から注入
 * されるhookに委ねており、`applyDamageAction` を直接呼ぶ経路では**呼ばれない**。
 * 「効果が消費されて失効すること」まで含めて見たい観測だけがこちらを使う。
 *
 * 対象は `POSITION_SLOT` filterで名指しする — 合成スキルを通す以上は実 selector
 * 語彙で表す必要があり、盤面の1スロットには1体しか居ないため一意に決まる。
 */
export function observeLifecycleDamageProbe(
  options: LifecycleDamageProbeOptions,
): DamageProbeObservation {
  const attacker = options.units.find((unit) => unit.battleUnitId === options.attackerUnitId);
  const target = options.units.find((unit) => unit.battleUnitId === options.targetUnitId);
  if (attacker === undefined || target === undefined) {
    throw new Error(
      `no attacker "${options.attackerUnitId}" / target "${options.targetUnitId}" on the board`,
    );
  }
  const action = probeAction(options);
  const selector: TargetSelectorDefinition = {
    kind: "SELECT",
    side: attacker.side === target.side ? "ALLY" : "ENEMY",
    count: 1,
    filters: [{ kind: "POSITION_SLOT", row: target.position.row, column: target.position.column }],
    order: ["DEFAULT"],
    includeDefeated: false,
  };
  const skill: SkillDefinition = {
    skillDefinitionId: createSkillDefinitionId(PROBE_SKILL_ID),
    skillType: "AS",
    cost: { resource: "AP", amount: 0 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [{ targetBindingId: createTargetBindingId(PROBE_BINDING_ID), selector }],
      steps: [
        {
          kind: "ACTION",
          stepCondition: { kind: "TRUE" },
          targetCondition: { kind: "TRUE" },
          target: { kind: "BINDING", targetBindingId: createTargetBindingId(PROBE_BINDING_ID) },
          actions: [{ effectActionDefinitionId: action.effectActionDefinitionId }],
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
    metadata: { displayName: PROBE_SKILL_ID, tags: [] },
  };
  const definitions: BattleDefinitions = {
    ...options.definitions,
    effectActions: new Map(options.definitions.effectActions).set(
      action.effectActionDefinitionId,
      action,
    ),
    skillDefinitions: new Map(options.definitions.skillDefinitions).set(
      skill.skillDefinitionId,
      skill,
    ),
  };

  const { recorder, rootEventId } = seedRecorder(options.battleId ?? "B_DAMAGE_PROBE");
  const plan = resolveSkillOrder(
    skill,
    attacker,
    options.units,
    definitions.effectActions,
    undefined,
    definitions.unitDefinitions,
  );
  if (plan.targetUnitIds.length !== 1 || plan.targetUnitIds[0] !== options.targetUnitId) {
    throw new Error(
      `the probe slot filter resolved to [${plan.targetUnitIds.join(", ")}] instead of "${options.targetUnitId}"`,
    );
  }
  const eventsBefore = recorder.getEvents().length;
  const result = applyEffectActionGroups(
    plan,
    options.units,
    effectActionGroupContext({
      actor: attacker,
      skillId: PROBE_SKILL_ID,
      definitions,
      recorder,
      rootEventId,
      ...(options.random === undefined ? {} : { random: options.random }),
    }),
  );
  return probeObservation(recorder, eventsBefore, options.units, result.units);
}
