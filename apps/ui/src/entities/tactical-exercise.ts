/**
 * R-TEX-01: 演習のターン数は固定で、リクエストにも入力にも現れない。ACL
 * （`shared/api/response-validator.ts`）が成功レスポンスの`completedTurn`を
 * この定数で検証するため、演習機能（`features/exercise`）ではなく`entities`に
 * 置く（REF-055）。
 */
export const EXERCISE_TURN_LIMIT = 5;
