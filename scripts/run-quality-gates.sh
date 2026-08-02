#!/usr/bin/env bash
# Canonical PR-level quality gate. Runs every check the PR CI
# (.github/workflows/pr.yml) runs, in the same job order:
#   changes -> quality -> container -> ui.
# Must be executed from the repository root.
#
# Prerequisites:
#   - Docker daemon running (test:container builds and smoke-tests the
#     production image).
#   - Playwright Chromium is installed automatically before ui:e2e
#     (on Linux with --with-deps, same as the PR CI).
#
# Platform note: ui:e2e:visual only runs on Linux — its screenshot
# baselines are Linux-only (apps/ui/e2e/visual-regression.spec.ts), so on
# other platforms the step is skipped here and left to the PR CI.
set -euo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker daemon is not available. test:container requires Docker;" >&2
  echo "       start Docker and re-run. (PR CI runs this gate — do not skip it.)" >&2
  exit 2
fi

# changes job
mise run format:check
mise run ci:test

# quality job (apps/api)
mise run typecheck
mise run lint
mise run test:coverage
mise run check:circular

# container job (apps/api, Docker required)
mise run test:container

# ui job (apps/ui)
mise run ui:typecheck
mise run ui:lint
mise run ui:test
mise run ui:build
if [[ "$(uname -s)" == "Linux" ]]; then
  # Same as PR CI: install OS-level browser dependencies too (uses apt,
  # may prompt for sudo outside CI).
  mise exec -- pnpm --filter ui exec playwright install --with-deps chromium
else
  mise exec -- pnpm --filter ui exec playwright install chromium
fi
mise run ui:e2e
if [[ "$(uname -s)" == "Linux" ]]; then
  mise run ui:e2e:visual
else
  echo "skip: ui:e2e:visual (baselines are Linux-only; verified by the PR CI)" >&2
fi
