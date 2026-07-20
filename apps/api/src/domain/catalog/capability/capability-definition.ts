import { createCapabilityId, type CapabilityId } from "../definitions/catalog-ids.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertEnumValue,
  assertNonEmptyArray,
  assertString,
} from "../../shared/validate.js";

const CAPABILITY_SCHEMA_STATUSES = ["SUPPORTED", "PLANNED", "BLOCKED"] as const;
export type CapabilitySchemaStatus = (typeof CAPABILITY_SCHEMA_STATUSES)[number];

const CAPABILITY_RUNTIME_STATUSES = ["IMPLEMENTED", "PLANNED", "BLOCKED"] as const;
export type CapabilityRuntimeStatus = (typeof CAPABILITY_RUNTIME_STATUSES)[number];

export interface CapabilityVerification {
  readonly productionDefinitionIds: readonly string[];
  readonly testCaseIds: readonly string[];
}

export interface CapabilityDefinition {
  readonly capabilityId: CapabilityId;
  /** Whether the current Catalog schema can describe this capability without approximation. */
  readonly schemaStatus: CapabilitySchemaStatus;
  /** Whether the Battle Engine can execute it through the production lifecycle. */
  readonly runtimeStatus: CapabilityRuntimeStatus;
  /** The one roadmap task responsible for moving runtimeStatus to IMPLEMENTED. */
  readonly implementationTaskId: string;
  readonly description: string;
  /** Production and test evidence required before runtimeStatus can become IMPLEMENTED. */
  readonly verification: CapabilityVerification;
}

export interface CapabilityDefinitionInput {
  readonly capabilityId: string;
  readonly schemaStatus: string;
  readonly runtimeStatus: string;
  readonly implementationTaskId: string;
  readonly description: string;
  readonly verification: CapabilityVerification;
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (value.trim().length === 0) {
    throw new DomainValidationError(path, "must not be empty");
  }
}

function assertUniqueStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new DomainValidationError(path, `must not contain duplicate value "${value}"`);
    }
    seen.add(value);
  }
}

export function createCapabilityDefinition(
  input: CapabilityDefinitionInput,
  path = "capability",
): CapabilityDefinition {
  const capabilityId = createCapabilityId(input.capabilityId, `${path}.capabilityId`);
  assertEnumValue(input.schemaStatus, CAPABILITY_SCHEMA_STATUSES, `${path}.schemaStatus`);
  assertEnumValue(input.runtimeStatus, CAPABILITY_RUNTIME_STATUSES, `${path}.runtimeStatus`);
  assertNonEmptyString(input.implementationTaskId, `${path}.implementationTaskId`);
  assertNonEmptyString(input.description, `${path}.description`);
  assertArray(
    input.verification.productionDefinitionIds,
    `${path}.verification.productionDefinitionIds`,
  );
  assertArray(input.verification.testCaseIds, `${path}.verification.testCaseIds`);
  for (const [index, definitionId] of input.verification.productionDefinitionIds.entries()) {
    assertNonEmptyString(definitionId, `${path}.verification.productionDefinitionIds[${index}]`);
  }
  for (const [index, testCaseId] of input.verification.testCaseIds.entries()) {
    assertNonEmptyString(testCaseId, `${path}.verification.testCaseIds[${index}]`);
  }
  assertUniqueStrings(
    input.verification.productionDefinitionIds,
    `${path}.verification.productionDefinitionIds`,
  );
  assertUniqueStrings(input.verification.testCaseIds, `${path}.verification.testCaseIds`);
  if (input.runtimeStatus === "IMPLEMENTED") {
    assertNonEmptyArray(
      input.verification.productionDefinitionIds,
      `${path}.verification.productionDefinitionIds`,
    );
    assertNonEmptyArray(input.verification.testCaseIds, `${path}.verification.testCaseIds`);
  }
  return deepFreeze({
    capabilityId,
    schemaStatus: input.schemaStatus,
    runtimeStatus: input.runtimeStatus,
    implementationTaskId: input.implementationTaskId,
    description: input.description,
    verification: input.verification,
  });
}
