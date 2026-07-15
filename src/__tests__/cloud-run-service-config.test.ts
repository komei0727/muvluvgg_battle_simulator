/**
 * `11_インフラストラクチャ設計.md`「M4.5 Cloud Run初期設定」の値が
 * `deploy/cloud-run/service.json`（`gcloud run services replace`が読む
 * Knative Service manifest）へ正しく反映されていることを検証する
 * （#105受け入れ条件「Cloud Run service設定が上記初期値と一致する」）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface EnvVar {
  readonly name: string;
  readonly value: string;
}

interface HttpProbe {
  readonly httpGet: { readonly path: string; readonly port: number };
  readonly periodSeconds: number;
  readonly timeoutSeconds: number;
  readonly failureThreshold: number;
}

interface CloudRunServiceManifest {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly annotations: Record<string, string>;
  };
  readonly spec: {
    readonly template: {
      readonly metadata: {
        readonly annotations: Record<string, string>;
      };
      readonly spec: {
        readonly containerConcurrency: number;
        readonly timeoutSeconds: number;
        readonly containers: ReadonlyArray<{
          readonly image: string;
          readonly ports: ReadonlyArray<{ readonly containerPort: number }>;
          readonly resources: {
            readonly limits: { readonly cpu: string; readonly memory: string };
          };
          readonly env: readonly EnvVar[];
          readonly startupProbe: HttpProbe;
          readonly livenessProbe: HttpProbe;
          readonly readinessProbe: HttpProbe;
        }>;
      };
    };
  };
}

function loadManifest(): CloudRunServiceManifest {
  const url = new URL("../../deploy/cloud-run/service.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as CloudRunServiceManifest;
}

function envValue(manifest: CloudRunServiceManifest, name: string): string | undefined {
  return manifest.spec.template.spec.containers[0]?.env.find((entry) => entry.name === name)?.value;
}

describe("Cloud Run service manifest", () => {
  it("IT-INFRA-CLOUDRUN-001: is a valid Knative Service manifest", () => {
    const manifest = loadManifest();
    expect(manifest.apiVersion).toBe("serving.knative.dev/v1");
    expect(manifest.kind).toBe("Service");
  });

  it("IT-INFRA-CLOUDRUN-002: declares the M4.5 service name and public ingress", () => {
    const manifest = loadManifest();
    expect(manifest.metadata.name).toBe("muvluvgg-battle-simulator-api");
    expect(manifest.metadata.annotations["run.googleapis.com/ingress"]).toBe("all");
  });

  it("IT-INFRA-CLOUDRUN-003: declares minimum 0 and maximum 1 instances", () => {
    const manifest = loadManifest();
    const annotations = manifest.spec.template.metadata.annotations;
    expect(annotations["autoscaling.knative.dev/minScale"]).toBe("0");
    expect(annotations["autoscaling.knative.dev/maxScale"]).toBe("1");
  });

  it("IT-INFRA-CLOUDRUN-004: declares request-based billing (CPU throttling enabled)", () => {
    const manifest = loadManifest();
    expect(manifest.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"]).toBe(
      "true",
    );
  });

  it("IT-INFRA-CLOUDRUN-005: declares container concurrency 2 and a 40 second request timeout", () => {
    const manifest = loadManifest();
    expect(manifest.spec.template.spec.containerConcurrency).toBe(2);
    expect(manifest.spec.template.spec.timeoutSeconds).toBe(40);
  });

  it("IT-INFRA-CLOUDRUN-006: declares 1 vCPU and 1 GiB memory limits", () => {
    const manifest = loadManifest();
    const container = manifest.spec.template.spec.containers[0];
    expect(container?.resources.limits.cpu).toBe("1");
    expect(container?.resources.limits.memory).toBe("1Gi");
  });

  it("IT-INFRA-CLOUDRUN-007: sets WORKER_MAX_QUEUE=1 and SHUTDOWN_GRACE_MS=8000", () => {
    const manifest = loadManifest();
    expect(envValue(manifest, "WORKER_MAX_QUEUE")).toBe("1");
    expect(envValue(manifest, "SHUTDOWN_GRACE_MS")).toBe("8000");
  });

  it("IT-INFRA-CLOUDRUN-008: allows only the GitHub Pages origin for CORS", () => {
    const manifest = loadManifest();
    expect(envValue(manifest, "CORS_ALLOWED_ORIGINS")).toBe("https://komei0727.github.io");
  });

  it("IT-INFRA-CLOUDRUN-009: keeps SIMULATION_TIMEOUT_MS below the Cloud Run request timeout", () => {
    const manifest = loadManifest();
    const simulationTimeoutMs = Number(envValue(manifest, "SIMULATION_TIMEOUT_MS"));
    const requestTimeoutMs = manifest.spec.template.spec.timeoutSeconds * 1000;
    expect(simulationTimeoutMs).toBeGreaterThan(0);
    expect(simulationTimeoutMs).toBeLessThan(requestTimeoutMs);
  });

  it("IT-INFRA-CLOUDRUN-010: runs production mode so Swagger UI stays disabled", () => {
    const manifest = loadManifest();
    expect(envValue(manifest, "NODE_ENV")).toBe("production");
  });

  it("IT-INFRA-CLOUDRUN-011: gates traffic behind a startupProbe on /health/live so Catalog/Worker warm-up must finish first", () => {
    const manifest = loadManifest();
    const probe = manifest.spec.template.spec.containers[0]?.startupProbe;
    expect(probe?.httpGet.path).toBe("/health/live");
    expect(probe?.httpGet.port).toBe(8080);
    expect(probe?.periodSeconds).toBeGreaterThan(0);
    expect(probe?.timeoutSeconds).toBeGreaterThan(0);
    expect(probe?.failureThreshold).toBeGreaterThan(0);
  });

  it("IT-INFRA-CLOUDRUN-012: restarts only on liveness failure (/health/live), never on transient readiness/pool saturation", () => {
    const manifest = loadManifest();
    const probe = manifest.spec.template.spec.containers[0]?.livenessProbe;
    expect(probe?.httpGet.path).toBe("/health/live");
    expect(probe?.httpGet.port).toBe(8080);
    expect(probe?.periodSeconds).toBeGreaterThan(0);
    expect(probe?.timeoutSeconds).toBeGreaterThan(0);
    expect(probe?.failureThreshold).toBeGreaterThan(0);
  });

  it("IT-INFRA-CLOUDRUN-013: probes target the same port the container listens on", () => {
    const manifest = loadManifest();
    const container = manifest.spec.template.spec.containers[0];
    const containerPort = container?.ports[0]?.containerPort;
    expect(container?.startupProbe.httpGet.port).toBe(containerPort);
    expect(container?.livenessProbe.httpGet.port).toBe(containerPort);
    expect(container?.readinessProbe.httpGet.port).toBe(containerPort);
  });

  it("IT-INFRA-CLOUDRUN-014: stops routing new traffic (without restarting) on /health/ready failure — shutdown, Catalog/Worker mismatch, or a degraded pool", () => {
    const manifest = loadManifest();
    const probe = manifest.spec.template.spec.containers[0]?.readinessProbe;
    expect(probe?.httpGet.path).toBe("/health/ready");
    expect(probe?.httpGet.port).toBe(8080);
    expect(probe?.periodSeconds).toBeGreaterThan(0);
    expect(probe?.timeoutSeconds).toBeGreaterThan(0);
    expect(probe?.failureThreshold).toBeGreaterThan(0);
  });
});
