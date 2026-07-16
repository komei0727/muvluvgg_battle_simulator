const UNSET_BUILD_REVISION = "dev";

// The Pages deploy workflow (Issue #99) sets VITE_BUILD_REVISION to the
// deployed Git SHA so the observability surface
// (05_非機能・アクセシビリティ設計.md §13) can show which build served the
// page; local dev and PR builds never set it, so this must degrade to a
// stable placeholder rather than an empty string.
export function resolveBuildRevision(rawValue: string | undefined): string {
  const trimmed = rawValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNSET_BUILD_REVISION;
}
