import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./env.js";

describe("resolveApiBaseUrl", () => {
  it("rejects an unset value", () => {
    const result = resolveApiBaseUrl(undefined, { requireHttps: true });

    expect(result).toEqual({ ok: false, reason: "MISSING" });
  });

  it("rejects an empty value", () => {
    const result = resolveApiBaseUrl("   ", { requireHttps: true });

    expect(result).toEqual({ ok: false, reason: "MISSING" });
  });

  it("rejects a value that is not a well-formed URL", () => {
    const result = resolveApiBaseUrl("not a url", { requireHttps: true });

    expect(result).toEqual({ ok: false, reason: "INVALID_URL" });
  });

  it("accepts an https URL and strips a trailing slash", () => {
    const result = resolveApiBaseUrl("https://api.example.com/", { requireHttps: true });

    expect(result).toEqual({ ok: true, url: "https://api.example.com" });
  });

  it("strips repeated trailing slashes", () => {
    const result = resolveApiBaseUrl("https://api.example.com///", { requireHttps: true });

    expect(result).toEqual({ ok: true, url: "https://api.example.com" });
  });

  it("rejects http when https is required", () => {
    const result = resolveApiBaseUrl("http://api.example.com", { requireHttps: true });

    expect(result).toEqual({ ok: false, reason: "NOT_HTTPS" });
  });

  it("accepts http when https is not required", () => {
    const result = resolveApiBaseUrl("http://localhost:3000", { requireHttps: false });

    expect(result).toEqual({ ok: true, url: "http://localhost:3000" });
  });
});
