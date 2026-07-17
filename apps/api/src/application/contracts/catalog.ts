/**
 * `10_API設計.md`の外部JSON契約と同じ形の、ブランド型を含まないプレーンな型群。
 * Presentation層（Fastify JSON Schema・ルートハンドラ）はこのファイルだけを
 * importすればよく、domain層のbranded typeへ直接触れずに済む
 * （`no-restricted-imports`によるpresentation→domain遮断を維持するため）。
 *
 * ここに定義する型はワイヤーフォーマットの正本であり、値の生成ロジックは
 * 持たない。DTO↔Command / Result↔Responseの変換は
 * `simulate-battle-request-mapper.ts` / `simulate-battle-response-mapper.ts`
 * が担う。
 *
 * Catalog応答の外部契約型を持つ。
 */

/** `10_API設計.md`「CatalogUnitSummaryResponse」。 */
export interface CatalogUnitSummaryResponseBody {
  readonly unitDefinitionId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: string;
  readonly unitType: string;
  readonly role: string;
  readonly positionAptitudes: readonly string[];
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

/** `10_API設計.md`「CatalogMemorySummaryResponse」。 */
export interface CatalogMemorySummaryResponseBody {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly string[];
}

/** `10_API設計.md`「BattleSimulationCatalogResponse」。 */
export interface BattleSimulationCatalogResponseBody {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
  readonly units: readonly CatalogUnitSummaryResponseBody[];
  readonly memories: readonly CatalogMemorySummaryResponseBody[];
}
