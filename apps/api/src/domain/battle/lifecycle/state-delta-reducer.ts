import type { BattleStateSnapshot, BattleUnitSnapshot } from "./battle-state-snapshot.js";
import {
  isExerciseBattleResult,
  type BattleResultSnapshot,
  type ChargeState,
  type CooldownState,
  type EffectSnapshot,
  type ExerciseStateDelta,
  type MarkerSnapshot,
  type StateDelta,
  type UnitStateDelta,
  type ValueChange,
} from "../events/state-delta.js";
import type { ExerciseStateSnapshot } from "../model/exercise-runtime.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectInstanceId, MarkerInstanceId } from "../../shared/event-ids.js";

function assertBeforeMatches<T>(path: string, current: T, change: ValueChange<T>): void {
  if (current !== change.before) {
    throw new DomainValidationError(
      path,
      `delta.before (${String(change.before)}) does not match the current value (${String(current)}); the delta sequence is dropped, reordered, or duplicated`,
    );
  }
}

/**
 * `charge`は毎回新しいオブジェクトとして構築される複合値（`ChargeStarted.after`
 * と`ChargeReleased.before`は同じ内容でも別インスタンス）のため、`assertBeforeMatches`
 * の参照同一性（`!==`）比較では正常な開始→発動イベント列でも誤って不一致と
 * 判定してしまう。フィールド単位の構造比較で判定する。
 */
export function sameChargeState(a: ChargeState | undefined, b: ChargeState | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.skillDefinitionId === b.skillDefinitionId && a.startedActionId === b.startedActionId;
}

function assertChargeBeforeMatches(
  path: string,
  current: ChargeState | undefined,
  change: ValueChange<ChargeState | undefined>,
): void {
  if (!sameChargeState(current, change.before)) {
    throw new DomainValidationError(
      path,
      `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(current)}); the delta sequence is dropped, reordered, or duplicated`,
    );
  }
}

/**
 * `RuntimeCounter`の`AppliedEffect`スコープ公開値（EFF-005/Issue #162）。
 * `counters`はキー数が可変な複合値のため、`sameChargeState`と同じ理由で参照
 * 同一性ではなく構造比較を行う。
 */
function sameCounters(
  a: Readonly<Record<RuntimeCounterId, number>> | undefined,
  b: Readonly<Record<RuntimeCounterId, number>> | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([counter, value]) => b[counter as RuntimeCounterId] === value);
}

/**
 * `sameCounters`と同じ理由（複合値は呼び出しごとに新しいオブジェクトとして
 * 構築されるため参照同一性では判定できない）の`EffectImmunityState`版
 * （M7-001B、Issue #243、R-EFF-03）。
 */
function sameImmunityState(a: EffectSnapshot["immunity"], b: EffectSnapshot["immunity"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.categories.length === b.categories.length &&
    a.categories.every((category, i) => category === b.categories[i]) &&
    a.maxBlocks === b.maxBlocks &&
    a.blockedCount === b.blockedCount &&
    JSON.stringify(a.statusKinds) === JSON.stringify(b.statusKinds) &&
    JSON.stringify(a.effectActionDefinitionIds) === JSON.stringify(b.effectActionDefinitionIds)
  );
}

/**
 * `sameCounters`/`sameImmunityState`と同じ理由の`StatusEffectDetails`版
 * （M7-004、Issue #183）。
 */
function sameStatusDetails(
  a: EffectSnapshot["statusDetails"],
  b: EffectSnapshot["statusDetails"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.probability === b.probability &&
    a.damageAmplificationOnBreak === b.damageAmplificationOnBreak &&
    JSON.stringify(a.appliesTo) === JSON.stringify(b.appliesTo) &&
    JSON.stringify(a.damageThreshold) === JSON.stringify(b.damageThreshold)
  );
}

/**
 * R-HEAL-04（M7-005-HEAL-LINK、Issue #229）: `APPLY_HEALING_LINK`由来の効果だけが
 * 持つ転送先・転送率を`sameStatusDetails`と同じ理由で構造比較する。
 */
function sameHealingLinkState(
  a: EffectSnapshot["healingLink"],
  b: EffectSnapshot["healingLink"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.transferToUnitId === b.transferToUnitId && a.transferRate === b.transferRate;
}

/**
 * R-DMG-04（DMG-002、Issue #192）: `APPLY_DAMAGE_MOD`由来の効果だけが持つ向き・
 * 対象ダメージタイプ・動的条件を`sameHealingLinkState`と同じ理由で構造比較する。
 * `condition`は再帰的な木なので、`sameStatusDetails`の`appliesTo`と同じく
 * `JSON.stringify`で比較する（Catalog由来の決定的なプレーン値であり、
 * `deepFreeze`済みでキー順も安定している）。
 */
/**
 * R-DMG-03（DMG-003、Issue #196）: `APPLY_PIERCING_MOD`由来の3率を構造比較する
 * （`sameDamageModifierState`と同じ理由 — `magnitude`だけでは復元できない）。
 */
function samePiercingModifierState(
  a: EffectSnapshot["piercing"],
  b: EffectSnapshot["piercing"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.defenseIgnoreRate === b.defenseIgnoreRate &&
    a.shieldIgnoreRate === b.shieldIgnoreRate &&
    a.damageReductionIgnoreRate === b.damageReductionIgnoreRate
  );
}

function sameDamageModifierState(
  a: EffectSnapshot["damageModifier"],
  b: EffectSnapshot["damageModifier"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.direction === b.direction &&
    a.damageType === b.damageType &&
    JSON.stringify(a.condition) === JSON.stringify(b.condition)
  );
}

/**
 * R-SHD-01（DMG-004、Issue #194）: `APPLY_SHIELD`由来の効果だけが持つプール区分・
 * 残量・漸減宣言を`sameDamageModifierState`と同じ理由で構造比較する。`decay`は
 * Catalog由来の固定値だがインスタンスへ焼き込まれるため、欠落を検出できるよう
 * フィールド単位で比較する。
 */
function sameShieldState(a: EffectSnapshot["shield"], b: EffectSnapshot["shield"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.shieldType === b.shieldType &&
    a.remaining === b.remaining &&
    a.decay?.unit === b.decay?.unit &&
    a.decay?.ratio === b.decay?.ratio &&
    a.decay?.owner === b.decay?.owner
  );
}

/**
 * R-SUB-01/02（DMG-005、Issue #190）: `APPLY_SUBUNIT`由来の効果だけが持つ残耐久力と
 * 追加ダメージ定義を`sameShieldState`と同じ理由で構造比較する。`additionalDamage`は
 * Catalog由来の決定的なプレーン値（Formula・ダメージタイプ・デバフ参照）であり
 * `deepFreeze`済みでキー順も安定しているため、`sameDamageModifierState`の`condition`と
 * 同じく`JSON.stringify`で比較する。
 */
function sameSubUnitState(a: EffectSnapshot["subUnit"], b: EffectSnapshot["subUnit"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.durability === b.durability &&
    JSON.stringify(a.additionalDamage) === JSON.stringify(b.additionalDamage)
  );
}

/**
 * R-INT-01〜03（DMG-006、Issue #188）: 防御介入系の4状態を`sameSubUnitState`と同じ
 * 理由・同じ方針で構造比較する。Formula（`reflect.formula`／`deathSurvival.*`）は
 * Catalog由来の決定的なプレーン値で`deepFreeze`済みのため`JSON.stringify`で比較する。
 */
function sameTargetRedirectState(
  a: EffectSnapshot["targetRedirect"],
  b: EffectSnapshot["targetRedirect"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.redirectToUnitId === b.redirectToUnitId &&
    JSON.stringify(a.actionKinds) === JSON.stringify(b.actionKinds)
  );
}

function sameCoverState(a: EffectSnapshot["cover"], b: EffectSnapshot["cover"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.covererUnitId === b.covererUnitId &&
    a.damageShareRate === b.damageShareRate &&
    a.guardRate === b.guardRate &&
    JSON.stringify(a.actionKinds) === JSON.stringify(b.actionKinds)
  );
}

function sameReflectState(a: EffectSnapshot["reflect"], b: EffectSnapshot["reflect"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.allowRecursiveReflect === b.allowRecursiveReflect &&
    JSON.stringify(a.formula) === JSON.stringify(b.formula)
  );
}

/**
 * R-LNK-01〜03（DMG-007、Issue #187）: リンクダメージ状態も`sameReflectState`と
 * 同じ理由・同じ方針で構造比較する（プレーンな2値のため`JSON.stringify`は不要）。
 */
function sameDamageLinkState(
  a: EffectSnapshot["damageLink"],
  b: EffectSnapshot["damageLink"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.linkToUnitId === b.linkToUnitId && a.linkRate === b.linkRate;
}

function sameDeathSurvivalState(
  a: EffectSnapshot["deathSurvival"],
  b: EffectSnapshot["deathSurvival"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    JSON.stringify(a.survivalHp) === JSON.stringify(b.survivalHp) &&
    JSON.stringify(a.healAfterSurvival) === JSON.stringify(b.healAfterSurvival)
  );
}

/**
 * R-DOT-01〜04（DMG-008、Issue #189）: `APPLY_CONTINUOUS_DAMAGE`由来の効果だけが
 * 持つ種別・ダメージタイプを`sameShieldState`と同じ理由で構造比較する。
 */
function sameContinuousDamageState(
  a: EffectSnapshot["continuousDamage"],
  b: EffectSnapshot["continuousDamage"],
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.continuousDamageKind === b.continuousDamageKind && a.damageType === b.damageType;
}

/**
 * R-EFF-02/03（M7-001E、Issue #248）: `effectCategoriesOf`が付与時点に確定した分類集合を
 * `sameShieldState`と同じ理由で構造比較する。`toEffectSnapshot`は常にソート済み配列を
 * 出すため、順序込みの要素比較で十分（順序が違う時点で正本の`toEffectSnapshot`を
 * 経由していない差分である）。
 */
function sameCategories(a: EffectSnapshot["categories"], b: EffectSnapshot["categories"]): boolean {
  return a.length === b.length && a.every((category, index) => category === b[index]);
}

/**
 * R-DOT-01（DMG-008、Issue #189）: 継続ダメージの`sourceAttack`など、付与時に
 * 固定した値を`sameShieldState`と同じ理由で構造比較する。キー集合自体が定義
 * 依存（`Record<string, number>`）のため、キー数の一致まで見て欠落を検出する。
 */
function sameSnapshot(a: EffectSnapshot["snapshot"], b: EffectSnapshot["snapshot"]): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

/**
 * `charge`の`sameChargeState`と同じ理由（複合値は呼び出しごとに新しい
 * オブジェクトとして構築されるため参照同一性では判定できない）で、フィールド
 * 単位の構造比較を行う。
 */
export function sameEffectSnapshot(
  a: EffectSnapshot | undefined,
  b: EffectSnapshot | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.effectInstanceId === b.effectInstanceId &&
    a.effectDefinitionId === b.effectDefinitionId &&
    a.sourceUnitId === b.sourceUnitId &&
    // R-MEM-04（M7-006、Issue #179）: Memory由来の効果は`sourceUnitId`を持たず
    // `sourceSide`を持つ。両方を比較しないと、Memory由来効果のStateDeltaから
    // 発生源が欠落・破損しても独立Reducerの復元一致検証を通過してしまう。
    a.sourceSide === b.sourceSide &&
    a.kindKey === b.kindKey &&
    a.duplicate === b.duplicate &&
    a.isEffective === b.isEffective &&
    a.magnitude === b.magnitude &&
    a.statusKind === b.statusKind &&
    a.duration?.unit === b.duration?.unit &&
    a.duration?.remaining === b.duration?.remaining &&
    a.consumptionRemaining === b.consumptionRemaining &&
    a.appliedTurnNumber === b.appliedTurnNumber &&
    a.appliedActionId === b.appliedActionId &&
    sameCounters(a.counters, b.counters) &&
    sameImmunityState(a.immunity, b.immunity) &&
    sameStatusDetails(a.statusDetails, b.statusDetails) &&
    a.isAttackDamageBonus === b.isAttackDamageBonus &&
    a.isFollowUpAttack === b.isFollowUpAttack &&
    sameHealingLinkState(a.healingLink, b.healingLink) &&
    sameDamageModifierState(a.damageModifier, b.damageModifier) &&
    samePiercingModifierState(a.piercing, b.piercing) &&
    sameShieldState(a.shield, b.shield) &&
    sameSubUnitState(a.subUnit, b.subUnit) &&
    sameContinuousDamageState(a.continuousDamage, b.continuousDamage) &&
    sameTargetRedirectState(a.targetRedirect, b.targetRedirect) &&
    sameCoverState(a.cover, b.cover) &&
    sameReflectState(a.reflect, b.reflect) &&
    sameDamageLinkState(a.damageLink, b.damageLink) &&
    sameDeathSurvivalState(a.deathSurvival, b.deathSurvival) &&
    sameCategories(a.categories, b.categories) &&
    a.statModStat === b.statModStat &&
    sameSnapshot(a.snapshot, b.snapshot)
  );
}

/**
 * R-EFF-01: `EffectInstanceId`をキーとする`EffectSnapshot`の差分を適用する。
 * `Map`の挿入順を使い、既存キーの更新は位置を保ったまま、新規キー
 * （`before: undefined`）は末尾へ追加する（`applied-effect.ts`のarray順=付与順を
 * 独立Reducerでも保つ）。
 */
function applyEffectDeltas(
  path: string,
  current: readonly EffectSnapshot[] | undefined,
  deltas: UnitStateDelta["effects"],
): readonly EffectSnapshot[] | undefined {
  if (deltas === undefined) {
    return current;
  }
  const byId = new Map((current ?? []).map((effect) => [effect.effectInstanceId, effect] as const));
  for (const [effectInstanceId, change] of Object.entries(deltas) as [
    EffectInstanceId,
    ValueChange<EffectSnapshot | undefined>,
  ][]) {
    const existing = byId.get(effectInstanceId);
    if (!sameEffectSnapshot(existing, change.before)) {
      throw new DomainValidationError(
        `${path}[${effectInstanceId}]`,
        `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(existing)}); the delta sequence is dropped, reordered, or duplicated`,
      );
    }
    if (change.after === undefined) {
      byId.delete(effectInstanceId);
    } else {
      byId.set(effectInstanceId, change.after);
    }
  }
  return [...byId.values()];
}

/**
 * `sameEffectSnapshot`と同じ理由・同じ役割の`MarkerSnapshot`版（R-EFF-10）。
 */
export function sameMarkerSnapshot(
  a: MarkerSnapshot | undefined,
  b: MarkerSnapshot | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.markerInstanceId === b.markerInstanceId &&
    a.markerId === b.markerId &&
    a.sourceUnitId === b.sourceUnitId &&
    // R-MEM-04（M7-008、Issue #176）: `sameEffectSnapshot`と同じ理由 — Memory由来の
    // Markerは`sourceUnitId`を持たず`sourceSide`を持つため、両方を比較しないと
    // 発生源の欠落・破損が独立Reducerの復元一致検証をすり抜ける。
    a.sourceSide === b.sourceSide &&
    a.stackCount === b.stackCount &&
    a.stackMax === b.stackMax &&
    a.duration?.unit === b.duration?.unit &&
    a.duration?.remaining === b.duration?.remaining &&
    a.consumptionRemaining === b.consumptionRemaining
  );
}

/**
 * R-EFF-10: `applyEffectDeltas`と同じ規約の`MarkerInstanceId`版。`Map`の挿入順を
 * 使い、既存キーの更新は位置を保ったまま、新規キー（`before: undefined`）は
 * 末尾へ追加する。
 */
function applyMarkerDeltas(
  path: string,
  current: readonly MarkerSnapshot[] | undefined,
  deltas: UnitStateDelta["markers"],
): readonly MarkerSnapshot[] | undefined {
  if (deltas === undefined) {
    return current;
  }
  const byId = new Map((current ?? []).map((marker) => [marker.markerInstanceId, marker] as const));
  for (const [markerInstanceId, change] of Object.entries(deltas) as [
    MarkerInstanceId,
    ValueChange<MarkerSnapshot | undefined>,
  ][]) {
    const existing = byId.get(markerInstanceId);
    if (!sameMarkerSnapshot(existing, change.before)) {
      throw new DomainValidationError(
        `${path}[${markerInstanceId}]`,
        `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(existing)}); the delta sequence is dropped, reordered, or duplicated`,
      );
    }
    if (change.after === undefined) {
      byId.delete(markerInstanceId);
    } else {
      byId.set(markerInstanceId, change.after);
    }
  }
  return [...byId.values()];
}

/**
 * R-STA-04: `CombatStatChanged`が持つ`combatStats`差分を適用する。`hp`/`ap`と
 * 同じ`assertBeforeMatches`規約だが、フィールドごとに個別のキーを持つ複合値
 * のため`hp`のような単一フィールドの比較を`CombatStats`の各キーへ繰り返す。
 */
function applyCombatStatsDelta(
  path: string,
  current: CombatStats,
  deltas: UnitStateDelta["combatStats"],
): CombatStats {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<keyof CombatStats, number> = { ...current };
  for (const [field, change] of Object.entries(deltas) as [
    keyof CombatStats,
    ValueChange<number>,
  ][]) {
    assertBeforeMatches(`${path}.${field}`, current[field], change);
    next[field] = change.after;
  }
  return next;
}

function applyUnitDelta(
  path: string,
  unit: BattleUnitSnapshot,
  delta: UnitStateDelta,
): BattleUnitSnapshot {
  if (delta.hp !== undefined) {
    assertBeforeMatches(`${path}.hp`, unit.hp, delta.hp);
  }
  if (delta.ap !== undefined) {
    assertBeforeMatches(`${path}.ap`, unit.ap, delta.ap);
  }
  if (delta.pp !== undefined) {
    assertBeforeMatches(`${path}.pp`, unit.pp, delta.pp);
  }
  if (delta.extraGauge !== undefined) {
    assertBeforeMatches(`${path}.extraGauge`, unit.extraGauge, delta.extraGauge);
  }
  // G-09（M7-002A／Issue #255）: `ResourceCapacityChanged`が単独で所有する上限差分。
  // 現在値（`ap`等）とは独立に変化するため別キーとして検証・適用する。
  if (delta.maximumAp !== undefined) {
    assertBeforeMatches(`${path}.maximumAp`, unit.maximumAp, delta.maximumAp);
  }
  if (delta.maximumPp !== undefined) {
    assertBeforeMatches(`${path}.maximumPp`, unit.maximumPp, delta.maximumPp);
  }
  if (delta.maximumExtraGauge !== undefined) {
    assertBeforeMatches(
      `${path}.maximumExtraGauge`,
      unit.maximumExtraGauge,
      delta.maximumExtraGauge,
    );
  }
  const cooldowns = applyCooldownDeltas(`${path}.cooldowns`, unit.cooldowns, delta.cooldowns);
  if (delta.charge !== undefined) {
    assertChargeBeforeMatches(`${path}.charge`, unit.charge, delta.charge);
  }
  const nextCharge = delta.charge !== undefined ? delta.charge.after : unit.charge;
  const skillCounters = applyTwoLevelCounterDeltas(
    `${path}.skillCounters`,
    unit.skillCounters,
    delta.skillCounters,
  );
  // `skillCounterCarry`は`captureBattleState`が
  // carry===0のskillDefinitionIdキーごと省略する（`skillCounters`と違い0を
  // デフォルト値として扱う）ため、Reducer側もdelta適用後に空になった
  // skillDefinitionIdエントリを剪定し、実状態と同じ形へ揃える。
  const skillCounterCarry = applyTwoLevelCounterDeltas(
    `${path}.skillCounterCarry`,
    unit.skillCounterCarry,
    delta.skillCounterCarry,
    { pruneEmptyFirstLevelEntries: true },
  );
  // EFF-006/Issue #212: `EffectSequence`スコープ。`skillCounters`と同じ2段キー
  // だが1段目が`SkillUseId`（1回の解決を識別する既存の実行時識別子）である点だけ
  // が異なる。解決完了時に`RuntimeCounterReset`がキー自体を必ず削除するため、
  // `skillCounterCarry`と同じく空になったら`pruneEmptyFirstLevelEntries`で
  // フィールド自体を省略する。
  const effectSequenceCounters = applyTwoLevelCounterDeltas(
    `${path}.effectSequenceCounters`,
    unit.effectSequenceCounters,
    delta.effectSequenceCounters,
    { pruneEmptyFirstLevelEntries: true },
  );
  const effectSequenceCounterCarry = applyTwoLevelCounterDeltas(
    `${path}.effectSequenceCounterCarry`,
    unit.effectSequenceCounterCarry,
    delta.effectSequenceCounterCarry,
    { pruneEmptyFirstLevelEntries: true },
  );
  const effects = applyEffectDeltas(`${path}.effects`, unit.effects, delta.effects);
  const markers = applyMarkerDeltas(`${path}.markers`, unit.markers, delta.markers);
  const combatStats = applyCombatStatsDelta(
    `${path}.combatStats`,
    unit.combatStats,
    delta.combatStats,
  );
  // R-TEX-04: ブレイク強化（`UnitRevived`）だけが動かす基礎側。`combatStats`とは
  // 独立の差分であり、同じイベントが両方を運ぶこともある。
  const baseCombatStats = applyCombatStatsDelta(
    `${path}.baseCombatStats`,
    unit.baseCombatStats,
    delta.baseCombatStats,
  );
  return {
    hp: delta.hp?.after ?? unit.hp,
    ap: delta.ap?.after ?? unit.ap,
    pp: delta.pp?.after ?? unit.pp,
    extraGauge: delta.extraGauge?.after ?? unit.extraGauge,
    maximumAp: delta.maximumAp?.after ?? unit.maximumAp,
    maximumPp: delta.maximumPp?.after ?? unit.maximumPp,
    maximumExtraGauge: delta.maximumExtraGauge?.after ?? unit.maximumExtraGauge,
    combatStats,
    baseCombatStats,
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(nextCharge !== undefined ? { charge: nextCharge } : {}),
    ...(skillCounters !== undefined ? { skillCounters } : {}),
    ...(skillCounterCarry !== undefined ? { skillCounterCarry } : {}),
    ...(effectSequenceCounters !== undefined ? { effectSequenceCounters } : {}),
    ...(effectSequenceCounterCarry !== undefined ? { effectSequenceCounterCarry } : {}),
    ...(effects !== undefined && effects.length > 0 ? { effects } : {}),
    ...(markers !== undefined && markers.length > 0 ? { markers } : {}),
  };
}

/**
 * `R-EFF-11`（`SkillRuntime`スコープ、Issue #143）: `SkillDefinitionId`→
 * `RuntimeCounterId`の2段キーで運ばれる`skillCounters`（`value`）／
 * `skillCounterCarry`（`carry`）の両方に使う共通
 * 差分適用。`EffectSequence`スコープ（EFF-006、Issue #212）の
 * `effectSequenceCounters`／`effectSequenceCounterCarry`も、1段目のキーが
 * `SkillDefinitionId`ではなく`SkillUseId`であるだけで同じ形のため、1段目キーの
 * 型を`K`として汎用化して再利用する。
 *
 * `change.after === undefined`は`RuntimeCounterReset`による
 * キー自体の削除を表すため、`0`を書き込むのではなく`updated`からキーを
 * `delete`する（実状態の`resetRuntimeCounter`と同じ規約）。
 */
function applyTwoLevelCounterDeltas<K extends string>(
  path: string,
  current: Readonly<Record<K, Readonly<Record<RuntimeCounterId, number>>>> | undefined,
  deltas:
    | Readonly<Record<K, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>>
    | undefined,
  options: { readonly pruneEmptyFirstLevelEntries?: boolean } = {},
): Readonly<Record<K, Readonly<Record<RuntimeCounterId, number>>>> | undefined {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<K, Readonly<Record<RuntimeCounterId, number>>> = { ...current } as Record<
    K,
    Readonly<Record<RuntimeCounterId, number>>
  >;
  for (const [firstLevelKey, counterChanges] of Object.entries(deltas) as [
    K,
    Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>,
  ][]) {
    const existing = next[firstLevelKey];
    const updated: Record<RuntimeCounterId, number> = { ...existing };
    for (const [counterId, change] of Object.entries(counterChanges) as [
      RuntimeCounterId,
      ValueChange<number | undefined>,
    ][]) {
      assertBeforeMatches(
        `${path}[${firstLevelKey}][${counterId}]`,
        existing?.[counterId] ?? 0,
        change,
      );
      if (change.after === undefined) {
        delete updated[counterId];
      } else {
        updated[counterId] = change.after;
      }
    }
    if (options.pruneEmptyFirstLevelEntries === true && Object.keys(updated).length === 0) {
      delete next[firstLevelKey];
    } else {
      next[firstLevelKey] = updated;
    }
  }
  // `skillCounterCarry`（`pruneEmptyFirstLevelEntries`）は、
  // 剪定の結果すべての1段目キーエントリが消えた場合、`{}`ではなく
  // `undefined`を返す。`captureBattleState`は非0のcarryが1件も無ければ
  // `skillCounterCarry`フィールド自体を省略するため、呼び出し元
  // （`applyUnitDelta`）がこのフィールド自体を省略できるようにする
  // （`skillCounters`は逆に空でもキーを保持する既存の非対称な規約のため、
  // このフィールド全体省略は`pruneEmptyFirstLevelEntries`のときだけ行う）。
  if (options.pruneEmptyFirstLevelEntries === true && Object.keys(next).length === 0) {
    return undefined;
  }
  return next;
}

/**
 * R-SKL-04: 変更されたスキルのクールタイムだけを既存の`cooldowns`へ差分適用する。
 * `setActionId`/`setTurnNumber`は初回設定時のdeltaだけが持つため、以降の変更
 * （`setActionId`/`setTurnNumber`を含まないdelta）では既存値をそのまま引き継ぐ。
 */
function applyCooldownDeltas(
  path: string,
  current: Readonly<Record<SkillDefinitionId, CooldownState>> | undefined,
  deltas: UnitStateDelta["cooldowns"],
): Readonly<Record<SkillDefinitionId, CooldownState>> | undefined {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<SkillDefinitionId, CooldownState> = { ...current };
  for (const [skillDefinitionId, change] of Object.entries(deltas) as [
    SkillDefinitionId,
    {
      readonly unit: CooldownState["unit"];
      readonly setActionId?: CooldownState["setActionId"];
      readonly setTurnNumber?: CooldownState["setTurnNumber"];
      readonly establishesScope?: true;
    } & ValueChange<number>,
  ][]) {
    const existing = next[skillDefinitionId];
    assertBeforeMatches(`${path}[${skillDefinitionId}]`, existing?.remaining ?? 0, change);
    // `establishesScope`（`CooldownStarted`）はエントリ自体を設定し直すため、
    // 差分が持つscopeがそのまま正本になる — 不在は「省略」ではなく「設定scopeなし」
    // （行動外のトップレベルイベントから発動したPS、R-SKL-04）を意味する。
    // それ以外（`CooldownReduced`等の残数変更）は設定scopeを変えないため既存値を保つ。
    const setActionId =
      change.establishesScope === true
        ? change.setActionId
        : (change.setActionId ?? existing?.setActionId);
    const setTurnNumber =
      change.establishesScope === true
        ? change.setTurnNumber
        : (change.setTurnNumber ?? existing?.setTurnNumber);
    next[skillDefinitionId] = {
      unit: change.unit,
      remaining: change.after,
      ...(setActionId !== undefined ? { setActionId } : {}),
      ...(setTurnNumber !== undefined ? { setTurnNumber } : {}),
    };
  }
  return next;
}

/**
 * `08_ドメインイベント.md`「状態復元」の独立Reducer。Battle集約自身の遷移ロジック
 * を経由せず、`StateDelta` だけから次状態を求める。変更のないフィールドは
 * そのまま引き継ぐ（「変更した項目だけを...記録する」）。適用前に各`before`が
 * 現在値と一致すること、および対象unitが存在することを検証し、差分の抜け・
 * 順序違反・重複適用を、黙って復元不能な状態を返す代わりに例外として検出する。
 */
export function applyStateDelta(
  state: BattleStateSnapshot,
  delta: StateDelta,
): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = { ...state.units };
  if (delta.units !== undefined) {
    for (const [unitId, unitDelta] of Object.entries(delta.units) as [
      BattleUnitId,
      UnitStateDelta,
    ][]) {
      const current = units[unitId];
      if (current === undefined) {
        throw new DomainValidationError(
          `delta.units[${unitId}]`,
          "references a BattleUnitId absent from the current state",
        );
      }
      units[unitId] = applyUnitDelta(`delta.units[${unitId}]`, current, unitDelta);
    }
  }
  if (delta.battleStatus !== undefined) {
    assertBeforeMatches("delta.battleStatus", state.status, delta.battleStatus);
  }
  if (delta.turnNumber !== undefined) {
    assertBeforeMatches("delta.turnNumber", state.currentTurn, delta.turnNumber);
  }
  if (delta.result !== undefined) {
    assertBeforeMatches("delta.result", state.result, delta.result);
  }
  const nextResult = delta.result !== undefined ? delta.result.after : state.result;
  const nextExercise = applyExerciseDelta(state.exercise, delta.exercise);
  if (delta.result?.after !== undefined) {
    assertResultMatchesMode(delta.result.after, nextExercise);
  }
  return {
    status: delta.battleStatus?.after ?? state.status,
    currentTurn: delta.turnNumber?.after ?? state.currentTurn,
    units,
    ...(nextResult !== undefined ? { result: nextResult } : {}),
    ...(nextExercise !== undefined ? { exercise: nextExercise } : {}),
  };
}

/**
 * R-TEX-10: 確定した結果が戦闘モードと整合することを、差分だけから検証する。
 *
 * - 演習結果（勝敗を持たない、同 #1）は演習状態を持つ戦闘だけが確定できる。逆に演習が
 *   勝敗を確定することもない。
 * - 演習結果の総スコア・ブレイク回数は、同じ時点まで復元した演習状態と一致する（同 #3）。
 *   結果の確定は`exercise.totalScore`／`breakCount`差分を所有しないため、この一致を
 *   ここで検証しないと、計上量差分の欠落が結果側の値だけ正しい形で潜伏する。
 */
function assertResultMatchesMode(
  result: BattleResultSnapshot,
  exercise: ExerciseStateSnapshot | undefined,
): void {
  if (!isExerciseBattleResult(result)) {
    if (exercise !== undefined) {
      throw new DomainValidationError(
        "delta.result",
        "a victory outcome was applied to a TACTICAL_EXERCISE battle, which owns no win or loss",
      );
    }
    return;
  }
  if (exercise === undefined) {
    throw new DomainValidationError(
      "delta.result",
      "an exercise result was applied to a state without exercise state; only a TACTICAL_EXERCISE battle owns one",
    );
  }
  if (result.totalScore !== exercise.totalScore) {
    throw new DomainValidationError(
      "delta.result.after.totalScore",
      `the exercise result's total score (${result.totalScore}) does not match the cumulative score restored so far (${exercise.totalScore}); a score delta is missing or duplicated`,
    );
  }
  if (result.breakCount !== exercise.breakCount) {
    throw new DomainValidationError(
      "delta.result.after.breakCount",
      `the exercise result's break count (${result.breakCount}) does not match the break count restored so far (${exercise.breakCount}); a break delta is missing or duplicated`,
    );
  }
}

/**
 * R-TEX-02: 演習状態の差分を適用する。演習状態を持たない状態（通常戦闘）へ演習差分が
 * 来ることは、モードの取り違えか差分の混線を意味するため、黙って作らずに拒否する。
 */
function applyExerciseDelta(
  current: ExerciseStateSnapshot | undefined,
  delta: ExerciseStateDelta | undefined,
): ExerciseStateSnapshot | undefined {
  if (delta === undefined) {
    return current;
  }
  if (current === undefined) {
    throw new DomainValidationError(
      "delta.exercise",
      "references exercise state absent from the current state; only a TACTICAL_EXERCISE battle owns one",
    );
  }
  if (delta.totalScore !== undefined) {
    assertBeforeMatches("delta.exercise.totalScore", current.totalScore, delta.totalScore);
  }
  if (delta.breakCount !== undefined) {
    assertBeforeMatches("delta.exercise.breakCount", current.breakCount, delta.breakCount);
  }
  return {
    totalScore: delta.totalScore?.after ?? current.totalScore,
    breakCount: delta.breakCount?.after ?? current.breakCount,
  };
}

/** `stateAt(sequence N) = initialState + delta(1) + delta(2) + ... + delta(N)` (`08_ドメインイベント.md`「状態復元」)。 */
export function reduceStateDeltas(
  initialState: BattleStateSnapshot,
  deltas: readonly StateDelta[],
): BattleStateSnapshot {
  return deltas.reduce(applyStateDelta, initialState);
}
