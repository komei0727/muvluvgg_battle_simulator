"""UI統計のfixture（`python-parity.ts`）が参照実装からの再生成結果と一致する。

fixtureはPrettier整形後のTSなので、キーの引用符と末尾カンマを戻してからJSONとして読む。
数値の書式（`37000.0` → `37000` など）はPrettierが正規化するため、値として比べる。
"""

import importlib.util
import json
import re
from pathlib import Path

import pytest

TOOL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = TOOL_ROOT / "scripts" / "export_ui_parity_fixture.py"
FIXTURE = TOOL_ROOT.parents[1] / "apps/ui/src/features/exercise-stats/__fixtures__/python-parity.ts"


def load_script():
    spec = importlib.util.spec_from_file_location("export_ui_parity_fixture", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def committed_payload() -> object:
    text = FIXTURE.read_text(encoding="utf-8")
    body = text.split("export const PYTHON_PARITY = ", 1)[1].rsplit(" as const;", 1)[0]
    quoted = re.sub(r"^(\s*)([A-Za-z_]\w*):", r'\1"\2":', body, flags=re.MULTILINE)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", quoted))


@pytest.mark.skipif(not FIXTURE.exists(), reason="UIのfixtureはリポジトリ全体のcheckoutにだけある")
def test_the_committed_fixture_matches_the_reference_implementation():
    assert load_script().build_payload() == committed_payload()
