"""workspaceのパッケージ境界。

workspaceは全パッケージを1つのvenvへ入れるので、宣言していない依存もimportできてしまう。
テストが通ることを依存の正しさの根拠にしないよう、ソースのimportと `pyproject.toml` の
宣言を突き合わせる。

- 各パッケージの実行時のimportは、標準ライブラリ・自分自身・宣言した依存だけ
- `mlgg_lab_common` はどのラボにも依存しない。ラボ同士も依存しない
- 統計用の `numpy` は `mlgg_lab_common.statistics` だけが使い、追加依存 `statistics` で宣言する

宣言どおりに単独でインストールできることは `scripts/check-isolated-installs.sh` が確かめる。
"""

import ast
import re
import sys
import tomllib
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]

# distribution名 → 配布物のトップレベルモジュール名。
PACKAGES = {
    "mlgg-lab-common": ("common", "mlgg_lab_common"),
    "exercise-lab": ("exercise-lab", "exercise_lab"),
    "battle-lab": ("battle-lab", "battle_lab"),
    "total-war-lab": ("total-war-lab", "total_war_lab"),
}
LABS = ("exercise-lab", "battle-lab", "total-war-lab")
# トップレベルのimport名がdistribution名と違うもの。
IMPORT_TO_DISTRIBUTION = {"yaml": "pyyaml"}
STATISTICS_EXTRA_MODULES = ("mlgg_lab_common.statistics",)


def distribution_of(name: str) -> str:
    module_to_dist = {module: dist for dist, (_, module) in PACKAGES.items()}
    return module_to_dist.get(name) or IMPORT_TO_DISTRIBUTION.get(name, name)


def requirement_name(requirement: str) -> str:
    return re.split(r"[\[<>=!~ ;]", requirement, maxsplit=1)[0].lower()


def project(dist: str) -> dict:
    directory, _ = PACKAGES[dist]
    return tomllib.loads((TOOLS / directory / "pyproject.toml").read_text(encoding="utf-8"))[
        "project"
    ]


def declared(dist: str) -> set[str]:
    return {requirement_name(r) for r in project(dist).get("dependencies", [])}


def declared_extra(dist: str, extra: str) -> set[str]:
    return {
        requirement_name(r) for r in project(dist).get("optional-dependencies", {}).get(extra, [])
    }


def source_imports(dist: str) -> dict[str, set[str]]:
    """モジュール（`a.b.c`）ごとの、外部（相対でない）importのトップレベル名。"""
    directory, module = PACKAGES[dist]
    root = TOOLS / directory / "src"
    found: dict[str, set[str]] = {}
    for path in sorted((root / module).rglob("*.py")):
        dotted = ".".join(path.relative_to(root).with_suffix("").parts)
        names: set[str] = set()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
        found[dotted] = {n for n in names if n not in sys.stdlib_module_names and n != "__future__"}
    return found


@pytest.mark.parametrize("dist", list(PACKAGES))
def test_every_runtime_import_is_a_declared_dependency(dist):
    _, own = PACKAGES[dist]
    base = declared(dist)
    statistics = declared_extra(dist, "statistics")
    undeclared = []
    for module, names in source_imports(dist).items():
        allowed = set(base)
        if module.startswith(STATISTICS_EXTRA_MODULES):
            allowed |= statistics
        undeclared.extend(
            f"{module}: {name}"
            for name in names
            if name != own and distribution_of(name) not in allowed
        )
    assert undeclared == []


def test_numpy_is_only_an_extra_of_the_common_package():
    assert "numpy" not in declared("mlgg-lab-common")
    assert declared_extra("mlgg-lab-common", "statistics") == {"numpy"}
    users = [m for m, names in source_imports("mlgg-lab-common").items() if "numpy" in names]
    assert users and all(m.startswith(STATISTICS_EXTRA_MODULES) for m in users)


def test_the_common_package_depends_on_no_lab():
    imported = set().union(*source_imports("mlgg-lab-common").values())
    assert not {distribution_of(n) for n in imported} & set(LABS)
    assert not declared("mlgg-lab-common") & set(LABS)


@pytest.mark.parametrize("lab", LABS)
def test_each_lab_depends_on_common_and_on_no_other_lab(lab):
    others = set(LABS) - {lab}
    imported = {distribution_of(n) for n in set().union(*source_imports(lab).values())}
    assert "mlgg-lab-common" in declared(lab)
    assert "mlgg-lab-common" in imported
    assert not imported & others
    assert not declared(lab) & others


@pytest.mark.parametrize("lab", LABS)
def test_tests_of_a_lab_do_not_reach_into_another_lab(lab):
    others = {PACKAGES[o][1] for o in set(LABS) - {lab}}
    directory, _ = PACKAGES[lab]
    for path in (TOOLS / directory / "tests").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert not [o for o in others if re.search(rf"^\s*(from|import) {o}\b", text, re.M)], path


def test_lab_command_names_do_not_collide():
    scripts = [name for lab in LABS for name in project(lab).get("scripts", {})]
    assert len(scripts) == len(set(scripts))
    assert all(name.startswith(tuple(LABS)) for name in scripts)


def test_every_resolved_input_runs_its_format_specific_validation():
    """解決時と読み戻し時に同じ独自検証を通すため、各形式は `validate_match` を実装する。"""
    from battle_lab.inputs import ResolvedBattleInput
    from exercise_lab.inputs.exercise import ResolvedExerciseInput
    from mlgg_lab_common.models import ResolvedInput
    from total_war_lab.inputs import ResolvedTotalWarInput

    for resolved in (ResolvedExerciseInput, ResolvedBattleInput, ResolvedTotalWarInput):
        assert resolved.validate_match is not ResolvedInput.validate_match, resolved.__name__
