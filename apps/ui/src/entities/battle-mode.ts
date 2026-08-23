// docs/ui-design/02_フロントエンドアーキテクチャ設計.md §「戦闘モード」:
// ルーターを導入せず、単一ページ内のタブで切り替える最上位状態。ページ全体・
// ダイアログ・ユニットプール判定が分岐するアプリ最上位の概念のため、タブUI
// （旧 `features/exercise/ModeTabs.tsx`）ではなく `entities` に置く（REF-055）。
export type BattleMode = "battle" | "exercise";
