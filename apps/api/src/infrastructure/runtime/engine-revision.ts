import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** gitを実行して標準出力を返す。失敗（gitが無い、リポジトリ外など）は`undefined`。 */
export type GitRunner = (args: readonly string[]) => string | undefined;

export interface ResolveEngineRevisionOptions {
  /** `ENGINE_REVISION`。指定があればgitを見ない（コンテナのビルド時に注入する想定）。 */
  readonly configured?: string;
  readonly git: GitRunner;
  /** 未追跡ファイルの内容を読む。パスはgitの作業ディレクトリ相対。 */
  readonly readFile?: (path: string) => Buffer | undefined;
  /** 解決できなかったときに、このプロセス限りの値にするための識別子。 */
  readonly bootId: string;
}

const DIRTY_DIGEST_LENGTH = 12;

/**
 * 大量試行の応答が載せる`engineRevision`を起動時に一度だけ決める。
 *
 * - `ENGINE_REVISION`があればそれを使う。
 * - なければ戦闘実装のソース（このディレクトリ配下）のcommitを使い、未コミット変更が
 *   あれば差分と未追跡ファイルの内容のダイジェストを付ける — 同じcommitでも手元の変更で
 *   結果が変わり得るため、変更の有無と内容を区別できるようにする。
 * - どちらも得られなければ、起動ごとに異なる`unresolved+boot.<id>`にする。固定の文字列で
 *   返すと、別々の実装で得た結果が同じ識別子のもとで再現可能に見えてしまう。
 */
export function resolveEngineRevision(options: ResolveEngineRevisionOptions): string {
  if (options.configured !== undefined) {
    return options.configured;
  }
  const unresolved = `unresolved+boot.${options.bootId}`;
  const { git } = options;

  const head = git(["rev-parse", "HEAD"])?.trim();
  // 追跡されていないディレクトリ（コンパイル済み`dist/`など）はcommitと対応しない。
  const tracked = git(["ls-files", "--", "."]);
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", "."]);
  if (head === undefined || head === "" || !tracked || status === undefined) {
    return unresolved;
  }
  if (status.trim() === "") {
    return head;
  }

  const diff = git(["diff", "HEAD", "--binary", "--", "."]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
  if (diff === undefined || untracked === undefined) {
    return unresolved;
  }
  const readFile = options.readFile ?? (() => undefined);
  const hash = createHash("sha256").update(diff);
  for (const path of untracked.split("\0").filter((entry) => entry !== "")) {
    hash.update("\0").update(path).update("\0");
    hash.update(readFile(path) ?? Buffer.alloc(0));
  }
  return `${head}+dirty.${hash.digest("hex").slice(0, DIRTY_DIGEST_LENGTH)}`;
}

/** 戦闘実装のソースのルート（`src/`、コンパイル後は`dist/`）。 */
export function defaultEngineSourceDirectory(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/** `cwd`で`git`を実行する{@link GitRunner}。起動時にだけ使い、リクエストごとには呼ばない。 */
export function createGitRunner(cwd: string): GitRunner {
  return (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  };
}

/** 未追跡ファイルを`cwd`相対で読む。読めないファイルは内容なしとして扱う。 */
export function createFileReader(cwd: string): (path: string) => Buffer | undefined {
  return (path) => {
    try {
      return readFileSync(join(cwd, path));
    } catch {
      return undefined;
    }
  };
}
