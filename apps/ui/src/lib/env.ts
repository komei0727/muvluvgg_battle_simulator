export interface ApiBaseUrlSuccess {
  readonly ok: true;
  readonly url: string;
}

export interface ApiBaseUrlFailure {
  readonly ok: false;
  readonly reason: "MISSING" | "INVALID_URL" | "NOT_HTTPS";
}

export type ApiBaseUrlResult = ApiBaseUrlSuccess | ApiBaseUrlFailure;

export interface ResolveApiBaseUrlOptions {
  readonly requireHttps: boolean;
}

// GitHub Pages cannot proxy or hold secrets, so the API base URL is the only
// runtime configuration surface. Production must resist an unset, malformed,
// or non-HTTPS value rather than sending traffic to an unintended origin.
export function resolveApiBaseUrl(
  rawValue: string | undefined,
  options: ResolveApiBaseUrlOptions,
): ApiBaseUrlResult {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return { ok: false, reason: "MISSING" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }

  if (options.requireHttps && parsed.protocol !== "https:") {
    return { ok: false, reason: "NOT_HTTPS" };
  }

  const normalized = trimmed.replace(/\/+$/, "");
  return { ok: true, url: normalized };
}
