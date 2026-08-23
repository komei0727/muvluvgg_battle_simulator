import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { BATTLE_DOMAIN_EVENT_TYPES } from "../../../../domain/battle/events/domain-event.js";
import {
  battleLogEventResponseDocSchema,
  exerciseBattleLogEventResponseDocSchema,
} from "./battle-log-schema.js";

/**
 * REF-051（Issue #596）: `battle-log-schema.ts`の手書きJSON Schemaと
 * `domain-event.ts`の`BattleDomainEventPayloadMap`は、5か所に分かれたワイヤー契約の
 * 手写しのうちの2つで、同期漏れがコンパイルエラーにならない。`battle-log-schema.ts`は
 * `as const`のデータリテラルなのでimportした時点で全行実行済みになり、内容の正しさを
 * 何も検証しないままカバレッジ100%と表示される（`12_テスト戦略.md`参照）。
 *
 * このファイルは各`details`schemaの`required`集合を、対応する
 * `BattleDomainEventPayloadMap`メンバーの必須（非optional）キー集合と突合する。
 * イベント種別集合そのものの突合（新種別がschema側に無ければ落ちる）は
 * `openapi.test.ts`の`API-OPENAPI-024`が`BATTLE_DOMAIN_EVENT_TYPES`を正本に
 * 既に検査しているため、ここでは重複させない——このファイルが担うのは「両側に
 * 存在する型の“形”が一致しているか」であり、「存在するかどうか」ではない。
 *
 * **完全一致ではなく`schema required ⊆ payload required`を検査する。** DMG-005／
 * DMG-009／DMG-012（`subUnitAbsorbed`／`confusionDamageMultiplier`等）が明文化する
 * `10_API設計.md`「バージョニング」の方針により、`schemaVersion: 1`のまま既存イベントへ
 * 必須項目を足すのは後方互換でないため、Response Mapperが常に値を設定するpayloadの
 * 必須keyでも、wire契約側は意図して任意項目のまま追加する。したがって
 * `payload required ⊋ schema required`は正常系であり、その逆
 * （`schema required`が`payload required`に無いkeyを持つ——wireが実際には保証されない
 * 値を約束している）だけを不合格にする。
 */

const DOMAIN_EVENT_SOURCE_PATH = fileURLToPath(
  new URL("../../../../domain/battle/events/domain-event.ts", import.meta.url),
);
const PAYLOAD_MAP_INTERFACE_NAME = "BattleDomainEventPayloadMap";

/** PascalCaseのeventTypeを、schemaの`type`が使う大文字スネークケースへ変換する（`battle-log-event.ts`の`toUpperSnakeCase`と同じ変換）。 */
function toUpperSnakeCase(eventType: string): string {
  return eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function requiredKeysOfTypeLiteral(
  node: ts.TypeLiteralNode,
  sourceFile: ts.SourceFile,
): Set<string> {
  const keys = new Set<string>();
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.questionToken === undefined) {
      keys.add(member.name.getText(sourceFile));
    }
  }
  return keys;
}

/**
 * unionは`BattleCompleted`のような排他的な複数variant payload（通常戦闘／戦術演習で
 * 形が変わる）を表す。各variantを1要素として返し、呼び出し側でどちらか一方との
 * 適合を見る。
 */
function requiredKeyBranchesOf(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
): readonly ReadonlySet<string>[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    return [requiredKeysOfTypeLiteral(typeNode, sourceFile)];
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.flatMap((member) => requiredKeyBranchesOf(member, sourceFile));
  }
  throw new Error(
    `BattleDomainEventPayloadMap member has an unsupported type node (${ts.SyntaxKind[typeNode.kind]}); ` +
      "this extractor only understands inline object literals or unions of them.",
  );
}

/**
 * `BattleDomainEventPayloadMap`をソーステキストから静的解析し、event種別（PascalCase）
 * ごとの必須keyの集合を得る。`keyof`は型であって値ではなく実行時に読めないため、
 * 型チェッカーではなくASTを直接走査する（`testing/traceability/test-case-definitions.ts`
 * の`collectTestCaseDefinitionsFromSource`と同じ手法）。
 */
function collectPayloadRequiredKeyBranches(): ReadonlyMap<string, readonly ReadonlySet<string>[]> {
  const sourceText = readFileSync(DOMAIN_EVENT_SOURCE_PATH, "utf-8");
  const sourceFile = ts.createSourceFile(
    DOMAIN_EVENT_SOURCE_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const result = new Map<string, readonly ReadonlySet<string>[]>();
  let interfaceFound = false;

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === PAYLOAD_MAP_INTERFACE_NAME) {
      interfaceFound = true;
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.type !== undefined) {
          result.set(
            member.name.getText(sourceFile),
            requiredKeyBranchesOf(member.type, sourceFile),
          );
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (!interfaceFound) {
    throw new Error(
      `interface ${PAYLOAD_MAP_INTERFACE_NAME} not found in ${DOMAIN_EVENT_SOURCE_PATH}`,
    );
  }
  return result;
}

function isSubsetOf(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  return [...subset].every((key) => superset.has(key));
}

/**
 * schemaの`required`が、対応payloadのいずれかのbranchの部分集合であるかを検証する
 * （完全一致ではない——理由はファイル先頭のコメント参照）。適合するbranchが1つも
 * 無ければ、差分を読める形の失敗理由を返す。
 */
function findRequiredKeyMismatch(
  eventType: string,
  schemaRequired: ReadonlySet<string>,
  branches: readonly ReadonlySet<string>[],
): string | undefined {
  if (branches.some((branch) => isSubsetOf(schemaRequired, branch))) {
    return undefined;
  }
  return (
    `${eventType}: schema required=[${[...schemaRequired].sort().join(", ")}] is not a subset of any payload branch ` +
    `[${branches.map((branch) => `{${[...branch].sort().join(", ")}}`).join(" | ")}]`
  );
}

type JsonSchemaLike = {
  readonly required?: readonly string[];
  readonly oneOf?: readonly JsonSchemaLike[];
};

/**
 * detail schemaの「常に成立するrequired」を得る。多くは`type: "object"`直下の
 * `required`だが、`RuntimeCounterChanged`（`runtimeCounterChangedDetailsSchema`）は
 * `scope`の値によって`skillDefinitionId`／`effectInstanceId`のどちらが必須かが変わる
 * discriminated unionを`oneOf`で表すため、トップレベルに`required`を持たない。
 * その場合は全branchに共通するkey（積集合）だけを「常に成立する」required とみなす。
 */
function effectiveRequiredKeysOf(detailsSchema: JsonSchemaLike): Set<string> {
  if (detailsSchema.oneOf !== undefined) {
    return detailsSchema.oneOf
      .map((branch) => effectiveRequiredKeysOf(branch))
      .reduce((common, branchKeys) => new Set([...common].filter((key) => branchKeys.has(key))));
  }
  return new Set(detailsSchema.required ?? []);
}

function collectVariants(docSchema: {
  readonly oneOf: readonly { readonly properties: object }[];
}) {
  return docSchema.oneOf.map((variant) => {
    const properties = variant.properties as {
      readonly type: { readonly const: string };
      readonly details: JsonSchemaLike;
    };
    return {
      upperType: properties.type.const,
      required: effectiveRequiredKeysOf(properties.details),
    };
  });
}

describe("battle-log event schema ⇄ domain event payload parity (REF-051 / Issue #596)", () => {
  const payloadRequiredKeyBranchesByPascalName = collectPayloadRequiredKeyBranches();
  const pascalNameByUpperSnake = new Map(
    Object.keys(BATTLE_DOMAIN_EVENT_TYPES).map((pascalName) => [
      toUpperSnakeCase(pascalName),
      pascalName,
    ]),
  );

  it("API-OPENAPI-038: every published details schema requires no key that isn't also required by the corresponding BattleDomainEventPayloadMap member", () => {
    // 通常戦闘・戦術演習の両unionを見る。`BattleCompleted`等はモードごとに別schema
    // オブジェクトを参照する（同じ`type`でも要求されるpayloadの形が変わる）ため、
    // 片方だけを見ると通常戦闘用／演習用のどちらか一方のvariantが未検査になる。
    const variants = [
      ...collectVariants(battleLogEventResponseDocSchema),
      ...collectVariants(exerciseBattleLogEventResponseDocSchema),
    ];
    expect(variants.length).toBeGreaterThan(0);

    const mismatches = variants
      .map(({ upperType, required }) => {
        const pascalName = pascalNameByUpperSnake.get(upperType);
        if (pascalName === undefined) {
          return `${upperType}: no BattleDomainEventPayloadMap member maps to this schema type`;
        }
        const branches = payloadRequiredKeyBranchesByPascalName.get(pascalName);
        if (branches === undefined) {
          return `${pascalName}: not found while parsing BattleDomainEventPayloadMap`;
        }
        return findRequiredKeyMismatch(pascalName, required, branches);
      })
      .filter((mismatch) => mismatch !== undefined);

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("API-OPENAPI-039: the parity check rejects a schema `required` key the payload doesn't guarantee, while still allowing the payload to require more than the wire promises", () => {
    const branches = [new Set(["turnLimit", "allySlotCount", "enemySlotCount"])];
    // schemaがpayloadに無いkeyを要求している——実際には保証されない値を約束しており不合格。
    expect(
      findRequiredKeyMismatch(
        "BattleStarted",
        new Set(["turnLimit", "allySlotCount", "enemySlotCount", "notInPayload"]),
        branches,
      ),
    ).toBeDefined();
    // 完全一致は合格。
    expect(
      findRequiredKeyMismatch(
        "BattleStarted",
        new Set(["turnLimit", "allySlotCount", "enemySlotCount"]),
        branches,
      ),
    ).toBeUndefined();
    // payloadの方が多く必須を持つ（DMG-005等と同じ後方互換のための意図的な非対称）のは合格。
    expect(
      findRequiredKeyMismatch("BattleStarted", new Set(["turnLimit", "allySlotCount"]), branches),
    ).toBeUndefined();
    // unionの片方のbranchの部分集合であれば通す（`BattleCompleted`の通常戦闘／演習分岐）。
    const unionBranches = [
      new Set(["outcome", "completionReason", "completedTurn"]),
      new Set(["completionReason", "completedTurn", "totalScore", "breakCount"]),
    ];
    expect(
      findRequiredKeyMismatch(
        "BattleCompleted",
        new Set(["completionReason", "completedTurn", "totalScore", "breakCount"]),
        unionBranches,
      ),
    ).toBeUndefined();
  });

  it("API-OPENAPI-040 (RuntimeCounterChanged, discriminated by `scope`): the parity check treats a `oneOf`-wrapped details schema's cross-branch common `required` as its effective required set", () => {
    const oneOfSchema: JsonSchemaLike = {
      oneOf: [
        { required: ["ownerUnitId", "scope", "skillDefinitionId"] },
        { required: ["ownerUnitId", "scope", "effectInstanceId"] },
      ],
    };
    expect(effectiveRequiredKeysOf(oneOfSchema)).toEqual(new Set(["ownerUnitId", "scope"]));
  });
});
