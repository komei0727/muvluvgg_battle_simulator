"""試行計画・実行設定・予算の値型。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, PositiveFloat, PositiveInt, field_validator

from ..api.client import DEFAULT_TIMEOUT_SECONDS, EvaluationHttpClient
from ..api.contracts import ExpectedSlot, FormatContract

# 計画（`EvaluationPlan`）の保存形式。DBの保存形式（`storage.migrations`）とは別に数える。
PLAN_FORMAT_VERSION = 1
DEFAULT_BASE_URL = "http://localhost:3000"


class _Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)


class ExecutionSettings(_Settings):
    """接続先・要求の上限・再送の方針。

    要求あたりの上限はAPIの配備設定（`*_EVALUATION_MAX_CASES` 等）で変わり、形式ごとにも
    違う。`None` は「その形式の契約の既定値」を意味し、計画の作成時に確定する。
    """

    base_url: str = Field(default=DEFAULT_BASE_URL, alias="baseUrl")
    max_cases_per_request: PositiveInt | None = Field(default=None, alias="maxCasesPerRequest")
    max_runs_per_request: PositiveInt | None = Field(default=None, alias="maxRunsPerRequest")
    timeout_seconds: PositiveFloat = Field(default=DEFAULT_TIMEOUT_SECONDS, alias="timeoutSeconds")
    # 再送できる失敗（通信断・混雑）が連続してよい回数。成功した要求で数え直す。
    max_retries: int = Field(default=3, ge=0, alias="maxRetries")
    retry_backoff_seconds: float = Field(default=1.0, ge=0, alias="retryBackoffSeconds")
    # 1件も完了しない応答（期限到達の部分応答）が連続してよい回数。
    max_consecutive_no_progress: PositiveInt = Field(default=3, alias="maxConsecutiveNoProgress")
    # 実行環境を初回から固定したいときに指定する。省略すると最初の応答で確定する。
    expected_catalog_revision: str | None = Field(default=None, alias="expectedCatalogRevision")
    expected_engine_revision: str | None = Field(default=None, alias="expectedEngineRevision")

    @field_validator("base_url")
    @classmethod
    def _base_url_is_an_http_origin(cls, value: str) -> str:
        # 接続先は計画に保存されて resume でも変えられないので、保存前に確かめる。
        # 送信時（HTTPクライアントの生成時）に初めて壊れていると分かっても直せない。
        try:
            url = httpx.URL(value)
            url.port  # noqa: B018 - 不正なポートはここで InvalidURL になる
        except (httpx.InvalidURL, TypeError) as error:
            raise ValueError(f"baseUrl {value!r} はURLとして読めない: {error}") from error
        if url.scheme not in ("http", "https") or not url.host:
            raise ValueError(f"baseUrl {value!r} は http(s)://<ホスト>[:<ポート>] で書く")
        return value

    def http_client(self, *, access_key: str | None = None) -> EvaluationHttpClient:
        """この設定の接続先・タイムアウトで評価APIのクライアントを作る。

        アクセスキーは秘密値なので計画・DBへ保存せず、実行のたびに渡す。
        """
        return EvaluationHttpClient(
            self.base_url, timeout_seconds=self.timeout_seconds, access_key=access_key
        )

    def resolved_for(self, contract: FormatContract) -> ExecutionSettings:
        return self.model_copy(
            update={
                "max_cases_per_request": self.max_cases_per_request
                or contract.default_max_cases_per_request,
                "max_runs_per_request": self.max_runs_per_request
                or contract.default_max_runs_per_request,
            }
        )


class Budget(_Settings):
    """送信してよい試行数（再送を含む）の上限。"""

    max_submitted_runs: PositiveInt = Field(alias="maxSubmittedRuns")


@dataclass(frozen=True)
class PlannedCase:
    case_id: str
    # 解決済み入力のJSON（`ResolvedInput` の保存形式、`schemaVersion` 付き）。由来情報も持つ。
    input_snapshot: dict[str, Any]
    # 実際に送る対戦条件（`caseId` / `runIndices` を除く）。再開時はこれだけを送る。
    match_request: dict[str, Any]
    expected_slots: tuple[ExpectedSlot, ...]
    run_indices: tuple[int, ...]
    match_fingerprint: str


@dataclass(frozen=True)
class EvaluationPlan:
    evaluation_id: str
    contract: FormatContract
    seed: str
    settings: ExecutionSettings
    budget: Budget
    cases: tuple[PlannedCase, ...]
    created_at: str

    @property
    def planned_runs(self) -> int:
        return sum(len(case.run_indices) for case in self.cases)
