/**
 * `dump-golden-event-types-cli.ts`の引数解析。`process.argv.slice(2)`をそのまま渡す。
 *
 * 先頭の`--`は剥がしてから解釈する——`pnpm run <script> -- <args>`はnpmと異なり
 * `--`を除去せずそのまま子プロセスへ転送するため、`pnpm run dump-golden-event-types
 * -- unit UNIT_X`は`["--", "unit", "UNIT_X"]`を渡してくる（PR #628レビュー指摘の回帰）。
 */
export type GoldenEventTypesCliRequest =
  | { readonly kind: "unit"; readonly unitDefinitionId: string }
  | {
      readonly kind: "party";
      readonly ally: readonly string[];
      readonly enemy: readonly string[];
    }
  | {
      readonly kind: "exercise";
      readonly ally: readonly string[];
      readonly enemyUnitDefinitionId: string;
    }
  | { readonly kind: "usage" };

function parseIds(csv: string): readonly string[] {
  return csv
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function parseGoldenEventTypesCliRequest(
  argv: readonly string[],
): GoldenEventTypesCliRequest {
  const [kind, first, second] = argv[0] === "--" ? argv.slice(1) : argv;

  if (kind === "unit" && first !== undefined) {
    return { kind: "unit", unitDefinitionId: first };
  }
  if (kind === "party" && first !== undefined && second !== undefined) {
    return { kind: "party", ally: parseIds(first), enemy: parseIds(second) };
  }
  if (kind === "exercise" && first !== undefined && second !== undefined) {
    return { kind: "exercise", ally: parseIds(first), enemyUnitDefinitionId: second };
  }
  return { kind: "usage" };
}
