import { resolveRevisionName, type DeployTrigger } from "./revision-name.js";

/**
 * `scripts/cloud-run/ci-deploy-candidate.sh`から呼ばれ、新revisionの名前をstdoutへ書く。
 *
 * - `SERVICE`・`COMMIT_SHA`（必須）
 * - `DEPLOY_TRIGGER`（`push` | `redeploy`、既定は`push`）
 * - `GITHUB_RUN_NUMBER`・`GITHUB_RUN_ATTEMPT`（GitHub Actionsが設定する）
 * - `REVISION_SUFFIX`（任意。指定されたらsuffixをこの値にする）
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseTrigger(value: string | undefined): DeployTrigger {
  if (value === undefined || value === "" || value === "push") {
    return "push";
  }
  if (value === "redeploy") {
    return "redeploy";
  }
  throw new Error(`DEPLOY_TRIGGER must be "push" or "redeploy": ${JSON.stringify(value)}`);
}

const runNumber = optionalInteger("GITHUB_RUN_NUMBER");
const runAttempt = optionalInteger("GITHUB_RUN_ATTEMPT");
const suffixOverride = process.env["REVISION_SUFFIX"];

process.stdout.write(
  resolveRevisionName({
    service: requireEnv("SERVICE"),
    commitSha: requireEnv("COMMIT_SHA"),
    trigger: parseTrigger(process.env["DEPLOY_TRIGGER"]),
    ...(runNumber !== undefined ? { runNumber } : {}),
    ...(runAttempt !== undefined ? { runAttempt } : {}),
    ...(suffixOverride !== undefined ? { suffixOverride } : {}),
  }),
);
