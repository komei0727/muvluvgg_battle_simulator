import { applyDamageAction } from "../../domain/battle/combat/damage-application-service.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { DamageType } from "../../domain/catalog/definitions/catalog-enums.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import { noMissNoCrit } from "../fixtures/index.js";

/**
 * ユニット効果軸の `-004` 以降が使う「1発だけ殴って、その1ヒットが実ダメージ
 * pipeline で何を通ったか」を観測するハーネス。
 *
 * `-001` の振る舞い表は**そのユニットのスキル使用1回**が起こしたことを見るため、
 * 保持している効果が**別のスキル使用（＝以後の攻撃）で**どう効くかを表せない。
 * `APPLY_DAMAGE_MOD` の与ダメージ／被ダメージ補正（R-DMG-04）と貫通（R-DMG-03）、
 * `APPLY_DAMAGE_LINK` の転送（R-LNK-01〜03）はどれもこの形の機構である。
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
  /** 元ダメージと、そこから派生したリンクダメージの適用を発生順に並べたもの。 */
  readonly applications: readonly ObservedDamageApplication[];
  readonly linked: readonly ObservedLinkedDamage[];
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
      critical: { mode: "PREVENTED" },
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
    noMissNoCrit(),
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

  const emitted = recorder.getEvents().slice(eventsBefore);
  const calculated = emitted.find(
    (event): event is Extract<BattleDomainEvent, { eventType: "DamageCalculated" }> =>
      event.eventType === "DamageCalculated",
  );
  if (calculated === undefined) {
    throw new Error("the probe hit produced no DamageCalculated");
  }

  const hpBefore = new Map(options.units.map((unit) => [unit.battleUnitId, unit.currentHp]));
  const hpDeltas: Record<string, number> = {};
  for (const unit of result.units) {
    const before = hpBefore.get(unit.battleUnitId);
    if (before !== undefined && before !== unit.currentHp) {
      hpDeltas[unit.battleUnitId] = unit.currentHp - before;
    }
  }

  return {
    units: result.units,
    recorder,
    calculated: {
      outgoingDamageMultiplier: calculated.payload.outgoingDamageMultiplier,
      incomingDamageMultiplier: calculated.payload.incomingDamageMultiplier,
      shieldIgnoreRate: calculated.payload.shieldIgnoreRate,
      damageReductionIgnoreRate: calculated.payload.damageReductionIgnoreRate,
      preTruncationDamage: calculated.payload.preTruncationDamage,
      finalDamage: calculated.payload.finalDamage,
    },
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
    hpDeltas,
  };
}
