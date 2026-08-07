import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UNCOVERED_MEMORY_IDS, UNCOVERED_UNIT_IDS } from "./production-id-coverage.js";

const catalogDir = fileURLToPath(new URL("../../../catalog", import.meta.url));
const unitsTestDir = fileURLToPath(
  new URL("../../__tests__/production-catalog/units", import.meta.url),
);
const memoriesTestDir = fileURLToPath(
  new URL("../../__tests__/production-catalog/memories", import.meta.url),
);

interface CatalogEntry {
  readonly [key: string]: unknown;
}

function readCatalogArray(fileName: string): readonly CatalogEntry[] {
  return JSON.parse(readFileSync(`${catalogDir}/${fileName}`, "utf8")) as CatalogEntry[];
}

/**
 * JSONツリーから `effectActionDefinitionId` 参照を再帰収集する。skill定義の
 * `resolution`／`chargeRelease` はstep種別（BRANCH/RANDOM_BRANCH/REPEAT）ごとに
 * ネスト形状が異なるため、形状を列挙せずキー名だけで拾う（形状の追加に追随できる）。
 */
function collectEffectActionReferences(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectEffectActionReferences(item, into);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "effectActionDefinitionId" && typeof value === "string") {
      into.add(value);
      continue;
    }
    collectEffectActionReferences(value, into);
  }
}

/**
 * 起点集合から、EffectAction payloadが参照する別のEffectActionまで閉包を取る。
 * production Catalogには payload 経由の EffectAction間参照が実在するため
 * （例: 付与した効果が別のEffectActionを起動する定義）、skill直下の参照だけでは
 * 「そのUnitが発揮しうる全効果」に届かない。
 */
function effectActionClosure(
  seeds: ReadonlySet<string>,
  effectPayloadsById: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  const closure = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) {
      break;
    }
    const payload = effectPayloadsById.get(id);
    const referenced = new Set<string>();
    collectEffectActionReferences(payload, referenced);
    for (const next of referenced) {
      if (!closure.has(next)) {
        closure.add(next);
        queue.push(next);
      }
    }
  }
  return closure;
}

interface CoverageTarget {
  readonly definitionId: string;
  /** 対応するユニット単位テストファイルが文字列として含むべき全ID。 */
  readonly requiredIds: readonly string[];
  readonly testFilePath: string;
}

function stringOf(entry: CatalogEntry, key: string): string {
  const value = entry[key];
  if (typeof value !== "string") {
    throw new Error(`catalog entry is missing string field "${key}"`);
  }
  return value;
}

function stringsOf(entry: CatalogEntry, key: string): readonly string[] {
  const value = entry[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`catalog entry is missing string-array field "${key}"`);
  }
  return value as string[];
}

const effectPayloadsById: ReadonlyMap<string, unknown> = new Map(
  readCatalogArray("effects.json").map((effect) => [
    stringOf(effect, "effectActionDefinitionId"),
    effect["payload"],
  ]),
);

const skillsById: ReadonlyMap<string, CatalogEntry> = new Map(
  readCatalogArray("skills.json").map((skill) => [stringOf(skill, "skillDefinitionId"), skill]),
);

function unitCoverageTargets(): readonly CoverageTarget[] {
  return readCatalogArray("units.json").map((unit) => {
    const unitDefinitionId = stringOf(unit, "unitDefinitionId");
    const skillIds = [
      ...stringsOf(unit, "activeSkillDefinitionIds"),
      ...stringsOf(unit, "passiveSkillDefinitionIds"),
      stringOf(unit, "extraSkillDefinitionId"),
    ];
    const actionSeeds = new Set<string>();
    for (const skillId of skillIds) {
      const skill = skillsById.get(skillId);
      if (skill === undefined) {
        throw new Error(`unit "${unitDefinitionId}" references unknown skill "${skillId}"`);
      }
      collectEffectActionReferences(skill, actionSeeds);
    }
    const actionIds = effectActionClosure(actionSeeds, effectPayloadsById);
    return {
      definitionId: unitDefinitionId,
      requiredIds: [...skillIds, ...actionIds].sort(),
      testFilePath: `${unitsTestDir}/${unitDefinitionId}.test.ts`,
    };
  });
}

function memoryCoverageTargets(): readonly CoverageTarget[] {
  return readCatalogArray("memories.json").map((memory) => {
    const memoryDefinitionId = stringOf(memory, "memoryDefinitionId");
    const actionSeeds = new Set<string>();
    collectEffectActionReferences(memory["triggeredEffects"], actionSeeds);
    const actionIds = effectActionClosure(actionSeeds, effectPayloadsById);
    return {
      definitionId: memoryDefinitionId,
      requiredIds: [...actionIds].sort(),
      testFilePath: `${memoriesTestDir}/${memoryDefinitionId}.test.ts`,
    };
  });
}

function existingTestFiles(directory: string): ReadonlySet<string> {
  if (!existsSync(directory)) {
    return new Set();
  }
  return new Set(
    readdirSync(directory)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.replace(/\.test\.ts$/, "")),
  );
}

interface CoverageAudit {
  readonly label: string;
  readonly targets: readonly CoverageTarget[];
  readonly uncovered: readonly string[];
  readonly testDir: string;
}

const audits: readonly CoverageAudit[] = [
  {
    label: "unit",
    targets: unitCoverageTargets(),
    uncovered: UNCOVERED_UNIT_IDS,
    testDir: unitsTestDir,
  },
  {
    label: "memory",
    targets: memoryCoverageTargets(),
    uncovered: UNCOVERED_MEMORY_IDS,
    testDir: memoriesTestDir,
  },
];

describe("Production ID coverage audit", () => {
  it("UT-AUDIT-UNITCOV-001: every definition outside the allowlist has a per-definition test referencing all of its IDs", () => {
    const violations: string[] = [];
    for (const audit of audits) {
      const uncovered = new Set(audit.uncovered);
      for (const target of audit.targets) {
        if (uncovered.has(target.definitionId)) {
          continue;
        }
        if (!existsSync(target.testFilePath)) {
          violations.push(`${target.definitionId}: missing ${target.testFilePath}`);
          continue;
        }
        const source = readFileSync(target.testFilePath, "utf8");
        const missing = target.requiredIds.filter((id) => !source.includes(id));
        if (missing.length > 0) {
          violations.push(`${target.definitionId}: unreferenced IDs ${JSON.stringify(missing)}`);
        }
      }
    }
    expect(
      violations,
      `definitions outside the allowlist without full ID coverage: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("UT-AUDIT-UNITCOV-002: allowlisted definitions have no per-definition test file yet", () => {
    // カバー済み定義がallowlistへ残留すると、監査001の対象から外れたまま
    // 「未カバー」を名乗り続け、台帳が実態を失う。逆方向からも検査して
    // allowlistが縮小のみ許される台帳であることを機械的に強制する。
    const violations: string[] = [];
    for (const audit of audits) {
      for (const definitionId of audit.uncovered) {
        const path = `${audit.testDir}/${definitionId}.test.ts`;
        if (existsSync(path)) {
          violations.push(`${definitionId}: covered by ${path} but still allowlisted`);
        }
      }
    }
    expect(
      violations,
      `allowlisted definitions that already have a test file: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("UT-AUDIT-UNITCOV-003: allowlist plus covered definitions equals the full catalog exactly", () => {
    const violations: string[] = [];
    for (const audit of audits) {
      const knownIds = new Set(audit.targets.map((target) => target.definitionId));
      const covered = existingTestFiles(audit.testDir);
      const uncovered = new Set(audit.uncovered);
      if (uncovered.size !== audit.uncovered.length) {
        violations.push(`${audit.label}: allowlist contains duplicates`);
      }
      for (const id of audit.uncovered) {
        if (!knownIds.has(id)) {
          violations.push(`${audit.label}: allowlisted "${id}" does not exist in the catalog`);
        }
      }
      for (const id of covered) {
        if (!knownIds.has(id)) {
          violations.push(`${audit.label}: test file "${id}" does not match any catalog ID`);
        }
      }
      for (const id of knownIds) {
        if (!covered.has(id) && !uncovered.has(id)) {
          violations.push(`${audit.label}: "${id}" is neither covered nor allowlisted`);
        }
      }
    }
    expect(
      violations,
      `allowlist and covered set do not partition the catalog: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});
