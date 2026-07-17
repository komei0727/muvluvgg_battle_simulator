import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";
import type { FormationPosition } from "./formation-input.js";
import type { GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { CombatStats } from "./starting-combat-stats.js";

/** `05_ドメインモデル.md` の BattleParty: 味方または敵の一方を表す集約内エンティティ。 */
export interface BattlePartyMember {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  /** R-ATR-02: `UnitDefinition.attribute` をそのまま写す。戦闘中は変化しない。 */
  readonly attribute: Attribute;
  readonly position: FormationPosition;
  readonly globalCoordinate: GlobalCoordinate;
  /** R-STA-01: 配置適性・編成補正・Memory補正を含む開始時の戦闘中ステータス。 */
  readonly combatStats: CombatStats;
}

export interface BattleParty {
  readonly side: Side;
  readonly members: readonly BattlePartyMember[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
  readonly formationBonus: FormationBonus;
}
