"""リポジトリ内のYAMLの `yaml-language-server: $schema=` 行が、`schema` コマンドの
出力（`tools/.schema/<名前>`）を指していること。

Schemaのファイル名や置き場所を変えると、YAML側の参照は黙って壊れる（エディタの
補完が効かなくなるだけで、どの検査も落ちない）。ここで参照先を実際に解決して突き合わせる。
対象はリポジトリ全体で git が追跡しているYAMLだけ——個人の入力（`tools/data/`）は追跡しない。
"""

import itertools
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
# YAML Language Server（`modelineUtil.ts`）と同じ判定。行が modeline かを先に見て、
# 参照先はその行から取り出す。空白の数・`$schema:` の形もサーバーが読む範囲は受理する。
# サーバーはYAMLのコメント（`#` の前のインデントを除いたもの）へ判定を掛けるので、行頭の空白は
# 許す。先頭の `#` は複数を許す——`##` の書きかけの行も、`#` を1つ削れば効くので検査する。
MODELINE = re.compile(r"^\s*#+\s+(?:yaml-language-server\s*:|\$schema:)")
TARGET = re.compile(r"\$schema(?:=|:[^\S\r\n]*)(\S+)")
LABS = (EXERCISE_LAB, BATTLE_LAB, TOTAL_WAR_LAB)
GENERATED = {file.name for lab in LABS for file in (*common_schema_files(lab.format), *lab.schemas)}


def schema_target(line: str) -> str | None:
    if not MODELINE.match(line):
        return None
    found = TARGET.search(line)
    return None if found is None else found[1]


# 文書の頭の区切り。これらの後から次のトークンまでの行が、その文書のヘッダーになる。
_HEADER_OPENERS = (
    yaml.StreamStartToken,
    yaml.DirectiveToken,
    yaml.DocumentStartToken,
    yaml.DocumentEndToken,
)


def header_comment_lines(text: str) -> list[str]:
    """各文書の最初の内容より前にあるコメント行（ヘッダーコメント）。

    サーバーは文書のヘッダーコメントだけを modeline として読む。行単位で探すと、
    ブロックスカラー（`|`）の中身や内容の後のコメントまで拾ってしまう。コメントは
    トークンにならないので、内容のトークンの位置からヘッダーの行範囲を求める。
    """
    lines = text.splitlines()
    tokens = list(yaml.scan(text, Loader=yaml.SafeLoader))
    header: list[str] = []
    for previous, following in itertools.pairwise(tokens):
        if not isinstance(previous, _HEADER_OPENERS):
            continue
        # 区切りと同じ行（`--- # ...`）はヘッダーコメントとして扱わない。
        first = previous.end_mark.line + (0 if isinstance(previous, yaml.StreamStartToken) else 1)
        last = following.start_mark.line
        if isinstance(following, yaml.StreamEndToken):
            last = len(lines)
        header.extend(line for line in lines[first:last] if line.lstrip().startswith("#"))
    return header


def directives_in(text: str) -> list[str]:
    targets = (schema_target(line) for line in header_comment_lines(text))
    return [target for target in targets if target is not None]


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


@pytest.mark.parametrize(
    ("line", "target"),
    [
        ("# yaml-language-server: $schema=a.json", "a.json"),
        ("#  yaml-language-server: $schema=a.json", "a.json"),
        ("#\tyaml-language-server : $schema=a.json", "a.json"),
        ("# yaml-language-server:$schema=a.json  ", "a.json"),
        ("# $schema: a.json", "a.json"),
        ("# $schema:a.json", "a.json"),
        # `##` はサーバーが読まないが、先頭の `#` を1つ削れば効く書きかけの行として検査する。
        ("## yaml-language-server: $schema=a.json", "a.json"),
        # YAMLのコメントとして読むので、`#` の前のインデントは取り除かれてから判定される。
        ("  # yaml-language-server: $schema=a.json", "a.json"),
        ("\t# $schema: a.json", "a.json"),
    ],
)
def test_every_form_the_language_server_reads_is_found(line, target):
    assert schema_target(line) == target


@pytest.mark.parametrize(
    "line",
    [
        "#yaml-language-server: $schema=a.json",
        "# `# yaml-language-server:` はコメントではなく有効なディレクティブなので、",
        "# yaml-language-server: $schema= a.json",
        "# $schema=a.json",
        "key: value  # yaml-language-server: $schema=a.json",
    ],
)
def test_lines_the_language_server_ignores_are_not_found(line):
    assert schema_target(line) is None


@pytest.mark.parametrize(
    ("text", "targets"),
    [
        pytest.param(
            "  # yaml-language-server: $schema=a.json\nkey: 1\n", ["a.json"], id="indented-header"
        ),
        pytest.param(
            "# note\n\n## yaml-language-server: $schema=a.json\n# more\nkey: 1\n",
            ["a.json"],
            id="header-after-other-comments",
        ),
        pytest.param(
            "embeddedYaml: |\n  # yaml-language-server: $schema=embedded.json\n  value: 1\n",
            [],
            id="block-scalar",
        ),
        pytest.param("key: 1\n# yaml-language-server: $schema=late.json\n", [], id="after-content"),
        pytest.param(
            "list:\n  # yaml-language-server: $schema=nested.json\n  - 1\n", [], id="nested"
        ),
        pytest.param(
            "# yaml-language-server: $schema=a.json\na: 1\n---\n"
            "# yaml-language-server: $schema=b.json\nb: 1\n",
            ["a.json", "b.json"],
            id="each-document",
        ),
        pytest.param("# yaml-language-server: $schema=a.json\n", ["a.json"], id="comment-only"),
    ],
)
def test_only_header_comments_are_read(text, targets):
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
