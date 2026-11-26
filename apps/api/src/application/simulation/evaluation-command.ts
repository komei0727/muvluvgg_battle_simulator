import { ApplicationError, type Violation } from "../contracts/application-error.js";
import type { EvaluationCasePlan } from "./evaluation-runner.js";
import type { FormationInput } from "./simulate-battle-command.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

/** 1リクエストが要求できる大量試行の量。形式ごとに設定（環境変数）から渡る。 */
export interface EvaluationRequestLimits {
  readonly maxCases: number;
  /** `sum(cases[i].runIndices.length)`の上限。 */
  readonly maxTotalRuns: number;
}

/** 大量試行Commandのうち、戦闘形式に依存しない部分。 */
export interface EvaluationRequestShape {
  readonly seed: string;
  readonly cases: readonly EvaluationCasePlan[];
  readonly expectedCatalogRevision?: string;
  readonly expectedEngineRevision?: string;
}

/** `SeededRandomSourceProvider.forRun`が受け付ける範囲と同じ（符号なし32bit整数）。 */
const MAX_RUN_INDEX = 0xffffffff;

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * 単発ユースケースのCommand検証が返す違反を、それを生んだケースの下へ置く。
 * 違反のパスから`cases[i]`と陣営・編成・枠を特定できるようにするためである。
 */
export function prefixViolationPaths(
  violations: readonly Violation[],
  prefix: string,
): Violation[] {
  return violations.map((violation) => ({
    ...violation,
    path: violation.path === undefined ? prefix : `${prefix}.${violation.path}`,
  }));
}

function validateRunIndices(
  runIndices: readonly number[],
  path: string,
  violations: Violation[],
): void {
  if (runIndices.length < 1) {
    violations.push({ path, reason: "must contain at least 1 run index" });
    return;
  }
  const firstIndexOf = new Map<number, number>();
  runIndices.forEach((runIndex, position) => {
    if (!Number.isInteger(runIndex) || runIndex < 0 || runIndex > MAX_RUN_INDEX) {
      violations.push({
        path: `${path}[${position}]`,
        reason: `must be an integer between 0 and ${MAX_RUN_INDEX}, got ${runIndex}`,
      });
      return;
    }
    const first = firstIndexOf.get(runIndex);
    if (first !== undefined) {
      // 同じ番号は同じ乱数列になるため、重複は同じ試行を2回数えるだけになる。
      violations.push({
        path: `${path}[${position}]`,
        reason: `duplicates runIndices[${first}]: ${runIndex}`,
      });
      return;
    }
    firstIndexOf.set(runIndex, position);
  });
}

/**
 * 大量試行APIに共通するCommand検証。seed・ケース・試行番号・要求量の上限だけを扱い、
 * 編成の検証は形式別のCommand検証が単発ユースケースと同じ規則で行う。違反はすべて
 * 集めて返し、Catalogへは触れない。
 */
export function validateEvaluationRequestShape(
  command: EvaluationRequestShape,
  limits: EvaluationRequestLimits,
): Violation[] {
  const violations: Violation[] = [];

  if (isBlank(command.seed)) {
    violations.push({ path: "seed", reason: "must not be blank" });
  }
  if (command.expectedCatalogRevision !== undefined && isBlank(command.expectedCatalogRevision)) {
    violations.push({ path: "expectedCatalogRevision", reason: "must not be blank" });
  }
  if (command.expectedEngineRevision !== undefined && isBlank(command.expectedEngineRevision)) {
    violations.push({ path: "expectedEngineRevision", reason: "must not be blank" });
  }

  if (command.cases.length < 1) {
    violations.push({ path: "cases", reason: "must contain at least 1 case" });
  } else if (command.cases.length > limits.maxCases) {
    violations.push({
      path: "cases",
      reason: `must not contain more than ${limits.maxCases} cases, got ${command.cases.length}`,
    });
  }

  const firstCaseIndexOf = new Map<string, number>();
  command.cases.forEach((plan, caseIndex) => {
    const casePath = `cases[${caseIndex}]`;
    if (isBlank(plan.caseId)) {
      violations.push({ path: `${casePath}.caseId`, reason: "must not be blank" });
    } else {
      const first = firstCaseIndexOf.get(plan.caseId);
      if (first !== undefined) {
        // 結果はcaseIdで対応づけるため、重複すると応答からケースを特定できない。
        violations.push({
          path: `${casePath}.caseId`,
          reason: `duplicates the caseId of cases[${first}]: "${plan.caseId}"`,
        });
      } else {
        firstCaseIndexOf.set(plan.caseId, caseIndex);
      }
    }
    validateRunIndices(plan.runIndices, `${casePath}.runIndices`, violations);
  });

  const totalRuns = command.cases.reduce((total, plan) => total + plan.runIndices.length, 0);
  if (totalRuns > limits.maxTotalRuns) {
    violations.push({
      path: "cases",
      reason: `the summed runIndices of all cases must not exceed ${limits.maxTotalRuns} runs, got ${totalRuns}`,
    });
  }

  return violations;
}

/** 全ケースの編成が参照する定義ID。Catalogスナップショットは1回だけ取得する。 */
export function collectFormationReferences(formations: readonly FormationInput[]): {
  unitDefinitionIds: UnitDefinitionId[];
  memoryDefinitionIds: MemoryDefinitionId[];
} {
  const unitDefinitionIds = new Set<UnitDefinitionId>();
  const memoryDefinitionIds = new Set<MemoryDefinitionId>();
  for (const formation of formations) {
    formation.slots.forEach((slot) => unitDefinitionIds.add(slot.unitDefinitionId));
    formation.memoryDefinitionIds.forEach((id) => memoryDefinitionIds.add(id));
  }
  return {
    unitDefinitionIds: [...unitDefinitionIds],
    memoryDefinitionIds: [...memoryDefinitionIds],
  };
}

/**
 * 単発ユースケースと同じ参照検証（preflight）を全ケースへ実行前にまとめて行う。1ケース
 * でも違反があれば1試行も実行しない — 後方のケースの誤りのために先行ケースを実行してから
 * 失敗すると、実行時間を捨てたうえにどのケースが悪いのか応答から読み取れない。
 */
export function runCasesPreflight<C>(cases: readonly C[], preflight: (caseInput: C) => void): void {
  const notFound: Violation[] = [];
  const invalid: Violation[] = [];

  cases.forEach((caseInput, caseIndex) => {
    try {
      preflight(caseInput);
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        (error.code !== "DEFINITION_NOT_FOUND" && error.code !== "INVALID_COMMAND")
      ) {
        throw error;
      }
      const violations = prefixViolationPaths(error.violations, `cases[${caseIndex}]`);
      (error.code === "DEFINITION_NOT_FOUND" ? notFound : invalid).push(...violations);
    }
  });

  if (notFound.length > 0) {
    // 単発の`runPreflight`と同じ優先順位: 未解決の参照を先に返す。解決済み定義を前提に
    // する検査（levelGrowth・カテゴリ）の結果を、存在しない定義に対して返さない。
    throw new ApplicationError("DEFINITION_NOT_FOUND", notFound);
  }
  if (invalid.length > 0) {
    throw new ApplicationError("INVALID_COMMAND", invalid);
  }
}
