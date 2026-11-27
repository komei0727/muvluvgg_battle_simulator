"""総力戦の対戦入力YAML（`match.yaml`）用の JSON Schema を Catalog から生成する。

部品は `mlgg_lab_common.inputs.schema` が持ち、ここは総力戦の形（両陣営1～3編成の
出撃順の列）へ当てはめる。各編成はインラインか編成ライブラリの参照
（`{ library: <id> }`）で、両陣営とも `PLAYABLE`（R-TWR-01 #6）。規定ターン数は
15で固定なので項目を持たない（R-TWR-01 #5）。

編成内のメモリーの重複（R-TWR-01 #4）は `uniqueItems` で表す。ユニットの重複（#3）と
配置重複は、要素の一部についての一意性でJSON Schemaでは表せないため、ローダーだけが落とす。
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
    # 1編成内のメモリー重複（R-TWR-01 #4）。文字列の配列なので `uniqueItems` で表せる。
    # `FormationSpec` の定義は各編成の要素なので、別の編成への再登場は妨げない。
    schema["$defs"]["FormationSpec"]["properties"]["memoryDefinitionIds"]["uniqueItems"] = True
    properties = schema["properties"]
    for field in ("allyFormations", "enemyFormations"):
        properties[field]["items"] = formation_entry(properties[field]["items"])
    return finish_schema(schema, catalog, title="total-war-lab match")
