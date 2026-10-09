/**
 * Cloud Run revision名の決め方。
 *
 * 既存と同じ名前でdeployすると、Cloud Runは新revisionを作らず既存（起動に失敗
 * したものを含む）のrevisionを返すだけになる。環境変数へ注入したsecretの
 * `latest`はinstance起動時にしか読まれないため、名前が重なるとキーの更新が
 * 反映されない。また最後に作られたrevisionは削除できないので、名前を変える
 * 以外に復旧手段がない。そのため再実行（`-a<回数>`）と手動再deploy
 * （`-r<実行番号>`）では必ず別の名前にする。
 */
export type DeployTrigger = "push" | "redeploy";

export interface RevisionNameInput {
  readonly service: string;
  readonly commitSha: string;
  readonly trigger: DeployTrigger;
  /** `GITHUB_RUN_NUMBER`。手動再deployでは必須。 */
  readonly runNumber?: number;
  /** `GITHUB_RUN_ATTEMPT`。2以上なら再実行。 */
  readonly runAttempt?: number;
  /** 指定されたらsuffixをこの値にする（手動検証用）。 */
  readonly suffixOverride?: string;
}

// Cloud Runのrevision名はDNS label: 小文字英数字と`-`、先頭は英字、末尾は英数字、63文字以内。
const MAX_REVISION_NAME_LENGTH = 63;
const REVISION_NAME_PATTERN = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{12,}$/;
const SHORT_SHA_LENGTH = 12;

function deriveSuffix(input: RevisionNameInput): string {
  if (!COMMIT_SHA_PATTERN.test(input.commitSha)) {
    throw new Error(`Invalid commit SHA: ${JSON.stringify(input.commitSha)}`);
  }
  let suffix = input.commitSha.slice(0, SHORT_SHA_LENGTH);
  if (input.trigger === "redeploy") {
    if (
      input.runNumber === undefined ||
      !Number.isInteger(input.runNumber) ||
      input.runNumber < 1
    ) {
      throw new Error("A redeploy requires a positive run number (GITHUB_RUN_NUMBER)");
    }
    suffix = `${suffix}-r${input.runNumber}`;
  }
  if (input.runAttempt !== undefined && input.runAttempt > 1) {
    suffix = `${suffix}-a${input.runAttempt}`;
  }
  return suffix;
}

export function resolveRevisionName(input: RevisionNameInput): string {
  const suffix =
    input.suffixOverride !== undefined && input.suffixOverride !== ""
      ? input.suffixOverride
      : deriveSuffix(input);
  const name = `${input.service}-${suffix}`;
  if (name.length > MAX_REVISION_NAME_LENGTH) {
    throw new Error(
      `Revision name ${JSON.stringify(name)} exceeds ${MAX_REVISION_NAME_LENGTH} characters`,
    );
  }
  if (!REVISION_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid revision name ${JSON.stringify(name)}`);
  }
  return name;
}
