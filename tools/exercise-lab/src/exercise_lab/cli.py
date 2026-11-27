"""`exercise-lab` コマンド。育成情報・編成情報・Catalogの取り込みを補助し、戦術演習を評価する。

    uv run exercise-lab import-draft local_storage/draft.json --out configs/formation.yaml
    uv run exercise-lab units --grep 純夏
    uv run exercise-lab evaluate exercise-lab/configs/evaluation.example.yaml
    uv run exercise-lab summarize data/evaluations/<evaluation-id>
    uv run exercise-lab inspect data/evaluations/<evaluation-id> --case a --run 7

評価コマンド（evaluate / resume / status / summarize / export）の通信・保存・再開・表示は
`mlgg_lab_common.cli` の共通部が持つ。保存済みの試行の再生（inspect）は `inspect.py` が持つ。

Catalogを引くコマンドの相手はローカルのdevサーバー（`apps/api/` で `mise run dev`）を
既定にする。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from rich.console import Console
from rich.table import Table

from mlgg_lab_common.cli import LabCommands, register_evaluation_commands
from mlgg_lab_common.inputs.catalog import (
    DEFAULT_BASE_URL,
    Catalog,
    CatalogClient,
    CatalogUnit,
    LabApiError,
    search_memories,
    search_units,
)
from mlgg_lab_common.inputs.draft import DraftError
from mlgg_lab_common.inputs.library import (
    DEFAULT_FORMATIONS_DIR,
    FormationLibraryEntry,
    dump_formation_library_entry,
    list_formation_ids,
    load_formation_library_entry,
)
from mlgg_lab_common.inputs.player_data import (
    PlayerData,
    PlayerDataError,
    StoredUnitEnhancement,
    load_player_data,
    resolved_level,
)
from mlgg_lab_common.inputs.schema import build_formation_library_json_schema
from mlgg_lab_common.models import ConfigError

from .analysis import ANALYZER
from .evaluation import FORMAT, plan_exercise_evaluation
from .inputs.exercise import dump_formation_config, load_exercise_draft
from .inputs.schema import build_formation_json_schema
from .inspect import register_inspect_command

DEFAULT_SCHEMA_DIR = Path(".schema")
FORMATION_SCHEMA_JSON = "formation.schema.json"
# 既存の編成ライブラリのファイルがこの名前を `yaml-language-server` の行で指している。
FORMATION_LIBRARY_SCHEMA_JSON = "formation-seed.schema.json"

app = typer.Typer(
    add_completion=False,
    help="育成情報・編成情報・Catalogの取り込みと、戦術演習の評価・集計・出力",
)
console = Console()
error_console = Console(stderr=True)


@app.callback()
def main() -> None:
    """常にサブコマンド形式（`exercise-lab units ...`）を保つために置く。

    typerはコマンドが1つだけのときトップレベルへ畳み込み、`exercise-lab <引数>` になる。
    コマンドの増減で呼び出し方が変わると、それまでの手順・スクリプトが黙って壊れる。
    """


@app.command("import-draft")
def import_draft(
    draft_path: Annotated[
        Path,
        typer.Argument(help="localStorage `mlgg:last-draft:exercise` のJSON", exists=True),
    ],
    out: Annotated[
        Path | None, typer.Option("--out", "-o", help="出力先。省略時は標準出力")
    ] = None,
    library: Annotated[
        bool,
        typer.Option("--library", help="編成ライブラリ形式（configs/formations/<id>.yaml）で出す"),
    ] = False,
    note: Annotated[
        str | None,
        typer.Option("--note", help="編成ライブラリの note（この編成を組んだ意図・狙い）"),
    ] = None,
) -> None:
    """UIで組んだ演習編成を編成定義YAMLへ変換する。IDの転記を不要にする入口。

    `--library` を付けると、敵を含まない編成ライブラリ1件分（`units` +
    `memoryDefinitionIds`）を出す。`configs/formations/<id>.yaml` として保存すれば、
    `exercise-lab formations` にファイル名（ID）で載る。
    """
    if note is not None and not library:
        _abort("--note には --library が要る（note は編成ライブラリだけが持つ項目）")
    try:
        config = load_exercise_draft(draft_path)
    except DraftError as error:
        _abort(str(error))
    if library:
        entry = FormationLibraryEntry(
            note=note,
            units=config.ally.units,
            memory_definition_ids=config.ally.memory_definition_ids,
        )
        document = _IMPORTED_LIBRARY_HEADER.format(
            source=draft_path.name
        ) + dump_formation_library_entry(entry)
    else:
        document = _IMPORTED_HEADER.format(source=draft_path.name) + dump_formation_config(config)
    if out is None:
        # 標準出力へはヘッダーごと出す。リダイレクトしてもそのまま使える。
        print(document, end="")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(document, encoding="utf-8")
    if library:
        console.print(
            f"[bold]{out}[/] を書き出した（味方{len(config.ally.units)}体 /"
            f" メモリー{len(config.ally.memory_definition_ids)}件）。"
            f" configs/formations/ 配下へ置けば `exercise-lab formations` にIDで載る"
        )
        return
    console.print(
        f"[bold]{out}[/] を書き出した（味方{len(config.ally.units)}体 /"
        f" メモリー{len(config.ally.memory_definition_ids)}件 /"
        f" 敵 {config.enemy.unit_definition_id}）"
    )


# 生成物であることと、育成状態がここに無いことをファイル自身に持たせる。
# 後から開いた人が「レベルが書いていない＝レベル200で評価される」と誤読しないため。
_IMPORTED_HEADER = """\
# {source} から `exercise-lab import-draft` で生成した編成定義。
#
# 育成状態（レベル・ギア・学園レベル）は含まない。育成値は手持ちデータ
# （localStorage `mlgg:player-data`）が正本で、読み込む側が未指定の項目へ適用する。
#
# エディタ補完を効かせるには `exercise-lab schema` でSchemaを生成したうえで、次の行の
# 先頭の `#` を1つ削り、パスをこのファイルからの相対で合わせる。
#
# `# yaml-language-server:` はコメントではなく有効なディレクティブなので、
# 最初から効かせておくと、まだ生成していないSchemaを指してエディタが赤くなる。
## yaml-language-server: $schema=../.schema/formation.schema.json

"""

_IMPORTED_LIBRARY_HEADER = """\
# {source} から `exercise-lab import-draft --library` で生成した編成ライブラリの1件。
#
# `configs/formations/<id>.yaml` として保存する（ファイル名がそのままID）。
# 敵・育成状態（レベル・ギア・学園レベル）は含まない——敵に依らない編成の
# 中身だけを持つ。
#
# エディタ補完を効かせるには `exercise-lab schema` でSchemaを生成したうえで、次の行の
# 先頭の `#` を1つ削る（`configs/formations/` 以外へ保存するならパスも相対で合わせる）。
## yaml-language-server: $schema=../../.schema/formation-seed.schema.json

"""


@app.command()
def units(
    grep: Annotated[
        str | None, typer.Option("--grep", help="ID・表示名・キャラクター名の部分一致")
    ] = None,
    category: Annotated[
        str | None, typer.Option("--category", help="PLAYABLE / EXERCISE_ENEMY")
    ] = None,
    owned: Annotated[bool, typer.Option("--owned", help="手持ちのユニットだけに絞る")] = False,
    player_data: Annotated[
        Path | None,
        typer.Option("--player-data", help="localStorage `mlgg:player-data` のJSON", exists=True),
    ] = None,
    as_yaml: Annotated[bool, typer.Option("--yaml", help="編成YAMLへ貼れる形で出す")] = False,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """Catalog のユニットを検索してIDを引く。"""
    data = _player_data_for_owned(owned, player_data)
    catalog = _fetch_catalog(base_url)
    found = search_units(
        catalog,
        query=grep,
        category=category,
        owned_ids=None if data is None else set(data.units),
    )
    _reject_no_match(found, grep)
    if as_yaml:
        console.print(_units_yaml(found), highlight=False)
        return
    _print_units(found, catalog.catalog_revision, data)


@app.command()
def memories(
    grep: Annotated[str | None, typer.Option("--grep", help="ID・表示名の部分一致")] = None,
    as_yaml: Annotated[bool, typer.Option("--yaml", help="編成YAMLへ貼れる形で出す")] = False,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """Catalog のメモリーを検索してIDを引く。"""
    catalog = _fetch_catalog(base_url)
    found = search_memories(catalog, query=grep)
    _reject_no_match(found, grep)
    if as_yaml:
        console.print("\n".join(f"- {memory.memory_definition_id}" for memory in found))
        return
    table = Table(title=f"memories ({len(found)}) / catalogRevision {catalog.catalog_revision}")
    _add_id_column(table, "memoryDefinitionId", [m.memory_definition_id for m in found])
    table.add_column("displayName")
    for memory in found:
        table.add_row(memory.memory_definition_id, memory.display_name)
    console.print(table)


@app.command()
def formations(
    grep: Annotated[str | None, typer.Option("--grep", help="IDの部分一致")] = None,
    formations_dir: Annotated[
        Path, typer.Option("--formations-dir", help="編成ライブラリのディレクトリ")
    ] = DEFAULT_FORMATIONS_DIR,
) -> None:
    """編成ライブラリ（`configs/formations/`）に登録済みの編成IDを一覧する。

    Catalogへは問い合わせない（ローカルのファイル一覧だけで完結する）。
    """
    ids = list_formation_ids(formations_dir)
    if grep:
        ids = [formation_id for formation_id in ids if grep in formation_id]
    _reject_no_match(ids, grep)
    table = Table(title=f"formations ({len(ids)}) / {formations_dir}")
    _add_id_column(table, "id", ids)
    table.add_column("units", justify="right")
    table.add_column("memories", justify="right")
    table.add_column("note")
    for formation_id in ids:
        try:
            spec = load_formation_library_entry(formations_dir, formation_id)
        except ConfigError as error:
            _abort(str(error))
        table.add_row(
            formation_id,
            str(len(spec.units)),
            str(len(spec.memory_definition_ids)),
            spec.note or "-",
        )
    console.print(table)


@app.command()
def schema(
    out: Annotated[Path, typer.Option("--out", "-o", help="出力ディレクトリ")] = DEFAULT_SCHEMA_DIR,
    base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
) -> None:
    """YAML用の JSON Schema を Catalog から生成する（エディタ補完用）。

    演習の編成定義YAMLと編成ライブラリ1件（`configs/formations/<id>.yaml`）で
    書式が違うため、Schemaも2つ出す。実IDを enum に焼くので、Catalog を更新したら
    作り直す。
    """
    catalog = _fetch_catalog(base_url)
    out.mkdir(parents=True, exist_ok=True)
    written = [
        (
            out / FORMATION_SCHEMA_JSON,
            build_formation_json_schema(catalog),
            "編成定義YAML",
        ),
        (
            out / FORMATION_LIBRARY_SCHEMA_JSON,
            build_formation_library_json_schema(catalog),
            "編成ライブラリYAML（configs/formations/）",
        ),
    ]
    for path, document, _ in written:
        path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    console.print(
        f"[bold]{out}[/] へ書き出した（catalogRevision {catalog.catalog_revision}）。"
        "各YAMLの先頭へ対応する行を置くと補完が効く:"
    )
    for path, _, label in written:
        console.print(f"  {label}: # yaml-language-server: $schema={path}", highlight=False)


def _fetch_catalog(base_url: str) -> Catalog:
    with CatalogClient(base_url) as client:
        try:
            return client.fetch_catalog()
        except LabApiError as error:
            _abort(str(error))


def _player_data_for_owned(owned: bool, player_data: Path | None) -> PlayerData | None:
    if not owned:
        return None
    if player_data is None:
        _abort("--owned には --player-data が要る（手持ちの一覧はそのファイルにしかない）")
    try:
        return load_player_data(player_data)
    except PlayerDataError as error:
        _abort(str(error))


def _reject_no_match(found: Sequence[object], grep: str | None) -> None:
    # 空の表を出して「該当なし」を読み取らせない。検索の絞り込みすぎは打ち間違いと
    # 見分けがつかないので、条件を添えて失敗させる。
    if found:
        return
    condition = "（条件なし）" if grep is None else f"（--grep {grep}）"
    _abort(f"該当するものが無い{condition}")


def _print_units(
    found: Sequence[CatalogUnit], catalog_revision: str, data: PlayerData | None
) -> None:
    table = Table(title=f"units ({len(found)}) / catalogRevision {catalog_revision}")
    _add_id_column(table, "unitDefinitionId", [unit.unit_definition_id for unit in found])
    for column in ("displayName", "category", "role", "aptitudes"):
        table.add_column(column)
    if data is not None:
        table.add_column("level", justify="right")
    for unit in found:
        row = [
            unit.unit_definition_id,
            unit.display_name,
            unit.category,
            unit.role,
            "/".join(unit.position_aptitudes),
        ]
        if data is not None:
            stored = data.units.get(unit.unit_definition_id)
            row.append("-" if stored is None else _owned_level(stored, data))
        table.add_row(*row)
    console.print(table)


def _owned_level(stored: StoredUnitEnhancement, data: PlayerData) -> str:
    """実効レベルを出す。リンク由来の値には`*`を付ける。

    表の用途は編成YAMLへ書き写すIDと値を引くことなので、個別に入力した値と
    リンクで一括指定された値を見分けられないと、リンクを外したときに戻る値を
    取り違える。
    """
    level = resolved_level(stored, data)
    return f"{level}*" if level != stored.level else str(level)


def _add_id_column(table: Table, header: str, values: Sequence[str]) -> None:
    """ID列は必ず1行へ収める。

    IDはこの表を出す目的そのもので、省略記号で切れても折り返されてもコピーできない。
    最長のIDぶんの幅を先に確保し、幅が足りないときは表示名の側を削らせる。
    """
    table.add_column(
        header, no_wrap=True, min_width=max((len(value) for value in values), default=len(header))
    )


# 貼り付けたときに枠が重複しないよう、前衛→後衛・column昇順で別々の枠を割り当てる。
# 6件を超えたら一巡させる（そこまで貼るなら手で直すことになる）。
_PLACEHOLDER_POSITIONS = [(row, column) for row in ("FRONT", "REAR") for column in (0, 1, 2)]


def _units_yaml(found: Sequence[CatalogUnit]) -> str:
    lines = ["# position は仮置き。実際の配置へ直す（結果に影響する）。"]
    for index, unit in enumerate(found):
        row, column = _PLACEHOLDER_POSITIONS[index % len(_PLACEHOLDER_POSITIONS)]
        lines.append(f"- unitDefinitionId: {unit.unit_definition_id}")
        lines.append(f"  position: {{ column: {column}, row: {row} }}")
    return "\n".join(lines)


def _abort(message: str) -> NoReturn:
    error_console.print(f"[red]error[/]: {message}")
    raise typer.Exit(code=1)


LAB = LabCommands(
    name="exercise-lab", format=FORMAT, planner=plan_exercise_evaluation, analyzer=ANALYZER
)
register_evaluation_commands(app, LAB)
register_inspect_command(app, LAB)


if __name__ == "__main__":
    app()
