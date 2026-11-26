"""テスト用の入力データ。UIの保存形式（`apps/ui/src/features/formation/persistence.ts`）を写す。

各ラボのテストが同じ形のドラフトを作れるよう、配布物に含めて公開する
（`typer.testing` などと同じ位置付け）。実行時の入力解決からは使わない。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import Field

from .api.client import HttpExchange
from .api.contracts import ExpectedSlot
from .evaluation.identity import canonical_json
from .models import (
    FormationSpec,
    ParticipantSlot,
    ResolvedInput,
    Spec,
    build_formation_request,
    participant_slots,
)


def slot(
    side: str,
    row: str,
    column: int,
    unit_definition_id: str | None = None,
    enhancement: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # JSON.stringify はオブジェクトの `undefined` をキーごと落とすため、
    # 空枠には `unitDefinitionId` が現れない。
    built: dict[str, Any] = {
        "slotKey": f"{side}:{row}:{column}",
        "side": side,
        "row": row,
        "column": column,
    }
    if unit_definition_id is not None:
        built["unitDefinitionId"] = unit_definition_id
    if enhancement is not None:
        built["enhancement"] = enhancement
    return built


ENHANCEMENT = {
    "level": 298,
    "gears": [{"stat": "ATTACK", "tier": "III", "grade": "S"}] + [None] * 8,
}


def draft_body(**overrides: Any) -> dict[str, Any]:
    """`BattleDraft` 本体1件。味方3体（前衛0・2、後衛1）・敵1体・メモリー2件。"""
    draft: dict[str, Any] = {
        "allySlots": [
            slot("ally", "FRONT", 0, "UNIT_A", ENHANCEMENT),
            slot("ally", "FRONT", 1),
            slot("ally", "FRONT", 2, "UNIT_C"),
            slot("ally", "REAR", 0),
            slot("ally", "REAR", 1, "UNIT_D"),
            slot("ally", "REAR", 2),
        ],
        "enemySlots": [
            slot("enemy", "FRONT", 0),
            slot("enemy", "FRONT", 1, "UNIT_ENEMY"),
            slot("enemy", "FRONT", 2),
            slot("enemy", "REAR", 0),
            slot("enemy", "REAR", 1),
            slot("enemy", "REAR", 2),
        ],
        # 空枠は配列上 `null` として並ぶ。
        "allyMemoryDefinitionIds": [None, "MEM_Z", None, "MEM_A", None, None],
        "enemyMemoryDefinitionIds": [None] * 6,
        "turnLimit": 5,
        "logLevel": "SUMMARY",
        "allyEnhancement": {
            "enabled": True,
            "academyLevels": {
                "unitTypes": {"PHYSICAL": 99, "ENERGY": 100, "AGILE": 101},
                "attributes": {
                    "AGGRESSIVE": 102,
                    "SHY": 103,
                    "CUTE": 101,
                    "SMART": 102,
                    "COMICAL": 26,
                    "CLEVER": 27,
                },
            },
        },
        "enemyEnhancement": {
            "enabled": False,
            "academyLevels": {"unitTypes": {}, "attributes": {}},
        },
    }
    draft.update(overrides)
    return draft


def draft_json(**overrides: Any) -> dict[str, Any]:
    """`mlgg:last-draft` / `mlgg:last-draft:exercise` の中身（封筒付き）。"""
    return {"schemaVersion": 1, "catalogRevision": "2026-08-16.3", "draft": draft_body(**overrides)}


# ---------------------------------------------------------------------------
# 評価API（`10_API設計.md`「BattleEvaluationResponse／TotalWarEvaluationResponse」）の応答。


def unit_record(slot: Any, *, damage: int = 100) -> dict[str, Any]:
    """`ExpectedSlot` 1つ分のユニット集計。総力戦の枠（編成番号あり）は出撃フラグも持つ。"""
    record: dict[str, Any] = {
        "side": slot.side,
        "unitIndex": slot.unit_index,
        "unitDefinitionId": slot.unit_definition_id,
        "damageDealt": damage,
        "damageTaken": 0,
        "healingDone": 0,
        "finalHp": 1000,
        "maximumHp": 1000,
        "combatStatus": "ACTIVE",
    }
    if slot.formation_number is not None:
        record["formationNumber"] = slot.formation_number
        record["deployed"] = True
        record["reappearance"] = False
    return record


def battle_run(
    run_index: int, slots: Any, *, outcome: str = "ALLY_WIN", damage: int | None = None
) -> dict[str, Any]:
    dealt = run_index * 10 + 1 if damage is None else damage
    return {
        "runIndex": run_index,
        "outcome": outcome,
        "completionReason": "ENEMY_DEFEATED" if outcome == "ALLY_WIN" else "ALLY_DEFEATED",
        "completedTurn": 1 + run_index % 5,
        "units": [unit_record(s, damage=dealt) for s in slots],
    }


def total_war_run(
    run_index: int, slots: Any, *, outcome: str = "ALLY_WIN", damage: int | None = None
) -> dict[str, Any]:
    run = battle_run(run_index, slots, outcome="ALLY_WIN", damage=damage)
    run["outcome"] = outcome
    run["completionReason"] = "TURN_LIMIT_REACHED" if outcome == "DRAW" else "ENEMY_DEFEATED"
    run["stages"] = [
        {
            "stageNumber": 1,
            "allyFormationNumber": 1,
            "enemyFormationNumber": 1,
            "startTurn": 1,
            "endTurn": run["completedTurn"],
            "defeatedSides": [] if outcome == "DRAW" else ["ENEMY"],
        }
    ]
    run["defeatedFormationCounts"] = {"ally": 0, "enemy": 0 if outcome == "DRAW" else 1}
    return run


def evaluation_response(cases: list[dict[str, Any]], **header: Any) -> dict[str, Any]:
    """ヘッダーの件数（`requestedRuns` 等）はケースから数える。"""
    completed = sum(len(case["runs"]) for case in cases)
    requested = completed + sum(len(case["incompleteRunIndices"]) for case in cases)
    body: dict[str, Any] = {
        "schemaVersion": 1,
        "seed": "s",
        "seedDerivationVersion": "MULBERRY32_FNV1A_SPLITMIX32_V1",
        "catalogRevision": "cat-1",
        "engineRevision": "eng-1",
        "requestedRuns": requested,
        "completedRuns": completed,
        "partial": completed < requested,
        "cases": cases,
    }
    body.update(header)
    return body


# ---------------------------------------------------------------------------
# 解決済み入力の代役。common のテストはラボをimportできないので、ラボの解決済み入力と
# 同じ口（`format` / `to_request()` / `participant_slots()`）だけを持つ最小の型を使う。


def _formation(unit_ids: list[str]) -> FormationSpec:
    return FormationSpec.model_validate(
        {
            "units": [
                {"unitDefinitionId": uid, "position": {"column": i % 3, "row": "FRONT"}}
                for i, uid in enumerate(unit_ids)
            ]
        }
    )


class FakeBattleMatch(Spec):
    ally_formation: FormationSpec = Field(alias="allyFormation")
    enemy_formation: FormationSpec = Field(alias="enemyFormation")
    turn_limit: int = Field(alias="turnLimit")


class FakeBattleInput(ResolvedInput):
    format: Literal["BATTLE"] = "BATTLE"
    match: FakeBattleMatch

    @classmethod
    def of(cls, ally: list[str], enemy: list[str], *, turn_limit: int = 5) -> FakeBattleInput:
        return cls(
            match=FakeBattleMatch(
                ally_formation=_formation(ally),
                enemy_formation=_formation(enemy),
                turn_limit=turn_limit,
            )
        )

    def to_request(self) -> dict[str, Any]:
        return {
            "allyFormation": build_formation_request(self.match.ally_formation),
            "enemyFormation": build_formation_request(self.match.enemy_formation),
            "turnLimit": self.match.turn_limit,
        }

    def participant_slots(self) -> list[ParticipantSlot]:
        return participant_slots(
            "ALLY", [self.match.ally_formation], numbered=False
        ) + participant_slots("ENEMY", [self.match.enemy_formation], numbered=False)


class FakeTotalWarMatch(Spec):
    ally_formations: list[FormationSpec] = Field(alias="allyFormations")
    enemy_formations: list[FormationSpec] = Field(alias="enemyFormations")


class FakeTotalWarInput(ResolvedInput):
    format: Literal["TOTAL_WAR"] = "TOTAL_WAR"
    match: FakeTotalWarMatch

    @classmethod
    def of(cls, ally: list[list[str]], enemy: list[list[str]]) -> FakeTotalWarInput:
        return cls(
            match=FakeTotalWarMatch(
                ally_formations=[_formation(f) for f in ally],
                enemy_formations=[_formation(f) for f in enemy],
            )
        )

    def to_request(self) -> dict[str, Any]:
        return {
            "allyFormations": [build_formation_request(f) for f in self.match.ally_formations],
            "enemyFormations": [build_formation_request(f) for f in self.match.enemy_formations],
        }

    def participant_slots(self) -> list[ParticipantSlot]:
        return participant_slots(
            "ALLY", self.match.ally_formations, numbered=True
        ) + participant_slots("ENEMY", self.match.enemy_formations, numbered=True)


# ---------------------------------------------------------------------------
# 評価APIの偽物。観測値は `(seed, 対戦条件, runIndex)` だけから決まり、`caseId` や
# 要求の分け方には依らない（実APIの乱数列と同じ性質）。


class FakeEvaluationServer:
    """`EvaluationTransport` と同じ口を持つ評価APIの偽物。

    `script` に要求ごとの振る舞いを先頭から積む。空なら毎回正常に応答する。

    - `"ok"`: 正常応答
    - `"lost"`: サーバーは実行したが応答を失う（通信断）
    - `("status", 422, "INVALID_COMMAND", path)`: エラー応答
    - `"garbage"`: 契約と合わない本文
    - `("engine", "eng-2")`: 以降の engineRevision を変える
    - `("flip", case_id, run_index)`: その試行の観測値を変える（非決定性の再現）
    - `"interrupt"`: 実行後に `KeyboardInterrupt`（プロセス中断）
    """

    def __init__(
        self,
        *,
        complete_limit: int | None = None,
        engine_revision: str = "eng-1",
        catalog_revision: str = "cat-1",
        script: list[Any] | None = None,
    ) -> None:
        self.complete_limit = complete_limit
        self.engine_revision = engine_revision
        self.catalog_revision = catalog_revision
        self.script = list(script or [])
        self.requests: list[dict[str, Any]] = []
        self.executed_runs = 0
        self._flipped: set[tuple[str, int]] = set()

    def post_json(self, path: str, payload: dict[str, Any]) -> HttpExchange:
        self.requests.append(payload)
        action = self.script.pop(0) if self.script else "ok"
        if isinstance(action, tuple) and action[0] == "engine":
            self.engine_revision = action[1]
            action = "ok"
        if isinstance(action, tuple) and action[0] == "flip":
            self._flipped.add((action[1], action[2]))
            action = "ok"
        if isinstance(action, tuple) and action[0] == "status":
            _, status, code, *paths = action
            body = {
                "error": {
                    "code": code,
                    "message": "fake",
                    "violations": [{"path": p, "message": "v"} for p in paths],
                }
            }
            return HttpExchange(status, json.dumps(body), None, "t0", "t1")
        if action == "garbage":
            return HttpExchange(200, '{"schemaVersion": 1}', None, "t0", "t1")
        body = self._evaluate(path, payload)
        if action == "lost":
            return HttpExchange(None, None, "ReadTimeout: fake", "t0", "t1")
        if action == "interrupt":
            raise KeyboardInterrupt
        return HttpExchange(200, json.dumps(body), None, "t0", "t1")

    def _evaluate(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        budget = self.complete_limit
        cases = []
        for case in payload["cases"]:
            match = {k: v for k, v in case.items() if k not in ("caseId", "runIndices")}
            runs, incomplete = [], []
            for run_index in case["runIndices"]:
                if budget is not None and budget <= 0:
                    incomplete.append(run_index)
                    continue
                if budget is not None:
                    budget -= 1
                self.executed_runs += 1
                runs.append(self._observe(path, payload["seed"], case, match, run_index))
            cases.append(
                {"caseId": case["caseId"], "runs": runs, "incompleteRunIndices": incomplete}
            )
        return evaluation_response(
            cases,
            seed=payload["seed"],
            engineRevision=self.engine_revision,
            catalogRevision=self.catalog_revision,
        )

    def _observe(
        self, path: str, seed: str, case: dict[str, Any], match: dict[str, Any], run_index: int
    ) -> dict[str, Any]:
        digest = hashlib.sha256(canonical_json([seed, match, run_index]).encode()).digest()
        damage = int.from_bytes(digest[:4], "big")
        if (case["caseId"], run_index) in self._flipped:
            damage += 1
        slots = _slots_of_request(match)
        if path.endswith("total-war-evaluations"):
            outcome = ("ALLY_WIN", "ALLY_LOSE", "DRAW")[digest[4] % 3]
            return total_war_run(run_index, slots, outcome=outcome, damage=damage)
        return battle_run(
            run_index, slots, outcome=("ALLY_WIN", "ALLY_LOSE")[digest[4] % 2], damage=damage
        )


def _slots_of_request(match: dict[str, Any]) -> list[ExpectedSlot]:
    if "allyFormations" in match:
        return [
            ExpectedSlot(side, number, index, unit["unitDefinitionId"])
            for side, key in (("ALLY", "allyFormations"), ("ENEMY", "enemyFormations"))
            for number, formation in enumerate(match[key], start=1)
            for index, unit in enumerate(formation["units"])
        ]
    return [
        ExpectedSlot(side, None, index, unit["unitDefinitionId"])
        for side, key in (("ALLY", "allyFormation"), ("ENEMY", "enemyFormation"))
        for index, unit in enumerate(match[key]["units"])
    ]
