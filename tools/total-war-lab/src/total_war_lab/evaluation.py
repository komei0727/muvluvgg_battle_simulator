"""総力戦の評価設定から試行計画を作る。

実行・保存・再開は `mlgg_lab_common.evaluation` / `mlgg_lab_common.storage` の共通基盤を
そのまま使い、ここは「評価設定のケース1件 → 解決済みの総力戦入力」だけを持つ。
"""

from __future__ import annotations

from pathlib import Path

from mlgg_lab_common.evaluation.config import (
    CaseSource,
    InputOptions,
    load_evaluation_config,
    plan_from_config,
)
from mlgg_lab_common.evaluation.models import EvaluationPlan
from mlgg_lab_common.inputs.catalog import Catalog

from .inputs import (
    ResolvedTotalWarInput,
    load_total_war_draft,
    load_total_war_match_file,
    resolve_total_war_input,
)

FORMAT = "TOTAL_WAR"


def resolve_case(source: CaseSource, options: InputOptions) -> ResolvedTotalWarInput:
    loaded = (
        load_total_war_match_file(source.path, formations_dir=options.formations_dir)
        if source.kind == "MATCH_FILE"
        else load_total_war_draft(source.path)
    )
    return resolve_total_war_input(
        loaded,
        player_data_path=options.player_data_path,
        player_data_sides=options.player_data_sides,
        catalog=options.catalog,
    )


def plan_total_war_evaluation(
    config_path: Path, *, catalog: Catalog | None = None, evaluation_id: str | None = None
) -> EvaluationPlan:
    config = load_evaluation_config(config_path, expected_format=FORMAT)
    return plan_from_config(config, resolve_case, catalog=catalog, evaluation_id=evaluation_id)
