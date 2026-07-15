/**
 * Cloud Run Serviceのcurrentどのrevisionがproductionへserveされているか、
 * rollback先に安全なrevisionはどれかを`status.traffic`（Serviceのみが持つ）
 * から判定する（Revision resourceにはtraffic割当が無い）。
 */
import { STABLE_PREVIOUS_TAG, STABLE_TAG, type TrafficTarget } from "./cloud-run-manifest.js";

export { STABLE_PREVIOUS_TAG, STABLE_TAG };

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

/**
 * rollback先の自動検出は「直近のReady revision」では選ばない——Readyは
 * Cloud Runのstartup/liveness probe通過を意味するだけで、smoke test成功や
 * promote実績を保証しない。複数回連続でcandidateがsmokeに失敗すると、
 * 未promoteの失敗revisionがReadyのまま残り、`candidate` tagは常に最新の
 * 失敗revisionへ移るため、tagだけを見た除外も机上の空論になる
 * （PRレビュー指摘 #112 P1、2026-07-15 再レビュー）。
 *
 * 代わりに、promote成功時にだけ更新される永続的な2つのtagで判定する。
 * - `stable`: 現在100% trafficを受けている、最後にpromoteされたrevision。
 * - `stable-previous`: 直前にpromoteされていたrevision（1段階のrollback履歴）。
 * どちらも`findRevisionNameByTag`で取得する
 * （`scripts/cloud-run/ci-promote-traffic.sh`が`stable`→`stable-previous`への
 * rotationを行い、`scripts/cloud-run/ci-rollback-traffic.sh`が`stable-previous`
 * をrollback先として読む。tag名自体は`cloud-run-manifest.ts`が定義する
 * ——`ci-deploy-candidate.sh`が`services replace`のたびに両tagを
 * manifestへ再宣言し、消えないようにする必要があるため）。
 */
