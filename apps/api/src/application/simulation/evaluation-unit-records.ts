import { ApplicationError } from "../contracts/application-error.js";
import type { FormationInput } from "./simulate-battle-command.js";
import type { CombatStatus } from "../observation/combat-status.js";
import type { UnitBattleSummary } from "../observation/unit-battle-summary-projector.js";
import type { UnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

/** 単発ユースケースのロースターのうち、この投影が読む部分だけ。 */
export interface EvaluationRosterEntry {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly side: Side;
  /** 総力戦のみ。 */
  readonly formationNumber?: number;
  readonly deployed?: boolean;
  readonly reappearance?: boolean;
}

/**
 * 1試行のユニット1枠分の集計。枠は元リクエストの`(side, formationNumber, unitIndex)`で
 * 特定する — R-FRM-03により同じ`UnitDefinitionId`を同一陣営へ複数置けるため、定義IDでは
 * 枠が決まらない。値は単発ユースケースの`unitSummaries`をそのまま写したものである。
 */
export interface EvaluationUnitRecord {
  readonly side: Side;
  /** 総力戦のみ。リクエストの`allyFormations`／`enemyFormations`の1始まりの番号。 */
  readonly formationNumber?: number;
  /** リクエストの編成の`units`配列での添字（0始まり）。 */
  readonly unitIndex: number;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly healingDone: number;
  readonly finalHp: number;
  readonly maximumHp: number;
  readonly combatStatus: CombatStatus;
  /** 総力戦のみ。一度でも出撃したか。控えのまま終わった枠は`false`。 */
  readonly deployed?: boolean;
  /** 総力戦のみ。再登場の基礎値補正（R-TWR-02）を受けたか。 */
  readonly reappearance?: boolean;
}

function invariant(reason: string): ApplicationError {
  return new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [{ reason }]);
}

/**
 * ロースター（陣営 → 編成番号 → 配置順）を元リクエストの枠へ対応づけ、ユニット別集計を
 * 枠ごとに取り出す。対応はロースターの並びに依存するため、数と定義IDがリクエストと
 * 一致することを確かめる — ずれたまま返すと、別の枠の集計を黙って取り違える。
 */
export function projectEvaluationUnits(
  roster: readonly EvaluationRosterEntry[],
  summaries: readonly UnitBattleSummary[],
  formations: Readonly<Record<Side, readonly FormationInput[]>>,
): EvaluationUnitRecord[] {
  const summaryByUnitId = new Map(summaries.map((summary) => [summary.battleUnitId, summary]));
  const nextUnitIndex = new Map<string, number>();

  const records = roster.map((entry): EvaluationUnitRecord => {
    const formationNumber = entry.formationNumber ?? 1;
    const key = `${entry.side}:${formationNumber}`;
    const unitIndex = nextUnitIndex.get(key) ?? 0;
    nextUnitIndex.set(key, unitIndex + 1);

    const slot = formations[entry.side][formationNumber - 1]?.slots[unitIndex];
    if (slot === undefined || slot.unitDefinitionId !== entry.unitDefinitionId) {
      throw invariant(
        `the unit roster entry ${entry.battleUnitId} does not match ${entry.side} formation ${formationNumber} unit ${unitIndex} of the request`,
      );
    }
    const summary = summaryByUnitId.get(entry.battleUnitId);
    if (summary === undefined) {
      throw invariant(`the unit roster entry ${entry.battleUnitId} has no unit summary`);
    }

    return {
      side: entry.side,
      ...(entry.formationNumber !== undefined ? { formationNumber: entry.formationNumber } : {}),
      unitIndex,
      unitDefinitionId: entry.unitDefinitionId,
      damageDealt: summary.damageDealt,
      damageTaken: summary.damageTaken,
      healingDone: summary.healingDone,
      finalHp: summary.finalHp,
      maximumHp: summary.maximumHp,
      combatStatus: summary.combatStatus,
      ...(entry.deployed !== undefined ? { deployed: entry.deployed } : {}),
      ...(entry.reappearance !== undefined ? { reappearance: entry.reappearance } : {}),
    };
  });

  for (const side of ["ALLY", "ENEMY"] as const) {
    formations[side].forEach((formation, formationIndex) => {
      const projected = nextUnitIndex.get(`${side}:${formationIndex + 1}`) ?? 0;
      if (projected !== formation.slots.length) {
        throw invariant(
          `${side} formation ${formationIndex + 1} requested ${formation.slots.length} units but the unit roster holds ${projected}`,
        );
      }
    });
  }

  return records;
}
