import { createActionQueue } from "./action-queue.js";
import { selectAsCandidate } from "./action-selection-policy.js";
import type { BattleDefinitions } from "./battle-definitions.js";
import { isDefeated, type BattleUnit } from "./battle-unit.js";
import { applyDamageAction } from "./damage-application-service.js";
import { createActionPoint } from "./resource-gauge.js";
import { resolveSkillOrder, type ResolvedEffectApplication } from "./skill-resolution-service.js";
import { resolveVictory, type VictoryResult } from "./victory-policy.js";
import type { EffectActionDefinitionId } from "../catalog/catalog-ids.js";
import type { RandomSource } from "../ports/random-source.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";

export interface ActionPhaseResult {
  readonly allyUnits: readonly BattleUnit[];
  readonly enemyUnits: readonly BattleUnit[];
  /** `undefined` means the phase drained naturally without a victory being resolved. */
  readonly result: VictoryResult | undefined;
}

function requireUnit(units: readonly BattleUnit[], id: BattleUnitId): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === id);
  if (unit === undefined) {
    throw new DomainValidationError("battleUnitId", `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

function consumeAp(
  units: readonly BattleUnit[],
  actorId: BattleUnitId,
  amount: number,
): readonly BattleUnit[] {
  return units.map((unit) =>
    unit.battleUnitId === actorId
      ? { ...unit, currentAp: createActionPoint(unit.currentAp - amount, unit.maximumAp) }
      : unit,
  );
}

interface EffectActionGroup {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hits: ResolvedEffectApplication[];
}

/** `resolveSkillOrder` の定義順出力を、同一EffectActionDefinitionIdの連続runでまとめる。 */
function groupConsecutiveByEffectAction(
  plan: readonly ResolvedEffectApplication[],
): readonly EffectActionGroup[] {
  const groups: EffectActionGroup[] = [];
  for (const entry of plan) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.effectActionDefinitionId === entry.effectActionDefinitionId) {
      last.hits.push(entry);
    } else {
      groups.push({ effectActionDefinitionId: entry.effectActionDefinitionId, hits: [entry] });
    }
  }
  return groups;
}

/**
 * `06_戦闘状態遷移.md` のDECIDING〜COMPLETINGの基本形。R-ACT-03の一部
 * （ASのAPコスト消費、通常の待機によるAP1消費）だけを実装する。EXゲージ増加
 * (R-ACT-04)、クールタイム・気絶・凍結・チャージ(M7)、PS/Memory連鎖(M6)は
 * この関数の対象外。DAMAGE以外のEffectActionKindの解決も対象外（M6/M7）。
 */
function resolveOneAsAction(
  actorId: BattleUnitId,
  units: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
): readonly BattleUnit[] {
  const actor = requireUnit(units, actorId);
  const activeSkills = definitions.activeSkillsByUnit.get(actor.unitDefinitionId) ?? [];
  const selection = selectAsCandidate(activeSkills, actor, units);

  if (selection.kind === "WAIT") {
    return consumeAp(units, actorId, 1);
  }

  let working = consumeAp(units, actorId, selection.skill.cost.amount);
  const actorAfterCost = requireUnit(working, actorId);
  const plan = resolveSkillOrder(
    selection.skill,
    actorAfterCost,
    working,
    definitions.effectActions,
  );

  for (const group of groupConsecutiveByEffectAction(plan)) {
    const effectAction = definitions.effectActions.get(group.effectActionDefinitionId);
    if (effectAction === undefined || effectAction.kind !== "DAMAGE") {
      throw new DomainValidationError(
        "effectActionDefinitionId",
        `EffectAction kind other than "DAMAGE" is not supported by this basic turn action resolver (M6/M7 scope)`,
      );
    }
    const currentActor = requireUnit(working, actorId);
    const result = applyDamageAction(currentActor, group.hits, effectAction, working, random);
    working = result.units;
  }

  return working;
}

function splitBySide(units: readonly BattleUnit[]): {
  ally: readonly BattleUnit[];
  enemy: readonly BattleUnit[];
} {
  return {
    ally: units.filter((unit) => unit.side === "ALLY"),
    enemy: units.filter((unit) => unit.side === "ENEMY"),
  };
}

/**
 * `06_戦闘状態遷移.md` のQUEUE_BUILDING〜ACTION_RESOLUTIONを、使用可能な行動が
 * 無くなるまで繰り返す（`createActionQueue` が空を返した時点で終了）。各1行動
 * 完了後にR-END-01タイミング#1（ユニットの1行動完了後）の勝敗判定を行い、
 * 確定した時点で残りの行動を打ち切る。PS/Memory連鎖(M6)は行わない。
 */
export function resolveActionPhase(
  allyUnits: readonly BattleUnit[],
  enemyUnits: readonly BattleUnit[],
  definitions: BattleDefinitions,
  random: RandomSource,
): ActionPhaseResult {
  let units: readonly BattleUnit[] = [...allyUnits, ...enemyUnits];

  for (;;) {
    const queue = createActionQueue(units);
    if (queue.entries.length === 0) {
      break;
    }

    for (const reservation of queue.entries) {
      // Q-BTL-04/06_戦闘状態遷移.md「戦闘不能者の除去」: このキュー生成後、
      // 自分の番が来るまでの間に戦闘不能になった予約者は、防御的にそのまま
      // 破棄する（DECIDING #1「戦闘不能なら処理せず終了する」）。
      if (isDefeated(requireUnit(units, reservation.battleUnitId))) {
        continue;
      }

      if (reservation.reservedActionKind === "EX") {
        throw new DomainValidationError(
          "reservedActionKind",
          '"EX" action resolution is not supported by this basic turn action resolver (M6 scope)',
        );
      }

      units = resolveOneAsAction(reservation.battleUnitId, units, definitions, random);

      const { ally, enemy } = splitBySide(units);
      const victory = resolveVictory({
        allAlliesDefeated: ally.every(isDefeated),
        allEnemiesDefeated: enemy.every(isDefeated),
        turnLimitReached: false,
      });
      if (victory !== undefined) {
        return { allyUnits: ally, enemyUnits: enemy, result: victory };
      }
    }
  }

  const { ally, enemy } = splitBySide(units);
  return { allyUnits: ally, enemyUnits: enemy, result: undefined };
}
