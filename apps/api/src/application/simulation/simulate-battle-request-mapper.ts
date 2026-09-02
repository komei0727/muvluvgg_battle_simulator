import type {
  FormationEnhancementInput,
  FormationPositionInput,
  GearInput,
  SimulateBattleCommand,
  UnitEnhancementInput,
} from "./simulate-battle-command.js";
import type { BattleSimulationRequestBody, FormationRequestBody } from "../contracts/request.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

/**
 * `10_API設計.md`「SimulationOptions」: `options.logLevel`の既定値。既定の用途は
 * 「編成を比べるための実行」であり、必要なのは勝敗とユニット別集計だけである
 * （`DETAILED`を既定にすると、指定しないクライアントが毎回数MBのレスポンスを
 * 受け取る）。
 */
const DEFAULT_LOG_LEVEL = "SUMMARY";

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

/**
 * R-ENH-01 #1: ユニット単位の強化指定。列挙値・値域はここでは検査せず、
 * `validateCommandShape`（`422 INVALID_COMMAND`）へ委ねる — 他の入力（`row`や
 * `logLevel`）と同じく、Command検証で違反をまとめて収集するため。
 */
function toUnitEnhancementInput(
  enhancement: NonNullable<FormationRequestBody["units"][number]["enhancement"]>,
): UnitEnhancementInput {
  return {
    ...(enhancement.level === undefined ? {} : { level: enhancement.level }),
    ...(enhancement.rank === undefined ? {} : { rank: enhancement.rank }),
    ...(enhancement.gears === undefined
      ? {}
      : { gears: enhancement.gears.map((gear) => gear as GearInput) }),
    ...(enhancement.module === undefined ? {} : { module: enhancement.module }),
  };
}

/**
 * R-ENH-01 #2: 陣営の強化指定は「存在すること」自体が全ユニットを強化対象にする。
 * `academyLevels`が無い空オブジェクトも意味を持つため、そのまま保持する。
 */
function toFormationEnhancementInput(
  enhancement: NonNullable<FormationRequestBody["enhancement"]>,
): FormationEnhancementInput {
  return {
    ...(enhancement.academyLevels === undefined
      ? {}
      : { academyLevels: enhancement.academyLevels }),
  };
}

/**
 * 1陣営ぶんのDTO→Command変換。編成ステータスプレビュー
 * （`preview-formation-stats-request-mapper.ts`）とも共有する。
 */
export function toFormationInput(
  formation: FormationRequestBody,
): SimulateBattleCommand["allyFormation"] {
  return {
    slots: formation.units.map((unit) => ({
      unitDefinitionId: toUnitDefinitionId(unit.unitDefinitionId),
      position: toFormationPositionInput(unit.position),
      ...(unit.enhancement === undefined
        ? {}
        : { enhancement: toUnitEnhancementInput(unit.enhancement) }),
    })),
    memoryDefinitionIds: formation.memoryDefinitionIds.map(toMemoryDefinitionId),
    ...(formation.enhancement === undefined
      ? {}
      : { enhancement: toFormationEnhancementInput(formation.enhancement) }),
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
