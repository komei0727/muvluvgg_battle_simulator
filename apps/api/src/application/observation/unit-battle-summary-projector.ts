import { combatStatusOf, type CombatStatus } from "./combat-status.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type {
  BattleStateSnapshot,
  BattleUnitRosterEntry,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { Side } from "../../domain/shared/side.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";

/**
 * `10_API設計.md`「UnitBattleSummaryResponse」のユニット1件分。編成検討のための
 * 大量実行が必要とする「勝敗＋ユニット別集計」を、クライアント側のイベント集計に
 * 頼らずサーバーが確定させる。
 */
export interface UnitBattleSummary {
  readonly battleUnitId: BattleUnitId;
  readonly side: Side;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly finalHp: number;
  readonly maximumHp: number;
  readonly combatStatus: CombatStatus;
}

interface SummaryAccumulator {
  readonly damageDealt: Map<BattleUnitId, number>;
  readonly damageTaken: Map<BattleUnitId, number>;
  readonly healingDone: Map<BattleUnitId, number>;
  readonly rosterUnitIds: ReadonlySet<BattleUnitId>;
}

/**
 * Rosterに無いユニットIDへは計上しない。`unitSummaries`はRosterの全件をちょうど1行ずつ
 * 返す契約であり、行を持たないIDへ足した量はどこにも現れないまま合計だけを狂わせる。
 */
function addTo(
  accumulator: SummaryAccumulator,
  map: Map<BattleUnitId, number>,
  battleUnitId: BattleUnitId,
  amount: number,
): void {
  if (!accumulator.rosterUnitIds.has(battleUnitId)) {
    return;
  }
  map.set(battleUnitId, (map.get(battleUnitId) ?? 0) + amount);
}

/**
 * `10_API設計.md`「集計セマンティクス」のユニット別集計を、公開レベルによる間引き
 * **前**の全イベントから投影する（`projectExerciseBreaks`と同じ規約）。`logLevel`を
 * 下げただけでダメージ・回復の集計が欠けることがあってはならない — `SUMMARY`は
 * `DamageApplied`・`HealApplied`をどれも公開しないため、間引き後の列から集計すると
 * 全ユニットの集計値が警告なく0になる。
 *
 * 量は常に「実際にHPが動いた分」を採る。
 * - ダメージは`hitPointDamage`（`calculatedDamage`ではない）。シールド吸収
 *   （R-SHD-02）・サブユニット吸収（R-SUB-01）・HPクランプで消えた`discardedDamage`
 *   （R-SHD-03第2項）は、いずれもHPを減らしていないので含めない。
 * - 回復は`appliedAmount`（要求量`healAmount`でも破棄分を含む`formulaResult`でもない）。
 *
 * 反射（R-INT-03）・リンク（R-LNK-03）ダメージは`DamageApplied`として流れるため
 * 固有の分岐を持たない。エンベロープの`sourceUnitId`が反射側・リンク発生側を指し、
 * その与ダメージへ計上される。
 */
export function projectUnitBattleSummaries(
  events: readonly BattleDomainEvent[],
  finalState: BattleStateSnapshot,
  unitRoster: readonly BattleUnitRosterEntry[],
): readonly UnitBattleSummary[] {
  const accumulator: SummaryAccumulator = {
    damageDealt: new Map(),
    damageTaken: new Map(),
    healingDone: new Map(),
    rosterUnitIds: new Set(unitRoster.map((entry) => entry.battleUnitId)),
  };

  for (const event of events) {
    switch (event.eventType) {
      case "DamageApplied":
      case "ContinuousDamageApplied": {
        const amount = event.payload.hitPointDamage;
        // R-MEM-04: Memory由来の継続ダメージは付与者ユニットを持たず`sourceSide`
        // だけを持つ。陣営から特定のユニットを推測して与ダメージへ帰属させない
        // （被ダメージ側は対象が確定しているので計上する）。
        if (event.sourceUnitId !== undefined) {
          addTo(accumulator, accumulator.damageDealt, event.sourceUnitId, amount);
        }
        addTo(accumulator, accumulator.damageTaken, event.payload.targetUnitId, amount);
        break;
      }
      case "HealApplied": {
        addTo(
          accumulator,
          accumulator.healingDone,
          event.payload.sourceUnitId,
          event.payload.appliedAmount,
        );
        break;
      }
      case "HealingTransferred": {
        // R-HEAL-04: `HealApplied.appliedAmount`は転送分を含まないため、転送先で
        // 実際に増えた分をここで足さないと回復者の実回復量を過小に集計する。
        // 回復者はエンベロープの`sourceUnitId`（元の`HealApplied`と同じ回復者）で
        // あり、`payload.fromUnitId`（リンク保持者）ではない。
        if (event.sourceUnitId !== undefined) {
          addTo(
            accumulator,
            accumulator.healingDone,
            event.sourceUnitId,
            event.payload.appliedAmount,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return unitRoster.map((entry) => {
    const snapshot = finalState.units[entry.battleUnitId];
    if (snapshot === undefined) {
      throw new Error(
        `unitRoster references a BattleUnitId absent from the state snapshot: "${entry.battleUnitId}"`,
      );
    }
    return {
      battleUnitId: entry.battleUnitId,
      side: entry.side,
      damageDealt: accumulator.damageDealt.get(entry.battleUnitId) ?? 0,
      damageTaken: accumulator.damageTaken.get(entry.battleUnitId) ?? 0,
      healingDone: accumulator.healingDone.get(entry.battleUnitId) ?? 0,
      combatStatus: combatStatusOf(snapshot.hp),
      finalHp: snapshot.hp,
      // 戦闘中に動きうるHP上限（`APPLY_STAT_MOD(MAXIMUM_HP)`・G-09）を反映するため、
      // 開始時点の`roster.combatStats`ではなくこの時点の実効値を返す
      // （`BattleUnitStateResponse.hp.maximum`と同じ規約）。
      maximumHp: snapshot.combatStats.maximumHp,
    };
  });
}
