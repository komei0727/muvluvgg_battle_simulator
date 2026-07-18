import {
  createSkillDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";

/**
 * `detectPassiveCandidates`（Issue #34、`domain/battle/triggering`）は
 * `BattleDefinitions.unitDefinitions`に、戦闘へ参加する全ユニットの
 * `unitDefinitionId`が存在することを要求する（`UT-R-PS-01-027`が検証する
 * Catalog整合性の防御）。PSを検証対象にしないテストが、参加ユニットの
 * `UnitDefinitionId`ごとに完全な`UnitDefinition`を用意する手間を避けられる
 * よう、未登録キーには「PSを1つも持たないユニット」を指す既定値を返す。
 */
function defaultUnitDefinition(unitDefinitionId: UnitDefinitionId): UnitDefinition {
  return {
    unitDefinitionId,
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX_DEFAULT"),
    requiredCapabilities: [],
    metadata: {
      displayName: "Default Test Unit",
      characterName: "Default Test Character",
      characterId: "CHAR_DEFAULT_TEST",
      affiliations: [],
      tags: [],
    },
  };
}

/**
 * `unitDefinitions`に未登録の`UnitDefinitionId`を`get()`した時、PSを1つも
 * 持たない既定の`UnitDefinition`へ自動的にフォールバックする`Map`。他の
 * `ReadonlyMap`操作（`size`/`forEach`/`keys`等）は登録済みエントリだけを
 * 反映する（`Map`をそのまま継承し、`get`だけを上書きする）。
 */
export class DefaultUnitDefinitionMap extends Map<UnitDefinitionId, UnitDefinition> {
  override get(unitDefinitionId: UnitDefinitionId): UnitDefinition | undefined {
    return super.get(unitDefinitionId) ?? defaultUnitDefinition(unitDefinitionId);
  }
}
