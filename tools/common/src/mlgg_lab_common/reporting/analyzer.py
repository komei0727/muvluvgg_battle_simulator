"""形式ごとの集計の口。各ラボの `analysis.py` が1つずつ定義する。"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

Observation = Mapping[str, Any]


@dataclass(frozen=True)
class CsvColumn:
    """CSVの形式固有の列。値が無い（その形式・試行に存在しない）ときは `None` を返し、
    CSVでは空欄になる。0や敗北へ読み替えない。"""

    name: str
    value: Callable[[Observation], object]
    description: str


@dataclass(frozen=True)
class FormatAnalyzer:
    format: str
    # 集計の定義を変えたら上げる。`summary.json` に載り、古い集計と混ぜないために使う。
    statistics_version: int
    # 終了理由として起こり得る値。0件でも内訳に載せる。
    completion_reasons: tuple[str, ...]
    # 完了した観測値（1件以上）からケース1件分の形式固有の統計を作る。
    case_statistics: Callable[[Sequence[Observation]], dict[str, Any]]
    # `case_statistics` の結果を人が読む行にする。
    describe_statistics: Callable[[Mapping[str, Any]], list[str]]
    # 送信する対戦条件の短い説明（ユニットIDの並び等）。
    describe_match: Callable[[Mapping[str, Any]], str]
    csv_columns: tuple[CsvColumn, ...] = ()
    # 統計量の定義（`summary.json` の `definitions` と文書の対応）。
    definitions: Mapping[str, str] = field(default_factory=dict)
