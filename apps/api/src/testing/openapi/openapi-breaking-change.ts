/**
 * `12_テスト戦略.md`「OpenAPI」「互換性検査で意図しない破壊的変更がない」
 * （品質ゲート「OpenAPI契約に意図しない破壊的変更がない」）の判定器。
 *
 * 凍結したv1文書（`apps/api/openapi/v1-baseline.json`）と、いま生成される文書を
 * 比較する。`10_API設計.md`「バージョニング」が破壊的と定めるものだけを失敗させ、
 * 後方互換な追加（任意プロパティ・新イベント種別・新エラーコード・新列挙値）は
 * 通す。整形差分やdescriptionの書き換えでは落とさない。
 *
 * 文書を丸ごとsnapshot比較しないのはこのため——追加のたびに更新が要求されると、
 * 「意図的な追加」と「うっかりの破壊」がレビュー上で区別できなくなる。
 */

export interface BreakingChange {
  readonly kind:
    | "PATH_REMOVED"
    | "OPERATION_REMOVED"
    | "RESPONSE_STATUS_REMOVED"
    | "REQUIRED_PROPERTY_REMOVED"
    | "PROPERTY_TYPE_CHANGED"
    | "ENUM_VALUE_REMOVED"
    | "REQUEST_PROPERTY_NEWLY_REQUIRED";
  readonly location: string;
  readonly detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `oneOf`/`anyOf`のvariantを安定した名前で指す。位置indexをキーにすると、新しい
 * variantが途中へ挿入されただけで以降が全部ずれ、追加を削除と読み違える。
 *
 * 判別子は単一値`enum`を持つプロパティ（`@fastify/swagger`がOpenAPI 3.0向けに
 * `const`をこの形へ正規化する）。イベントログのunionは`type`、
 * `ConditionDefinition`は`kind`で判別するため、両方を候補として順に見る。
 */
const VARIANT_DISCRIMINATOR_PROPERTIES = ["type", "kind"] as const;

function discriminatorOf(variant: unknown): string | undefined {
  if (!isRecord(variant)) {
    return undefined;
  }
  const properties = variant["properties"];
  if (!isRecord(properties)) {
    return undefined;
  }
  for (const discriminatorName of VARIANT_DISCRIMINATOR_PROPERTIES) {
    const discriminator = properties[discriminatorName];
    if (!isRecord(discriminator)) {
      continue;
    }
    const values = discriminator["enum"];
    if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") {
      return `${discriminatorName}=${values[0]}`;
    }
  }
  return undefined;
}

/**
 * 配列全体のvariantキーを一度に決める。
 *
 * 判別子は一意とは限らない（`ConditionDefinition`の`kind=TARGET_STATE`は
 * `field`と`value`の型の組み合わせごとに3variantある）。同じ判別子が複数あるときは
 * その中での出現順を添えて区別する——新しい判別子の追加では既存キーが動かず、
 * 同じ判別子の変種を足したときだけ末尾に新キーが増える。
 */
function variantKeys(variants: readonly unknown[]): readonly string[] {
  const seen = new Map<string, number>();
  return variants.map((variant, index) => {
    const discriminator = discriminatorOf(variant);
    if (discriminator === undefined) {
      return `#${index}`;
    }
    const occurrence = seen.get(discriminator) ?? 0;
    seen.set(discriminator, occurrence + 1);
    return occurrence === 0 ? discriminator : `${discriminator}#${occurrence}`;
  });
}

type SchemaFactSink = (change: BreakingChange) => void;

/**
 * baseline側とcurrent側のSchema Objectを同じ位置同士で突き合わせる。
 * currentにしか無いもの（追加）は互換なので辿らない。
 */
function compareSchema(
  baseline: unknown,
  current: unknown,
  location: string,
  isRequestSchema: boolean,
  report: SchemaFactSink,
): void {
  if (!isRecord(baseline)) {
    return;
  }
  if (!isRecord(current)) {
    report({
      kind: "REQUIRED_PROPERTY_REMOVED",
      location,
      detail: "the baseline documented a schema here and the current document does not",
    });
    return;
  }

  // `$ref`は解決せず、参照先の名前が変わっていないかだけを見る。参照先の中身は
  // `components.schemas`を名前どうしで突き合わせる経路（`findBreakingChanges`）が
  // 比較する。解決してしまうと`ConditionDefinition`のような自己参照schemaで
  // 無限再帰になるため、この二段構えにしている。
  const baselineRef = baseline["$ref"];
  const currentRef = current["$ref"];
  if (typeof baselineRef === "string" && baselineRef !== currentRef) {
    report({
      kind: "PROPERTY_TYPE_CHANGED",
      location,
      detail:
        typeof currentRef === "string"
          ? `$ref ${baselineRef} -> ${currentRef}`
          : `$ref ${baselineRef} was replaced by an inline schema`,
    });
    return;
  }

  const baselineType = baseline["type"];
  const currentType = current["type"];
  if (typeof baselineType === "string" && baselineType !== currentType) {
    report({
      kind: "PROPERTY_TYPE_CHANGED",
      location,
      // `type`キーごと消えて`oneOf`等へ組み替えられた場合も、値域が広がった／
      // 変わったことに違いはないので報告する。`10_API設計.md`「バージョニング」の
      // 「既存必須プロパティの…型変更」。
      detail: `type ${baselineType} -> ${typeof currentType === "string" ? currentType : "(no type keyword)"}`,
    });
  }

  const baselineEnum = baseline["enum"];
  const currentEnum = current["enum"];
  if (Array.isArray(baselineEnum)) {
    const currentValues = new Set(Array.isArray(currentEnum) ? currentEnum : []);
    for (const value of baselineEnum) {
      if (!currentValues.has(value)) {
        report({
          kind: "ENUM_VALUE_REMOVED",
          location,
          detail: `enum value ${JSON.stringify(value)} is no longer accepted`,
        });
      }
    }
  }

  const baselineProperties = isRecord(baseline["properties"]) ? baseline["properties"] : {};
  const currentProperties = isRecord(current["properties"]) ? current["properties"] : {};
  const baselineRequired = new Set(
    Array.isArray(baseline["required"]) ? (baseline["required"] as unknown[]) : [],
  );
  const currentRequired = new Set(
    Array.isArray(current["required"]) ? (current["required"] as unknown[]) : [],
  );

  // 「既存必須プロパティの削除」は、プロパティ自体が消えた場合だけ機械的に判定する。
  //
  // `required`から外すだけ（プロパティは残る）の緩和を無条件の破壊とはしない。
  // `10_API設計.md`「バージョニング」はこれを**条件付き**で後方互換と認めており
  // （「緩めた後も従来から公開されていた変種では常に存在することを併せて示す」）、
  // その条件——どの変種が従来公開されていたか——は文書だけからは判定できない。
  // REL-008の`MarkerStateResponse.sourceUnitId`とREL-004の
  // `CooldownStateResponse.setAtActionId`がこの形で、いずれも「その変種は一度も
  // 公開されたことがない」ことを人手で示して初めて互換と言える。
  // したがってレスポンス側の`required`縮小はここを素通りする。緩和する側が
  // 設計書へ根拠を書く責任を負う。
  for (const name of baselineRequired) {
    if (typeof name === "string" && !(name in currentProperties) && name in baselineProperties) {
      report({
        kind: "REQUIRED_PROPERTY_REMOVED",
        location,
        detail: `required property "${name}" no longer exists`,
      });
    }
  }

  if (isRequestSchema) {
    for (const name of currentRequired) {
      if (typeof name === "string" && !baselineRequired.has(name)) {
        report({
          kind: "REQUEST_PROPERTY_NEWLY_REQUIRED",
          location,
          detail: `request property "${name}" became required, so previously valid requests are now rejected`,
        });
      }
    }
  }

  for (const [name, propertySchema] of Object.entries(baselineProperties)) {
    if (name in currentProperties) {
      compareSchema(
        propertySchema,
        currentProperties[name],
        `${location}.${name}`,
        isRequestSchema,
        report,
      );
    }
  }

  for (const keyword of ["items", "not", "additionalProperties"] as const) {
    if (keyword in baseline) {
      compareSchema(
        baseline[keyword],
        current[keyword],
        `${location}.${keyword}`,
        isRequestSchema,
        report,
      );
    }
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const baselineVariants = baseline[keyword];
    if (!Array.isArray(baselineVariants)) {
      continue;
    }
    const currentVariants = Array.isArray(current[keyword]) ? (current[keyword] as unknown[]) : [];
    const currentKeys = variantKeys(currentVariants);
    const currentByKey = new Map(
      currentVariants.map((variant, index) => [currentKeys[index]!, variant]),
    );
    const baselineKeys = variantKeys(baselineVariants);
    for (const [index, variant] of baselineVariants.entries()) {
      const key = baselineKeys[index]!;
      const counterpart = currentByKey.get(key);
      if (counterpart === undefined) {
        report({
          kind: "REQUIRED_PROPERTY_REMOVED",
          location: `${location}.${keyword}[${key}]`,
          detail: `the "${key}" variant the baseline documented is gone`,
        });
        continue;
      }
      compareSchema(
        variant,
        counterpart,
        `${location}.${keyword}[${key}]`,
        isRequestSchema,
        report,
      );
    }
  }
}

interface OperationShape {
  readonly requestBody?: { readonly content?: Record<string, { readonly schema?: unknown }> };
  readonly responses?: Record<string, { readonly content?: Record<string, { schema?: unknown }> }>;
}

type DocumentShape = {
  readonly paths?: Record<string, Record<string, OperationShape>>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
};

/**
 * 破壊的変更だけを返す。空配列なら「後方互換」。
 */
export function findBreakingChanges(
  baseline: unknown,
  current: unknown,
): readonly BreakingChange[] {
  const changes: BreakingChange[] = [];
  const report: SchemaFactSink = (change) => changes.push(change);

  // `components.schemas`を先に名前どうしで比較する。`paths`側からは`$ref`としか
  // 見えないため、ここを見ないと参照先の中身（この文書では再帰的な
  // `ConditionDefinition`＝`EffectApplied`/`EffectApplicationRejected`の
  // `details.expirationConditions`）が丸ごと検査の外に落ちる。
  const baseComponents = (baseline as DocumentShape).components?.schemas ?? {};
  const currentComponents = (current as DocumentShape).components?.schemas ?? {};
  for (const [name, baseSchema] of Object.entries(baseComponents)) {
    if (!(name in currentComponents)) {
      changes.push({
        kind: "REQUIRED_PROPERTY_REMOVED",
        location: `components.schemas.${name}`,
        detail: "the baseline documented this shared schema and it is gone",
      });
      continue;
    }
    // 共有schemaはrequest・response双方から参照され得るので、requestだけの規則
    // （任意→必須の締め付け）は適用しない。
    compareSchema(baseSchema, currentComponents[name], `components.schemas.${name}`, false, report);
  }

  const basePaths = (baseline as DocumentShape).paths ?? {};
  const currentPaths = (current as DocumentShape).paths ?? {};

  for (const [routePath, baseMethods] of Object.entries(basePaths)) {
    const currentMethods = currentPaths[routePath];
    if (currentMethods === undefined) {
      changes.push({
        kind: "PATH_REMOVED",
        location: routePath,
        detail: "the baseline documented this path and it is gone",
      });
      continue;
    }

    for (const [method, baseOperation] of Object.entries(baseMethods)) {
      const currentOperation = currentMethods[method];
      if (currentOperation === undefined) {
        changes.push({
          kind: "OPERATION_REMOVED",
          location: `${method.toUpperCase()} ${routePath}`,
          detail: "the baseline documented this operation and it is gone",
        });
        continue;
      }

      for (const [mediaType, media] of Object.entries(baseOperation.requestBody?.content ?? {})) {
        compareSchema(
          media.schema,
          currentOperation.requestBody?.content?.[mediaType]?.schema,
          `${method.toUpperCase()} ${routePath} requestBody(${mediaType})`,
          true,
          report,
        );
      }

      for (const [status, response] of Object.entries(baseOperation.responses ?? {})) {
        const currentResponse = currentOperation.responses?.[status];
        if (currentResponse === undefined) {
          changes.push({
            kind: "RESPONSE_STATUS_REMOVED",
            location: `${method.toUpperCase()} ${routePath} -> ${status}`,
            detail: "the baseline documented this status and it is gone",
          });
          continue;
        }
        for (const [mediaType, media] of Object.entries(response.content ?? {})) {
          compareSchema(
            media.schema,
            currentResponse.content?.[mediaType]?.schema,
            `${method.toUpperCase()} ${routePath} -> ${status} (${mediaType})`,
            false,
            report,
          );
        }
      }
    }
  }

  return changes;
}
