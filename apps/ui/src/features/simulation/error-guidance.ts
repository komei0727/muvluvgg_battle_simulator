import type { UiApiErrorKind } from "./api-contract.js";

// docs/ui-design/03_API・データ連携設計.md §13: エラー種別ごとの表示文言。
// サーバーの生message/violationsはこの下にそのままtext表示し、HTMLとして解釈
// しない(05_非機能・アクセシビリティ設計.md §11 XSS)。
//
// 単一実行（`SubmissionFeedback`）と統計実行（`describeStatisticsRunError`）が同じ表を
// 使う。実行経路ごとに文言を持つと、同じ失敗がモードによって別の案内で出る。
export const ERROR_KIND_GUIDANCE: Readonly<Record<UiApiErrorKind, string>> = {
  VALIDATION: "入力内容を確認してください。",
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
