"""実APIでの探索の接続確認。`MLGG_LAB_LIVE_API_URL` を設定したときだけ走る。

    cd apps/api && EVALUATION_ENDPOINT_ENABLED=true PORT=3917 mise exec -- pnpm exec tsx src/main.ts
    cd tools && MLGG_LAB_LIVE_API_URL=http://localhost:3917 \
      uv run pytest tests/test_live_search_api.py

通常戦闘・戦術演習の形式別アダプターと共通の実行制御を、テスト用の接続実装（台本どおりの
提案・要求）で小さく通す。乱数・DB等の内部機構は段階2のテストが確かめる。
"""

import os
from pathlib import Path

import pytest

from battle_lab.inputs import load_battle_match_file, resolve_battle_input
from battle_lab.search_space import BATTLE_SEARCH, battle_search_problem
from exercise_lab.inputs.exercise import resolve_exercise_input
from exercise_lab.search_space import EXERCISE_SEARCH, exercise_search_problem
from mlgg_lab_common.experiments.layout import create_search, open_search
from mlgg_lab_common.inputs.catalog import CatalogClient
from mlgg_lab_common.search import operations as ops
from mlgg_lab_common.search.candidate import Origin
from mlgg_lab_common.search.method import Allocation, Proposal, TrialRequest
from mlgg_lab_common.search.problem import AllyTraining, SearchExecution, SearchSpace
from mlgg_lab_common.search.runner import SearchStopReason, run_search
from mlgg_lab_common.testing import scripted_method

LIVE_URL = os.environ.get("MLGG_LAB_LIVE_API_URL")
pytestmark = pytest.mark.skipif(LIVE_URL is None, reason="MLGG_LAB_LIVE_API_URL が無い")

TOOLS = Path(__file__).resolve().parents[1]


def battle_problem(method):
    resolved = resolve_battle_input(
        load_battle_match_file(TOOLS / "battle-lab/configs/match.example.yaml")
    )
    ally = resolved.match.ally_formation
    return battle_search_problem(
        resolved,
        space=SearchSpace(
            unitPool=[u.unit_definition_id for u in ally.units] + ["UNIT_KOTOHA_DAILY"],
            memoryPool=list(ally.memory_definition_ids),
        ),
        training=AllyTraining(),
        execution=SearchExecution(
            candidateSeed="live",
            battleSeed="live-search-1",
            budget={"maxSubmittedRuns": 40},
            api={"baseUrl": LIVE_URL, "maxRunsPerRequest": 3},
        ),
        method=method.binding(),
    )


def exercise_problem(method):
    resolved = resolve_exercise_input(TOOLS / "exercise-lab/tests/fixtures/match.yaml")
    ally = resolved.match.ally
    return exercise_search_problem(
        resolved,
        space=SearchSpace(
            unitPool=[u.unit_definition_id for u in ally.units],
            memoryPool=list(ally.memory_definition_ids),
        ),
        training=AllyTraining(),
        execution=SearchExecution(
            candidateSeed="live",
            battleSeed="live-search-1",
            budget={"maxSubmittedRuns": 40},
            api={"baseUrl": LIVE_URL, "maxRunsPerRequest": 3},
        ),
        method=method.binding(),
    )


@pytest.mark.parametrize(
    ("build", "adapter", "variant"),
    [
        (battle_problem, BATTLE_SEARCH, lambda c: ops.replace_unit(c, 2, "UNIT_KOTOHA_DAILY")),
        (exercise_problem, EXERCISE_SEARCH, lambda c: ops.swap_memories(c, 0, 5)),
    ],
)
def test_a_scripted_search_runs_end_to_end_against_the_api(tmp_path, build, adapter, variant):
    with CatalogClient(LIVE_URL) as client:
        catalog = client.fetch_catalog()
    start = build(scripted_method([], [])).starts[0]
    changed = variant(start)
    script = (
        [[Proposal(changed, Origin(kind="PROPOSED", operations=("variant",)))]],
        [
            Allocation(
                requests=(
                    TrialRequest(start.candidate_id, runs=2),
                    TrialRequest(changed.candidate_id, run_indices=(0, 7)),
                )
            ),
            Allocation(requests=(TrialRequest(changed.candidate_id, runs=2),)),
        ],
    )
    method = scripted_method(*script)
    directory, store = create_search(
        tmp_path, build(method), adapter, search_id="live", catalog=catalog
    )
    problem = store.load_problem()
    with store, problem.execution.api.http_client() as client:
        report = run_search(store, method, adapter, client, max_steps=1)
        assert report.stop_reason is SearchStopReason.STEP_LIMIT_REACHED

    resumed = scripted_method(*script)
    with open_search(directory) as reopened, problem.execution.api.http_client() as client:
        report = run_search(reopened, resumed, adapter, client)
        assert report.stop_reason is SearchStopReason.METHOD_FINISHED
        assert report.budget.used == 6

    view = resumed.allocator.views[-1]
    assert view.candidates[start.candidate_id].estimate["runIndices"] == [0, 1]
    assert view.candidates[changed.candidate_id].estimate["runIndices"] == [0, 1, 2, 7]
    # 同じ battleSeed・試行番号なので、起点と変更後の runIndex 0 は同じ乱数列で比べられる。
    observations = {
        (o.candidate_id, o.run_index): o.observation
        for entry in view.candidates.values()
        for o in entry.observations
    }
    assert all(o["runIndex"] == index for (_, index), o in observations.items())
