// docs/ui-design/03_API・データ連携設計.md §12.5「処理ステップ」/ 01_UI要求・画面設計.md §8.10。
//
// 区間（`action-segment-projector.ts`）のイベントを、行動トレースが処理単位で進む・戻る
// 「処理ステップ」の配列へ分ける純関数。区間の全イベントがちょうど1つのステップに属し、
// ステップは区間のイベント順を保つ。見出しと要約は既存の`formatEvent`に任せ、ここでは
// 文言を作らない。ヒットの内訳と回復量はpayloadをそのまま読み、再計算・按分しない。
import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import { formatEvent } from "../details/event-formatters.js";
import type { ActionSegment } from "./action-segment-projector.js";
import type { EventPresentation, RosterIndex } from "../details/event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

export type TraceStepKind =
  | "ACTION_STARTED"
  | "SKILL_USE"
  | "TARGETS_SELECTED"
  | "ACTIVATION"
  | "HIT"
  | "SPECIAL_DAMAGE"
  | "HEAL"
  | "EFFECT"
  | "CHARGE"
  | "DEFEAT"
  | "ACTION_COMPLETED"
  | "SYSTEM"
  /** 区間の先頭から最初の起点までの、起点を持たないステップ。 */
  | "OTHER";

/** `DAMAGE_CALCULATED`の計算項目（§12.1.1）。payloadが持たない項目は持たない。 */
export interface HitCalculation {
  readonly damageType?: string;
  readonly attackerAttack?: number;
  readonly defenderDefense?: number;
  readonly effectiveDefense?: number;
  readonly defenseIgnoreRate?: number;
  readonly shieldIgnoreRate?: number;
  readonly damageReductionIgnoreRate?: number;
  readonly baseDamage?: number;
  readonly skillPower?: number;
  readonly skillPowerFormulaKind?: string;
  readonly attributeMultiplier?: number;
  readonly attackerAttribute?: string;
  readonly defenderAttribute?: string;
  readonly isFavorableAttribute?: boolean;
  readonly isSubAttributeFavorable?: boolean;
  readonly attackerAffinityBonus?: number;
  readonly criticalMultiplier?: number;
  readonly outgoingDamageMultiplier?: number;
  readonly incomingDamageMultiplier?: number;
  readonly actionDamageMultiplier?: number;
  readonly confusionDamageMultiplier?: number;
  readonly rawPreTruncationDamage?: number;
  readonly freezeMultiplier?: number;
  readonly guardRate?: number;
  readonly preTruncationDamage?: number;
  readonly thresholdReductionMultiplier?: number;
  readonly damageImmunityNullified?: boolean;
  readonly finalDamage?: number;
}

/** `DAMAGE_APPLIED`の内訳。payloadが持たない項目は持たない。 */
export interface HitApplication {
  readonly calculatedDamage?: number;
  readonly typedShieldAbsorbed?: number;
  readonly untypedShieldAbsorbed?: number;
  readonly subUnitAbsorbed?: number;
  readonly hpDirectDamage?: number;
  readonly hitPointDamage?: number;
  readonly discardedDamage?: number;
  readonly hpBefore?: number;
  readonly hpAfter?: number;
  readonly defeated?: boolean;
}

export interface TraceHit {
  /** `HIT_CONFIRMED`の対象。 */
  readonly targetUnitId?: string;
  /** 引き寄せ・肩代わり（`DAMAGE_REDIRECTED`）で防御側が変わった場合の、実際に適用された対象。 */
  readonly appliedTargetUnitId?: string;
  readonly hitIndex?: number;
  readonly calculation?: HitCalculation;
  readonly application?: HitApplication;
  /** `CRITICAL_CHECK_RESOLVED.details.result`。 */
  readonly critical?: boolean;
}

export interface TraceHeal {
  readonly targetUnitId?: string;
  /** 実際の回復量（§11のHEAL列と同じ値）。 */
  readonly appliedAmount: number;
  /** 最大HPを超えて破棄された分。 */
  readonly discardedAmount?: number;
}

export interface TraceStep {
  /** 区間の中の位置。 */
  readonly index: number;
  readonly kind: TraceStepKind;
  /** 構成イベント（区間の順）。 */
  readonly events: readonly BattleLogEventResponse[];
  /** 起点のイベント。効果・回復を束ねたステップでは複数、`OTHER`では空。 */
  readonly originEvents: readonly BattleLogEventResponse[];
  /** 起点以外の構成イベント（「その他」）。 */
  readonly otherEvents: readonly BattleLogEventResponse[];
  /** 起点ごとの`formatEvent`の結果。`OTHER`では先頭のイベントのもの。 */
  readonly presentations: readonly EventPresentation[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  /** 構成イベントの`stateVersionAfter`の最大。 */
  readonly stateVersionAfter: number;
  /** 割り込みの深さ。行動本体・システム処理は0。 */
  readonly interruptDepth: number;
  /** 構成イベントの`targetUnitIds`の和（初出順）。 */
  readonly targetUnitIds: readonly string[];
  /** 起点の`sourceUnitId`。メモリー発動は行動者を求められない（R-MEM-04）ため持たない。 */
  readonly sourceUnitId?: string;
  /** 起点の`skillUseId`。無ければ構成イベントで最初のもの。 */
  readonly skillUseId?: string;
  readonly hit?: TraceHit;
  readonly heals?: readonly TraceHeal[];
}

const ORIGIN_KIND_BY_TYPE: ReadonlyMap<string, TraceStepKind> = new Map([
  ["ACTION_STARTED", "ACTION_STARTED"],
  ["SKILL_USE_STARTED", "SKILL_USE"],
  ["TARGETS_SELECTED", "TARGETS_SELECTED"],
  ["PASSIVE_ACTIVATED", "ACTIVATION"],
  ["MEMORY_TRIGGERED", "ACTIVATION"],
  ["HIT_CONFIRMED", "HIT"],
  ["EVASION_ACTIVATED", "HIT"],
  ["SKILL_MISSED", "HIT"],
  ["CONTINUOUS_DAMAGE_APPLIED", "SPECIAL_DAMAGE"],
  ["REFLECTED_DAMAGE_GENERATED", "SPECIAL_DAMAGE"],
  ["LINKED_DAMAGE_GENERATED", "SPECIAL_DAMAGE"],
  ["HEAL_APPLIED", "HEAL"],
  ["DAMAGE_CONVERTED_TO_HEAL", "HEAL"],
  ["HEALING_TRANSFERRED", "HEAL"],
  ["EFFECT_APPLIED", "EFFECT"],
  ["EFFECT_REMOVED", "EFFECT"],
  ["EFFECT_EXPIRED", "EFFECT"],
  ["MARKER_APPLIED", "EFFECT"],
  ["MARKER_REMOVED", "EFFECT"],
  ["CHARGE_STARTED", "CHARGE"],
  ["CHARGE_RELEASED", "CHARGE"],
  ["CHARGE_CANCELLED", "CHARGE"],
  ["UNIT_DEFEATED", "DEFEAT"],
  ["LETHAL_DAMAGE_SURVIVED", "DEFEAT"],
  ["UNIT_BROKEN", "DEFEAT"],
  ["UNIT_REVIVED", "DEFEAT"],
  ["ACTION_COMPLETED", "ACTION_COMPLETED"],
  ["BATTLE_STARTED", "SYSTEM"],
  ["TURN_STARTED", "SYSTEM"],
  ["RESOURCES_RECOVERED", "SYSTEM"],
  ["ACTION_QUEUE_CREATED", "SYSTEM"],
  ["TURN_COMPLETED", "SYSTEM"],
  ["FORMATION_DEPLOYED", "SYSTEM"],
  ["FORMATION_DEFEATED", "SYSTEM"],
  ["BATTLE_COMPLETED", "SYSTEM"],
]);

const ACTIVATION_TYPES = new Set(["PASSIVE_ACTIVATED", "MEMORY_TRIGGERED"]);

/** ヒットの適用中に現れても新しいステップを始めない起点の種類。 */
const CAPTURABLE_KINDS = new Set<TraceStepKind>(["EFFECT", "HEAL"]);

/** EffectActionの境界。ダメージが無効化されて`DAMAGE_APPLIED`が出ないヒットもここで閉じる。 */
const EFFECT_ACTION_BOUNDARY_TYPES = new Set([
  "EFFECT_ACTION_COMPLETED",
  "EFFECT_ACTION_STARTING",
  "EFFECT_STEP_COMPLETED",
  "EFFECT_STEP_STARTING",
]);

const CALCULATION_STRING_KEYS = [
  "damageType",
  "skillPowerFormulaKind",
  "attackerAttribute",
  "defenderAttribute",
] as const;
const CALCULATION_BOOLEAN_KEYS = [
  "isFavorableAttribute",
  "isSubAttributeFavorable",
  "damageImmunityNullified",
] as const;
const CALCULATION_NUMBER_KEYS = [
  "attackerAttack",
  "defenderDefense",
  "effectiveDefense",
  "defenseIgnoreRate",
  "shieldIgnoreRate",
  "damageReductionIgnoreRate",
  "baseDamage",
  "skillPower",
  "attributeMultiplier",
  "attackerAffinityBonus",
  "criticalMultiplier",
  "outgoingDamageMultiplier",
  "incomingDamageMultiplier",
  "actionDamageMultiplier",
  "confusionDamageMultiplier",
  "rawPreTruncationDamage",
  "freezeMultiplier",
  "guardRate",
  "preTruncationDamage",
  "thresholdReductionMultiplier",
  "finalDamage",
] as const;
const APPLICATION_NUMBER_KEYS = [
  "calculatedDamage",
  "typedShieldAbsorbed",
  "untypedShieldAbsorbed",
  "subUnitAbsorbed",
  "hpDirectDamage",
  "hitPointDamage",
  "discardedDamage",
  "hpBefore",
  "hpAfter",
] as const;
const APPLICATION_BOOLEAN_KEYS = ["defeated"] as const;

function detailsOf(event: BattleLogEventResponse): Record<string, unknown> {
  const details = event["details"];
  return isRecord(details) ? details : {};
}

function sequenceOf(event: BattleLogEventResponse): number {
  return numberOf(event["sequence"]) ?? 0;
}

function skillUseIdOf(event: BattleLogEventResponse): string | undefined {
  return stringOf(event["skillUseId"]);
}

function parentSequenceOf(event: BattleLogEventResponse): number | undefined {
  return numberOf(event["parentSequence"]);
}

/** payloadが型どおりに持つ項目だけを写す。欠落・型違いを0や`false`と断定しない。 */
function pick(
  details: Record<string, unknown>,
  numberKeys: readonly string[],
  stringKeys: readonly string[],
  booleanKeys: readonly string[],
): Record<string, number | string | boolean> {
  const picked: Record<string, number | string | boolean> = {};
  for (const key of numberKeys) {
    const value = details[key];
    if (typeof value === "number") {
      picked[key] = value;
    }
  }
  for (const key of stringKeys) {
    const value = details[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  for (const key of booleanKeys) {
    const value = details[key];
    if (typeof value === "boolean") {
      picked[key] = value;
    }
  }
  return picked;
}

/** ヒットの同一性。`HIT_CONFIRMED`と`DAMAGE_APPLIED`の対応づけに使う。 */
interface HitKey {
  readonly skillUseId: string | undefined;
  readonly targetUnitId: string | undefined;
  readonly hitIndex: number | undefined;
}

function hitKeyOf(event: BattleLogEventResponse): HitKey {
  const details = detailsOf(event);
  return {
    skillUseId: skillUseIdOf(event),
    targetUnitId: stringOf(details["targetUnitId"]),
    hitIndex: numberOf(details["hitIndex"]),
  };
}

function sameHit(a: HitKey, b: HitKey): boolean {
  return (
    a.skillUseId === b.skillUseId && a.targetUnitId === b.targetUnitId && a.hitIndex === b.hitIndex
  );
}

/**
 * 引き寄せ・肩代わりでこのヒットの防御側が変わったら、対応づけの対象を新しい防御側へ移す。
 * 適用（`DAMAGE_APPLIED`）は差し替え後の防御側について記録されるため、移さないと
 * 元の対象のままでは同じヒットの適用を見つけられない。両方が成立すると2件続けて届く。
 */
function followRedirect(key: HitKey, event: BattleLogEventResponse): HitKey {
  if (event.type !== "DAMAGE_REDIRECTED" || skillUseIdOf(event) !== key.skillUseId) {
    return key;
  }
  const details = detailsOf(event);
  const newTargetUnitId = stringOf(details["newTargetUnitId"]);
  if (
    newTargetUnitId === undefined ||
    stringOf(details["originalTargetUnitId"]) !== key.targetUnitId ||
    numberOf(details["hitIndex"]) !== key.hitIndex
  ) {
    return key;
  }
  return { ...key, targetUnitId: newTargetUnitId };
}

function hitOf(
  origin: BattleLogEventResponse,
  events: readonly BattleLogEventResponse[],
): TraceHit {
  const key = hitKeyOf(origin);
  const calculated = events.find((event) => event.type === "DAMAGE_CALCULATED");
  let appliedKey = key;
  let applied: BattleLogEventResponse | undefined;
  for (const event of events) {
    appliedKey = followRedirect(appliedKey, event);
    if (event.type === "DAMAGE_APPLIED" && sameHit(hitKeyOf(event), appliedKey)) {
      applied = event;
      break;
    }
  }
  const critical = events
    .filter((event) => event.type === "CRITICAL_CHECK_RESOLVED")
    .map((event) => detailsOf(event)["result"])
    .find((result): result is boolean => typeof result === "boolean");
  return {
    ...(key.targetUnitId !== undefined ? { targetUnitId: key.targetUnitId } : {}),
    ...(appliedKey.targetUnitId !== key.targetUnitId && appliedKey.targetUnitId !== undefined
      ? { appliedTargetUnitId: appliedKey.targetUnitId }
      : {}),
    ...(key.hitIndex !== undefined ? { hitIndex: key.hitIndex } : {}),
    ...(calculated !== undefined
      ? {
          calculation: pick(
            detailsOf(calculated),
            CALCULATION_NUMBER_KEYS,
            CALCULATION_STRING_KEYS,
            CALCULATION_BOOLEAN_KEYS,
          ),
        }
      : {}),
    ...(applied !== undefined
      ? {
          application: pick(
            detailsOf(applied),
            APPLICATION_NUMBER_KEYS,
            [],
            APPLICATION_BOOLEAN_KEYS,
          ),
        }
      : {}),
    ...(critical !== undefined ? { critical } : {}),
  };
}

/** 実回復量を持つ回復の起点と、その回復を受けたユニットを持つ項目。 */
const HEAL_TARGET_KEY_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ["HEAL_APPLIED", "targetUnitId"],
  ["HEALING_TRANSFERRED", "toUnitId"],
]);

function healsOf(origins: readonly BattleLogEventResponse[]): readonly TraceHeal[] {
  const heals: TraceHeal[] = [];
  for (const origin of origins) {
    // 回復リンクの転送は、転送先を`toUnitId`に持つ（`targetUnitId`は持たない）。
    const targetKey = HEAL_TARGET_KEY_BY_TYPE.get(origin.type);
    if (targetKey === undefined) {
      continue;
    }
    const details = detailsOf(origin);
    const appliedAmount = numberOf(details["appliedAmount"]);
    if (appliedAmount === undefined) {
      continue;
    }
    const targetUnitId = stringOf(details[targetKey]);
    const discardedAmount = numberOf(details["discardedAmount"]);
    heals.push({
      ...(targetUnitId !== undefined ? { targetUnitId } : {}),
      appliedAmount,
      ...(discardedAmount !== undefined ? { discardedAmount } : {}),
    });
  }
  return heals;
}

function targetUnitIdsOf(events: readonly BattleLogEventResponse[]): readonly string[] {
  const targets = new Set<string>();
  for (const event of events) {
    const ids = event["targetUnitIds"];
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const id of ids) {
      if (typeof id === "string") {
        targets.add(id);
      }
    }
  }
  return [...targets];
}

interface PendingStep {
  readonly kind: TraceStepKind;
  readonly events: BattleLogEventResponse[];
  readonly originEvents: BattleLogEventResponse[];
}

/**
 * 取り込み中の適用。ヒットは同じヒットの`DAMAGE_APPLIED`で、反射・リンクの生成は続く
 * 反射先・リンク先への`DAMAGE_APPLIED`で閉じる。
 */
type Capture = { readonly kind: "hit"; readonly key: HitKey } | { readonly kind: "generated" };

/**
 * 反射・リンクの生成。吸収源を枯渇させる適用は`*_DAMAGE_GENERATED → SHIELD_CONSUMED →
 * EFFECT_EXPIRED → HIT_POINT_REDUCED → DAMAGE_APPLIED`と届くため、ヒットと同じく適用まで取り込む。
 */
const GENERATED_DAMAGE_TYPES = new Set(["REFLECTED_DAMAGE_GENERATED", "LINKED_DAMAGE_GENERATED"]);

function closesCapture(capture: Capture, event: BattleLogEventResponse): boolean {
  if (EFFECT_ACTION_BOUNDARY_TYPES.has(event.type)) {
    return true;
  }
  if (capture.kind === "generated") {
    return event.type === "DAMAGE_APPLIED";
  }
  return (
    (event.type === "DAMAGE_APPLIED" && sameHit(hitKeyOf(event), capture.key)) ||
    event.type === "DAMAGE_CONVERTED_TO_HEAL"
  );
}

/**
 * 区間のイベントを起点typeごとにステップへ分ける（§12.5の起点表と取り込み規則）。
 * 取り込みは`HIT_CONFIRMED`を起点とするヒットと反射・リンクの生成だけが持ち、その適用の
 * `DAMAGE_APPLIED`（ヒットは`DAMAGE_CONVERTED_TO_HEAL`も）・EffectActionの境界・効果と回復以外の起点で閉じる。
 */
function splitSteps(events: readonly BattleLogEventResponse[]): readonly PendingStep[] {
  const steps: PendingStep[] = [];
  let capture: Capture | undefined;
  for (const event of events) {
    const current = steps.at(-1);
    const kind = ORIGIN_KIND_BY_TYPE.get(event.type);

    if (capture !== undefined && current !== undefined) {
      if (capture.kind === "hit") {
        capture = { kind: "hit", key: followRedirect(capture.key, event) };
      }
      if (closesCapture(capture, event)) {
        current.events.push(event);
        capture = undefined;
        continue;
      }
      if (kind === undefined || CAPTURABLE_KINDS.has(kind)) {
        current.events.push(event);
        continue;
      }
      capture = undefined;
    }

    if (kind === undefined) {
      if (current === undefined) {
        steps.push({ kind: "OTHER", events: [event], originEvents: [] });
      } else {
        current.events.push(event);
      }
      continue;
    }

    const lastOrigin = current?.originEvents.at(-1);
    const bundles =
      current !== undefined &&
      lastOrigin !== undefined &&
      CAPTURABLE_KINDS.has(kind) &&
      current.kind === kind &&
      parentSequenceOf(event) !== undefined &&
      parentSequenceOf(lastOrigin) === parentSequenceOf(event);
    if (bundles) {
      current.events.push(event);
      current.originEvents.push(event);
      continue;
    }

    steps.push({ kind, events: [event], originEvents: [event] });
    if (event.type === "HIT_CONFIRMED") {
      capture = { kind: "hit", key: hitKeyOf(event) };
    } else if (GENERATED_DAMAGE_TYPES.has(event.type)) {
      capture = { kind: "generated" };
    }
  }
  return steps;
}

/**
 * 行動本体以外の発動（PS・メモリー）の`skillUseId`ごとに、その深さを求める。
 * 深さは、発動から`parentSequence`を遡って出会う、行動本体以外の発動の`skillUseId`の数+1。
 */
function activationDepths(
  events: readonly BattleLogEventResponse[],
  mainSkillUseId: string | undefined,
): ReadonlyMap<string, number> {
  const bySequence = new Map(events.map((event) => [sequenceOf(event), event] as const));
  const activations = new Map<string, BattleLogEventResponse>();
  for (const event of events) {
    const skillUseId = skillUseIdOf(event);
    if (
      skillUseId !== undefined &&
      skillUseId !== mainSkillUseId &&
      ACTIVATION_TYPES.has(event.type) &&
      !activations.has(skillUseId)
    ) {
      activations.set(skillUseId, event);
    }
  }
  const depths = new Map<string, number>();
  for (const [skillUseId, activation] of activations) {
    const ancestors = new Set<string>();
    const visited = new Set<number>();
    let parent = parentSequenceOf(activation);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = bySequence.get(parent);
      if (ancestor === undefined) {
        break;
      }
      const ancestorSkillUseId = skillUseIdOf(ancestor);
      if (
        ancestorSkillUseId !== undefined &&
        ancestorSkillUseId !== skillUseId &&
        activations.has(ancestorSkillUseId)
      ) {
        ancestors.add(ancestorSkillUseId);
      }
      parent = parentSequenceOf(ancestor);
    }
    depths.set(skillUseId, ancestors.size + 1);
  }
  return depths;
}

export function projectTraceSteps(
  segment: ActionSegment,
  roster: RosterIndex,
): readonly TraceStep[] {
  const mainSkillUseId = segment.kind === "ACTION" ? segment.mainSkill?.skillUseId : undefined;
  const depths = activationDepths(segment.events, mainSkillUseId);
  // システム区間では契機となったPSを字下げせず、PSの連鎖だけを字下げする。
  const depthOffset = segment.kind === "SYSTEM" ? 1 : 0;

  return splitSteps(segment.events).map((step, index): TraceStep => {
    const origin = step.originEvents[0];
    const skillUseId =
      (origin !== undefined ? skillUseIdOf(origin) : undefined) ??
      step.events.map(skillUseIdOf).find((id) => id !== undefined);
    const depth = skillUseId !== undefined ? depths.get(skillUseId) : undefined;
    const sourceUnitId =
      origin !== undefined && origin.type !== "MEMORY_TRIGGERED"
        ? stringOf(origin["sourceUnitId"])
        : undefined;
    const presented = step.originEvents.length > 0 ? step.originEvents : step.events.slice(0, 1);
    const heals = step.kind === "HEAL" ? healsOf(step.originEvents) : [];
    const otherEvents = step.events.filter((event) => !step.originEvents.includes(event));
    return {
      index,
      kind: step.kind,
      events: step.events,
      originEvents: step.originEvents,
      otherEvents,
      presentations: presented.map((event) => formatEvent(event, roster)),
      firstSequence: sequenceOf(step.events[0]!),
      lastSequence: sequenceOf(step.events.at(-1)!),
      stateVersionAfter: Math.max(
        ...step.events.map((event) => numberOf(event["stateVersionAfter"]) ?? 0),
      ),
      interruptDepth: depth !== undefined ? Math.max(0, depth - depthOffset) : 0,
      targetUnitIds: targetUnitIdsOf(step.events),
      ...(sourceUnitId !== undefined ? { sourceUnitId } : {}),
      ...(skillUseId !== undefined ? { skillUseId } : {}),
      ...(step.kind === "HIT" && origin !== undefined ? { hit: hitOf(origin, step.events) } : {}),
      ...(heals.length > 0 ? { heals } : {}),
    };
  });
}
