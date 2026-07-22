import type { AppliedEffect } from "./applied-effect.js";
import type { BattleUnit } from "./battle-unit.js";
import type { ActionId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";

/**
 * `14_Catalog定義スキーマ.md`「DurationDefinition」`timeLimit.owner`が省略された
 * 場合の既定値。production Catalogの`ACTION`単位行は常に`owner`を明示するが、
 * `TURN`単位行は常に省略する（実データを網羅した調査、EFF-003スコープ）ため、
 * このデフォルトは主に`TURN`単位行に適用される。
 */
const DEFAULT_TIME_LIMIT_OWNER = "EFFECT_TARGET";

/** `timeLimit.unit === "ACTION"`の効果すべてに共通する、単位ごとの1減算結果。 */
export interface EffectDurationChange {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
  readonly unit: "ACTION" | "TURN";
  readonly before: number;
  readonly after: number;
}

export interface DecrementEffectDurationsResult {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly EffectDurationChange[];
}

/**
 * `14_Catalog定義スキーマ.md`「DurationDefinition」`timeLimit.owner`を、実際に
 * 行動・ターンの完了契機と突き合わせられる具体的な戦闘ユニットIDへ解決する
 * （R-EFF-04/06）。`AppliedEffect`は常に対象(`targetId`)側の`appliedEffects`へ
 * 保持されるため（`effect-grant-service.ts`）、`EFFECT_SOURCE`のように保持者と
 * 別のユニットの行動を契機にする場合はこの解決が必須になる。`BATTLE`は
 * 特定ユニットに紐付かない（いずれのユニットの行動・ターン終了でも減算する）
 * ことを表すセンチネルとして`"BATTLE"`をそのまま返す。
 */
export function resolveTimeLimitOwnerUnitId(effect: AppliedEffect): BattleUnitId | "BATTLE" {
  const owner = effect.duration.definition.timeLimit?.owner ?? DEFAULT_TIME_LIMIT_OWNER;
  if (owner === "BATTLE") {
    return "BATTLE";
  }
  return owner === "EFFECT_SOURCE" ? effect.sourceId : effect.targetId;
}

function decrementDurations(
  units: readonly BattleUnit[],
  unit: "ACTION" | "TURN",
  isEligible: (effect: AppliedEffect) => boolean,
  wasGrantedInCurrentScope: (effect: AppliedEffect) => boolean,
): DecrementEffectDurationsResult {
  const changes: EffectDurationChange[] = [];
  const nextUnits = units.map((battleUnit) => {
    let changedInUnit = false;
    const nextEffects = battleUnit.appliedEffects.map((effect) => {
      const timeLimit = effect.duration.definition.timeLimit;
      if (
        timeLimit?.unit !== unit ||
        effect.duration.timeLimitRemaining === undefined ||
        effect.duration.timeLimitRemaining <= 0 ||
        wasGrantedInCurrentScope(effect) ||
        !isEligible(effect)
      ) {
        return effect;
      }
      const before = effect.duration.timeLimitRemaining;
      const after = before - 1;
      changes.push({
        battleUnitId: battleUnit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit,
        before,
        after,
      });
      changedInUnit = true;
      return { ...effect, duration: { ...effect.duration, timeLimitRemaining: after } };
    });
    return changedInUnit ? { ...battleUnit, appliedEffects: nextEffects } : battleUnit;
  });
  return { units: nextUnits, changes };
}

/**
 * R-EFF-04「行動単位期間の減算」: `actingUnitId`が1つの行動を完了したときに
 * 呼ぶ。`timeLimit.owner`が解決する具体的なユニットが`actingUnitId`と一致する
 * （`BATTLE`はどのユニットの行動でも一致する）行動単位効果のうち、今回完了した
 * 行動中に付与されたもの（`grantedActionId === currentActionId`）を除く各
 * インスタンスの残り回数を1減らす。0になったインスタンスもこの関数自身は
 * 除去しない — 失効処理（`EffectExpired`発行・除去・CombatStat再計算・
 * linkedEffectGroupカスケード）は呼び出し側の責務。
 */
export function decrementActionEffectDurations(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
  currentActionId: ActionId,
): DecrementEffectDurationsResult {
  return decrementDurations(
    units,
    "ACTION",
    (effect) => {
      const owner = resolveTimeLimitOwnerUnitId(effect);
      return owner === "BATTLE" || owner === actingUnitId;
    },
    (effect) => effect.duration.grantedActionId === currentActionId,
  );
}

/**
 * R-EFF-06「ターン単位期間の減算」: ターン終了時に1度だけ呼ぶ。行動単位と
 * 異なり、ターン終了は特定ユニットの行動に紐付かないトップレベルの契機の
 * ため、`timeLimit.owner`に関わらず全ユニットのターン単位効果を対象にする
 * （production Catalogの`TURN`単位行はいずれも`owner`を指定しない、
 * `06_戦闘状態遷移.md` TURN_ENDING #5も owner を区別しない）。今回終了した
 * ターン中に付与されたもの（`grantedTurnNumber === currentTurnNumber`）は
 * 除く。0になったインスタンスの除去・失効処理は呼び出し側の責務。
 */
export function decrementTurnEffectDurations(
  units: readonly BattleUnit[],
  currentTurnNumber: number,
): DecrementEffectDurationsResult {
  return decrementDurations(
    units,
    "TURN",
    () => true,
    (effect) => effect.duration.grantedTurnNumber === currentTurnNumber,
  );
}

/** `consumption.kind`ごとの1消費結果。 */
export interface ConsumptionChange {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
  readonly kind: ConsumptionKind;
  readonly before: number;
  readonly after: number;
}

export interface ConsumeEffectDurationsResult {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly ConsumptionChange[];
}

/**
 * R-EFF-07「消費条件」: `ownerUnitId`が`kind`に該当する事象（次の攻撃・被ヒット等）
 * に到達したときに呼ぶ。`consumption`は`timeLimit`と異なり、常に効果を保持する
 * ユニット自身（`effect.targetId`、`AppliedEffect`は常に対象側の`appliedEffects`
 * に保持される）を「効果owner」とする — `timeLimit.owner`のようなEFFECT_SOURCE/
 * BATTLEの切り替えは存在しない（`consumption`はDurationDefinition上で`timeLimit`
 * から独立したフィールドであり、`owner`を持たない）。`consumptionRemaining`が
 * 0より大きい、`kind`が一致するインスタンスだけを1減らす。0になったインスタンス
 * の除去・失効処理は呼び出し側の責務。
 */
export function consumeEffectDurations(
  units: readonly BattleUnit[],
  ownerUnitId: BattleUnitId,
  kind: ConsumptionKind,
): ConsumeEffectDurationsResult {
  const changes: ConsumptionChange[] = [];
  const nextUnits = units.map((battleUnit) => {
    if (battleUnit.battleUnitId !== ownerUnitId) {
      return battleUnit;
    }
    let changedInUnit = false;
    const nextEffects = battleUnit.appliedEffects.map((effect) => {
      const consumption = effect.duration.definition.consumption;
      if (
        consumption?.kind !== kind ||
        effect.duration.consumptionRemaining === undefined ||
        effect.duration.consumptionRemaining <= 0
      ) {
        return effect;
      }
      const before = effect.duration.consumptionRemaining;
      const after = before - 1;
      changes.push({
        battleUnitId: battleUnit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        kind,
        before,
        after,
      });
      changedInUnit = true;
      return { ...effect, duration: { ...effect.duration, consumptionRemaining: after } };
    });
    return changedInUnit ? { ...battleUnit, appliedEffects: nextEffects } : battleUnit;
  });
  return { units: nextUnits, changes };
}
