import type { Attribute } from "../../domain/catalog/definitions/catalog-enums.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import type { BaseStats } from "../../domain/catalog/definitions/unit-definition.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { Side } from "../../domain/shared/side.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * production-catalogテストの行動主体ビルダー。既定値は「会心なし・属性相性なし」
 * の決定的ステータスで、乱数消費と補正を検証対象の機能だけへ閉じる。
 * テスト意図に関わる値だけを `combatStats` / `limits` / `overrides` で明示する。
 */

const DEFAULT_COMBAT_STATS: CombatStats = {
  maximumHp: 100,
  attack: 20,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

/**
 * `BattlePartyMember` の型を満たすためだけの `enhancedBaseStats`（R-ENH-06の
 * 強化後基本ステータス）。`combatStats` を直接指定するテストでは補正前の値に
 * 意味がなく、`createBattleUnit` も読まないため、対応関係を持たせない。
 * 補正前後の関係そのものを検証するテストは `FormationFactory` 経由で組む。
 */
export const UNUSED_ENHANCED_BASE_STATS: BaseStats = {
  maximumHp: 0,
  attack: 0,
  defense: 0,
  criticalRate: 0,
  criticalDamageBonus: 0,
  affinityBonus: 0,
  actionSpeed: 0,
  maximumAp: 0,
  maximumPp: 0,
};

const DEFAULT_LIMITS: BattleUnitResourceLimits = {
  maximumAp: 4,
  maximumPp: 4,
  maximumExtraGauge: 10,
};

const DEFAULT_POSITION: FormationPosition = { column: "LEFT", row: "FRONT" };

export interface TestPartyMemberOptions {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  /** 省略時は味方。`globalCoordinate` の導出にも使う。 */
  readonly side?: Side;
  readonly position?: FormationPosition;
  readonly attribute?: Attribute;
  readonly combatStats?: Partial<CombatStats>;
}

export function testPartyMember(options: TestPartyMemberOptions): BattlePartyMember {
  const side = options.side ?? "ALLY";
  const position = options.position ?? DEFAULT_POSITION;
  return {
    battleUnitId: createBattleUnitId(options.battleUnitId),
    unitDefinitionId: createUnitDefinitionId(options.unitDefinitionId),
    attribute: options.attribute ?? "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: { ...DEFAULT_COMBAT_STATS, ...options.combatStats },
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
  };
}

export interface TestBattleUnitOptions extends TestPartyMemberOptions {
  readonly limits?: Partial<BattleUnitResourceLimits>;
  /** `createBattleUnit` が導出した初期状態の上へ最後に展開する（HP半減・効果付与など）。 */
  readonly overrides?: Partial<BattleUnit>;
}

export function testBattleUnit(options: TestBattleUnitOptions): BattleUnit {
  const side = options.side ?? "ALLY";
  return {
    ...createBattleUnit(testPartyMember(options), side, {
      ...DEFAULT_LIMITS,
      ...options.limits,
    }),
    ...options.overrides,
  };
}
