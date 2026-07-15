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
    });
    expect(rendered.spec.traffic).toEqual(traffic);
  });

  it("IT-INFRA-CICD-004: does not mutate the input template", () => {
    const template = minimalTemplate();
    const snapshot = JSON.parse(JSON.stringify(template)) as KnativeServiceManifest;
    renderCloudRunManifest({
      template,
      image: "img:tag",
      revisionName: "muvluvgg-battle-simulator-api-abc123",
      traffic: [{ revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 }],
    });
    expect(template).toEqual(snapshot);
  });
});

describe("buildCandidateTrafficTargets", () => {
  it("IT-INFRA-CICD-005: pins 100 percent to the new revision when no previous revision exists (bootstrap)", () => {
    const traffic = buildCandidateTrafficTargets({
      newRevisionName: "muvluvgg-battle-simulator-api-abc123",
      previousRevisionName: undefined,
      tag: "candidate",
    });
    expect(traffic).toEqual([
      { revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 100 },
    ]);
  });

  it("IT-INFRA-CICD-006: keeps 100 percent on the previous revision and stages the new revision at 0 percent with a tag", () => {
    const traffic = buildCandidateTrafficTargets({
      newRevisionName: "muvluvgg-battle-simulator-api-abc123",
      previousRevisionName: "muvluvgg-battle-simulator-api-prev",
      tag: "candidate",
    });
    expect(traffic).toEqual([
      { revisionName: "muvluvgg-battle-simulator-api-prev", percent: 100 },
      { revisionName: "muvluvgg-battle-simulator-api-abc123", percent: 0, tag: "candidate" },
    ]);
  });
});
