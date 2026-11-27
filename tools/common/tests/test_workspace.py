"""tools ルート（uv workspace のルート）の探索。Schemaの出力先・編成ライブラリの既定位置の基準。"""

from pathlib import Path

from mlgg_lab_common.workspace import (
    default_formations_dir,
    default_schema_dir,
    find_tools_root,
)

WORKSPACE_PYPROJECT = '[tool.uv.workspace]\nmembers = ["common"]\n'


def make_workspace(tmp_path: Path) -> Path:
    root = tmp_path / "tools"
    (root / "common").mkdir(parents=True)
    (root / "pyproject.toml").write_text(WORKSPACE_PYPROJECT, encoding="utf-8")
    # メンバーの pyproject は workspace のルートではない。
    (root / "common" / "pyproject.toml").write_text('[project]\nname = "x"\n', encoding="utf-8")
    return root


def test_the_root_is_found_from_a_nested_directory(tmp_path):
    root = make_workspace(tmp_path)
    nested = root / "common" / "deep"
    nested.mkdir()

    assert find_tools_root(nested) == root


def test_a_member_pyproject_is_not_mistaken_for_the_root(tmp_path):
    root = make_workspace(tmp_path)

    assert find_tools_root(root / "common") == root


def test_no_root_outside_a_workspace(tmp_path):
    assert find_tools_root(tmp_path) is None


def test_the_repository_tools_directory_is_found():
    tools = Path(__file__).resolve().parents[2]

    assert find_tools_root(Path(__file__).parent) == tools


def test_the_defaults_hang_off_the_root(tmp_path):
    root = make_workspace(tmp_path)

    assert default_schema_dir(root / "common") == root / ".schema"
    assert default_formations_dir(root / "common") == root / "data" / "inputs" / "formations"


def test_the_defaults_are_none_outside_a_workspace(tmp_path):
    assert default_schema_dir(tmp_path) is None
    assert default_formations_dir(tmp_path) is None
