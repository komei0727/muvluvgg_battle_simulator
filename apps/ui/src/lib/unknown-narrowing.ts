// APIレスポンスの`unknown`な詳細(details/delta/rawJSON)を読む箇所は、
// features横断で同じナローイングを必要とする。個別定義に散らすと契約解釈が
// ファイルごとにずれるため、この1箇所へ集約する。

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
