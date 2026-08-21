"""レジーム署名の抽出。行動順・順位で決まる効果の付与先・単発消費デバフの消費者。"""

import pytest

from exercise_lab.api import TacticalExerciseResponse
from exercise_lab.gear.regime import (
    RegimeSignature,
    extract_signature,
    slot_label,
)

ROSTER = [
    {
        "battleUnitId": "BU_A",
        "unitDefinitionId": "UNIT_A",
        "side": "ALLY",
        "formationPosition": {"column": 0, "row": "FRONT"},
    },
    {
        "battleUnitId": "BU_B",
        "unitDefinitionId": "UNIT_B",
        "side": "ALLY",
        "formationPosition": {"column": 1, "row": "FRONT"},
    },
    {
        "battleUnitId": "BU_E",
        "unitDefinitionId": "UNIT_ENEMY",
        "side": "ENEMY",
        "formationPosition": {"column": 1, "row": "REAR"},
    },
]


def event(sequence, type_, details, **extra):
    return {
        "sequence": sequence,
        "type": type_,
        "category": "FACT",
        "targetUnitIds": [],
        "details": details,
        **extra,
    }


def response(events, roster=None):
    return TacticalExerciseResponse.model_validate(
        {
            "catalogRevision": "rev",
            "result": {
                "completionReason": "TURN_LIMIT_REACHED",
                "completedTurn": 5,
                "totalScore": 100,
                "breakCount": 0,
            },
            "initialState": {"units": roster or ROSTER},
            "events": events,
        }
    )


QUEUE = event(
    1,
    "ACTION_QUEUE_CREATED",
    {
        "cycleNumber": 1,
        "reservations": [
            {"battleUnitId": "BU_B", "reservedActionKind": "AS", "actionSpeed": 900},
            {"battleUnitId": "BU_A", "reservedActionKind": "AS", "actionSpeed": 800},
        ],
    },
)


def test_the_action_order_comes_from_the_first_queue():
    later = event(
        9,
        "ACTION_QUEUE_CREATED",
        {
            "cycleNumber": 2,
            "reservations": [
                {"battleUnitId": "BU_A", "reservedActionKind": "AS", "actionSpeed": 950}
            ],
        },
    )

    signature = extract_signature(response([QUEUE, later]))

    # 2周目以降はブレイク解除や速度バフで揺れる。最初の周回だけを署名に使う。
    # 呼び名は編成枠の索引であって行動順の順位ではない（BU_B は2枠目）。
    assert signature.action_order == ("1:UNIT_B", "0:UNIT_A")


def test_the_first_recipient_of_each_effect_is_recorded():
    first = event(
        2,
        "EFFECT_APPLIED",
        {"effectInstanceId": "EI_1", "effectActionDefinitionId": "ACT_X", "targetUnitId": "BU_A"},
    )
    second = event(
        3,
        "EFFECT_APPLIED",
        {"effectInstanceId": "EI_2", "effectActionDefinitionId": "ACT_X", "targetUnitId": "BU_B"},
    )

    signature = extract_signature(response([QUEUE, first, second]))

    # 後半の解決はブレイク解除の絡みで揺れるため、最初の1件だけを見る。
    assert signature.assignments["ACT_X"] == "0:UNIT_A"


def test_the_consumer_of_a_single_use_effect_is_the_unit_acting_at_that_moment():
    applied = event(
        2,
        "EFFECT_APPLIED",
        {
            "effectInstanceId": "EI_1",
            "effectActionDefinitionId": "ACT_DEBUFF",
            "targetUnitId": "BU_E",
            "consumptionKind": "NEXT_INCOMING_ATTACK",
        },
    )
    action = event(3, "ACTION_STARTED", {"actorUnitId": "BU_B"})
    consumed = event(
        4,
        "EFFECT_CONSUMPTION_CHANGED",
        {
            "effectInstanceId": "EI_1",
            "battleUnitId": "BU_E",
            "kind": "NEXT_INCOMING_ATTACK",
            "before": 1,
            "after": 0,
        },
    )

    signature = extract_signature(response([QUEUE, applied, action, consumed]))

    # 保持者は敵。誰の得になったかは、そのとき行動していた枠でしか分からない。
    assert signature.consumers["ACT_DEBUFF"] == "1:UNIT_B"
    assert signature.holders["ACT_DEBUFF"] == "enemy:UNIT_ENEMY"


def test_a_consumption_without_a_known_instance_is_ignored():
    consumed = event(
        2,
        "EFFECT_CONSUMPTION_CHANGED",
        {
            "effectInstanceId": "EI_UNKNOWN",
            "battleUnitId": "BU_E",
            "kind": "OUTGOING_HIT",
            "before": 1,
            "after": 0,
        },
    )

    signature = extract_signature(response([QUEUE, consumed]))

    assert signature.consumers == {}


def test_slots_are_labelled_by_formation_order_so_duplicate_units_stay_apart():
    roster = [
        {
            "battleUnitId": "BU_1",
            "unitDefinitionId": "UNIT_A",
            "side": "ALLY",
            "formationPosition": {"column": 0, "row": "FRONT"},
        },
        {
            "battleUnitId": "BU_2",
            "unitDefinitionId": "UNIT_A",
            "side": "ALLY",
            "formationPosition": {"column": 1, "row": "FRONT"},
        },
    ]
    applied = event(
        2,
        "EFFECT_APPLIED",
        {"effectInstanceId": "EI", "effectActionDefinitionId": "ACT_X", "targetUnitId": "BU_2"},
    )

    signature = extract_signature(response([applied], roster))

    assert signature.assignments["ACT_X"] == "1:UNIT_A"
    assert slot_label(1, "UNIT_A") == "1:UNIT_A"


# --- 署名の比較 -------------------------------------------------------------


def signature(**overrides) -> RegimeSignature:
    base = {
        "action_order": ("0:UNIT_A", "1:UNIT_B"),
        "assignments": {"ACT_X": "0:UNIT_A", "ACT_Y": "1:UNIT_B"},
        "consumers": {},
        "holders": {},
    }
    base.update(overrides)
    return RegimeSignature(**base)


def test_two_observations_of_the_same_regime_have_the_same_digest():
    assert signature().digest() == signature().digest()
    assert signature(action_order=("1:UNIT_B", "0:UNIT_A")).digest() != signature().digest()


def test_a_component_missing_from_one_observation_is_not_a_difference():
    partial = signature(assignments={"ACT_X": "0:UNIT_A"})

    # 効果が1度も発動しなかったのは「別のレジーム」ではなく「観測されなかった」である。
    assert signature().differences(partial) == ()
    assert partial.differences(signature()) == ()


def test_a_changed_recipient_is_reported_as_a_difference():
    moved = signature(assignments={"ACT_X": "1:UNIT_B", "ACT_Y": "1:UNIT_B"})

    assert signature().differences(moved) == ("ACT_X",)


def test_a_changed_action_order_is_reported_as_a_difference():
    reordered = signature(action_order=("1:UNIT_B", "0:UNIT_A"))

    assert signature().differences(reordered) == ("actionOrder",)


def test_the_recipient_of_a_component_can_be_read_back():
    assert signature().recipient("ACT_X") == "0:UNIT_A"
    assert signature().recipient("ACT_MISSING") is None
    with pytest.raises(KeyError):
        signature().assignments["ACT_MISSING"]
