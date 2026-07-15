/**
 * PRレビュー指摘（#112 review 2026-07-15、2026-07-15再レビュー）への対応:
 * - `status.latestReadyRevisionName`はsmokeに失敗しても未promoteのまま
 *   Readyになり得るため、「現在100% trafficを受けているrevision」の判定には
 *   使えない。`status.traffic`のpercent===100エントリだけを正とする。
 * - rollback先の自動検出は「直近のReady revision」では選ばない。複数回
 *   連続でcandidateがsmokeに失敗すると、未promoteの失敗revisionがReadyの
 *   まま残り、`candidate` tagは常に最新の失敗revisionへ移るため、tagだけの
 *   除外でも古い失敗revisionを再選択し得る。promote成功時にだけ更新される
 *   `stable`／`stable-previous` tagで判定する。
 */
import { describe, expect, it } from "vitest";
import {
  findRevisionNameByTag,
  resolveCurrentRevisionName,
  STABLE_PREVIOUS_TAG,
  STABLE_TAG,
} from "./cloud-run-traffic.js";
import type { TrafficTarget } from "./cloud-run-manifest.js";

describe("resolveCurrentRevisionName", () => {
  it("IT-INFRA-CICD-007: returns undefined when the service has no traffic yet (bootstrap)", () => {
    expect(resolveCurrentRevisionName([])).toBeUndefined();
  });

  it("IT-INFRA-CICD-008: returns the revision at exactly 100 percent traffic", () => {
    const traffic: TrafficTarget[] = [
      { revisionName: "svc-a", percent: 100 },
      { revisionName: "svc-b", percent: 0, tag: "candidate" },
    ];
    expect(resolveCurrentRevisionName(traffic)).toBe("svc-a");
  });

  it("IT-INFRA-CICD-009: throws when no traffic target is at 100 percent (ambiguous split)", () => {
    const traffic: TrafficTarget[] = [
      { revisionName: "svc-a", percent: 50 },
      { revisionName: "svc-b", percent: 50 },
    ];
    expect(() => resolveCurrentRevisionName(traffic)).toThrow(/100/);
  });

  it("IT-INFRA-CICD-010: throws when more than one traffic target is at 100 percent", () => {
    const traffic: TrafficTarget[] = [
      { revisionName: "svc-a", percent: 100 },
      { revisionName: "svc-b", percent: 100 },
    ];
    expect(() => resolveCurrentRevisionName(traffic)).toThrow(/100/);
  });
});

describe("findRevisionNameByTag", () => {
  it("IT-INFRA-CICD-011: returns the revision name carrying the given tag", () => {
    const traffic: TrafficTarget[] = [
      { revisionName: "svc-a", percent: 100 },
      { revisionName: "svc-b", percent: 0, tag: "candidate" },
    ];
    expect(findRevisionNameByTag(traffic, "candidate")).toBe("svc-b");
  });

  it("IT-INFRA-CICD-012: returns undefined when no target carries the tag", () => {
    const traffic: TrafficTarget[] = [{ revisionName: "svc-a", percent: 100 }];
    expect(findRevisionNameByTag(traffic, "candidate")).toBeUndefined();
  });
});

describe("rollback target resolution via stable/stable-previous tags", () => {
  it("IT-INFRA-CICD-013: resolves the rollback target from the stable-previous tag, ignoring untagged Ready revisions", () => {
    // svc-a was promoted (stable-previous), then svc-d was promoted (stable).
    // svc-b and svc-c are untagged failed candidates that never got promoted,
    // but are still Ready and newer than svc-a — a recency-based heuristic
    // would wrongly pick one of them.
    const traffic: TrafficTarget[] = [
      { revisionName: "svc-d", percent: 100, tag: STABLE_TAG },
      { revisionName: "svc-a", percent: 0, tag: STABLE_PREVIOUS_TAG },
    ];
    expect(findRevisionNameByTag(traffic, STABLE_PREVIOUS_TAG)).toBe("svc-a");
    expect(findRevisionNameByTag(traffic, STABLE_TAG)).toBe("svc-d");
  });

  it("IT-INFRA-CICD-014: returns undefined when only one promote has ever happened (no rollback history yet)", () => {
    const traffic: TrafficTarget[] = [{ revisionName: "svc-a", percent: 100, tag: STABLE_TAG }];
    expect(findRevisionNameByTag(traffic, STABLE_PREVIOUS_TAG)).toBeUndefined();
  });
});
