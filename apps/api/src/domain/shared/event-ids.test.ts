import { describe, expect, it } from "vitest";
import { DomainValidationError } from "./errors.js";
import {
  createActionId,
  createDomainEventId,
  createEffectInstanceId,
  createResolutionScopeId,
  createSkillUseId,
} from "./event-ids.js";

describe("Event ID brands", () => {
  it("UT-EVENT-ID-001: creates a DomainEventId from a non-empty string", () => {
    expect(createDomainEventId("battle-1:1")).toBe("battle-1:1");
  });

  it("UT-EVENT-ID-002: rejects an empty DomainEventId", () => {
    expect(() => createDomainEventId("")).toThrow(DomainValidationError);
  });

  it("UT-EVENT-ID-003: creates an ActionId from a non-empty string", () => {
    expect(createActionId("battle-1:action:1")).toBe("battle-1:action:1");
  });

  it("UT-EVENT-ID-004: creates a SkillUseId from a non-empty string", () => {
    expect(createSkillUseId("battle-1:skill-use:1")).toBe("battle-1:skill-use:1");
  });

  it("UT-EVENT-ID-005: creates a ResolutionScopeId from a non-empty string", () => {
    expect(createResolutionScopeId("battle-1:scope:1")).toBe("battle-1:scope:1");
  });

  it("UT-EVENT-ID-006: creates an EffectInstanceId from a non-empty string", () => {
    expect(createEffectInstanceId("battle-1:effect:1")).toBe("battle-1:effect:1");
  });

  it("UT-EVENT-ID-007: rejects an empty EffectInstanceId", () => {
    expect(() => createEffectInstanceId("")).toThrow(DomainValidationError);
  });
});
