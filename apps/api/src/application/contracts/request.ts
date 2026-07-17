/**
 * `10_API設計.md`の外部JSON契約と同じ形の、ブランド型を含まないプレーンな型群。
 * Presentation層（Fastify JSON Schema・ルートハンドラ）はこのファイルだけを
 * importすればよく、domain層のbranded typeへ直接触れずに済む
 * （`no-restricted-imports`によるpresentation→domain遮断を維持するため）。
 *
 * ここに定義する型はワイヤーフォーマットの正本であり、値の生成ロジックは
 * 持たない。DTO→Commandの変換は`simulate-battle-request-mapper.ts`が担う。
 *
 * `POST /api/v1/battle-simulations`のrequest body契約型を持つ。
 */

export interface FormationPositionRequestBody {
  readonly column: number;
  readonly row: string;
}

export interface FormationUnitRequestBody {
  readonly unitDefinitionId: string;
  readonly position: FormationPositionRequestBody;
}

export interface FormationRequestBody {
  readonly units: readonly FormationUnitRequestBody[];
  readonly memoryDefinitionIds: readonly string[];
}

export interface SimulationOptionsRequestBody {
  readonly logLevel?: string;
}

export interface BattleSimulationRequestBody {
  readonly allyFormation: FormationRequestBody;
  readonly enemyFormation: FormationRequestBody;
  readonly turnLimit: number;
  readonly options?: SimulationOptionsRequestBody;
}
