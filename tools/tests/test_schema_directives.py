"""リポジトリ内のYAMLの Schema 参照が、`schema` コマンドの出力（`tools/.schema/<名前>`）を
指していること。

対象は tools/README.md「エディタ補完」の保証範囲——ファイル先頭のコメント・空行ブロックに
行頭から書いた `# yaml-language-server: $schema=...` と `## yaml-language-server: $schema=...`——に
限る。YAML Language Server が読む他の書式（`# $schema: ...` 等）は保証せず、検査もしない。

Schemaのファイル名や置き場所を変えると、YAML側の参照は黙って壊れる（エディタの
補完が効かなくなるだけで、どの検査も落ちない）。ここで参照先を実際に解決して突き合わせる。
対象はリポジトリ全体で git が追跡しているYAMLだけ——個人の入力（`tools/data/`）は追跡しない。
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
# 保証範囲（tools/README.md「エディタ補完」）: ファイル先頭のコメント・空行ブロックに、
# 行頭から書いた次の2書式だけ。`##` は `import-draft` が書く書きかけの行で、`#` を1つ外すと効く。
DIRECTIVE = re.compile(r"^##? yaml-language-server: \$schema=(?P<path>\S+)\s*$")
LABS = (EXERCISE_LAB, BATTLE_LAB, TOTAL_WAR_LAB)
GENERATED = {file.name for lab in LABS for file in (*common_schema_files(lab.format), *lab.schemas)}


def leading_block(text: str) -> list[str]:
    """ファイル先頭のコメント行と空行の並び。最初の内容（`---` を含む）の手前で終わる。"""
    block: list[str] = []
    for line in text.splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            break
        block.append(line)
    return block


def directives_in(text: str) -> list[str]:
    matches = (DIRECTIVE.match(line) for line in leading_block(text))
    return [match["path"] for match in matches if match is not None]


def _git(*args: str) -> str:
    assert TOOLS is not None
    return subprocess.run(
        ["git", *args], cwd=TOOLS, capture_output=True, check=True, text=True
    ).stdout


# tools/ の中から `git ls-files` すると tools/ 配下しか列挙しないので、
# リポジトリのルートから数える。
REPOSITORY = Path(_git("rev-parse", "--show-toplevel").strip())


def tracked_yaml() -> list[Path]:
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.yaml", "*.yml"],
        cwd=REPOSITORY,
        capture_output=True,
        check=True,
    ).stdout
    return [REPOSITORY / name for name in listed.decode().split("\0") if name]


def directives() -> list[tuple[Path, str]]:
    return [
        (path, target)
        for path in tracked_yaml()
        for target in directives_in(path.read_text(encoding="utf-8"))
    ]


def case(text: str, targets: list[str], id: str):
    return pytest.param(text, targets, id=id)


@pytest.mark.parametrize(
    ("text", "targets"),
    [
        # 保証範囲の2書式。先頭のコメント・空行ブロックのどこにあってもよい。
        case("# yaml-language-server: $schema=a.json\nkey: 1\n", ["a.json"], "standard"),
        case("## yaml-language-server: $schema=a.json\nkey: 1\n", ["a.json"], "inert"),
        case(
            "# note\n\n## yaml-language-server: $schema=a.json\n# more\nkey: 1\n",
            ["a.json"],
            "after-other-comments",
        ),
        case("# yaml-language-server: $schema=a.json\n", ["a.json"], "comment-only"),
        # 保証範囲外の書式は参照として扱わない（検査が発火しない）。
        case("# $schema: other.schema.json\nkey: 1\n", [], "schema-colon-form"),
        case("#  yaml-language-server: $schema=a.json\nkey: 1\n", [], "two-spaces"),
        case("  # yaml-language-server: $schema=a.json\nkey: 1\n", [], "indented"),
        case("### yaml-language-server: $schema=a.json\nkey: 1\n", [], "three-hashes"),
        case("# yaml-language-server : $schema=a.json\nkey: 1\n", [], "space-before-colon"),
        # 先頭ブロックの外は対象にしない。
        case(
            "embeddedYaml: |\n  # yaml-language-server: $schema=embedded.json\n  value: 1\n",
            [],
            "block-scalar",
        ),
        case("key: 1\n# yaml-language-server: $schema=late.json\n", [], "after-content"),
        case("---\n# yaml-language-server: $schema=a.json\nkey: 1\n", [], "after-marker"),
    ],
)
def test_only_the_supported_forms_in_the_leading_block_are_read(text, targets):
    assert directives_in(text) == targets


def test_the_generated_names_do_not_collide_between_labs():
    names = [file.name for lab in LABS for file in lab.schemas]

    assert len(names) == len(set(names))
    assert not set(names) & {file.name for file in common_schema_files("BATTLE")}


def test_the_whole_repository_is_searched():
    # tools/ の外に置いたYAMLの参照も検査の対象にする。
    assert any(TOOLS not in path.parents for path in tracked_yaml())


def test_every_lab_sample_points_at_a_schema():
    pointed = {path.relative_to(REPOSITORY).as_posix() for path, _ in directives()}

    assert {
        "tools/exercise-lab/configs/evaluation.example.yaml",
        "tools/battle-lab/configs/match.example.yaml",
        "tools/battle-lab/configs/evaluation.example.yaml",
        "tools/total-war-lab/configs/match.example.yaml",
        "tools/total-war-lab/configs/evaluation.example.yaml",
    } <= pointed


@pytest.mark.parametrize(
    ("path", "target"),
    directives(),
    ids=lambda value: (
        value.relative_to(REPOSITORY).as_posix() if isinstance(value, Path) else value
    ),
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
