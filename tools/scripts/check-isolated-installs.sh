#!/usr/bin/env bash
# 各パッケージを、宣言した依存だけを持つ使い捨てのvenvへ入れてimportできるか確かめる。
#
# workspaceの共通venvでは、宣言していない依存も他のパッケージ経由でimportできてしまう。
# ここでは1パッケージずつ（依存先の mlgg-lab-common だけを添えて）入れ直し、宣言の
# 漏れを実際のインストールで検出する。依存の解決は uv.lock と同じ版に固定する。
#
#   bash tools/scripts/check-isolated-installs.sh
set -euo pipefail

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# lockfileの版を制約として渡す（新しい版が出ても結果が変わらないように）。
uv export --project "$TOOLS" --locked --all-packages --no-dev --no-emit-workspace \
  --no-hashes --no-header --no-annotate --quiet > "$WORK/constraints.txt"

check() {
  local name="$1"
  shift
  local packages=()
  while [[ "$1" != "--" ]]; do
    packages+=("$1")
    shift
  done
  shift
  local venv="$WORK/$name"
  uv venv --quiet --python ">=3.12" "$venv"
  uv pip install --quiet --python "$venv/bin/python" --constraint "$WORK/constraints.txt" \
    "${packages[@]}"
  "$venv/bin/python" -I -c "$*"
  echo "ok: $name"
}

# 追加依存なしの common は入力・モデルだけで動き、統計は numpy が無いので読めない。
check common "$TOOLS/common" -- '
import importlib.util
import mlgg_lab_common.inputs.catalog, mlgg_lab_common.inputs.resolution, mlgg_lab_common.inputs.schema
import mlgg_lab_common.inputs.sources, mlgg_lab_common.models, mlgg_lab_common.testing
assert importlib.util.find_spec("numpy") is None, "numpy は statistics 追加依存だけが持ち込む"
'
check common-statistics "$TOOLS/common[statistics]" -- '
import mlgg_lab_common.statistics.descriptive
'
check exercise-lab "$TOOLS/common" "$TOOLS/exercise-lab" -- '
import exercise_lab.cli, exercise_lab.inputs.exercise, exercise_lab.inputs.schema
import exercise_lab.statistics.daily_best, mlgg_lab_common.statistics.descriptive
'
check battle-lab "$TOOLS/common" "$TOOLS/battle-lab" -- '
import importlib.util
import battle_lab.inputs
for unexpected in ("numpy", "typer", "rich", "exercise_lab", "total_war_lab"):
    assert importlib.util.find_spec(unexpected) is None, unexpected
'
check total-war-lab "$TOOLS/common" "$TOOLS/total-war-lab" -- '
import importlib.util
import total_war_lab.inputs
for unexpected in ("numpy", "typer", "rich", "exercise_lab", "battle_lab"):
    assert importlib.util.find_spec(unexpected) is None, unexpected
'
