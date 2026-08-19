"""UI側の統計ライブラリ（`apps/ui/src/features/exercise-stats/`）が数値一致を検証する
fixtureを書き出す。

統計の定義の正本は `exercise_lab.stats` と `exercise_lab.optimize.fitness` であり、
UIのTS実装はその移植である。両者が黙って乖離しないよう、期待値はここで生成して
リポジトリへコミットし、TS側のテストが読む。標本はこのファイル内のLCGで作るので、
Pythonや依存の版が変わっても同じ入力が再現する。

    cd tools/exercise-lab && uv run python scripts/export_ui_parity_fixture.py

書き出した後は `pnpm exec prettier --write` を通すこと（format:check ゲートのため）。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from exercise_lab.optimize.fitness import (
    DEFAULT_BEST_OF,
    best_quantile,
    effective_samples,
    expected_best,
)
from exercise_lab.optimize.fitness import (
    MIN_RELIABLE_EFFECTIVE_SAMPLES as _MIN_RELIABLE,
)
from exercise_lab.stats import (
    _histogram_bins,
    break_count_distribution,
    defeat_rate,
    summarize_scores,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "apps/ui/src/features/exercise-stats/__fixtures__/python-parity.ts"
)

# 保証ラインの分位点。0.25 は「4日に3日はこれ以上」（75%保証）、0.10 は90%保証。
GUARD_QUANTILES = (0.25, 0.10, 0.50)


def lcg(seed: int, count: int) -> list[int]:
    """標本生成の乱数。numpyやrandomを使わないのは、版が変わっても同じ列が出る
    ことをこのファイルだけで保証するため。"""
    state = seed
    values: list[int] = []
    for _ in range(count):
        state = (state * 6364136223846793005 + 1442695040888963407) % (2**64)
        values.append(state >> 11)
    return values


def build_scores(count: int) -> list[int]:
    """スコアらしい形の標本。上振れの裾を持たせるのは、期待日次ベストと平均が
    別物であることを fixture が実際に区別できるようにするため。"""
    raw = lcg(20260819, count * 2)
    scores: list[int] = []
    for index in range(count):
        base = 38_000 + raw[index * 2] % 9_000
        spike = 11_000 if raw[index * 2 + 1] % 17 == 0 else 0
        collapse = -21_000 if raw[index * 2 + 1] % 23 == 0 else 0
        scores.append(base + spike + collapse)
    return scores


def daily_best(scores: Sequence[int]) -> dict[str, object]:
    count = len(scores)
    return {
        "bestOf": DEFAULT_BEST_OF,
        "expectedBest": expected_best(scores, best_of=DEFAULT_BEST_OF),
        "quantiles": [
            {
                "quantile": quantile,
                "value": best_quantile(scores, best_of=DEFAULT_BEST_OF, quantile=quantile),
            }
            for quantile in GUARD_QUANTILES
        ],
        "effectiveSamples": effective_samples(count, best_of=DEFAULT_BEST_OF),
        "reliable": effective_samples(count, best_of=DEFAULT_BEST_OF) >= _MIN_RELIABLE,
    }


def camel(name: str) -> str:
    """`ScoreSummary`のfield名（`ci_low`）をTS側の綴り（`ciLow`）へ寄せる。fixtureの
    読み手はTSだけなので、変換は書き出し側で済ませる。"""
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def case(name: str, scores: Sequence[int]) -> dict[str, object]:
    return {
        "name": name,
        "scores": list(scores),
        "summary": {camel(key): value for key, value in summarize_scores(scores).to_dict().items()},
        "histogramBinCount": _histogram_bins(scores),
        "dailyBest": daily_best(scores),
    }


def main() -> None:
    main_scores = build_scores(400)
    # 完了理由とブレイク回数はスコアと同じ添字の試行を指す。敗北はスコアが崩れた
    # 試行へ寄せ、敗北率がスコア分布と無関係な乱数にならないようにする。
    completion_reasons = [
        "ALLY_DEFEATED" if score < 30_000 else "TURN_LIMIT_REACHED" for score in main_scores
    ]
    break_counts = [
        0 if score < 30_000 else min(4, (score - 30_000) // 5_000) for score in main_scores
    ]

    payload = {
        "minReliableEffectiveSamples": _MIN_RELIABLE,
        "cases": [
            case("main", main_scores),
            case("belowBestOf", [41_200, 39_500, 44_100]),
            case("single", [42_195]),
            case("uniform", [37_000] * 20),
        ],
        "runs": {
            "completionReasons": completion_reasons,
            "defeatRate": defeat_rate(completion_reasons),
            "breakCounts": break_counts,
            "breakCountDistribution": [
                {"breakCount": count, "runs": runs}
                for count, runs in break_count_distribution(break_counts).items()
            ],
        },
    }

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "// 生成物。手で編集しない。\n"
        "// tools/exercise-lab/scripts/export_ui_parity_fixture.py が\n"
        "// `exercise_lab.stats` / `exercise_lab.optimize.fitness` から書き出す。\n"
        "//\n"
        "//   cd tools/exercise-lab && uv run python scripts/export_ui_parity_fixture.py\n"
        "\n"
    )
    FIXTURE_PATH.write_text(
        header + "export const PYTHON_PARITY = " + json.dumps(payload, indent=2) + " as const;\n",
        encoding="utf-8",
    )
    print(f"wrote {FIXTURE_PATH}")


if __name__ == "__main__":
    main()
