"""戦術演習の評価設定から試行計画を作る。

実行・保存・再開は `mlgg_lab_common.evaluation` / `mlgg_lab_common.storage` の共通基盤を
そのまま使い、ここは「評価設定のケース1件 → 解決済みの演習入力」だけを持つ。

対戦入力は演習の編成定義YAML（`ally` + `enemy`。`ally` は編成ライブラリの参照
`{ library: <id> }` でもよい）かUIの演習ドラフト（`mlgg:last-draft:exercise`）である。
手持ちデータは味方にだけ当てる——演習の敵は強化を持たない（R-TEX-01 #3）。
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
from mlgg_lab_common.models import ConfigError, InputSource

from .inputs.exercise import (
    ResolvedExerciseInput,
    load_exercise_draft,
    load_exercise_match_file,
    resolve_exercise_config,
)

FORMAT = "TACTICAL_EXERCISE"


def resolve_case(source: CaseSource, options: InputOptions) -> ResolvedExerciseInput:
    if options.player_data_sides != ("ALLY",):
        raise ConfigError(
            "戦術演習の手持ちデータは味方にだけ当てる（演習の敵は強化を持たない、R-TEX-01 #3）。"
            f"inputs.playerDataSides は [ALLY] にする（{list(options.player_data_sides)}）"
        )
    if source.kind == "MATCH_FILE":
        config, sources = load_exercise_match_file(
            source.path, formations_dir=options.formations_dir
        )
    else:
        config = load_exercise_draft(source.path)
        sources = [InputSource(role="DRAFT", path=str(source.path))]
    return resolve_exercise_config(
        config,
        origin=sources,
        player_data_path=options.player_data_path,
        catalog=options.catalog,
    )


def plan_exercise_evaluation(
    config_path: Path, *, catalog: Catalog | None = None, evaluation_id: str | None = None
) -> EvaluationPlan:
    config = load_evaluation_config(config_path, expected_format=FORMAT)
    return plan_from_config(config, resolve_case, catalog=catalog, evaluation_id=evaluation_id)
