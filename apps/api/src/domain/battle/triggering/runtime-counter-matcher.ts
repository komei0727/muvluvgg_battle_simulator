import type {
  RuntimeCounterId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  applyCumulativeDamageThreshold,
  incrementRuntimeCounter,
  type RuntimeCounterMap,
} from "../model/runtime-counter-state.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export interface RuntimeCounterUpdateResult {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
  /** `CUMULATIVE_DAMAGE_THRESHOLD`の繰り越し端数（更新後、`INCREMENT`では常に0）。観測用。 */
  readonly carry: number;
  /** この更新の直前の繰り越し端数（`carry`との差分でcarry自体の変化を判定する）。 */
  readonly carryBefore: number;
  /**
   * `before !== after`（公開値が実際に変化した＝閾値を跨いだ）かどうか。
   * レビュー再々レビュー[P1]: `RuntimeCounterChanged`はcarryのみの変化でも
   * 発行するため（追跡性のため）、閾値到達時だけ発動すべきPS
   * （`CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`）はこのフィールドで絞り込む
   * 契約とする（Catalog側の条件は`docs/ddd/14_Catalog定義スキーマ.md`参照）。
   */
  readonly valueChanged: boolean;
}

export interface RuntimeCounterMatchInput {
  readonly event: TriggerCandidateEvent;
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
}

function matchesUpdateTrigger(
  update: RuntimeCounterUpdateDefinition,
  owner: BattleUnit,
  skillDefinitionId: SkillDefinitionId,
  event: TriggerCandidateEvent,
  unitsById: ReadonlyMap<BattleUnitId, BattleUnit>,
): boolean {
  const trigger = update.trigger;
  return (
    trigger.eventType === event.eventType &&
    trigger.category === event.category &&
    evaluateSourceSelector(trigger.sourceSelector, owner, event, unitsById) &&
    evaluateTargetSelector(trigger.targetSelector, owner, event, unitsById) &&
    evaluateTriggerCondition(trigger.condition, event, { owner, skillDefinitionId })
  );
}

function readNumberPayloadField(event: TriggerCandidateEvent, field: string): number {
  const value = event.payload[field];
  if (typeof value !== "number") {
    throw new DomainValidationError(
      "event.payload",
      `CUMULATIVE_DAMAGE_THRESHOLD requires a numeric "${field}" field on eventType "${event.eventType}", got ${typeof value}`,
    );
  }
  return value;
}

/**
 * `INCREMENT`/`CUMULATIVE_DAMAGE_THRESHOLD`の適用そのものはscope非依存
 * （`runtime-counter-state.ts`参照）。EFF-005/Issue #162の`runtime-counter-
 * effect-matcher.ts`（`AppliedEffect`スコープ）も同じ関数を再利用する — `owner`は
 * `CUMULATIVE_DAMAGE_THRESHOLD`が参照する`combatStats.maximumHp`の持ち主
 * （`SKILL_RUNTIME`ではスキル所有者、`APPLIED_EFFECT`では効果の保持者）を渡す。
 */
export function applyUpdate(
  update: RuntimeCounterUpdateDefinition,
  counters: RuntimeCounterMap,
  owner: BattleUnit,
  event: TriggerCandidateEvent,
): {
  readonly counters: RuntimeCounterMap;
  readonly before: number;
  readonly after: number;
  readonly carry: number;
} {
  if (update.kind === "INCREMENT") {
    const result = incrementRuntimeCounter(counters, update.counter, update.amount);
    return {
      counters: result.counters,
      before: result.change.before,
      after: result.change.after,
      carry: 0,
    };
  }
  const damageAmount = readNumberPayloadField(event, "hitPointDamage");
  const result = applyCumulativeDamageThreshold(
    counters,
    update.counter,
    damageAmount,
    owner.combatStats.maximumHp,
    update.maxHpRatio,
  );
  return {
    counters: result.counters,
    before: result.change.before,
    after: result.change.after,
    carry: result.counters[update.counter]?.carry ?? 0,
  };
}

/** `matchRuntimeCounterUpdates`が1件マッチしたとして報告する、更新前の(所有者・スキル・更新定義)の組。 */
export interface MatchedRuntimeCounterUpdate {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  /** 定義オブジェクト自身を識別子として使う。同じcounterへの複数`counterUpdates`定義（レビュー再々指摘[P2]）でも、配列上の別エントリとして区別できる。 */
  readonly update: RuntimeCounterUpdateDefinition;
}

/**
 * `R-EFF-11`/`08_ドメインイベント.md`「イベント発行と処理」#3の「マッチング」段階
 * だけを行う。`input.units`（原因イベント確定直後の状態）に対して`trigger`が
 * 一致する`counterUpdates`定義を、決定論的な順序（Unit→Unitが持つPS→
 * `counterUpdates`配列順）で列挙するだけで、値は一切適用しない。
 *
 * レビュー再々指摘[P2]: マッチする集合と順序は、原因イベント直後の状態から
 * 一度だけ確定しなければならない（R-EFF-11「原因イベントの状態変更確定後、
 * PS/Memory候補抽出前にcounter更新を決定する」）。呼び出し側がこの結果を
 * `input.units`のスナップショットに対して1回だけ計算し、以降のPS連鎖による
 * 状態変化でこの集合を再評価（追加・除外）してはならない — 各エントリの
 * before/after/carryだけを`applyMatchedRuntimeCounterUpdate`で適用時点の
 * 最新状態から計算し直す。
 */
export function matchRuntimeCounterUpdates(
  input: RuntimeCounterMatchInput,
): readonly MatchedRuntimeCounterUpdate[] {
  const { event, unitDefinitions, skillDefinitions } = input;
  const unitsById = new Map(input.units.map((u) => [u.battleUnitId, u] as const));
  const matched: MatchedRuntimeCounterUpdate[] = [];

  for (const owner of input.units) {
    if (isDefeated(owner)) {
      continue;
    }
    const unitDefinition = unitDefinitions.get(owner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${owner.unitDefinitionId}" (battleUnitId "${owner.battleUnitId}")`,
      );
    }
    for (const skillId of unitDefinition.passiveSkillDefinitionIds) {
      const skill = skillDefinitions.get(skillId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillId}"`,
        );
      }
      for (const update of skill.counterUpdates) {
        if (update.scope !== "SKILL_RUNTIME") {
          throw new DomainValidationError(
            "counterUpdates.scope",
            `scope "${update.scope}" is not supported yet (Issue #143 only implements SKILL_RUNTIME scope)`,
          );
        }
        if (!matchesUpdateTrigger(update, owner, skillId, event, unitsById)) {
          continue;
        }
        matched.push({ ownerUnitId: owner.battleUnitId, skillDefinitionId: skillId, update });
      }
    }
  }

  return matched;
}

/**
 * `matchRuntimeCounterUpdates`が確定した1件の`MatchedRuntimeCounterUpdate`を、
 * 呼び出し時点の`units`（先行`RuntimeCounterChanged`の候補解決を経た最新状態
 * でありうる）に対して適用する（レビュー再々指摘[P2]）。`before`/`after`/`carry`は
 * 常にこの時点の実状態から計算するため、マッチングを確定した時点の状態とは
 * 異なりうる。
 */
export function applyMatchedRuntimeCounterUpdate(
  matched: MatchedRuntimeCounterUpdate,
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): {
  readonly units: readonly BattleUnit[];
  readonly change: RuntimeCounterUpdateResult | undefined;
} {
  const owner = units.find((u) => u.battleUnitId === matched.ownerUnitId);
  if (owner === undefined) {
    throw new DomainValidationError(
      "units",
      `battleUnitId "${matched.ownerUnitId}" disappeared while applying counterUpdates`,
    );
  }
  const { skillDefinitionId, update } = matched;
  const existingCounters = owner.skillCounters?.[skillDefinitionId] ?? {};
  const carryBefore = existingCounters[update.counter]?.carry ?? 0;
  const applied = applyUpdate(update, existingCounters, owner, event);
  // レビュー指摘[P1]: 閾値未到達（value不変）でも`applied.counters`の`carry`
  // （繰り越し端数）は必ず`units`へ反映する。ここで反映しないと次回の更新が
  // 繰り越し前のcarryから再計算され、複数回に分けて閾値へ到達する累計ダメージが
  // 正しく積み上がらない。
  const updatedOwner: BattleUnit = {
    ...owner,
    skillCounters: { ...owner.skillCounters, [skillDefinitionId]: applied.counters },
  };
  const nextUnits = units.map((u) =>
    u.battleUnitId === updatedOwner.battleUnitId ? updatedOwner : u,
  );
  // レビュー指摘[P2]: `value`(公開値)が変わらなくても`carry`(内部端数)が
  // 変化した場合は`RuntimeCounterChanged`を発行する。ここで完全にno-op扱い
  // すると、可変状態(carry)が変化したこと自体がイベント列から追跡できなくなる
  // （対象3スキルでは閾値未到達ヒットの方が通常経路）。`valueChanged`をpayloadへ
  // 含めるのは、この関数の呼び出し側（Catalog側の閾値到達PS）が「carryだけの
  // 変化」と「実際の閾値到達」を区別できるようにするため（レビュー再々レビュー[P1]）。
  const valueChanged = applied.before !== applied.after;
  if (!valueChanged && applied.carry === carryBefore) {
    return { units: nextUnits, change: undefined };
  }
  return {
    units: nextUnits,
    change: {
      ownerUnitId: matched.ownerUnitId,
      skillDefinitionId,
      counter: update.counter,
      before: applied.before,
      after: applied.after,
      carry: applied.carry,
      carryBefore,
      valueChanged,
    },
  };
}

/**
 * `R-EFF-11`/`08_ドメインイベント.md`「イベント発行と処理」#3: 対象イベントに
 * 対応する`counterUpdates`（M6最小実装、`SKILL_RUNTIME`スコープ、Issue #143）を
 * 検出し、決定的に更新する。呼び出し側はPS/Memory候補抽出より前に呼び出し、
 * 変化があった件数分だけ`RuntimeCounterChanged`を発行する。
 *
 * `matchRuntimeCounterUpdates`＋`applyMatchedRuntimeCounterUpdate`の単純な
 * 合成（マッチングを1回確定し、`input.units`から順に適用するだけ）。PS連鎖の
 * 候補解決を挟まず1回で結果がほしい呼び出し側（テスト、集計）向けに残す。
 * `PassiveActivationRuntime`のように各`RuntimeCounterChanged`の候補解決を
 * 挟む必要がある呼び出し側は、代わりに2つの関数を個別に使う。
 *
 * `Battle`／`BattleUnit`スコープは`createRuntimeCounterUpdateDefinition`
 * （Catalogロード時点）が既に拒否するため、ここへ到達するのは`SKILL_RUNTIME`
 * だけのはずである。それでも到達した場合（Catalogを経由しない直接構築など）に
 * 未対応のまま実行を続けないよう、防御的にも明示的に拒否する（レビュー指摘[P2]、
 * `matchRuntimeCounterUpdates`が担う）。
 */
export function detectRuntimeCounterUpdates(input: RuntimeCounterMatchInput): {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly RuntimeCounterUpdateResult[];
} {
  const matched = matchRuntimeCounterUpdates(input);
  const changes: RuntimeCounterUpdateResult[] = [];
  let workingUnits = input.units;
  for (const entry of matched) {
    const result = applyMatchedRuntimeCounterUpdate(entry, workingUnits, input.event);
    workingUnits = result.units;
    if (result.change !== undefined) {
      changes.push(result.change);
    }
  }
  return { units: workingUnits, changes };
}

export interface RuntimeCounterResetTarget {
  readonly ownerUnitId: BattleUnitId;
  readonly skillDefinitionId: SkillDefinitionId;
  readonly counter: RuntimeCounterId;
}

export interface RuntimeCounterResetScanInput {
  readonly units: readonly BattleUnit[];
  readonly unitDefinitions: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skillDefinitions: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
}

/**
 * `R-EFF-11`「解決スコープ終了時にリセットするcounter」（レビュー指摘[P2]、
 * Issue #143）: `resetScope: "RESOLUTION_SCOPE"`を宣言するcounterのうち、現在値を
 * 持つものを列挙する。呼び出し側（`PassiveActivationRuntime.finalizeResolutionScope`）
 * が、この結果を使ってcounterを破棄し`RuntimeCounterReset`を発行する。
 */
export function collectResolutionScopeResets(
  input: RuntimeCounterResetScanInput,
): readonly RuntimeCounterResetTarget[] {
  const { units, unitDefinitions, skillDefinitions } = input;
  const targets: RuntimeCounterResetTarget[] = [];

  for (const owner of units) {
    const unitDefinition = unitDefinitions.get(owner.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        "unitDefinitions",
        `no UnitDefinition found for unitDefinitionId "${owner.unitDefinitionId}" (battleUnitId "${owner.battleUnitId}")`,
      );
    }
    for (const skillId of unitDefinition.passiveSkillDefinitionIds) {
      const skill = skillDefinitions.get(skillId);
      if (skill === undefined) {
        throw new DomainValidationError(
          "skillDefinitions",
          `no SkillDefinition found for skillDefinitionId "${skillId}"`,
        );
      }
      for (const update of skill.counterUpdates) {
        if (update.resetScope !== "RESOLUTION_SCOPE") {
          continue;
        }
        if (owner.skillCounters?.[skillId]?.[update.counter] === undefined) {
          continue;
        }
        targets.push({
          ownerUnitId: owner.battleUnitId,
          skillDefinitionId: skillId,
          counter: update.counter,
        });
      }
    }
  }

  return targets;
}
