import type { FormationPositionInput, SimulateBattleCommand } from "./simulate-battle-command.js";
import type { BattleSimulationRequestBody, FormationRequestBody } from "./http-contract.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../domain/catalog/catalog-ids.js";

const DEFAULT_LOG_LEVEL = "DETAILED";

/**
 * `10_API設計.md`: 定義IDは「クライアントが解析しない不透明な文字列」であり、
 * API境界ではCatalogの命名規約（`UNIT_`/`MEM_`プレフィックス）を要求しない。
 * 存在確認は`SimulationPreflightValidator`（参照検証）の責務であり、ここでは
 * branded typeへ付け替えるだけで、`createUnitDefinitionId`のような書式検証は
 * 行わない（書式違反も「Catalogに存在しないID」も、クライアントから見れば
 * 等しく`DEFINITION_NOT_FOUND`になるべきため）。
 */
function toUnitDefinitionId(value: string): UnitDefinitionId {
  return value as UnitDefinitionId;
}

function toMemoryDefinitionId(value: string): MemoryDefinitionId {
  return value as MemoryDefinitionId;
}

function toFormationPositionInput(
  position: FormationRequestBody["units"][number]["position"],
): FormationPositionInput {
  return { column: position.column as 0 | 1 | 2, row: position.row as "FRONT" | "REAR" };
}

function toFormationInput(formation: FormationRequestBody): SimulateBattleCommand["allyFormation"] {
  return {
    slots: formation.units.map((unit) => ({
      unitDefinitionId: toUnitDefinitionId(unit.unitDefinitionId),
      position: toFormationPositionInput(unit.position),
    })),
    memoryDefinitionIds: formation.memoryDefinitionIds.map(toMemoryDefinitionId),
  };
}

/**
 * `10_API設計.md`「Inbound Adapterでの変換」: 外部DTO(`BattleSimulationRequestBody`)を
 * `SimulateBattleCommand`へ変換する。構造的な妥当性（型・必須項目・未知
 * プロパティ）はFastify JSON Schemaが事前に保証済みの前提で、ここでは値の
 * 変換だけを行う。人数・値域・配置重複などのCommand検証は
 * `validateCommandShape`（Application層）へ委ねる。
 */
export function toSimulateBattleCommand(body: BattleSimulationRequestBody): SimulateBattleCommand {
  return {
    allyFormation: toFormationInput(body.allyFormation),
    enemyFormation: toFormationInput(body.enemyFormation),
    turnLimit: body.turnLimit,
    logLevel: (body.options?.logLevel ?? DEFAULT_LOG_LEVEL) as SimulateBattleCommand["logLevel"],
  };
}
