"""レジーム署名の観測（Phase A）。

目的関数は滑らかな部分と不連続な部分の合成である。攻撃力・会心率・会心ダメージ・属性
相性はダメージへ単調に効き、不連続は**順位で決まるもの**——`HIGHEST_ATTACK` /
`LOWEST_ATTACK` の当て先、行動順、単発消費デバフの消費者——から来る。この不連続を
**レジーム**として扱う。

**レジームは事前に列挙できない。** バフ込みの実効値は回さないと分からず、レジームの
不等式をギア枚数の制約として書けないためである。したがって署名は「配分を評価した結果
として観測されるもの」であり、探索中に発見して束ねる。

観測は単発実行（`POST /api/v1/tactical-exercises`、`DETAILED`）1回で行う。一括評価は
数値しか返さないので、誰へ効果が付いたかはこの経路でしか取れない。

**Python側は最小限に留める。** UIの効果トレースと同じ射影（解決時点の候補比較・余裕幅）
は再実装しない。ここで取るのは「誰へ付いたか」だけである。

順位セレクタで対象が決まる効果かどうかは、このツールからは判別できない——一括評価にも
Catalog APIにもセレクタ定義が無いためである。そこで**観測できた全効果の初回付与先**を
署名に載せる。順位で決まらない効果は配分を変えても付与先が動かないので、署名の成分と
しては定数であり、偽の「レジームが変わった」を作らない。比較は両方の観測に現れた成分
だけで行う（片方にしか無い成分は「別のレジーム」ではなく「観測されなかった」である）。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..api import BattleLogEvent, LabApiClient, TacticalExerciseResponse, build_exercise_request
from .allocation import Allocation
from .formation import GearFormationSource

ACTION_QUEUE_CREATED = "ACTION_QUEUE_CREATED"
ACTION_STARTED = "ACTION_STARTED"
EFFECT_APPLIED = "EFFECT_APPLIED"
EFFECT_CONSUMPTION_CHANGED = "EFFECT_CONSUMPTION_CHANGED"

# 行動順は署名の成分名としてこの1語で扱う（成分ごとの差分を名前で報告するため）。
ACTION_ORDER_COMPONENT = "actionOrder"

ENEMY_SIDE = "ENEMY"


def slot_label(slot_index: int, unit_definition_id: str) -> str:
    """味方枠の呼び名。同じユニットを2マスへ置ける以上、IDだけでは枠を特定できない。"""
    return f"{slot_index}:{unit_definition_id}"


def enemy_label(unit_definition_id: str) -> str:
    return f"enemy:{unit_definition_id}"


@dataclass(frozen=True)
class RegimeSignature:
    """1回の観測から取った署名。

    成分は3つ。行動順、各効果の**初回**付与先、単発消費効果の**初回**消費者である。
    初回だけを見るのは、後半の解決がブレイク解除の絡みで揺れるためで、そこを含めると
    同じ配分でも観測ごとに違う署名が出る。
    """

    action_order: tuple[str, ...] = ()
    assignments: Mapping[str, str] = field(default_factory=dict)
    consumers: Mapping[str, str] = field(default_factory=dict)
    holders: Mapping[str, str] = field(default_factory=dict)

    def recipient(self, component: str) -> str | None:
        return self.assignments.get(component)

    def digest(self) -> str:
        """署名の短い識別子。到達したレジームを数え上げるために使う。"""
        payload = json.dumps(
            {
                "actionOrder": list(self.action_order),
                "assignments": dict(sorted(self.assignments.items())),
                "consumers": dict(sorted(self.consumers.items())),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]

    def differences(self, other: RegimeSignature) -> tuple[str, ...]:
        """食い違う成分の名前。両方に現れた成分だけを比べる。

        片方にしか無い成分を差分に数えない。効果が1度も発動しなかった観測は「別の
        レジーム」ではなく「その成分を観測できなかった」であり、そこを差分に数えると
        乱数のゆらぎがレジーム変更として報告される。
        """
        found: list[str] = []
        if self.action_order and other.action_order and self.action_order != other.action_order:
            found.append(ACTION_ORDER_COMPONENT)
        for mapping, theirs in (
            (self.assignments, other.assignments),
            (self.consumers, other.consumers),
        ):
            for component, value in mapping.items():
                if component in theirs and theirs[component] != value:
                    found.append(component)
        return tuple(sorted(set(found)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "digest": self.digest(),
            "actionOrder": list(self.action_order),
            "assignments": dict(sorted(self.assignments.items())),
            "consumers": dict(sorted(self.consumers.items())),
            "holders": dict(sorted(self.holders.items())),
        }


def extract_signature(response: TacticalExerciseResponse) -> RegimeSignature:
    """`DETAILED` のイベント列から署名を組む。純粋関数（HTTPを知らない）。"""
    labels = _labels(response)
    events = sorted(response.events, key=lambda event: event.sequence)
    consumers, holders = _consumers(events, labels)
    return RegimeSignature(
        action_order=_action_order(events, labels),
        assignments=_assignments(events, labels),
        consumers=consumers,
        holders=holders,
    )


def _labels(response: TacticalExerciseResponse) -> dict[str, str]:
    """参加枠ID → 呼び名。味方は編成順の索引つき、敵は `enemy:` 接頭辞。

    索引は `initialState.units` の味方側の並び（`10_API設計.md`「配列順は味方陣営を
    先に、各陣営は配置順」）であり、送信した `allyFormation.units` と同じ順である。
    """
    labels: dict[str, str] = {}
    slot_index = 0
    for unit in response.initial_state.units:
        if unit.side == ENEMY_SIDE:
            labels[unit.battle_unit_id] = enemy_label(unit.unit_definition_id)
            continue
        labels[unit.battle_unit_id] = slot_label(slot_index, unit.unit_definition_id)
        slot_index += 1
    return labels


def _action_order(events: Sequence[BattleLogEvent], labels: Mapping[str, str]) -> tuple[str, ...]:
    """最初の周回の予約順。2周目以降は速度バフとブレイク解除で揺れる。"""
    for event in events:
        if event.type != ACTION_QUEUE_CREATED:
            continue
        reservations = event.details.get("reservations", [])
        return tuple(
            labels.get(entry.get("battleUnitId", ""), entry.get("battleUnitId", ""))
            for entry in reservations
        )
    return ()


def _assignments(events: Sequence[BattleLogEvent], labels: Mapping[str, str]) -> dict[str, str]:
    first: dict[str, str] = {}
    for event in events:
        if event.type != EFFECT_APPLIED:
            continue
        definition = event.details.get("effectActionDefinitionId")
        target = event.details.get("targetUnitId")
        if not definition or not target or definition in first:
            continue
        first[definition] = labels.get(target, target)
    return first


def _consumers(
    events: Sequence[BattleLogEvent], labels: Mapping[str, str]
) -> tuple[dict[str, str], dict[str, str]]:
    """初回消費の「そのとき行動していた枠」と保持者。

    消費イベントが持つのは保持者だけである（`EffectConsumptionChanged`）。単発消費の
    デバフは敵が保持し、消費するのは攻撃した側なので、保持者を消費者と読み替えると
    誰の得になったのかが逆になる。行動中の枠は直前の `ACTION_STARTED` から取る。
    """
    definitions: dict[str, str] = {}
    holders: dict[str, str] = {}
    consumers: dict[str, str] = {}
    consumed_holders: dict[str, str] = {}
    actor = ""
    for event in events:
        if event.type == ACTION_STARTED:
            actor = labels.get(event.details.get("actorUnitId", ""), "")
            continue
        if event.type == EFFECT_APPLIED:
            instance = event.details.get("effectInstanceId")
            definition = event.details.get("effectActionDefinitionId")
            if instance and definition:
                definitions[instance] = definition
                holders[instance] = labels.get(
                    event.details.get("targetUnitId", ""), event.details.get("targetUnitId", "")
                )
            continue
        if event.type != EFFECT_CONSUMPTION_CHANGED:
            continue
        instance = event.details.get("effectInstanceId", "")
        definition = definitions.get(instance)
        # 観測窓の外で付与された効果は定義IDが分からない。推測せず落とす。
        if definition is None or definition in consumers:
            continue
        consumers[definition] = actor
        consumed_holders[definition] = holders.get(instance, "")
    return consumers, consumed_holders


def observe_signature(
    client: LabApiClient, source: GearFormationSource, allocation: Allocation
) -> tuple[RegimeSignature, TacticalExerciseResponse]:
    """1回だけ回して署名を取る。

    単発実行はseedを受け取らない（`TacticalExerciseRequest` に `seed` は無い）ので、
    観測は乱数を固定できない。初回解決だけを署名に使うのはこの制約への対処でもある。
    """
    response = client.simulate_exercise(
        build_exercise_request(
            ally_formation=source.ally_formation(allocation),
            enemy_formation=source.enemy_formation(),
        )
    )
    return extract_signature(response), response
