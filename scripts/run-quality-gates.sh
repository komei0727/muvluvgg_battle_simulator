#!/usr/bin/env bash
# Run all PR-level quality gates in the same order as CI.
# Must be executed from the repository root.
set -euo pipefail

mise run format-check
mise run typecheck
mise run lint
mise run test:coverage
mise run check-circular
mise run ui:typecheck
mise run ui:lint
mise run ui:test
mise run ui:build
mise run ci:test
