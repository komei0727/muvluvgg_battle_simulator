"""保存形式1: 計画・入力スナップショット・要求履歴・結果。

- `evaluations`: 実行設定・予算・確定した実行環境（1行だけ）
- `cases`: ケースID・解決済み入力・送信する対戦条件・参加枠
- `trials`: ケース×試行番号の予定
- `attempts`: 要求1回ごとの履歴（要求本文・原応答・通信エラー・時刻・失敗の分類）
- `attempt_trials`: 各要求に含めた試行と、その要求での結末
- `results`: 完了した試行の観測値。1試行につき最大1件で、書き換えない
- `sessions`: 実行1回ごとの開始・終了・停止理由

検索・対応づけに使う項目は列に、編成や形式固有の詳細はバージョン付きのJSONに持つ。
"""

SQL = """
CREATE TABLE evaluations (
    evaluation_id TEXT PRIMARY KEY,
    singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
    format TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    plan_format_version INTEGER NOT NULL,
    seed TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    max_submitted_runs INTEGER NOT NULL CHECK (max_submitted_runs > 0),
    created_at TEXT NOT NULL,
    catalog_revision TEXT,
    engine_revision TEXT,
    seed_derivation_version TEXT,
    environment_contract_id TEXT,
    environment_established_at TEXT
);

CREATE TABLE cases (
    case_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL UNIQUE,
    match_fingerprint TEXT NOT NULL,
    input_schema_version INTEGER NOT NULL,
    input_json TEXT NOT NULL,
    match_request_json TEXT NOT NULL,
    expected_slots_json TEXT NOT NULL
);

CREATE TABLE trials (
    trial_id INTEGER PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases (case_id),
    run_index INTEGER NOT NULL CHECK (run_index BETWEEN 0 AND 4294967295),
    trial_key TEXT NOT NULL,
    UNIQUE (case_id, run_index)
);

CREATE TABLE sessions (
    session_id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    stop_reason TEXT,
    detail TEXT
);

CREATE TABLE attempts (
    attempt_id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions (session_id),
    status TEXT NOT NULL CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
    run_count INTEGER NOT NULL CHECK (run_count > 0),
    request_json TEXT NOT NULL,
    reserved_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    http_status INTEGER,
    response_body TEXT,
    transport_error TEXT,
    failure_kind TEXT,
    failure_code TEXT,
    failure_message TEXT,
    completed_runs INTEGER,
    new_results INTEGER,
    duplicate_results INTEGER,
    catalog_revision TEXT,
    engine_revision TEXT,
    seed_derivation_version TEXT
);

CREATE TABLE attempt_trials (
    attempt_id INTEGER NOT NULL REFERENCES attempts (attempt_id),
    trial_id INTEGER NOT NULL REFERENCES trials (trial_id),
    outcome TEXT NOT NULL CHECK (outcome IN ('PENDING', 'COMPLETED', 'INCOMPLETE')),
    PRIMARY KEY (attempt_id, trial_id)
);

CREATE TABLE results (
    trial_id INTEGER PRIMARY KEY REFERENCES trials (trial_id),
    attempt_id INTEGER NOT NULL REFERENCES attempts (attempt_id),
    observation_format TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    observation_digest TEXT NOT NULL,
    outcome TEXT,
    completion_reason TEXT,
    completed_turn INTEGER,
    recorded_at TEXT NOT NULL
);

CREATE INDEX attempt_trials_by_trial ON attempt_trials (trial_id);

-- 観測値は正本なので書き換え・削除を許さない。
CREATE TRIGGER results_are_immutable BEFORE UPDATE ON results
BEGIN
    SELECT RAISE(ABORT, 'results are immutable');
END;

CREATE TRIGGER results_are_not_deleted BEFORE DELETE ON results
BEGIN
    SELECT RAISE(ABORT, 'results are immutable');
END;
"""
