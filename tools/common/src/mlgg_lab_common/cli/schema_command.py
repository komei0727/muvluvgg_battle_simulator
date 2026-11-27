"""`schema` コマンド。YAML用の JSON Schema を Catalog から生成する（エディタ補完用）。

共通部が持つSchema（編成ライブラリ1件・このラボの形式の評価設定）と、ラボが渡した
`SchemaFile` を書き出す。評価設定は `format` をラボの形式に固定するので、形式の接頭辞付きの
名前で出す——同じ出力先で別のラボを実行しても上書きし合わない。

出力先の既定は tools ルートの `.schema/`（`workspace.default_schema_dir`）で、
実行場所に依らない。workspace の外で実行したときは `--out` を求めて止める。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated, NoReturn

import typer
from rich.console import Console

from ..evaluation.schema import build_evaluation_config_json_schema
from ..inputs.catalog import DEFAULT_BASE_URL, Catalog, CatalogClient, LabApiError
from ..inputs.schema import (
    FORMATION_LIBRARY_SCHEMA,
    SchemaFile,
    build_formation_library_json_schema,
    schema_name,
)
from ..workspace import default_schema_dir


def common_schema_files(format: str) -> tuple[SchemaFile, ...]:
    return (
        SchemaFile(
            name=FORMATION_LIBRARY_SCHEMA,
            label="編成ライブラリYAML（data/inputs/formations/）",
            build=build_formation_library_json_schema,
        ),
        SchemaFile(
            name=schema_name(format, "evaluation"),
            label=f"評価設定YAML（format: {format}）",
            build=lambda catalog: build_evaluation_config_json_schema(catalog, format=format),
        ),
    )


def register_schema_command(
    app: typer.Typer, *, format: str, schemas: Sequence[SchemaFile]
) -> None:
    console = Console(highlight=False, soft_wrap=True)
    errors = Console(stderr=True, highlight=False, soft_wrap=True)
    files = (*common_schema_files(format), *schemas)

    def abort(message: str) -> NoReturn:
        errors.print(f"[red]error[/]: {message}", markup=True)
        raise typer.Exit(code=1)

    @app.command("schema")
    def schema(
        out: Annotated[
            Path | None,
            typer.Option("--out", "-o", help="出力ディレクトリ。既定は tools/.schema/"),
        ] = None,
        base_url: Annotated[str, typer.Option("--base-url")] = DEFAULT_BASE_URL,
    ) -> None:
        """YAML用の JSON Schema を Catalog から生成する（エディタ補完用）。

        共通（編成ライブラリ1件・評価設定）と、このラボの入力のSchemaを出す。
        実IDを enum に焼くので、Catalog を更新したら作り直す。
        """
        directory = out if out is not None else default_schema_dir()
        if directory is None:
            abort("tools/ の uv workspace の外で実行している。--out で出力先を指定する")
        catalog = fetch(base_url)
        directory.mkdir(parents=True, exist_ok=True)
        for file in files:
            document = file.build(catalog)
            (directory / file.name).write_text(
                json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        console.print(
            f"[bold]{directory}[/] へ書き出した（catalogRevision {catalog.catalog_revision}）。"
            "各YAMLの先頭へ `# yaml-language-server: $schema=<相対パス>` を置くと補完が効く"
            "（パスはそのYAMLから次のファイルを指す）:",
            markup=True,
        )
        for file in files:
            console.print(f"  {file.label}: {directory / file.name}")

    def fetch(base_url: str) -> Catalog:
        with CatalogClient(base_url) as client:
            try:
                return client.fetch_catalog()
            except LabApiError as error:
                abort(str(error))
