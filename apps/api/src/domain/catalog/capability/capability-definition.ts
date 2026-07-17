import { createCapabilityId, type CapabilityId } from "../definitions/catalog-ids.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { assertArray, assertEnumValue } from "../../shared/validate.js";

const CAPABILITY_STATUSES = ["IMPLEMENTED", "PLANNED", "BLOCKED"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityDefinition {
  readonly capabilityId: CapabilityId;
  readonly status: CapabilityStatus;
  readonly description: string;
  readonly requiredBy: readonly string[];
}

export interface CapabilityDefinitionInput {
  readonly capabilityId: string;
  readonly status: string;
  readonly description: string;
  readonly requiredBy: readonly string[];
}

export function createCapabilityDefinition(
  input: CapabilityDefinitionInput,
  path = "capability",
): CapabilityDefinition {
  const capabilityId = createCapabilityId(input.capabilityId, `${path}.capabilityId`);
  assertEnumValue(input.status, CAPABILITY_STATUSES, `${path}.status`);
  assertArray(input.requiredBy, `${path}.requiredBy`);
  return deepFreeze({
    capabilityId,
    status: input.status,
    description: input.description,
    requiredBy: input.requiredBy,
  });
}
