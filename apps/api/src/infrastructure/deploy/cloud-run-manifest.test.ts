/**
 * CI deploy (#106, `M45-INFRA-002`)がCloud Run Knative Service manifestへ
 * imageとdeterministicなrevision nameを差し込み、`spec.traffic`を宣言することで
 * 新revisionを0%traffic・tag付きで作成できることを検証する
 * （`gcloud run services replace`は本体は`services/replace`ヘルプに`--no-traffic`
 * を持たないため、manifestの`spec.traffic`で新revisionへ0%を宣言する）。
 */
import { describe, expect, it } from "vitest";
import {
  buildCandidateTrafficTargets,
  renderCloudRunManifest,
  type KnativeServiceManifest,
} from "./cloud-run-manifest.js";

function minimalTemplate(): KnativeServiceManifest {
  return {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: { name: "muvluvgg-battle-simulator-api", annotations: {} },
    spec: {
      template: {
        metadata: { annotations: {} },
        spec: {
          containerConcurrency: 2,
          timeoutSeconds: 40,
          containers: [{ image: "placeholder:latest" }],
        },
      },
    },
  };
}

describe("renderCloudRunManifest", () => {
  it("IT-INFRA-CICD-001: sets the container image to the given image reference", () => {
    const rendered = renderCloudRunManifest({
      template: minimalTemplate(),
      image: "asia-northeast1-docker.pkg.dev/p/r/api:abc123",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic: [{ revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 }],
      serviceAccountName: "runtime@p.iam.gserviceaccount.com",
    });
    expect(rendered.spec.template.spec.containers[0]?.image).toBe(
      "asia-northeast1-docker.pkg.dev/p/r/api:abc123",
    );
  });

  it("IT-INFRA-CICD-002: sets a deterministic revision name on the template", () => {
    const rendered = renderCloudRunManifest({
      template: minimalTemplate(),
      image: "img:tag",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic: [{ revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 }],
      serviceAccountName: "runtime@p.iam.gserviceaccount.com",
    });
    expect(rendered.spec.template.metadata.name).toBe("muvluvgg-battle-simulator-api-abc123");
  });

  it("IT-INFRA-CICD-003: declares spec.traffic exactly as given", () => {
    const traffic = [
      { revisionName: "muvluvgg-battle-simulator-api-prev", percent: 100 },
      { revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 0, tag: "candidate" },
    ];
    const rendered = renderCloudRunManifest({
      template: minimalTemplate(),
      image: "img:tag",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic,
      serviceAccountName: "runtime@p.iam.gserviceaccount.com",
    });
    expect(rendered.spec.traffic).toEqual(traffic);
  });

  it("IT-INFRA-CICD-022: sets a dedicated runtime service account, never leaving it unset for the project default Compute Engine SA (P1 security review)", () => {
    const rendered = renderCloudRunManifest({
      template: minimalTemplate(),
      image: "img:tag",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic: [{ revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 }],
      serviceAccountName: "battle-sim-api-runtime@p.iam.gserviceaccount.com",
    });
    expect(rendered.spec.template.spec.serviceAccountName).toBe(
      "battle-sim-api-runtime@p.iam.gserviceaccount.com",
    );
  });

  it("IT-INFRA-CICD-004: does not mutate the input template", () => {
    const template = minimalTemplate();
    const snapshot = JSON.parse(JSON.stringify(template)) as KnativeServiceManifest;
    renderCloudRunManifest({
      template,
      image: "img:tag",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic: [{ revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 }],
      serviceAccountName: "runtime@p.iam.gserviceaccount.com",
    });
    expect(template).toEqual(snapshot);
  });
});

describe("buildCandidateTrafficTargets", () => {
  it("IT-INFRA-CICD-005: rejects bootstrap (no known previous revision) rather than granting the new revision 100% traffic immediately", () => {
    // PRレビュー指摘 #112（2026-07-15、5回目）: CIは初回Cloud Run deployを
    // 行わない——最初のrevisionはscripts/cloud-run/03-deploy-service.shの
    // 一度限りの手動セットアップで事前に作成されている前提。`describe`の
    // 一時的失敗やservice未作成をbootstrapとして扱い、未smoke-testの
    // 新revisionへ即100% trafficを流すことは、Issue #106の安全条件
    // 「smoke test成功後にのみtrafficを確定する」に反するため、fail closedで
    // 拒否する。
    expect(() =>
      buildCandidateTrafficTargets({
        newRevisionName: "muvluvgg-battle-simulator-api-abc123",
        previousRevisionName: undefined,
        stablePreviousRevisionName: undefined,
        tag: "candidate",
      }),
    ).toThrow(/current production revision/i);
  });

  it("IT-INFRA-CICD-006: keeps 100 percent on the previous revision (tagged stable) and stages the new revision at 0 percent with a tag", () => {
    const traffic = buildCandidateTrafficTargets({
      newRevisionName: "muvluvgg-battle-simulator-api-abc123",
      previousRevisionName: "muvluvgg-battle-simulator-api-prev",
      stablePreviousRevisionName: undefined,
      tag: "candidate",
    });
    expect(traffic).toEqual([
      { revisionName: "muvluvgg-battle-simulator-api-prev", percent: 100, tag: "stable" },
      { revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 0, tag: "candidate" },
    ]);
  });

  it("IT-INFRA-CICD-020: re-declares the stable-previous tag on its own revision so `services replace` does not drop it", () => {
    // `gcloud run services replace`はmanifestのspec.traffic全体を新しいdesired
    // stateとして適用するため、既存のstable-previous tagをmanifestへ含めないと
    // deploy attempt（成功・失敗いずれでも）ごとに消えてしまう（PRレビュー指摘
    // #112 P1、2026-07-15再レビューを踏まえた防御的実装）。
    const traffic = buildCandidateTrafficTargets({
      newRevisionName: "muvluvgg-battle-simulator-api-c",
      previousRevisionName: "muvluvgg-battle-simulator-api-current",
      stablePreviousRevisionName: "muvluvgg-battle-simulator-api-older",
      tag: "candidate",
    });
    expect(traffic).toEqual([
      { revisionName: "muvluvgg-battle-simulator-api-current", percent: 100, tag: "stable" },
      { revisionName: "muvluvgg-battle-simulator-api-older", percent: 0, tag: "stable-previous" },
      { revisionName: "muvluvgg-battle-simulator-api-c", percent: 0, tag: "candidate" },
    ]);
  });

  it("IT-INFRA-CICD-021: omits the stable-previous entry when it is the same revision as previousRevisionName", () => {
    const traffic = buildCandidateTrafficTargets({
      newRevisionName: "muvluvgg-battle-simulator-api-c",
      previousRevisionName: "muvluvgg-battle-simulator-api-current",
      stablePreviousRevisionName: "muvluvgg-battle-simulator-api-current",
      tag: "candidate",
    });
    expect(traffic).toEqual([
      { revisionName: "muvluvgg-battle-simulator-api-current", percent: 100, tag: "stable" },
      { revisionName: "muvluvgg-battle-simulator-api-c", percent: 0, tag: "candidate" },
    ]);
  });
});
