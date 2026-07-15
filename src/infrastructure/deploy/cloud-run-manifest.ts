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

/** promote成功時にだけ更新される、rollback先を永続的に識別するためのtag名。 */
export const STABLE_TAG = "stable";
export const STABLE_PREVIOUS_TAG = "stable-previous";

export interface BuildCandidateTrafficTargetsOptions {
  newRevisionName: string;
  previousRevisionName: string | undefined;
  /** 現在Serviceの`stable-previous` tagが指すrevision（無ければundefined）。 */
  stablePreviousRevisionName: string | undefined;
  tag: string;
}

/**
 * previousRevisionNameが無い（=初回deploy）場合は新revisionへ即100%を割り当てる。
 * それ以外は既存revisionへ100%を固定したまま、新revisionをtag付き0%で追加する。
 *
 * `previousRevisionName`には常に`STABLE_TAG`を、`stablePreviousRevisionName`
 * （既存revisionと異なる場合のみ）には常に`STABLE_PREVIOUS_TAG`を明示的に
 * 再宣言する。`gcloud run services replace`は`spec.traffic`をそのdeployの
 * 新しいdesired stateとして丸ごと適用するため、ここで明示しないtagはdeploy
 * attempt（成功・失敗いずれでも）ごとに失われ得る（PRレビュー指摘 #112 P1、
 * 2026-07-15再レビュー）。rotation自体（stable→stable-previousへ進める処理）は
 * `scripts/cloud-run/ci-promote-traffic.sh`がpromote成功時にだけ行う。
 */
export function buildCandidateTrafficTargets(
  options: BuildCandidateTrafficTargetsOptions,
): TrafficTarget[] {
  if (options.previousRevisionName === undefined) {
    return [{ revisionName: options.newRevisionName, percent: 100 }];
  }
  const targets: TrafficTarget[] = [
    { revisionName: options.previousRevisionName, percent: 100, tag: STABLE_TAG },
  ];
  if (
    options.stablePreviousRevisionName !== undefined &&
    options.stablePreviousRevisionName !== options.previousRevisionName
  ) {
    targets.push({
      revisionName: options.stablePreviousRevisionName,
      percent: 0,
      tag: STABLE_PREVIOUS_TAG,
    });
  }
  targets.push({ revisionName: options.newRevisionName, percent: 0, tag: options.tag });
  return targets;
}
