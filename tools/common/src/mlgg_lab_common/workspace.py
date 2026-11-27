"""tools ルート（uv workspace のルート）と、そこを基準にした既定の置き場所。

既定の置き場所をカレントディレクトリ相対にすると、コマンドを実行した場所ごとに
別のディレクトリを指す（`tools/` と `tools/<lab>/` で別の `.schema/` ができる）。
ここは実行場所から上へ workspace のルートを探し、そこを基準にする。

パッケージの位置（`__file__`）からは求めない。workspace の外へ単独で入れたとき
（`scripts/check-isolated-installs.sh`）は site-packages を指してしまうためである。
見つからないときは `None` を返し、呼び出し側が明示の指定を求める。
"""

from __future__ import annotations

import tomllib
from pathlib import Path

SCHEMA_DIR = Path(".schema")
FORMATIONS_DIR = Path("data") / "inputs" / "formations"


def find_tools_root(start: Path | None = None) -> Path | None:
    """`start`（既定はカレントディレクトリ）から上へ、`[tool.uv.workspace]` を持つ
    `pyproject.toml` のあるディレクトリを探す。

    各パッケージの `pyproject.toml` も途中にあるので、ファイルの有無ではなく
    workspace の宣言で判定する。
    """
    current = (start or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        if _declares_workspace(directory / "pyproject.toml"):
            return directory
    return None


def _declares_workspace(pyproject: Path) -> bool:
    if not pyproject.is_file():
        return False
    try:
        document = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return False
    return "workspace" in document.get("tool", {}).get("uv", {})


def default_schema_dir(start: Path | None = None) -> Path | None:
    root = find_tools_root(start)
    return None if root is None else root / SCHEMA_DIR


def default_formations_dir(start: Path | None = None) -> Path | None:
    root = find_tools_root(start)
    return None if root is None else root / FORMATIONS_DIR
