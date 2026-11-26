"""各ラボの入力解決に共通する手順。

    編成ファイル / UIドラフト / 編成ライブラリ
      + 育成情報（手持ちデータ）
      + Catalog
        → 読み込み → 育成情報の適用 → 共通・形式別の検証 → 解決済みの対戦入力

形式ごとの組み立て（どの陣営・どの編成へ手持ちデータを当てるか、どの検証を足すか）は
各ラボが持ち、ここは部品だけを持つ。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ..models.formation import ConfigError, FormationSpec
from ..models.resolved import InputSource
from .player_data import PlayerData, apply_player_data, load_player_data


class InputValidationError(ConfigError):
    """事前検証で見つかった問題をすべて持つ。最初の1件で止めずにまとめて返す。"""

    def __init__(self, errors: Sequence[str]) -> None:
        self.errors = list(errors)
        super().__init__("入力の検証に失敗した:\n" + "\n".join(f"  - {e}" for e in self.errors))


def raise_if_invalid(errors: Sequence[str]) -> None:
    if errors:
        raise InputValidationError(errors)


@dataclass(frozen=True)
class PlayerDataInput:
    data: PlayerData
    source: InputSource


def load_player_data_input(path: Path) -> PlayerDataInput:
    return PlayerDataInput(
        data=load_player_data(path), source=InputSource(role="PLAYER_DATA", path=str(path))
    )


def apply_player_data_at(
    formation: FormationSpec, data: PlayerData, where: str
) -> tuple[FormationSpec, list[str]]:
    """手持ちデータを1編成へ適用し、警告へ入力内の位置を添えて返す。

    複数の編成へ同じ手持ちデータを当てる形式（通常戦闘の両陣営、総力戦の編成列）で、
    どの編成の警告かを読み分けられるようにする。
    """
    applied, warnings = apply_player_data(formation, data)
    return applied, [f"{where}: {warning}" for warning in warnings]
