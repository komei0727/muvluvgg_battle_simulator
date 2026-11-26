"""`battle-lab` コマンド。通常戦闘の評価（evaluate / resume / status / summarize / export）。

    uv run battle-lab evaluate battle-lab/configs/evaluation.example.yaml
    uv run battle-lab summarize data/evaluations/<evaluation-id>

通信・保存・再開・表示は `mlgg_lab_common.cli` の共通部が持つ。
"""

from __future__ import annotations

from mlgg_lab_common.cli import LabCommands, build_lab_app

from .analysis import ANALYZER
from .evaluation import FORMAT, plan_battle_evaluation

LAB = LabCommands(
    name="battle-lab", format=FORMAT, planner=plan_battle_evaluation, analyzer=ANALYZER
)
app = build_lab_app(LAB, help="通常戦闘の評価を実行・再開し、保存結果を集計・出力する")

if __name__ == "__main__":
    app()
