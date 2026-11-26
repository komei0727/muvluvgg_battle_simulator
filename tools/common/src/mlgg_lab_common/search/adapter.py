"""形式別アダプターの契約。

共通基盤は候補・探索範囲・ギア条件の共通の制約だけを持ち、形式ごとの固定条件の解釈・
対戦入力の組み立て・形式固有の合法性検証は各ラボのアダプターが持つ
（`battle_lab.search_space` / `exercise_lab.search_space`）。

アダプターが組み立てる入力は、評価計画（段階2）へそのまま渡せる解決済み入力
（`ResolvedInput` かつ `EvaluableInput`）である。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Protocol

from ..evaluation.plan import EvaluableInput
from ..inputs.catalog import Catalog
from ..models.formation import FormationSpec

if TYPE_CHECKING:
    from .problem import SearchProblem


class FormatSearchAdapter(Protocol):
    format: str

    def fixed_problems(self, fixed: Mapping[str, Any]) -> list[str]:
        """固定条件が形式の契約を満たさない理由（満たせば空）。"""
        ...

    def build_input(self, problem: SearchProblem, ally: FormationSpec) -> EvaluableInput:
        """味方編成と固定条件から解決済みの対戦入力を作る。成立しなければ `ConfigError`。"""
        ...

    def catalog_problems(self, problem: SearchProblem, catalog: Catalog) -> list[str]:
        """使用可能プール・固定条件の参照をCatalogと突き合わせた問題（事前検証）。"""
        ...
