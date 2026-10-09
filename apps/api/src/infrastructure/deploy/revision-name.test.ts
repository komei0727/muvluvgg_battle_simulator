/**
 * Cloud Runは既存と同じrevision名のdeployでは新revisionを作らず、既存
 * （起動に失敗したものを含む）のrevisionを返すだけになる。secretの`latest`は
 * instance起動時にしか読まれないため、名前が重なるとキーの更新が反映されない。
 * 再実行・手動再deployのたびに名前が変わることをここで固定する。
 */
import { describe, expect, it } from "vitest";
import { resolveRevisionName } from "./revision-name.js";

const SERVICE = "muvluvgg-battle-simulator-api";
const SHA = "87c814ce19b2cac4add3d9da148d96918c9b14af";

describe("resolveRevisionName", () => {
  it("IT-INFRA-CICD-024: names a push deploy after the 12-character commit SHA", () => {
    expect(resolveRevisionName({ service: SERVICE, commitSha: SHA, trigger: "push" })).toBe(
      `${SERVICE}-87c814ce19b2`,
    );
  });

  it("IT-INFRA-CICD-025: appends the attempt number when a run is re-run, so Cloud Run creates a new revision", () => {
    expect(
      resolveRevisionName({ service: SERVICE, commitSha: SHA, trigger: "push", runAttempt: 2 }),
    ).toBe(`${SERVICE}-87c814ce19b2-a2`);
    expect(
      resolveRevisionName({ service: SERVICE, commitSha: SHA, trigger: "push", runAttempt: 1 }),
    ).toBe(`${SERVICE}-87c814ce19b2`);
  });

  it("IT-INFRA-CICD-026: names a manual redeploy with its run number, so it never collides with the push deploy of the same commit", () => {
    expect(
      resolveRevisionName({ service: SERVICE, commitSha: SHA, trigger: "redeploy", runNumber: 3 }),
    ).toBe(`${SERVICE}-87c814ce19b2-r3`);
    expect(
      resolveRevisionName({
        service: SERVICE,
        commitSha: SHA,
        trigger: "redeploy",
        runNumber: 3,
        runAttempt: 2,
      }),
    ).toBe(`${SERVICE}-87c814ce19b2-r3-a2`);
  });

  it("IT-INFRA-CICD-027: rejects a redeploy without a run number instead of reusing the push revision name", () => {
    expect(() =>
      resolveRevisionName({ service: SERVICE, commitSha: SHA, trigger: "redeploy" }),
    ).toThrow(/run number/);
  });

  it("IT-INFRA-CICD-028: prefers an explicit suffix over the derived one", () => {
    expect(
      resolveRevisionName({
        service: SERVICE,
        commitSha: SHA,
        trigger: "redeploy",
        runNumber: 3,
        suffixOverride: "manual-1",
      }),
    ).toBe(`${SERVICE}-manual-1`);
  });

  it("IT-INFRA-CICD-029: rejects names Cloud Run would refuse (over 63 characters or invalid characters)", () => {
    expect(() =>
      resolveRevisionName({
        service: SERVICE,
        commitSha: SHA,
        trigger: "push",
        suffixOverride: "x".repeat(40),
      }),
    ).toThrow(/63/);
    expect(() =>
      resolveRevisionName({
        service: SERVICE,
        commitSha: SHA,
        trigger: "push",
        suffixOverride: "Bad_Name",
      }),
    ).toThrow(/revision name/);
    expect(() =>
      resolveRevisionName({ service: SERVICE, commitSha: "not-a-sha", trigger: "push" }),
    ).toThrow(/commit SHA/);
  });

  it("IT-INFRA-CICD-030: keeps the longest derived name within the 63-character limit", () => {
    const name = resolveRevisionName({
      service: SERVICE,
      commitSha: SHA,
      trigger: "redeploy",
      runNumber: 99999,
      runAttempt: 99,
    });
    expect(name.length).toBeLessThanOrEqual(63);
  });
});
