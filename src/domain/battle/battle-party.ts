import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";
import type { FormationPosition } from "./formation-input.js";
import type { GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";

/** `05_ドメインモデル.md` の BattleParty: 味方または敵の一方を表す集約内エンティティ。 */
export interface BattlePartyMember {
  readonly battleUnitId: BattleUnitId;
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPosition;
  readonly globalCoordinate: GlobalCoordinate;
}

export interface BattleParty {
  readonly side: Side;
  readonly members: readonly BattlePartyMember[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
  readonly formationBonus: FormationBonus;
}
