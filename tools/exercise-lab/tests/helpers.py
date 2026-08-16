"""オプティマイザのテストが共有する探索設定の雛形。"""

from __future__ import annotations

import zlib
from pathlib import Path
from typing import Any

import yaml

UNIT_POOL = ("UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F", "UNIT_G", "UNIT_H")
MEMORY_POOL = ("MEM_1", "MEM_2", "MEM_3", "MEM_4", "MEM_5", "MEM_6", "MEM_7", "MEM_8")


def search_config_document(**overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "enemy": {"unitDefinitionId": "UNIT_ENEMY", "position": {"column": 1, "row": "REAR"}},
        "unitPool": list(UNIT_POOL),
        "memoryPool": list(MEMORY_POOL),
    }
    document.update(overrides)
    return document


def write_yaml(tmp_path: Path, document: dict[str, Any], name: str = "search.yaml") -> Path:
    path = tmp_path / name
    path.write_text(yaml.safe_dump(document, allow_unicode=True), encoding="utf-8")
    return path


# --- 人工の評価対象 ---------------------------------------------------------
#
# 最適解が分かっている目的関数へノイズを載せる。探索アルゴリズムが「ノイズの中から
# 良い編成へ寄れるか」を、devサーバーを立てずに確かめるために使う。

IDEAL_UNITS = ("UNIT_A", "UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E")
IDEAL_FRONT = ("UNIT_A", "UNIT_B")
IDEAL_MEMORIES = ("MEM_1", "MEM_2", "MEM_3")
# 理想編成の期待値。ノイズ幅より十分大きくし、順位が雑音で決まらないようにする。
IDEAL_SCORE = 1000 + 5 * 200 + 2 * 120 + 3 * 90 + 60
NOISE_RANGE = 400


class ArenaClient:
    """理想編成に近いほど高いスコアを返す評価API。

    ノイズは `(seed, runIndex)` だけで決める。実サーバーが乱数列を候補indexに依らず
    決める（共通乱数法が成り立つ）性質を写しており、同じラウンドの候補は同じノイズで
    比べられる。
    """

    def __init__(
        self,
        *,
        collapse_units: frozenset[str] = frozenset(),
        catalog_revision: str = "arena",
    ):
        # ここに挙げたユニットを含む編成は、5回に1回スコアが大きく崩れる。
        self._collapse_units = collapse_units
        self._catalog_revision = catalog_revision
        self.request_count = 0

    def evaluate(self, body: dict[str, Any]) -> Any:
        from exercise_lab.api import EvaluationResponse

        self.request_count += 1
        runs = body["runsPerCandidate"]
        seed = body["seed"]
        return EvaluationResponse.model_validate(
            {
                "catalogRevision": self._catalog_revision,
                "seed": seed,
                "runsPerCandidate": runs,
                "candidates": [
                    self._evaluate_one(candidate["allyFormation"], seed, runs)
                    for candidate in body["candidates"]
                ],
            }
        )

    def _evaluate_one(self, formation: dict[str, Any], seed: str, runs: int) -> dict[str, Any]:
        strength = self._strength(formation)
        collapses = self._collapses(formation)
        scores = []
        reasons = []
        for run_index in range(runs):
            if collapses and run_index % 5 == 0:
                scores.append(max(0, strength // 5 + _noise(seed, run_index) // 4))
                reasons.append("ALLY_DEFEATED")
                continue
            scores.append(max(0, strength + _noise(seed, run_index)))
            reasons.append("TURN_LIMIT_REACHED")
        return {
            "completedRuns": runs,
            "scores": scores,
            "breakCounts": [3] * runs,
            "completedTurns": [5] * runs,
            "completionReasons": reasons,
        }

    def _strength(self, formation: dict[str, Any]) -> int:
        units = {unit["unitDefinitionId"] for unit in formation["units"]}
        rows = {unit["unitDefinitionId"]: unit["position"]["row"] for unit in formation["units"]}
        memories = tuple(formation["memoryDefinitionIds"])

        strength = 1000
        strength += 200 * len(units & set(IDEAL_UNITS))
        strength += 120 * sum(1 for unit in IDEAL_FRONT if rows.get(unit) == "FRONT")
        strength += 90 * len(set(memories) & set(IDEAL_MEMORIES))
        # 並び順も結果に効く（R-MEM-02 の発動解決順を模す）
        if memories[: len(IDEAL_MEMORIES)] == IDEAL_MEMORIES:
            strength += 60
        # 編成ごとのわずかな差。実エンジンでは、狙いの条件が同点でも構成が違えば結果は
        # 割れる。ここを入れないと「強さが同じなら試行ごとのスコアまで完全一致」になり、
        # 挙動が同じ編成を畳む処理が、別物まで畳んでしまう。
        # 幅は最小の強さ刻み（60）より十分小さく、順位は変えない。
        return strength + _identity_offset(formation)

    def _collapses(self, formation: dict[str, Any]) -> bool:
        units = {unit["unitDefinitionId"] for unit in formation["units"]}
        return bool(units & self._collapse_units)


def _noise(seed: str, run_index: int) -> int:
    mixed = (sum(ord(char) for char in seed) * 2654435761 + run_index * 40503) % (NOISE_RANGE * 2)
    return mixed - NOISE_RANGE


def _identity_offset(formation: dict[str, Any]) -> int:
    """編成そのものから決まる小さな差。`hash` を使わないのはプロセス間で変わるため。"""
    identity = "|".join(
        [
            *(
                f"{unit['position']['row']}{unit['position']['column']}={unit['unitDefinitionId']}"
                for unit in formation["units"]
            ),
            *formation["memoryDefinitionIds"],
        ]
    )
    return zlib.crc32(identity.encode("utf-8")) % 20
