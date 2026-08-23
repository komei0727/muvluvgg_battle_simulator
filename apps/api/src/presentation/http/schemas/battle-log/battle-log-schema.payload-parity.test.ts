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

/** payloadの1 variant（1 union branch）が持つkeyの内訳。 */
interface PayloadBranch {
  /** 非optionalな（`?`を持たない）key。 */
  readonly requiredKeys: ReadonlySet<string>;
  /** optional込みの全key。 */
  readonly allKeys: ReadonlySet<string>;
}

function payloadBranchOfTypeLiteral(
  node: ts.TypeLiteralNode,
  sourceFile: ts.SourceFile,
): PayloadBranch {
  const requiredKeys = new Set<string>();
  const allKeys = new Set<string>();
  for (const member of node.members) {
    if (ts.isPropertySignature(member)) {
      const name = member.name.getText(sourceFile);
      allKeys.add(name);
      if (member.questionToken === undefined) {
        requiredKeys.add(name);
      }
    }
  }
  return { requiredKeys, allKeys };
}

/**
 * unionは`BattleCompleted`のような排他的な複数variant payload（通常戦闘／戦術演習で
 * 形が変わる）を表す。各variantを1要素として返し、呼び出し側でどちらか一方との
 * 適合を見る。
 */
function payloadBranchesOf(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile,
): readonly PayloadBranch[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    return [payloadBranchOfTypeLiteral(typeNode, sourceFile)];
  }
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.flatMap((member) => payloadBranchesOf(member, sourceFile));
  }
  throw new Error(
    `BattleDomainEventPayloadMap member has an unsupported type node (${ts.SyntaxKind[typeNode.kind]}); ` +
      "this extractor only understands inline object literals or unions of them.",
  );
}

/**
 * `BattleDomainEventPayloadMap`をソーステキストから静的解析し、event種別（PascalCase）
 * ごとのpayload branchを得る。`keyof`は型であって値ではなく実行時に読めないため、
 * 型チェッカーではなくASTを直接走査する（`testing/traceability/test-case-definitions.ts`
 * の`collectTestCaseDefinitionsFromSource`と同じ手法）。
 */
function collectPayloadBranches(): ReadonlyMap<string, readonly PayloadBranch[]> {
  const sourceText = readFileSync(DOMAIN_EVENT_SOURCE_PATH, "utf-8");
  const sourceFile = ts.createSourceFile(
    DOMAIN_EVENT_SOURCE_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const result = new Map<string, readonly PayloadBranch[]>();
  let interfaceFound = false;

  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === PAYLOAD_MAP_INTERFACE_NAME) {
      interfaceFound = true;
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.type !== undefined) {
          result.set(member.name.getText(sourceFile), payloadBranchesOf(member.type, sourceFile));
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

function intersectAll(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  return sets.reduce((common, current) => new Set([...common].filter((key) => current.has(key))));
}

/**
 * schemaの`required`集合（複数あれば`oneOf`の各branch）が、対応payloadのいずれかの
 * branchと整合するかを検証する（完全一致ではない——理由はファイル先頭のコメント参照）。
 * 不整合があれば、差分を読める形の失敗理由を返す。
 *
 * `schemaRequiredSets`が2件以上なのは、`RuntimeCounterChanged`
 * （`runtimeCounterChangedDetailsSchema`）のように`scope`の値で
 * `skillDefinitionId`／`effectInstanceId`のどちらが必須かが変わる discriminated union を
 * `oneOf`で表す場合だけである。この場合は2段で検証する:
 * 1. 各branchが要求するkeyは、そのbranchだけの話であっても必ずpayloadの実在するkey
 *    （必須・任意問わず）でなければならない——ここを「全branch共通のkey（積集合）」だけに
 *    緩めると、1つのbranchだけへ実在しないkeyを足しても積集合から消えて検出できなくなる。
 * 2. 全branchに共通して要求されるkey（discriminatorに関係なく常に必須なkey）は、
 *    payload側でも常に必須（非optional）でなければならない。
 */
function findRequiredKeyMismatch(
  eventType: string,
  schemaRequiredSets: readonly ReadonlySet<string>[],
  payloadBranches: readonly PayloadBranch[],
): string | undefined {
  if (schemaRequiredSets.length === 1) {
    const schemaRequired = schemaRequiredSets[0]!;
    if (payloadBranches.some((branch) => isSubsetOf(schemaRequired, branch.requiredKeys))) {
      return undefined;
    }
    return (
      `${eventType}: schema required=[${[...schemaRequired].sort().join(", ")}] is not a subset of any payload branch's required keys ` +
      `[${payloadBranches.map((branch) => `{${[...branch.requiredKeys].sort().join(", ")}}`).join(" | ")}]`
    );
  }

  const branchWithUnknownKey = schemaRequiredSets.find(
    (branchRequired) =>
      !payloadBranches.some((payload) => isSubsetOf(branchRequired, payload.allKeys)),
  );
  if (branchWithUnknownKey !== undefined) {
    return (
      `${eventType}: a oneOf branch requires=[${[...branchWithUnknownKey].sort().join(", ")}], which includes a key ` +
      `absent from the payload entirely (required or optional) ` +
      `[${payloadBranches.map((branch) => `{${[...branch.allKeys].sort().join(", ")}}`).join(" | ")}]`
    );
  }

  const commonRequired = intersectAll(schemaRequiredSets);
  if (payloadBranches.some((branch) => isSubsetOf(commonRequired, branch.requiredKeys))) {
    return undefined;
  }
  return (
    `${eventType}: keys required by every oneOf branch=[${[...commonRequired].sort().join(", ")}] are not all required by the payload ` +
    `[${payloadBranches.map((branch) => `{${[...branch.requiredKeys].sort().join(", ")}}`).join(" | ")}]`
  );
}

type JsonSchemaLike = {
  readonly required?: readonly string[];
  readonly oneOf?: readonly JsonSchemaLike[];
};

/** detail schemaが宣言する`required`集合を集める。`oneOf`があれば各branchを個別の要素として返す。 */
function requiredSetsOf(detailsSchema: JsonSchemaLike): readonly ReadonlySet<string>[] {
  if (detailsSchema.oneOf !== undefined) {
    return detailsSchema.oneOf.flatMap((branch) => requiredSetsOf(branch));
  }
  return [new Set(detailsSchema.required ?? [])];
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
      requiredSets: requiredSetsOf(properties.details),
    };
  });
}

describe("battle-log event schema ⇄ domain event payload parity (REF-051 / Issue #596)", () => {
  const payloadBranchesByPascalName = collectPayloadBranches();
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
      .map(({ upperType, requiredSets }) => {
        const pascalName = pascalNameByUpperSnake.get(upperType);
        if (pascalName === undefined) {
          return `${upperType}: no BattleDomainEventPayloadMap member maps to this schema type`;
        }
        const payloadBranches = payloadBranchesByPascalName.get(pascalName);
        if (payloadBranches === undefined) {
          return `${pascalName}: not found while parsing BattleDomainEventPayloadMap`;
        }
        return findRequiredKeyMismatch(pascalName, requiredSets, payloadBranches);
      })
      .filter((mismatch) => mismatch !== undefined);

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("API-OPENAPI-039: the parity check rejects a schema `required` key the payload doesn't guarantee, while still allowing the payload to require more than the wire promises", () => {
    const payloadBranches: readonly PayloadBranch[] = [
      {
        requiredKeys: new Set(["turnLimit", "allySlotCount", "enemySlotCount"]),
        allKeys: new Set(["turnLimit", "allySlotCount", "enemySlotCount"]),
      },
    ];
    // schemaがpayloadに無いkeyを要求している——実際には保証されない値を約束しており不合格。
    expect(
      findRequiredKeyMismatch(
        "BattleStarted",
        [new Set(["turnLimit", "allySlotCount", "enemySlotCount", "notInPayload"])],
        payloadBranches,
      ),
    ).toBeDefined();
    // 完全一致は合格。
    expect(
      findRequiredKeyMismatch(
        "BattleStarted",
        [new Set(["turnLimit", "allySlotCount", "enemySlotCount"])],
        payloadBranches,
      ),
    ).toBeUndefined();
    // payloadの方が多く必須を持つ（DMG-005等と同じ後方互換のための意図的な非対称）のは合格。
    expect(
      findRequiredKeyMismatch(
        "BattleStarted",
        [new Set(["turnLimit", "allySlotCount"])],
        payloadBranches,
      ),
    ).toBeUndefined();
    // unionの片方のbranchの部分集合であれば通す（`BattleCompleted`の通常戦闘／演習分岐）。
    const unionPayloadBranches: readonly PayloadBranch[] = [
      {
        requiredKeys: new Set(["outcome", "completionReason", "completedTurn"]),
        allKeys: new Set(["outcome", "completionReason", "completedTurn"]),
      },
      {
        requiredKeys: new Set(["completionReason", "completedTurn", "totalScore", "breakCount"]),
        allKeys: new Set(["completionReason", "completedTurn", "totalScore", "breakCount"]),
      },
    ];
    expect(
      findRequiredKeyMismatch(
        "BattleCompleted",
        [new Set(["completionReason", "completedTurn", "totalScore", "breakCount"])],
        unionPayloadBranches,
      ),
    ).toBeUndefined();
  });

  it("API-OPENAPI-040 (RuntimeCounterChanged, discriminated by `scope`): the parity check catches a required key that only one `oneOf` branch adds and the payload never defines", () => {
    // `runtimeCounterChangedDetailsSchema`と同じ形: payloadはunionではなく、
    // 両方のdiscriminator値で共通の必須keyに加え、`skillDefinitionId`／
    // `effectInstanceId`をoptionalとして両方持つ1つのTS型。
    const payloadBranches: readonly PayloadBranch[] = [
      {
        requiredKeys: new Set(["ownerUnitId", "scope", "counter"]),
        allKeys: new Set([
          "ownerUnitId",
          "scope",
          "counter",
          "skillDefinitionId",
          "effectInstanceId",
        ]),
      },
    ];

    // 正常系: 各branchの必須keyはpayloadに実在し、全branch共通の必須keyもpayload側で必須。
    expect(
      findRequiredKeyMismatch(
        "RuntimeCounterChanged",
        [
          new Set(["ownerUnitId", "scope", "counter", "skillDefinitionId"]),
          new Set(["ownerUnitId", "scope", "counter", "effectInstanceId"]),
        ],
        payloadBranches,
      ),
    ).toBeUndefined();

    // 1つのbranchだけに実在しないkeyを混入させても、積集合を取ると消えて見逃してしまう
    // 退行を防ぐ回帰テスト。
    expect(
      findRequiredKeyMismatch(
        "RuntimeCounterChanged",
        [
          new Set(["ownerUnitId", "scope", "counter", "skillDefinitionId", "notInPayload"]),
          new Set(["ownerUnitId", "scope", "counter", "effectInstanceId"]),
        ],
        payloadBranches,
      ),
    ).toBeDefined();

    // 全branch共通の必須keyがpayload側ではoptionalな場合は不合格
    // （skillDefinitionIdが両branchに共通して必須になっているが、payloadは常には保証しない）。
    expect(
      findRequiredKeyMismatch(
        "RuntimeCounterChanged",
        [
          new Set(["ownerUnitId", "scope", "counter", "skillDefinitionId"]),
          new Set(["ownerUnitId", "scope", "counter", "skillDefinitionId"]),
        ],
        payloadBranches,
      ),
    ).toBeDefined();
  });
});
