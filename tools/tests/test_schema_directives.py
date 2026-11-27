"""リポジトリ内のYAMLの `yaml-language-server: $schema=` 行が、`schema` コマンドの
出力（`tools/.schema/<名前>`）を指していること。

Schemaのファイル名や置き場所を変えると、YAML側の参照は黙って壊れる（エディタの
補完が効かなくなるだけで、どの検査も落ちない）。ここで参照先を実際に解決して突き合わせる。
対象は git が追跡しているYAMLだけ——個人の入力（`tools/data/`）は追跡しない。
"""

import re
import subprocess
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

from battle_lab.cli import LAB as BATTLE_LAB
from exercise_lab.cli import LAB as EXERCISE_LAB
from mlgg_lab_common.cli.schema_command import common_schema_files
from mlgg_lab_common.evaluation.schema import build_evaluation_config_json_schema
from mlgg_lab_common.testing import catalog_of_references
from mlgg_lab_common.workspace import SCHEMA_DIR, find_tools_root
from total_war_lab.cli import LAB as TOTAL_WAR_LAB

TOOLS = find_tools_root(Path(__file__).parent)
DIRECTIVE = re.compile(r"^#+ yaml-language-server: \$schema=(?P<path>\S+)\s*$")
LABS = (EXERCISE_LAB, BATTLE_LAB, TOTAL_WAR_LAB)
GENERATED = {file.name for lab in LABS for file in (*common_schema_files(lab.format), *lab.schemas)}


def tracked_yaml() -> list[Path]:
    assert TOOLS is not None
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.yaml", "*.yml"],
        cwd=TOOLS,
        capture_output=True,
        check=True,
    ).stdout
    return [TOOLS / name for name in listed.decode().split("\0") if name]


def directives() -> list[tuple[Path, str]]:
    found = []
    for path in tracked_yaml():
        for line in path.read_text(encoding="utf-8").splitlines():
            match = DIRECTIVE.match(line)
            if match:
                found.append((path, match["path"]))
    return found


def test_the_generated_names_do_not_collide_between_labs():
    names = [file.name for lab in LABS for file in lab.schemas]

    assert len(names) == len(set(names))
    assert not set(names) & {file.name for file in common_schema_files("BATTLE")}


def test_every_lab_sample_points_at_a_schema():
    pointed = {path.relative_to(TOOLS).as_posix() for path, _ in directives()}

    assert {
        "exercise-lab/configs/evaluation.example.yaml",
        "battle-lab/configs/match.example.yaml",
        "battle-lab/configs/evaluation.example.yaml",
        "total-war-lab/configs/match.example.yaml",
        "total-war-lab/configs/evaluation.example.yaml",
    } <= pointed


@pytest.mark.parametrize(
    ("path", "target"),
    directives(),
    ids=lambda value: value.relative_to(TOOLS).as_posix() if isinstance(value, Path) else value,
)
def test_the_directive_resolves_to_a_generated_schema(path, target):
    resolved = (path.parent / target).resolve()

    assert resolved.parent == TOOLS / SCHEMA_DIR
    assert resolved.name in GENERATED


@pytest.mark.parametrize(
    ("lab", "sample"),
    [
        (BATTLE_LAB, "battle-lab/configs/evaluation.example.yaml"),
        (TOTAL_WAR_LAB, "total-war-lab/configs/evaluation.example.yaml"),
        (EXERCISE_LAB, "exercise-lab/tests/fixtures/batch-evaluation.yaml"),
    ],
    ids=lambda value: value if isinstance(value, str) else value.name,
)
def test_the_evaluation_samples_pass_the_evaluation_schema(lab, sample):
    assert TOOLS is not None
    document = yaml.safe_load((TOOLS / sample).read_text(encoding="utf-8"))
    schema = build_evaluation_config_json_schema(catalog_of_references({}), format=lab.format)
    validator = Draft202012Validator(schema)

    assert validator.is_valid(document), list(validator.iter_errors(document))
