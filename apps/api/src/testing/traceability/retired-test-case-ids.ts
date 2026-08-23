/**
 * 退役したテストケースIDの台帳。番号の再利用は過去の証跡との衝突を生むため、
 * ここに載るIDは欠番のまま維持し、復活も再割当もしない
 * （`retired-test-case-ids.test.ts` の `UT-TRACEABILITY-011` が機械検査する）。
 */

export interface RetiredTestCaseId {
  readonly id: string;
  readonly retiredIn: string;
  readonly reason: string;
}

export const RETIRED_TEST_CASE_IDS: readonly RetiredTestCaseId[] = [
  {
    id: "SCN-BTL-022",
    retiredIn: "Issue #352",
    reason:
      "未実装Capabilityの拒否シナリオ。Capability概念自体の廃止（REF-023）で検証対象が消滅した。",
  },
  {
    id: "API-CONTRACT-011",
    retiredIn: "Issue #352",
    reason: "Capability概念の廃止（REF-023）に伴い削除された。",
  },
  {
    id: "UT-CAT-ACT-038",
    retiredIn: "Issue #352",
    reason: "Capability概念の廃止（REF-023）に伴い削除された。",
  },
  {
    id: "UT-R-EFF-01-026",
    retiredIn: "Issue #352",
    reason: "Capability概念の廃止（REF-023）に伴い削除された。",
  },
  {
    id: "UT-R-HEAL-04-003",
    retiredIn: "Issue #352",
    reason: "Capability概念の廃止（REF-023）に伴い削除された。",
  },
  {
    id: "UT-PREFLIGHT-004",
    retiredIn: "Issue #352",
    reason: "Capability概念の廃止（REF-023）に伴い削除された。",
  },
  {
    id: "UT-BATTLE-015",
    retiredIn: "PR #152",
    reason: "0コストPS適用を検証する不正なテストケースだったため削除された。",
  },
];
