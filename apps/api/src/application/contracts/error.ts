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
 * エラー応答の外部契約型を持つ。
 */

export interface ViolationResponseBody {
  readonly path?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  readonly message: string;
}

export interface ErrorObjectResponseBody {
  readonly code: string;
  readonly message: string;
  readonly violations: readonly ViolationResponseBody[];
  readonly diagnosticId?: string;
}

export interface ErrorResponseBody {
  readonly schemaVersion: number;
  readonly error: ErrorObjectResponseBody;
}
