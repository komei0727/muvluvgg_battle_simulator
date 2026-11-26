"""試行計画の作成。解決済み入力・seed・試行番号を確定し、送信内容を自己完結で持つ。"""

import pytest

from mlgg_lab_common.evaluation.identity import match_fingerprint, trial_key
from mlgg_lab_common.evaluation.models import Budget, ExecutionSettings
from mlgg_lab_common.evaluation.plan import CaseSpec, PlanError, create_plan, run_range
from mlgg_lab_common.testing import FakeBattleInput, FakeTotalWarInput


def plan_of(*cases: CaseSpec, **kwargs):
    kwargs.setdefault("seed", "study-1")
    kwargs.setdefault("budget", Budget(max_submitted_runs=1000))
    return create_plan("BATTLE", cases, **kwargs)


def test_plan_snapshots_resolved_input_request_and_slots():
    battle = FakeBattleInput.of(["UNIT_A", "UNIT_A"], ["UNIT_B"], turn_limit=7)

    plan = plan_of(CaseSpec("mirror", battle, [0, 1, 42]))

    case = plan.cases[0]
    assert case.case_id == "mirror"
    assert case.run_indices == (0, 1, 42)
    assert case.match_request == battle.to_request()
    assert case.input_snapshot["match"]["turnLimit"] == 7
    assert [(s.side, s.formation_number, s.unit_index) for s in case.expected_slots] == [
        ("ALLY", None, 0),
        ("ALLY", None, 1),
        ("ENEMY", None, 0),
    ]
    assert plan.contract.format == "BATTLE"
    assert plan.settings.max_cases_per_request == 64
    assert plan.settings.max_runs_per_request == 300


def test_total_war_plan_uses_its_own_request_limits():
    tw = FakeTotalWarInput.of([["UNIT_A"], ["UNIT_A"]], [["UNIT_B"]])

    plan = create_plan(
        "TOTAL_WAR", [CaseSpec("tw", tw, [0])], seed="s", budget=Budget(max_submitted_runs=10)
    )

    assert (plan.settings.max_cases_per_request, plan.settings.max_runs_per_request) == (32, 120)
    assert [(s.formation_number, s.unit_index) for s in plan.cases[0].expected_slots] == [
        (1, 0),
        (2, 0),
        (1, 0),
    ]


def test_explicit_limits_override_the_contract_defaults():
    battle = FakeBattleInput.of(["UNIT_A"], ["UNIT_B"])

    plan = plan_of(
        CaseSpec("a", battle, [0]),
        settings=ExecutionSettings(max_cases_per_request=2, max_runs_per_request=5),
    )

    assert (plan.settings.max_cases_per_request, plan.settings.max_runs_per_request) == (2, 5)


@pytest.mark.parametrize(
    ("cases", "kwargs", "message"),
    [
        ([("a", [0]), ("a", [1])], {}, "caseId 'a' が重複"),
        ([(" ", [0])], {}, "caseId"),
        ([("a", [])], {}, "試行番号が無い"),
        ([("a", [0, 0])], {}, "試行番号 0 が重複"),
        ([("a", [-1])], {}, "0～4294967295"),
        ([("a", [4294967296])], {}, "0～4294967295"),
        ([("a", [0])], {"seed": "  "}, "seed"),
        ([], {}, "ケースが無い"),
    ],
)
def test_invalid_plans_are_rejected(cases, kwargs, message):
    battle = FakeBattleInput.of(["UNIT_A"], ["UNIT_B"])

    with pytest.raises(PlanError, match=message):
        plan_of(*(CaseSpec(cid, battle, runs) for cid, runs in cases), **kwargs)


def test_inputs_of_another_format_are_rejected():
    tw = FakeTotalWarInput.of([["UNIT_A"]], [["UNIT_B"]])

    with pytest.raises(PlanError, match="TOTAL_WAR"):
        plan_of(CaseSpec("a", tw, [0]))


def test_identical_matches_under_different_case_ids_stay_separate_cases():
    battle = FakeBattleInput.of(["UNIT_A"], ["UNIT_B"])

    plan = plan_of(CaseSpec("a", battle, [0]), CaseSpec("b", battle, [0]))

    assert [c.case_id for c in plan.cases] == ["a", "b"]
    assert plan.cases[0].match_fingerprint == plan.cases[1].match_fingerprint


def test_trial_identity_ignores_case_id_and_depends_on_match_seed_and_run_index():
    request = FakeBattleInput.of(["UNIT_A"], ["UNIT_B"]).to_request()
    other = FakeBattleInput.of(["UNIT_A"], ["UNIT_C"]).to_request()
    fp = match_fingerprint("BATTLE", request)

    assert match_fingerprint("BATTLE", dict(reversed(list(request.items())))) == fp
    assert match_fingerprint("BATTLE", other) != fp
    assert match_fingerprint("TOTAL_WAR", request) != fp
    assert trial_key(fp, "s", 1) == trial_key(fp, "s", 1)
    assert len({trial_key(fp, "s", 1), trial_key(fp, "s", 2), trial_key(fp, "t", 1)}) == 3


def test_run_range_counts_from_start():
    assert run_range(3) == [0, 1, 2]
    assert run_range(2, start=40) == [40, 41]


def test_budget_must_be_positive():
    with pytest.raises(ValueError):
        Budget(max_submitted_runs=0)
