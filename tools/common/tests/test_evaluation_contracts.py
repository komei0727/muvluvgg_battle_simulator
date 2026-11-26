"""評価APIの応答検証。ケースID・試行番号で対応づけ、要求と対応しない応答を全部見つける。"""

import copy

import pytest

from mlgg_lab_common.api.contracts import (
    BATTLE_CONTRACT,
    TOTAL_WAR_CONTRACT,
    EvaluationRequest,
    ExpectedSlot,
    RequestCase,
    ResponseContractError,
    UnsupportedFormatError,
    contract_for,
    validate_response,
)
from mlgg_lab_common.testing import battle_run, evaluation_response, total_war_run

SLOTS = (
    ExpectedSlot("ALLY", None, 0, "UNIT_A"),
    ExpectedSlot("ALLY", None, 1, "UNIT_A"),
    ExpectedSlot("ENEMY", None, 0, "UNIT_B"),
)
TW_SLOTS = (
    ExpectedSlot("ALLY", 1, 0, "UNIT_A"),
    ExpectedSlot("ALLY", 2, 0, "UNIT_A"),
    ExpectedSlot("ENEMY", 1, 0, "UNIT_B"),
)


def battle_request(*cases: tuple[str, tuple[int, ...]]) -> EvaluationRequest:
    return EvaluationRequest(
        contract=BATTLE_CONTRACT,
        seed="s",
        cases=tuple(RequestCase(cid, {"turnLimit": 5}, runs, SLOTS) for cid, runs in cases),
    )


def runs_of(slots, *indices: int, factory=battle_run):
    return [factory(index, slots) for index in indices]


def test_runs_are_matched_by_case_id_and_run_index_not_by_position():
    request = battle_request(("a", (0, 42)), ("b", (7,)))
    # 応答のケース順・試行順を要求と逆にする。
    body = evaluation_response(
        [
            {"caseId": "b", "runs": runs_of(SLOTS, 7), "incompleteRunIndices": []},
            {"caseId": "a", "runs": runs_of(SLOTS, 42, 0), "incompleteRunIndices": []},
        ]
    )

    validated = validate_response(request, body)

    assert sorted((r.case_id, r.run_index) for r in validated.completed) == [
        ("a", 0),
        ("a", 42),
        ("b", 7),
    ]
    assert validated.environment.contract_id == BATTLE_CONTRACT.contract_id
    # 観測値は応答の試行オブジェクトそのもの。
    assert next(r for r in validated.completed if r.run_index == 42).observation == battle_run(
        42, SLOTS
    )


def test_partial_response_keeps_completed_runs_and_lists_the_rest():
    request = battle_request(("a", (0, 1, 2)))
    body = evaluation_response(
        [{"caseId": "a", "runs": runs_of(SLOTS, 1), "incompleteRunIndices": [0, 2]}]
    )

    validated = validate_response(request, body)

    assert [r.run_index for r in validated.completed] == [1]
    assert validated.incomplete == (("a", 0), ("a", 2))


def test_zero_completed_runs_is_a_valid_partial_response():
    request = battle_request(("a", (0, 1)))
    body = evaluation_response([{"caseId": "a", "runs": [], "incompleteRunIndices": [0, 1]}])

    assert validate_response(request, body).completed == ()


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda b: b["cases"][0]["runs"].append(battle_run(9, SLOTS)), "要求していない runIndex 9"),
        (
            lambda b: b["cases"][0]["runs"].append(battle_run(0, SLOTS)),
            "runIndex 0 が完了に2回ある",
        ),
        (lambda b: b["cases"][0]["incompleteRunIndices"].append(0), "完了と未完了の両方"),
        (lambda b: b["cases"][0]["runs"].pop(), "完了にも未完了にも無い"),
        (lambda b: b["cases"].append(copy.deepcopy(b["cases"][0])), "caseId 'a' が応答に2回"),
        (lambda b: b["cases"][0].update(caseId="z"), "要求していない caseId 'z'"),
        (lambda b: b.update(seed="other"), "seed が要求と違う"),
        (lambda b: b.update(completedRuns=1), "completedRuns=1"),
        (lambda b: b.update(requestedRuns=3), "requestedRuns=3"),
        (lambda b: b.update(partial=True), "partial=True"),
        (lambda b: b.update(schemaVersion=2), "schemaVersion=2"),
        (lambda b: b["cases"][0]["runs"][0]["units"].pop(), "の集計が無い"),
        (
            lambda b: b["cases"][0]["runs"][0]["units"][1].update(unitIndex=0),
            "の集計が2件ある",
        ),
        (
            lambda b: b["cases"][0]["runs"][0]["units"][2].update(unitDefinitionId="UNIT_C"),
            "UNIT_C",
        ),
        (lambda b: b["cases"][0]["runs"][0].update(outcome="DRAW"), "契約と合わない"),
    ],
)
def test_responses_that_do_not_correspond_to_the_request_are_rejected(mutate, expected):
    request = battle_request(("a", (0, 1)))
    body = evaluation_response(
        [{"caseId": "a", "runs": runs_of(SLOTS, 0, 1), "incompleteRunIndices": []}]
    )
    mutate(body)

    with pytest.raises(ResponseContractError) as raised:
        validate_response(request, body)

    assert any(expected in problem for problem in raised.value.problems), raised.value.problems


def test_all_problems_are_reported_together():
    request = battle_request(("a", (0, 1)))
    body = evaluation_response([{"caseId": "z", "runs": [], "incompleteRunIndices": []}])
    body["seed"] = "other"

    with pytest.raises(ResponseContractError) as raised:
        validate_response(request, body)

    assert len(raised.value.problems) >= 3


def test_total_war_runs_keep_draws_stages_and_reserve_slots():
    request = EvaluationRequest(
        contract=TOTAL_WAR_CONTRACT,
        seed="s",
        cases=(RequestCase("tw", {}, (0,), TW_SLOTS),),
    )
    run = total_war_run(0, TW_SLOTS, outcome="DRAW")
    # 2編成目は控えのまま終わった（未出撃）。
    run["units"][1]["deployed"] = False
    body = evaluation_response([{"caseId": "tw", "runs": [run], "incompleteRunIndices": []}])

    validated = validate_response(request, body)

    observation = validated.completed[0].observation
    assert observation["outcome"] == "DRAW"
    assert observation["stages"] == run["stages"]
    assert [u["deployed"] for u in observation["units"]] == [True, False, True]


def test_total_war_slots_must_carry_deployment_flags():
    request = EvaluationRequest(
        contract=TOTAL_WAR_CONTRACT, seed="s", cases=(RequestCase("tw", {}, (0,), TW_SLOTS),)
    )
    run = total_war_run(0, TW_SLOTS)
    del run["units"][0]["reappearance"]
    body = evaluation_response([{"caseId": "tw", "runs": [run], "incompleteRunIndices": []}])

    with pytest.raises(ResponseContractError, match="reappearance"):
        validate_response(request, body)


def test_request_body_keeps_case_order_and_run_indices_as_given():
    request = EvaluationRequest(
        contract=BATTLE_CONTRACT,
        seed="s",
        cases=(
            RequestCase("b", {"turnLimit": 3}, (5, 1), SLOTS),
            RequestCase("a", {"turnLimit": 4}, (0,), SLOTS),
        ),
        expected_engine_revision="e1",
    )

    assert request.body() == {
        "seed": "s",
        "cases": [
            {"caseId": "b", "turnLimit": 3, "runIndices": [5, 1]},
            {"caseId": "a", "turnLimit": 4, "runIndices": [0]},
        ],
        "expectedEngineRevision": "e1",
    }


def test_tactical_exercise_has_no_contract_until_the_api_is_redesigned():
    with pytest.raises(UnsupportedFormatError, match="再設計"):
        contract_for("TACTICAL_EXERCISE")
    assert contract_for("BATTLE") is BATTLE_CONTRACT
