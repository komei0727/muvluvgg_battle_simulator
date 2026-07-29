import type { AppliedEffect } from "./applied-effect.js";
import type { BattleUnit } from "./battle-unit.js";
import type { ActionId, EffectInstanceId, SkillUseId } from "../../shared/event-ids.js";
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
  readonly unit: "ACTION" | "TURN" | "SKILL_USE";
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
  // R-MEM-04（Issue #179）: Memory由来の効果は付与者ユニットを持たないため、
  // `EFFECT_SOURCE`を突き合わせる相手が存在しない。Catalog整合性検証
  // （`MEMORY_REQUIRES_SOURCE_UNIT`、PR #260再レビュー[P2]）がMemoryからの
  // `owner: EFFECT_SOURCE`宣言自体を拒否するため通常ここへは到達しないが、
  // 万一到達しても減算契機を完全に失って永続化しないよう、`BATTLE`と同じ
  // 「いずれのユニットの完了契機でも減算する」扱いへ倒す。
  return owner === "EFFECT_SOURCE" ? (effect.sourceId ?? "BATTLE") : effect.targetId;
}

function decrementDurations(
  units: readonly BattleUnit[],
  unit: "ACTION" | "TURN" | "SKILL_USE",
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
 * TGT-004フェーズ1（Issue #167、PR #234再レビュー）「SKILL_USE単位期間の減算」:
 * `actingUnitId`が1回のスキル使用（AS/EX、`SkillUseCompleted`）を完了したときに
 * 呼ぶ。R-EFF-04（ACTION単位）と同じ規約 — `timeLimit.owner`が解決する具体的な
 * ユニットが`actingUnitId`と一致する（`BATTLE`はどのユニットのスキル使用でも
 * 一致する）スキル使用単位効果のうち、今回完了した使用中に付与されたもの
 * （`grantedSkillUseId === currentSkillUseId`）を除く各インスタンスの残り回数を
 * 1減らす。中断された（`SkillUseInterrupted`）スキル使用はこの関数の呼び出し
 * 契機に含めない（呼び出し側が`SkillUseCompleted`だけを境界にする、PR #234
 * レビュー[P1]で明示された仕様固定）。0になったインスタンスもこの関数自身は
 * 除去しない — 失効処理は呼び出し側の責務。
 */
export function decrementSkillUseEffectDurations(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
  currentSkillUseId: SkillUseId,
): DecrementEffectDurationsResult {
  return decrementDurations(
    units,
    "SKILL_USE",
    (effect) => {
      const owner = resolveTimeLimitOwnerUnitId(effect);
      return owner === "BATTLE" || owner === actingUnitId;
    },
    (effect) => effect.duration.grantedSkillUseId === currentSkillUseId,
  );
}

/** `reapplySkillUseDurationDecrement`が対象を指定するための最小限のキー。 */
export interface SkillUseDurationDecrementTarget {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
}

/**
 * TGT-004フェーズ3再々レビュー[P1]（Issue #167）: `decrementSkillUseEffectDurations`
 * が連鎖解決前のunitsスナップショットから決定した対象（`battleUnitId`+
 * `effectInstanceId`のキーだけ）を、連鎖解決後のunitsへ実際に1減算として適用
 * する。`08_ドメインイベント.md`「イベント発行と処理」の順序契約（原因イベント
 * 自身のPS/Memory候補を直ちに解決してから、子イベントを発生順に処理する）を
 * 満たすため、`SkillUseCompleted`/`PassiveResolved`自身のPS連鎖解決を終えて
 * から期間減算を行う必要がある。しかしその連鎖解決前のunitsスナップショットから
 * 対象を決定しないと、連鎖中に新たに付与された別の`SkillUseId`を持つ
 * `SKILL_USE`効果まで「直前の使用分」として誤って減算・即時失効させてしまう
 * （PR #238再レビュー[P2]）。そのため呼び出し側は「連鎖解決前のunitsで対象
 * （キーのみ）を決定→連鎖解決後のunitsへこの関数で実際に減算」という2段階に
 * 分ける。
 *
 * 減算量（before/after）は連鎖解決前のスナップショット値を使い回さず、この
 * 関数へ渡された`units`（連鎖解決後の現在値）から都度再計算する
 * （PR #238再々レビュー[P1]）: 同じownerに属する独立した「1回のスキル使用
 * 完了」（この完了イベント自身の連鎖の中で反応した子PS自身の完了など）が、
 * 連鎖解決中に同じインスタンスを既に1減算している場合があるため——古い
 * スナップショット値をそのまま設定すると、子PSが既に適用した減算を上書きし、
 * 2回分の減算のうち1回を消してしまう。対象インスタンスが連鎖解決中に既に
 * 除去されていた場合、または`timeLimitRemaining`を持たない場合は無視する。
 */
export function reapplySkillUseDurationDecrement(
  units: readonly BattleUnit[],
  targets: readonly SkillUseDurationDecrementTarget[],
): DecrementEffectDurationsResult {
  if (targets.length === 0) {
    return { units, changes: [] };
  }
  const targetInstanceIdsByUnit = new Map<BattleUnitId, Set<EffectInstanceId>>();
  for (const target of targets) {
    const instanceIds =
      targetInstanceIdsByUnit.get(target.battleUnitId) ?? new Set<EffectInstanceId>();
    instanceIds.add(target.effectInstanceId);
    targetInstanceIdsByUnit.set(target.battleUnitId, instanceIds);
  }
  const changes: EffectDurationChange[] = [];
  const nextUnits = units.map((unit) => {
    const instanceIds = targetInstanceIdsByUnit.get(unit.battleUnitId);
    if (instanceIds === undefined) {
      return unit;
    }
    let changedInUnit = false;
    const nextEffects = unit.appliedEffects.map((effect) => {
      if (
        !instanceIds.has(effect.effectInstanceId) ||
        effect.duration.timeLimitRemaining === undefined
      ) {
        return effect;
      }
      const before = effect.duration.timeLimitRemaining;
      const after = before - 1;
      changes.push({
        battleUnitId: unit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        unit: "SKILL_USE",
        before,
        after,
      });
      changedInUnit = true;
      return { ...effect, duration: { ...effect.duration, timeLimitRemaining: after } };
    });
    return changedInUnit ? { ...unit, appliedEffects: nextEffects } : unit;
  });
  return { units: nextUnits, changes };
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
 *
 * R-HIT-04（M7-018、Issue #272）: `effectInstanceId`を指定すると、そのインスタンス
 * 1件だけへ消費を限定する。Nヒット回避は「回避を成立させたインスタンス自身」を
 * 回避した被ヒットで消費するが、同じ対象が持つ他の`INCOMING_HIT`消費効果は
 * R-EFF-07の一般規則どおり命中確定でしか消費しないため、owner+kindだけでは
 * 対象を絞れない。
 */
export function consumeEffectDurations(
  units: readonly BattleUnit[],
  ownerUnitId: BattleUnitId,
  kind: ConsumptionKind,
  effectInstanceId?: EffectInstanceId,
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
        (effectInstanceId !== undefined && effect.effectInstanceId !== effectInstanceId) ||
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
