"""評価設定（YAML）の読み込みと、そこからの試行計画の作成。

評価設定は「どの対戦入力を・どの育成情報で・どの試行番号まで・どこへ送るか」を書く。
対戦入力（編成YAML・UIドラフト）と育成JSONはパスで参照し、計画を作る時点で各ラボの
解決手順（`CaseResolver`）で解決済み入力へ変える。計画を作った後は元ファイルを読み直さない。

設定内のパスは**設定ファイルの位置を基準**に解決する（絶対パスはそのまま）。コマンドを
どのディレクトリから実行しても同じファイルを指す。

```yaml
format: BATTLE                  # BATTLE / TOTAL_WAR / TACTICAL_EXERCISE
seed: study-1
budget: { maxSubmittedRuns: 2000 }   # 再送込みの送信試行数の上限
api:                            # 省略時はローカルのdevサーバー・形式ごとの既定上限
  baseUrl: http://localhost:3000
  maxCasesPerRequest: 64
  maxRunsPerRequest: 300
inputs:
  formationsDir: ../../data/inputs/formations          # `{ library: <id> }` の参照先
  playerData: ../../data/inputs/player-data/player-data.json
  playerDataSides: [ALLY]
output:
  evaluationsDir: ../../data/evaluations
cases:
  - caseId: mirror
    match: match.example.yaml   # 対戦入力ファイル（YAML）。UIドラフトなら `draft:`
    runs: 100                   # 試行番号 0～99。`runStart` でずらせる
  - caseId: spot-check
    match: match.example.yaml
    runIndices: [0, 1, 42]      # 不連続な番号も書ける
```
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt, PositiveInt, ValidationError

from ..api.contracts import contract_for
from ..inputs.catalog import Catalog
from ..inputs.yaml_io import load_yaml_mapping
from ..models.formation import ConfigError
from ..models.participants import Side
from .models import Budget, EvaluationPlan, ExecutionSettings
from .plan import CaseSpec, EvaluableInput, create_plan, run_range

CaseSourceKind = Literal["MATCH_FILE", "DRAFT"]


class _File(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class _Inputs(_File):
    formations_dir: str | None = Field(default=None, alias="formationsDir")
    player_data: str | None = Field(default=None, alias="playerData")
    player_data_sides: tuple[Side, ...] = Field(default=("ALLY",), alias="playerDataSides")


class _Output(_File):
    evaluations_dir: str | None = Field(default=None, alias="evaluationsDir")


class _Case(_File):
    case_id: str = Field(alias="caseId", min_length=1)
    match: str | None = None
    draft: str | None = None
    runs: PositiveInt | None = None
    run_start: NonNegativeInt = Field(default=0, alias="runStart")
    run_indices: list[int] | None = Field(default=None, alias="runIndices")


class _ConfigFile(_File):
    format: Literal["BATTLE", "TOTAL_WAR", "TACTICAL_EXERCISE"]
    seed: str = Field(min_length=1)
    budget: Budget
    api: ExecutionSettings = Field(default_factory=ExecutionSettings)
    inputs: _Inputs = Field(default_factory=_Inputs)
    output: _Output = Field(default_factory=_Output)
    cases: list[_Case] = Field(min_length=1)


@dataclass(frozen=True)
class CaseSource:
    kind: CaseSourceKind
    path: Path


@dataclass(frozen=True)
class ConfiguredCase:
    case_id: str
    source: CaseSource
    run_indices: tuple[int, ...]


@dataclass(frozen=True)
class EvaluationConfig:
    path: Path
    format: str
    seed: str
    budget: Budget
    settings: ExecutionSettings
    formations_dir: Path | None
    player_data: Path | None
    player_data_sides: tuple[Side, ...]
    evaluations_dir: Path | None
    cases: tuple[ConfiguredCase, ...]


@dataclass(frozen=True)
class InputOptions:
    formations_dir: Path | None
    player_data_path: Path | None
    player_data_sides: tuple[Side, ...]
    catalog: Catalog | None


# 各ラボの解決手順。対戦入力1件を解決済み入力にする。
CaseResolver = Callable[[CaseSource, InputOptions], EvaluableInput]


def load_evaluation_config(path: Path, *, expected_format: str | None = None) -> EvaluationConfig:
    raw = load_yaml_mapping(path)
    try:
        parsed = _ConfigFile.model_validate(raw)
    except ValidationError as error:
        raise ConfigError(f"{path}: {error}") from error
    # 評価APIの契約を持つ形式かをここで確かめる。
    contract_for(parsed.format)
    if expected_format is not None and parsed.format != expected_format:
        raise ConfigError(
            f"{path}: format は {expected_format} でなければならない（{parsed.format}）"
        )
    base = path.resolve().parent
    cases = tuple(_case(entry, base, f"{path}: cases[{i}]") for i, entry in enumerate(parsed.cases))
    return EvaluationConfig(
        path=path.resolve(),
        format=parsed.format,
        seed=parsed.seed,
        budget=parsed.budget,
        settings=parsed.api,
        formations_dir=_resolve(base, parsed.inputs.formations_dir),
        player_data=_resolve(base, parsed.inputs.player_data),
        player_data_sides=parsed.inputs.player_data_sides,
        evaluations_dir=_resolve(base, parsed.output.evaluations_dir),
        cases=cases,
    )


def _case(entry: _Case, base: Path, where: str) -> ConfiguredCase:
    if (entry.match is None) == (entry.draft is None):
        raise ConfigError(
            f"{where}: match（対戦入力YAML）と draft（UIドラフト）のどちらか一方を書く"
        )
    if (entry.runs is None) == (entry.run_indices is None):
        raise ConfigError(f"{where}: runs（件数）と runIndices（番号の列）のどちらか一方を書く")
    if entry.run_indices is not None and entry.run_start:
        raise ConfigError(f"{where}: runStart は runs と一緒にだけ書ける")
    kind: CaseSourceKind = "MATCH_FILE" if entry.match is not None else "DRAFT"
    raw_path = entry.match if entry.match is not None else entry.draft
    assert raw_path is not None
    indices = (
        tuple(entry.run_indices)
        if entry.run_indices is not None
        else tuple(run_range(entry.runs or 0, start=entry.run_start))
    )
    return ConfiguredCase(
        entry.case_id, CaseSource(kind, _resolve_required(base, raw_path)), indices
    )


def _resolve(base: Path, value: str | None) -> Path | None:
    return None if value is None else _resolve_required(base, value)


def _resolve_required(base: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return (candidate if candidate.is_absolute() else base / candidate).resolve()


def plan_from_config(
    config: EvaluationConfig,
    resolve_case: CaseResolver,
    *,
    catalog: Catalog | None = None,
    evaluation_id: str | None = None,
) -> EvaluationPlan:
    options = InputOptions(
        formations_dir=config.formations_dir,
        player_data_path=config.player_data,
        player_data_sides=config.player_data_sides,
        catalog=catalog,
    )
    cases = [
        CaseSpec(case.case_id, resolve_case(case.source, options), case.run_indices)
        for case in config.cases
    ]
    return create_plan(
        config.format,
        cases,
        seed=config.seed,
        budget=config.budget,
        settings=config.settings,
        evaluation_id=evaluation_id,
    )
