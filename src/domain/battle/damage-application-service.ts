import { isDefeated, type BattleUnit } from "./battle-unit.js";
import { calculateDamage } from "./damage-calculator.js";
import { resolveCritical } from "./critical-policy.js";
import { resolveHit } from "./hit-policy.js";
import { createPercentage } from "./percentage.js";
import { createHitPoint } from "./resource-gauge.js";
import type { ResolvedEffectApplication } from "./skill-resolution-service.js";
import type { EffectActionDefinition } from "../catalog/effect-action-definition.js";
import type { RandomSource } from "../ports/random-source.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";

export interface DamageHitOutcome {
  readonly targetBattleUnitId: BattleUnitId;
  readonly hitIndex: number;
  /** false when the hit was skipped instead of applied (target already defeated, or MISS). */
  readonly applied: boolean;
  readonly isCritical: boolean;
  readonly damage: number;
}

export interface ApplyDamageActionResult {
  readonly units: readonly BattleUnit[];
  readonly hits: readonly DamageHitOutcome[];
}

function skip(hit: ResolvedEffectApplication): DamageHitOutcome {
  return {
    targetBattleUnitId: hit.targetBattleUnitId,
    hitIndex: hit.hitIndex,
    applied: false,
    isCritical: false,
    damage: 0,
  };
}

function findUnit(
  units: ReadonlyMap<BattleUnitId, BattleUnit>,
  id: BattleUnitId,
  path: string,
): BattleUnit {
  const unit = units.get(id);
  if (unit === undefined) {
    throw new DomainValidationError(path, `references an unknown BattleUnitId: "${id}"`);
  }
  return unit;
}

/**
 * `DamageApplicationService` の基本形 (`05_ドメインモデル.md`)。`SkillResolutionService`が
 * 解決した1つのDAMAGE EffectActionのヒット列を、R-DMG-05の順序（命中→会心→
 * ダメージ計算→HP適用→戦闘不能判定）でヒットごとに処理する。R-ACTN-01/R-SKL-03:
 * 参照時点で既に戦闘不能な対象へのヒットは適用をスキップする。R-SKL-01/R-SKL-03:
 * 使用者(attacker)自身が途中で戦闘不能になった場合、以降の未解決ヒットをすべて
 * 中断する（対象が異なるヒットも含む）。シールド・サブユニット・リンクダメージへの
 * 適用調整(R-SHD-*、R-SUB-*、R-LNK-*)はM8未実装のため、HPへ直接適用する。
 */
export function applyDamageAction(
  attacker: BattleUnit,
  hits: readonly ResolvedEffectApplication[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  units: readonly BattleUnit[],
  random: RandomSource,
): ApplyDamageActionResult {
  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const outcomes: DamageHitOutcome[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const currentAttacker = findUnit(working, attacker.battleUnitId, "attacker.battleUnitId");

    // R-SKL-01/R-SKL-03: 使用者が戦闘不能になったら残りの未解決ヒットを中断する。
    if (isDefeated(currentAttacker)) {
      outcomes.push(...hits.slice(i).map(skip));
      break;
    }

    const target = findUnit(working, hit.targetBattleUnitId, "hits[].targetBattleUnitId");

    if (isDefeated(target) || !resolveHit()) {
      outcomes.push(skip(hit));
      continue;
    }

    const critical = resolveCritical(
      damageAction.payload.critical.mode,
      createPercentage(currentAttacker.combatStats.criticalRate),
      currentAttacker.combatStats.criticalDamageBonus,
      random,
    );

    const damage = calculateDamage({
      attackerAttack: currentAttacker.combatStats.attack,
      attackerAttribute: currentAttacker.attribute,
      attackerAffinityBonus: currentAttacker.combatStats.affinityBonus,
      defenderDefense: target.combatStats.defense,
      defenderAttribute: target.attribute,
      defenseIgnoreRate: damageAction.payload.piercing.defenseIgnoreRate,
      skillPowerFormula: damageAction.payload.formula,
      damageModifiers: damageAction.payload.damageModifiers,
      criticalMultiplier: critical.multiplier,
    });

    const updatedTarget: BattleUnit = {
      ...target,
      currentHp: createHitPoint(
        Math.max(0, target.currentHp - damage),
        target.combatStats.maximumHp,
      ),
    };
    working.set(target.battleUnitId, updatedTarget);

    outcomes.push({
      targetBattleUnitId: hit.targetBattleUnitId,
      hitIndex: hit.hitIndex,
      applied: true,
      isCritical: critical.isCritical,
      damage,
    });
  }

  return {
    units: units.map((unit) => working.get(unit.battleUnitId)!),
    hits: outcomes,
  };
}
