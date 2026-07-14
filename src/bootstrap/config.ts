import { resolveDocsEnabled } from "./docs-enabled.js";

/**
 * `11_インフラストラクチャ設計.md`「設定管理」「文字列を検証済みの型付き
 * `ApplicationConfig`へ変換する」「必須値欠落、数値変換失敗、矛盾する期限は
 * 起動エラーにする」（レビュー指摘: `bootstrap/index.ts`が数値環境変数を
 * 素の`Number()`で変換していたため、`SIMULATION_TIMEOUT_MS=abc`が`NaN`へ、
 * `WORKER_MAX_QUEUE=Infinity`が無制限へ、それぞれ検証なしで通っていた）。
 *
 * M4で実際に起動へ配線されている数値設定（`PORT`・`SIMULATION_TIMEOUT_MS`・
 * `WORKER_MAX_QUEUE`・`SHUTDOWN_GRACE_MS`）だけを対象にする。文字列設定
 * （`HOST`・`CATALOG_PATH`・`LOG_LEVEL`）は数値変換が存在しないため対象外。
 * `HTTP_HANDLER_TIMEOUT_MS`など未実装の設定にまたがる期限順序検証は、
 * その設定自体が導入されるまで対象にできない。
 */
export class ConfigError extends Error {
  constructor(violations: readonly string[]) {
    super(
      `invalid configuration:\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

export interface ApplicationConfig {
  readonly port: number;
  readonly host: string;
  readonly catalogDir: string;
  readonly simulationTimeoutMs: number;
  readonly workerMaxQueue: number;
  readonly shutdownGraceMs: number;
  readonly logLevel: string;
  readonly docsEnabled: boolean;
}

interface PositiveIntegerSpec {
  readonly envVar: string;
  readonly defaultValue: number;
  /** 0を許容するかどうか（`WORKER_MAX_QUEUE=0`はPiscinaの正当な設定——即座に拒否する意味を持つ）。 */
  readonly min: number;
  readonly max?: number;
}

/**
 * `raw`が未設定なら既定値を返す。設定されているが安全な整数でない、
 * 空文字列（前後空白のみを含む）、または範囲外の場合は`violations`へ
 * 理由を積んで既定値を返す——呼び出し側は`violations`が空でなければ
 * 返り値をすべて捨てて`ConfigError`を送出する。
 *
 * レビュー指摘: `Number("") === 0`のため、空文字列が暗黙に`0`として
 * 受理されていた。`raw.trim() === ""`を明示的に拒否する。また
 * `Number.isInteger`は`2 ** 53`超のような安全域外の値も真を返すため、
 * `Number.isSafeInteger`へ強化する。
 */
function parsePositiveInteger(
  raw: string | undefined,
  spec: PositiveIntegerSpec,
  violations: string[],
): number {
  if (raw === undefined) {
    return spec.defaultValue;
  }
  const value = Number(raw);
  const inRange = value >= spec.min && (spec.max === undefined || value <= spec.max);
  if (raw.trim() === "" || !Number.isSafeInteger(value) || !inRange) {
    const rangeDescription =
      spec.max === undefined
        ? `an integer >= ${spec.min}`
        : `an integer between ${spec.min} and ${spec.max}`;
    violations.push(`${spec.envVar}=${JSON.stringify(raw)} must be ${rangeDescription}`);
    return spec.defaultValue;
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): ApplicationConfig {
  const violations: string[] = [];

  const port = parsePositiveInteger(
    env["PORT"],
    { envVar: "PORT", defaultValue: 3000, min: 1, max: 65535 },
    violations,
  );
  const simulationTimeoutMs = parsePositiveInteger(
    env["SIMULATION_TIMEOUT_MS"],
    { envVar: "SIMULATION_TIMEOUT_MS", defaultValue: 30_000, min: 1 },
    violations,
  );
  // `11_インフラストラクチャ設計.md`「待機キューを無制限にしない」。`min: 0`は
  // `maxQueue: 0`（即座に拒否）を許容するため——`Infinity`のような無制限指定
  // だけを`Number.isFinite`が拒否する。
  const workerMaxQueue = parsePositiveInteger(
    env["WORKER_MAX_QUEUE"],
    { envVar: "WORKER_MAX_QUEUE", defaultValue: 100, min: 0 },
    violations,
  );
  // レビュー指摘: この値はPiscinaの`closeTimeout`（`node:timers/promises`の
  // `setTimeout`）へそのまま渡る。Node.jsのタイマーは32-bit符号付き整数
  // （最大`2_147_483_647`ms、約24.8日）を超えるとオーバーフローし、
  // 待機時間が実質1msへ縮む——巨大な値ほど「長く待つ」設定のつもりが
  // 「即座にタイムアウトする」設定になる。上限を明示して起動時に拒否する。
  const shutdownGraceMs = parsePositiveInteger(
    env["SHUTDOWN_GRACE_MS"],
    { envVar: "SHUTDOWN_GRACE_MS", defaultValue: 30_000, min: 0, max: 2_147_483_647 },
    violations,
  );

  if (violations.length > 0) {
    throw new ConfigError(violations);
  }

  return {
    port,
    host: env["HOST"] ?? "0.0.0.0",
    catalogDir: env["CATALOG_PATH"] ?? "catalog",
    simulationTimeoutMs,
    workerMaxQueue,
    shutdownGraceMs,
    logLevel: env["LOG_LEVEL"] ?? "info",
    docsEnabled: resolveDocsEnabled(env["NODE_ENV"]),
  };
}
