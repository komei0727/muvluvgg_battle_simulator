import { Button } from "../../components/Button.js";
import type { ExecutionState, SuccessfulExecutionSnapshot } from "./execution-reducer.js";
import { selectDisplayedSuccess } from "./execution-reducer.js";
import type { UiApiError, UiApiErrorKind } from "./api-contract.js";
import styles from "./SubmissionFeedback.module.css";

export interface SubmissionFeedbackProps {
  readonly state: ExecutionState;
  readonly isDirty: boolean;
  // Issue #96 P1レビュー指摘: 表示中の成功snapshotが、現在保持しているCatalog
  // とは異なるrevisionで実行された結果であることを示す(selectIsCatalogRevisionMismatch)。
  readonly catalogRevisionMismatch?: boolean;
  readonly onReloadCatalog: () => void;
}

// docs/ui-design/03_API・データ連携設計.md §13: エラー種別ごとの表示文言。
// サーバーの生message/violationsはこの下にそのままtext表示し、HTMLとして解釈
// しない(05_非機能・アクセシビリティ設計.md §11 XSS)。
const ERROR_KIND_GUIDANCE: Readonly<Record<UiApiErrorKind, string>> = {
  VALIDATION: "入力内容を確認してください。",
  UNSUPPORTED_DEFINITION: "選択した定義は現在の戦闘ルールで未対応です。",
  RATE_LIMIT: "リクエストが多すぎます。しばらく待って再試行してください。",
  CAPACITY: "サーバーが混雑しています。しばらく待って再試行してください。",
  TIMEOUT: "応答がタイムアウトしました。条件を見直すか再試行してください。",
  // UIキャンセルはサーバーで戦闘が確実に停止したことを意味しない
  // (03_API・データ連携設計.md §7)。
  CANCELLED: "キャンセルを要求しました。",
  SERVER: "サーバーエラーが発生しました。",
  NETWORK: "APIに到達できませんでした。",
  CORS_OR_NETWORK: "APIに到達できませんでした。ネットワークまたはCORSの問題の可能性があります。",
  RESPONSE_CONTRACT_MISMATCH: "レスポンスの形式が想定と異なります。",
};

function isCatalogRevisionMismatch(error: UiApiError): boolean {
  return error.kind === "VALIDATION" && error.code === "DEFINITION_NOT_FOUND";
}

const CATALOG_REVISION_MISMATCH_MESSAGE =
  "Catalogが更新されたため、この結果は表示できません。再読込してユニット・Memoryの選択を確認してください。";

function SuccessSummary({ snapshot }: { readonly snapshot: SuccessfulExecutionSnapshot }) {
  const { response, requestId } = snapshot;
  return (
    <div className={styles["meta"]}>
      <span>Battle ID: {response.battleId}</span>
      <span>Catalog revision: {response.catalogRevision}</span>
      <span>
        {response.result.outcome} / {response.result.completionReason} (turn{" "}
        {response.result.completedTurn})
      </span>
      {requestId !== undefined ? <span>Request ID: {requestId}</span> : null}
    </div>
  );
}

// Renders whichever success snapshot is currently on screen, plus the dirty
// indicator whenever that snapshot no longer matches the live draft — this
// applies while submitting (rerun), failed, and cancelled alike, not only
// when the result itself just succeeded (UI-CMP-003). When the snapshot was
// produced by a Catalog revision that no longer matches the one currently
// held (Issue #96 P1), the result itself must not render — only a reload
// prompt — since the snapshot's definitionIds may resolve to different
// display data than what actually ran.
function DisplayedSuccess({
  snapshot,
  isDirty,
  label,
  catalogRevisionMismatch,
  onReloadCatalog,
}: {
  readonly snapshot: SuccessfulExecutionSnapshot;
  readonly isDirty: boolean;
  readonly label?: string;
  readonly catalogRevisionMismatch: boolean;
  readonly onReloadCatalog: () => void;
}) {
  if (catalogRevisionMismatch) {
    return (
      <>
        <p>{CATALOG_REVISION_MISMATCH_MESSAGE}</p>
        <Button variant="secondary" onClick={onReloadCatalog}>
          Catalogを再読込
        </Button>
      </>
    );
  }
  return (
    <>
      {label !== undefined ? <p>{label}</p> : null}
      <SuccessSummary snapshot={snapshot} />
      {isDirty ? <p className={styles["dirty"]}>この結果は変更前の条件です。</p> : null}
    </>
  );
}

function ErrorDetail({
  error,
  requestId,
}: {
  readonly error: UiApiError;
  readonly requestId?: string;
}) {
  return (
    <>
      <p>{error.message}</p>
      <div className={styles["meta"]}>
        {error.code !== undefined ? <span>code: {error.code}</span> : null}
        {error.diagnosticId !== undefined ? <span>diagnosticId: {error.diagnosticId}</span> : null}
        {requestId !== undefined ? <span>Request ID: {requestId}</span> : null}
        {error.retryAfterSeconds !== undefined ? (
          <span>Retry-After: {error.retryAfterSeconds}s</span>
        ) : null}
      </div>
      {error.violations !== undefined && error.violations.length > 0 ? (
        <ul>
          {error.violations.map((violation) => (
            <li key={`${violation.path ?? ""}:${violation.message}`}>
              {violation.path !== undefined ? `${violation.path}: ` : ""}
              {violation.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

// docs/ui-design/01_UI要求・画面設計.md §6 (実行状態), 03_API・データ連携設計.md
// §13 (エラー正規化), 05_非機能・アクセシビリティ設計.md §6 (aria-live="polite"
// で実行状態とエラー概要を通知、緊急でない失敗にrole="alert"を乱用しない)。
export function SubmissionFeedback({
  state,
  isDirty,
  catalogRevisionMismatch = false,
  onReloadCatalog,
}: SubmissionFeedbackProps) {
  const displayedSuccess = selectDisplayedSuccess(state);

  if (state.status === "idle") {
    return null;
  }

  if (state.status === "submitting") {
    return (
      <div className={`${styles["feedback"]} ${styles["submitting"]}`} aria-live="polite">
        <p>実行中…</p>
        {displayedSuccess !== undefined ? (
          <DisplayedSuccess
            snapshot={displayedSuccess}
            isDirty={isDirty}
            catalogRevisionMismatch={catalogRevisionMismatch}
            onReloadCatalog={onReloadCatalog}
          />
        ) : null}
      </div>
    );
  }

  if (state.status === "succeeded") {
    return (
      <div className={`${styles["feedback"]} ${styles["succeeded"]}`} aria-live="polite">
        <p>戦闘が完了しました。</p>
        <DisplayedSuccess
          snapshot={{ ...state }}
          isDirty={isDirty}
          catalogRevisionMismatch={catalogRevisionMismatch}
          onReloadCatalog={onReloadCatalog}
        />
      </div>
    );
  }

  if (state.status === "cancelled") {
    return (
      <div className={`${styles["feedback"]} ${styles["cancelled"]}`} aria-live="polite">
        <p>{ERROR_KIND_GUIDANCE.CANCELLED}</p>
        {displayedSuccess !== undefined ? (
          <DisplayedSuccess
            snapshot={displayedSuccess}
            isDirty={isDirty}
            label="前回成功結果を保持しています。"
            catalogRevisionMismatch={catalogRevisionMismatch}
            onReloadCatalog={onReloadCatalog}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${styles["feedback"]} ${styles["failed"]}`} aria-live="polite">
      <p>{ERROR_KIND_GUIDANCE[state.error.kind]}</p>
      <ErrorDetail
        error={state.error}
        {...(state.requestId !== undefined ? { requestId: state.requestId } : {})}
      />
      {isCatalogRevisionMismatch(state.error) ? (
        <Button variant="secondary" onClick={onReloadCatalog}>
          Catalogを再読込
        </Button>
      ) : null}
      {displayedSuccess !== undefined ? (
        <DisplayedSuccess
          snapshot={displayedSuccess}
          isDirty={isDirty}
          label="前回成功結果を保持しています。"
          catalogRevisionMismatch={catalogRevisionMismatch}
          onReloadCatalog={onReloadCatalog}
        />
      ) : null}
    </div>
  );
}
