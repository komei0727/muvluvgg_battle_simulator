"""入力YAMLの読み書き。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from ..models.formation import ConfigError, FormationUnitSpec


class FlowMapping(dict[str, object]):
    """1行（flow style）で書き出すマッピング。座標のような短い値を縦に展開しない。"""


def _represent_flow_mapping(dumper: yaml.SafeDumper, data: FlowMapping) -> yaml.Node:
    return dumper.represent_mapping("tag:yaml.org,2002:map", data, flow_style=True)


yaml.SafeDumper.add_representer(FlowMapping, _represent_flow_mapping)


def placement_documents(units: list[FormationUnitSpec]) -> list[dict[str, object]]:
    """ユニットIDと配置だけを書き出す形。強化情報は出さない。

    育成状態の正本は手持ちデータであり、YAMLへ焼くと同じ値が2か所に生まれる。
    """
    return [
        {
            "unitDefinitionId": unit.unit_definition_id,
            "position": FlowMapping(column=unit.position.column, row=unit.position.row),
        }
        for unit in units
    ]


def dump_yaml(document: dict[str, Any]) -> str:
    return yaml.dump(
        document,
        Dumper=yaml.SafeDumper,
        # キー順は渡された辞書のまま（アルファベット順に崩さない）。
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
    )


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise ConfigError(f"{path}: YAMLとして読めない: {error}") from error
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: トップレベルはマッピングでなければならない")
    return raw
