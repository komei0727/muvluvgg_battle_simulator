import { describe, expect, it } from "vitest";
import { SequenceIdGenerator } from "./sequence-id-generator.js";

describe("SequenceIdGenerator", () => {
  it("UT-IDGEN-001: generates unique sequential IDs with prefix", () => {
    const gen = new SequenceIdGenerator("battle");
    expect(gen.next()).toBe("battle-1");
    expect(gen.next()).toBe("battle-2");
    expect(gen.next()).toBe("battle-3");
  });

  it("UT-IDGEN-002: separate instances with same prefix produce independent sequences", () => {
    const genA = new SequenceIdGenerator("action");
    const genB = new SequenceIdGenerator("action");
    expect(genA.next()).toBe("action-1");
    expect(genB.next()).toBe("action-1");
    expect(genA.next()).toBe("action-2");
  });

  it("UT-IDGEN-003: separate instances with different prefixes produce distinct IDs", () => {
    const battleGen = new SequenceIdGenerator("battle");
    const skillGen = new SequenceIdGenerator("skill-use");
    const ids = [battleGen.next(), skillGen.next(), battleGen.next(), skillGen.next()];
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("UT-IDGEN-004: tracks call count", () => {
    const gen = new SequenceIdGenerator("effect");
    gen.next();
    gen.next();
    expect(gen.callCount).toBe(2);
  });

  it("UT-IDGEN-005: reset restarts the sequence", () => {
    const gen = new SequenceIdGenerator("battle");
    gen.next();
    gen.next();
    gen.reset();
    expect(gen.next()).toBe("battle-1");
    expect(gen.callCount).toBe(1);
  });
});
