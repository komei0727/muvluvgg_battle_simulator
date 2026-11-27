"""各ラボの評価コマンド（`evaluate` / `resume` / `status` / `summarize` / `export`）と
`schema` コマンドの共通部。

追加依存 `mlgg-lab-common[cli]`（typer・rich）が要る。ラボは形式・計画の作り方・集計
（`FormatAnalyzer`）だけを `LabCommands` に渡し、通信・保存・再開・表示はここが持つ。
"""

from .commands import (
    ACCESS_KEY_ENV,
    EXIT_INCOMPLETE,
    EXIT_INPUT_ERROR,
    EXIT_INTERRUPTED,
    EXIT_OK,
    EXIT_RUN_FAILED,
    LabCommands,
    build_lab_app,
    exit_code_for,
    register_evaluation_commands,
    register_lab_schema_command,
)

__all__ = [
    "ACCESS_KEY_ENV",
    "EXIT_INCOMPLETE",
    "EXIT_INPUT_ERROR",
    "EXIT_INTERRUPTED",
    "EXIT_OK",
    "EXIT_RUN_FAILED",
    "LabCommands",
    "build_lab_app",
    "exit_code_for",
    "register_evaluation_commands",
    "register_lab_schema_command",
]
