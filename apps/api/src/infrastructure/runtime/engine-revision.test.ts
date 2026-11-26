import { describe, expect, it } from "vitest";
import {
  createGitRunner,
  defaultEngineSourceDirectory,
  resolveEngineRevision,
  type GitRunner,
} from "./engine-revision.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** 引数列ごとの応答を返す偽のgit。登録のない呼び出しは失敗（`undefined`）として扱う。 */
function fakeGit(responses: Record<string, string>): GitRunner {
  return (args) => responses[args.join(" ")];
}

const CLEAN: Record<string, string> = {
  "rev-parse HEAD": `${HEAD}\n`,
  "ls-files -- .": "a.ts\n",
  "status --porcelain --untracked-files=all -- .": "",
};

function resolve(git: GitRunner, configured?: string): string {
  return resolveEngineRevision({
    ...(configured !== undefined ? { configured } : {}),
    git,
    readFile: (path) => Buffer.from(`contents of ${path}`),
    bootId: "boot-1",
  });
}

describe("resolveEngineRevision", () => {
  it("UT-ENGREV-001: a configured revision wins without consulting git", () => {
    expect(
      resolve(() => {
        throw new Error("must not run git");
      }, "image-abc"),
    ).toBe("image-abc");
  });

  it("UT-ENGREV-002: a clean checkout is identified by its commit", () => {
    expect(resolve(fakeGit(CLEAN))).toBe(HEAD);
  });

  it("UT-ENGREV-003: uncommitted changes add a digest of the diff and the untracked files", () => {
    const dirty = (diff: string, untracked: string) =>
      resolve(
        fakeGit({
          ...CLEAN,
          "status --porcelain --untracked-files=all -- .": " M a.ts\n",
          "diff HEAD --binary -- .": diff,
          "ls-files --others --exclude-standard -z -- .": untracked,
        }),
      );

    const first = dirty("diff-1", "");
    expect(first).toMatch(new RegExp(`^${HEAD}\\+dirty\\.[0-9a-f]{12}$`));
    expect(dirty("diff-1", "")).toBe(first);
    expect(dirty("diff-2", "")).not.toBe(first);
    expect(dirty("diff-1", "new.ts\0")).not.toBe(first);
  });

  it("UT-ENGREV-004: without git or tracked sources the revision is unique to this boot rather than a fixed placeholder", () => {
    expect(resolve(fakeGit({}))).toBe("unresolved+boot.boot-1");
    expect(resolve(fakeGit({ ...CLEAN, "ls-files -- .": "" }))).toBe("unresolved+boot.boot-1");
  });

  it("UT-ENGREV-005: the real repository resolves to a commit, optionally marked dirty", () => {
    const revision = resolveEngineRevision({
      git: createGitRunner(defaultEngineSourceDirectory()),
      bootId: "boot-real",
    });

    // CIのcheckoutにも`.git`があるため、ここで`unresolved`になるのは配線の誤りである。
    expect(revision).toMatch(/^[0-9a-f]{40}(\+dirty\.[0-9a-f]{12})?$/);
  });
});
