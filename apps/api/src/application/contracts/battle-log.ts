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
 * Battle Log/イベントログ関連の外部契約型を持つ。
 */

export interface BattleLogEventResponseBody {
  readonly sequence: number;
  readonly type: string;
  readonly category: string;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: string;
  readonly skillUseId?: string;
  readonly parentSequence?: number;
  readonly rootSequence: number;
  readonly sourceUnitId?: string;
  readonly targetUnitIds: readonly string[];
  readonly details: unknown;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly stateTransitionIndex?: number;
}
