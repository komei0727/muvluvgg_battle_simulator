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
 * `oneOf`/`anyOf`のvariantを安定した名前で指す。イベントログの union は
 * `type`を単一値の`enum`で判別する（`@fastify/swagger`がOpenAPI 3.0向けに
 * `const`をこの形へ正規化する）ため、その値をキーにする。位置indexをキーにすると
 * 新しいイベント種別が途中へ挿入されただけで以降が全部ずれて偽陽性になる。
 */
function variantKey(variant: unknown, index: number): string {
  if (isRecord(variant)) {
    const properties = variant["properties"];
    if (isRecord(properties)) {
      const discriminator = properties["type"];
      if (isRecord(discriminator)) {
        const values = discriminator["enum"];
        if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") {
          return values[0];
        }
      }
    }
  }
  return `#${index}`;
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

  const baselineType = baseline["type"];
  const currentType = current["type"];
  if (
    typeof baselineType === "string" &&
    typeof currentType === "string" &&
    baselineType !== currentType
  ) {
    report({
      kind: "PROPERTY_TYPE_CHANGED",
      location,
      detail: `type ${baselineType} -> ${currentType}`,
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
    const currentByKey = new Map(
      currentVariants.map((variant, index) => [variantKey(variant, index), variant]),
    );
    for (const [index, variant] of baselineVariants.entries()) {
      const key = variantKey(variant, index);
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
