#!/usr/bin/env bash
# Delegates to the canonical PR-level quality gate at the repository root
# (scripts/run-quality-gates.sh). Keep the gate definition there — this
# wrapper only resolves the repository root for skill invocations.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [[ "$(mise exec -- node -p "require('./package.json').name")" != "muvluvgg-battle-simulator" ]]; then
  echo "error: run this script in the muvluvgg-battle-simulator repository" >&2
  exit 2
fi

bash scripts/run-quality-gates.sh
