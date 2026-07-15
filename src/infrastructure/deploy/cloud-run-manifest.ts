/**
 * `gcloud run services replace`が読むKnative Service manifestへ、CIが決定した
 * imageとdeterministicなrevision nameを差し込み、`spec.traffic`を宣言する。
 *
 * `gcloud run services replace`は`--no-traffic`フラグを持たないため、
 * 新revisionをtraffic 0%・tag付きで作成するには、manifest自体の`spec.traffic`で
 * 既存revisionへ100%を明示的に固定する（#106 `M45-INFRA-002`）。
 */

export interface TrafficTarget {
  revisionName?: string;
  percent: number;
  tag?: string;
  latestRevision?: boolean;
}

export interface KnativeContainer {
  image: string;
  [key: string]: unknown;
}

export interface KnativeServiceManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; annotations: Record<string, string> };
  spec: {
    template: {
      metadata: { name?: string; annotations: Record<string, string> };
      spec: {
        containerConcurrency: number;
        timeoutSeconds: number;
        containers: KnativeContainer[];
      };
    };
    traffic?: TrafficTarget[];
  };
}

export interface RenderCloudRunManifestOptions {
  template: KnativeServiceManifest;
  image: string;
  revisionName: string;
  traffic: TrafficTarget[];
}

export function renderCloudRunManifest(
  options: RenderCloudRunManifestOptions,
): KnativeServiceManifest {
  const rendered = structuredClone(options.template);
  const container = rendered.spec.template.spec.containers[0];
  if (container === undefined) {
    throw new Error("Cloud Run manifest template must declare at least one container");
  }
  container.image = options.image;
  rendered.spec.template.metadata.name = options.revisionName;
  rendered.spec.traffic = options.traffic;
  return rendered;
}

export interface BuildCandidateTrafficTargetsOptions {
  newRevisionName: string;
  previousRevisionName: string | undefined;
  tag: string;
}

/**
 * previousRevisionNameが無い（=初回deploy）場合は新revisionへ即100%を割り当てる。
 * それ以外は既存revisionへ100%を固定したまま、新revisionをtag付き0%で追加する。
 */
export function buildCandidateTrafficTargets(
  options: BuildCandidateTrafficTargetsOptions,
): TrafficTarget[] {
  if (options.previousRevisionName === undefined) {
    return [{ revisionName: options.newRevisionName, percent: 100 }];
  }
  return [
    { revisionName: options.previousRevisionName, percent: 100 },
    { revisionName: options.newRevisionName, percent: 0, tag: options.tag },
  ];
}
