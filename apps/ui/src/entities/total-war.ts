/**
 * R-TWR-01 #5: 総力戦の規定ターン数は15固定で、リクエストにも入力にも現れない。
 * ACL（`shared/api/response-validator.ts`）が成功レスポンスの`completedTurn`を
 * この定数で検証するため、`features/total-war`ではなく`entities`に置く。
 */
export const TOTAL_WAR_TURN_LIMIT = 15;

/** R-TWR-01 #1: 陣営あたりの編成数の上限。`formationNumber`は1からこの値まで。 */
export const TOTAL_WAR_MAX_FORMATIONS = 3;
