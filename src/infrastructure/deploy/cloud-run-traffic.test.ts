/**
 * PRレビュー指摘（#112 review 2026-07-15）への対応:
 * - `status.latestReadyRevisionName`はsmokeに失敗しても未promoteのまま
 *   Readyになり得るため、「現在100% trafficを受けているrevision」の判定には
 *   使えない。`status.traffic`のpercent===100エントリだけを正とする。
 * - rollback先の自動検出は、Revision resourceにはtraffic割当が無いため
 *   Service側の`status.traffic`（現在productionのrevisionと、直近candidateの
 *   tagが指すrevision）を除外してから選ぶ。
 */
import { describe, expect, it } from "vitest";
import {
  findRevisionNameByTag,
  resolveCurrentRevisionName,
  selectRollbackTarget,
  type RevisionCandidate,
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

describe("selectRollbackTarget", () => {
  function revision(name: string, ready: boolean, creationTimestamp: string): RevisionCandidate {
    return { name, ready, creationTimestamp };
  }

  it("IT-INFRA-CICD-013: picks the most recent Ready revision that is not excluded", () => {
    const revisions = [
      revision("svc-a", true, "2026-07-10T00:00:00Z"),
      revision("svc-b", true, "2026-07-12T00:00:00Z"),
      revision("svc-c", true, "2026-07-14T00:00:00Z"),
    ];
    // svc-c is current (100%), svc-b is a failed candidate still tagged "candidate".
    expect(selectRollbackTarget(revisions, ["svc-c", "svc-b"])).toBe("svc-a");
  });

  it("IT-INFRA-CICD-014: never returns a not-Ready revision", () => {
    const revisions = [
      revision("svc-a", true, "2026-07-10T00:00:00Z"),
      revision("svc-b", false, "2026-07-14T00:00:00Z"),
    ];
    expect(selectRollbackTarget(revisions, [])).toBe("svc-a");
  });

  it("IT-INFRA-CICD-015: throws when every Ready revision is excluded", () => {
    const revisions = [revision("svc-a", true, "2026-07-10T00:00:00Z")];
    expect(() => selectRollbackTarget(revisions, ["svc-a"])).toThrow(/no safe revision/i);
  });
});
