"""`total-war-lab` コマンド。総力戦の評価（evaluate / resume / status / summarize / export）と、
入力YAML用の JSON Schema の生成（schema）。

    uv run total-war-lab evaluate total-war-lab/configs/evaluation.example.yaml
    uv run total-war-lab summarize data/evaluations/<evaluation-id>

通信・保存・再開・表示は `mlgg_lab_common.cli` の共通部が持つ。
"""

from __future__ import annotations

from mlgg_lab_common.cli import LabCommands, build_lab_app
from mlgg_lab_common.inputs.schema import SchemaFile

from .analysis import ANALYZER
from .evaluation import FORMAT, plan_total_war_evaluation
from .schema import MATCH_SCHEMA, build_total_war_match_json_schema

LAB = LabCommands(
    name="total-war-lab",
    format=FORMAT,
    planner=plan_total_war_evaluation,
    analyzer=ANALYZER,
    schemas=(
        SchemaFile(
            name=MATCH_SCHEMA, label="総力戦の対戦入力YAML", build=build_total_war_match_json_schema
        ),
    ),
)
app = build_lab_app(LAB, help="総力戦の評価を実行・再開し、保存結果を集計・出力する")

if __name__ == "__main__":
    app()
