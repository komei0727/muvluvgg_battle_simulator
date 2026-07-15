/**
 * Cloud Run Serviceのcurrentどのrevisionがproductionへserveされているか、
 * rollback先に安全なrevisionはどれかを`status.traffic`（Serviceのみが持つ）
 * から判定する（Revision resourceにはtraffic割当が無い）。
 */
import type { TrafficTarget } from "./cloud-run-manifest.js";

/**
 * `status.traffic`のうち、percentが厳密に100のrevisionだけを「現在の
 * production revision」とみなす。traffic未設定（bootstrap、serviceが
 * 存在しない）はundefinedを返す。100%が0件・複数件（split traffic等の
 * 想定外の状態）は誤った判定を返すより例外にする。
 */
export function resolveCurrentRevisionName(traffic: readonly TrafficTarget[]): string | undefined {
  if (traffic.length === 0) {
    return undefined;
  }
  const fullTraffic = traffic.filter((target) => target.percent === 100);
  if (fullTraffic.length !== 1) {
    throw new Error(
      `Cannot resolve the current production revision: expected exactly one traffic target at 100%, found ${fullTraffic.length} (traffic=${JSON.stringify(traffic)})`,
    );
  }
  const revisionName = fullTraffic[0]?.revisionName;
  if (revisionName === undefined) {
    throw new Error(
      `Traffic target at 100% has no revisionName (traffic=${JSON.stringify(traffic)})`,
    );
  }
  return revisionName;
}

export function findRevisionNameByTag(
  traffic: readonly TrafficTarget[],
  tag: string,
): string | undefined {
  return traffic.find((target) => target.tag === tag)?.revisionName;
}

export interface RevisionCandidate {
  readonly name: string;
  readonly ready: boolean;
  readonly creationTimestamp: string;
}

/**
 * `exclude`（現在のproduction revision・直近candidateのtagが指すrevisionなど）
 * を除いた、最も新しいReady revisionをrollback先として選ぶ。Ready==trueは
 * Cloud Runのstartup/liveness probe通過を意味するだけでsmoke test成功を
 * 保証しないため、直近の失敗candidateは呼び出し側が`exclude`へ渡すこと。
 */
export function selectRollbackTarget(
  revisions: readonly RevisionCandidate[],
  exclude: readonly (string | undefined)[],
): string {
  const excludeSet = new Set(exclude.filter((name): name is string => name !== undefined));
  const candidates = revisions
    .filter((revision) => revision.ready && !excludeSet.has(revision.name))
    .toSorted(
      (a, b) => new Date(b.creationTimestamp).getTime() - new Date(a.creationTimestamp).getTime(),
    );
  const target = candidates[0];
  if (target === undefined) {
    throw new Error("No safe revision found to roll back to (all Ready revisions are excluded)");
  }
  return target.name;
}
