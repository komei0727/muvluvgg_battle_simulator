"""チャンク分割・seed管理と、部分結果の累積。

サーバーは1リクエストの中で `runIndex` を 0 から振り直す
（`evaluate-tactical-exercise-candidates-use-case.ts`）。同じ `seed` のまま分割すると
全チャンクが同じ乱数列を引き当てるため、チャンクごとに別のseed文字列を送る必要がある。
"""

import httpx
import pytest
import respx

from exercise_lab.api import EVALUATION_PATH, LabApiClient
from exercise_lab.models import load_formation_config
from exercise_lab.runner import plan_chunks, run_evaluation

BASE_URL = "http://localhost:3000"

CONFIG_YAML = """
ally:
  units:
    - unitDefinitionId: UNIT_A
      position: { column: 0, row: FRONT }
  memoryDefinitionIds: []
enemy:
  unitDefinitionId: UNIT_ENEMY
  position: { column: 1, row: FRONT }
"""


def test_chunks_cover_every_run_without_exceeding_the_chunk_size():
    chunks = plan_chunks(total_runs=250, base_seed="abc", chunk_size=100)

    assert [chunk.runs for chunk in chunks] == [100, 100, 50]
    assert [chunk.run_offset for chunk in chunks] == [0, 100, 200]


def test_each_chunk_gets_a_distinct_seed_derived_from_its_run_offset():
    chunks = plan_chunks(total_runs=250, base_seed="abc", chunk_size=100)

    assert [chunk.seed for chunk in chunks] == ["abc#0", "abc#100", "abc#200"]


def test_chunk_plan_is_stable_for_the_same_inputs():
    first = plan_chunks(total_runs=7, base_seed="abc", chunk_size=3)
    second = plan_chunks(total_runs=7, base_seed="abc", chunk_size=3)

    assert first == second


def test_zero_or_negative_chunk_size_is_rejected():
    with pytest.raises(ValueError, match="chunk_size"):
        plan_chunks(total_runs=10, base_seed="abc", chunk_size=0)


@respx.mock
def test_each_chunk_posts_its_own_seed_and_run_count(tmp_path):
    route = respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        side_effect=[
            httpx.Response(200, json=evaluation_response(seed="abc#0", runs=2)),
            httpx.Response(200, json=evaluation_response(seed="abc#2", runs=1)),
        ]
    )
    config = load_formation_config(write(tmp_path, CONFIG_YAML))

    with LabApiClient(BASE_URL) as client:
        run_evaluation(client, config, plan_chunks(total_runs=3, base_seed="abc", chunk_size=2))

    sent = [request.read() for request, _ in route.calls]
    assert [body_of(payload)["seed"] for payload in sent] == ["abc#0", "abc#2"]
    assert [body_of(payload)["runsPerCandidate"] for payload in sent] == [2, 1]


@respx.mock
def test_records_carry_the_global_run_index_across_chunks(tmp_path):
    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        side_effect=[
            httpx.Response(200, json=evaluation_response(seed="abc#0", runs=2)),
            httpx.Response(200, json=evaluation_response(seed="abc#2", runs=1)),
        ]
    )
    config = load_formation_config(write(tmp_path, CONFIG_YAML))

    with LabApiClient(BASE_URL) as client:
        result = run_evaluation(
            client, config, plan_chunks(total_runs=3, base_seed="abc", chunk_size=2)
        )

    assert [record.run_index for record in result.records] == [0, 1, 2]
    assert [record.chunk_seed for record in result.records] == ["abc#0", "abc#0", "abc#2"]
    assert [record.run_index_in_chunk for record in result.records] == [0, 1, 0]
    assert result.requested_runs == 3
    assert result.completed_runs == 3


@respx.mock
def test_partial_chunk_is_accumulated_without_retry(tmp_path):
    route = respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        side_effect=[
            # 期限に達したチャンク: 要求2件に対し1件だけ返る（Q-TEX-18）。
            httpx.Response(200, json=evaluation_response(seed="abc#0", runs=1)),
            httpx.Response(200, json=evaluation_response(seed="abc#2", runs=2)),
        ]
    )
    config = load_formation_config(write(tmp_path, CONFIG_YAML))

    with LabApiClient(BASE_URL) as client:
        result = run_evaluation(
            client, config, plan_chunks(total_runs=4, base_seed="abc", chunk_size=2)
        )

    assert route.call_count == 2
    assert result.requested_runs == 4
    assert result.completed_runs == 3
    assert [record.run_index for record in result.records] == [0, 2, 3]


@respx.mock
def test_disabled_endpoint_reports_the_configuration_switch(tmp_path):
    respx.post(f"{BASE_URL}{EVALUATION_PATH}").mock(
        return_value=httpx.Response(
            404,
            json={
                "schemaVersion": 1,
                "error": {
                    "code": "ENDPOINT_DISABLED",
                    "message": "This deployment does not expose the operation.",
                    "violations": [],
                },
            },
        )
    )
    config = load_formation_config(write(tmp_path, CONFIG_YAML))

    with (
        LabApiClient(BASE_URL) as client,
        pytest.raises(Exception, match="EVALUATION_ENDPOINT_ENABLED"),
    ):
        run_evaluation(client, config, plan_chunks(total_runs=1, base_seed="abc", chunk_size=1))


def evaluation_response(*, seed: str, runs: int) -> dict:
    return {
        "schemaVersion": 1,
        "catalogRevision": "2026-06-28.1",
        "seed": seed,
        "runsPerCandidate": runs,
        "candidates": [
            {
                "completedRuns": runs,
                "scores": [1000 + index for index in range(runs)],
                "breakCounts": [3] * runs,
                "completedTurns": [5] * runs,
                "completionReasons": ["TURN_LIMIT_REACHED"] * runs,
            }
        ],
    }


def body_of(payload: bytes) -> dict:
    import json

    return json.loads(payload)


def write(tmp_path, text: str):
    path = tmp_path / "formation.yaml"
    path.write_text(text, encoding="utf-8")
    return path
