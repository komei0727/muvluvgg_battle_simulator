"""総力戦の対戦入力YAML（`match.yaml`）用の JSON Schema を Catalog から生成する。

部品は `mlgg_lab_common.inputs.schema` が持ち、ここは総力戦の形（両陣営1～3編成の
出撃順の列）へ当てはめる。各編成はインラインか編成ライブラリの参照
（`{ library: <id> }`）で、両陣営とも `PLAYABLE`（R-TWR-01 #6）。規定ターン数は
15で固定なので項目を持たない（R-TWR-01 #5）。

編成内のユニット・メモリーの重複（R-TWR-01 #3／#4）と配置重複は、要素の一部に
ついての一意性でJSON Schemaでは表せないため、ローダーだけが落とす。
"""

from __future__ import annotations

from typing import Any

from mlgg_lab_common.inputs.catalog import PLAYABLE, Catalog
from mlgg_lab_common.inputs.schema import (
    apply_formation_catalog,
    finish_schema,
    formation_entry,
    schema_name,
)

from .evaluation import FORMAT
from .inputs import TotalWarMatch

MATCH_SCHEMA = schema_name(FORMAT, "match")


def build_total_war_match_json_schema(catalog: Catalog) -> dict[str, Any]:
    schema: dict[str, Any] = TotalWarMatch.model_json_schema(by_alias=True)
    apply_formation_catalog(schema["$defs"], catalog, PLAYABLE)
    properties = schema["properties"]
    for field in ("allyFormations", "enemyFormations"):
        properties[field]["items"] = formation_entry(properties[field]["items"])
    return finish_schema(schema, catalog, title="total-war-lab match")
