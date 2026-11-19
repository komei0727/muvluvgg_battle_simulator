/**
 * スキルレビューで要修正となった207評価行（`docs/skill-reviews/fix-issues/対応表.md`）の
 * 修正台帳。各行の必須の修正担当（FIX-01〜15）ごとに、修正を入れたIssue・PR・マージ
 * コミットと、その修正を実production定義で確かめる恒久テストのIDを持つ。
 *
 * 対応表の行・担当と台帳の一致、テストIDの実在、評価シートの対応状況・修正参照との
 * 同期は `skill-review-fix-ledger.test.ts` が検査する。
 */

export type FixId =
  | "FIX-01"
  | "FIX-02"
  | "FIX-03"
  | "FIX-04"
  | "FIX-05"
  | "FIX-06"
  | "FIX-07"
  | "FIX-08"
  | "FIX-09"
  | "FIX-10"
  | "FIX-11"
  | "FIX-12"
  | "FIX-13"
  | "FIX-14"
  | "FIX-15";

export interface FixDelivery {
  readonly issue: number;
  readonly pullRequest: number;
  readonly mergeCommit: string;
}

export const FIX_DELIVERIES: Readonly<Record<FixId, FixDelivery>> = {
  "FIX-01": {
    issue: 825,
    pullRequest: 841,
    mergeCommit: "a5556aa25ee50f86b25caa6a535e3ffc85db46d6",
  },
  "FIX-02": {
    issue: 826,
    pullRequest: 842,
    mergeCommit: "4bc0c8aa345c717248f6129e80e5f2c60c760ca3",
  },
  "FIX-03": {
    issue: 827,
    pullRequest: 843,
    mergeCommit: "7b14f3bb79c5d5448b3cf3b06a4d823b8c731dac",
  },
  "FIX-04": {
    issue: 828,
    pullRequest: 844,
    mergeCommit: "34835cf1f0afc337285ce6741bda4d4cf27bef8a",
  },
  "FIX-05": {
    issue: 829,
    pullRequest: 845,
    mergeCommit: "23ff2e20dc9f955026e1e723110f67962b140623",
  },
  "FIX-06": {
    issue: 830,
    pullRequest: 846,
    mergeCommit: "f98f39fd2064a8bf793b4cc6c9a879666bd45c3a",
  },
  "FIX-07": {
    issue: 831,
    pullRequest: 847,
    mergeCommit: "c29963f573982bc97142838896df64f8396b230c",
  },
  "FIX-08": {
    issue: 832,
    pullRequest: 849,
    mergeCommit: "1340185ed325aac2ba7fa1003d73d2aaabb5f36c",
  },
  "FIX-09": {
    issue: 833,
    pullRequest: 850,
    mergeCommit: "e51b3999937e2e482950c95a5bc7f22227d9931d",
  },
  "FIX-10": {
    issue: 834,
    pullRequest: 851,
    mergeCommit: "d0a2eabd2dcf017b50115a8a19712976188dc30c",
  },
  "FIX-11": {
    issue: 835,
    pullRequest: 852,
    mergeCommit: "b8b00034c603b37ec9568be480c1e5e2f7cd8cea",
  },
  "FIX-12": {
    issue: 836,
    pullRequest: 848,
    mergeCommit: "ec738583eefcdff8b1266674a0ffc467675825c7",
  },
  "FIX-13": {
    issue: 837,
    pullRequest: 853,
    mergeCommit: "07b0d3c48feb708d346ed5dad17fcc817bf3f4d8",
  },
  "FIX-14": {
    issue: 838,
    pullRequest: 854,
    mergeCommit: "632f36870ca2adced1e3b5ec36377f4fe573dcc8",
  },
  "FIX-15": {
    issue: 839,
    pullRequest: 859,
    mergeCommit: "93e01835b428a76a503d12a83841fb60cfbbc685",
  },
};

/**
 * 1つのテストが多数の評価行を表のスキル集合で回す横断テスト。テストのファイルに評価行の
 * SR番号もスキルIDも現れないため、行が横断の対象に入っていることを別に確かめる。
 */
export const SWEEP_ANCHOR_TEST_IDS: ReadonlySet<string> = new Set(["IT-CAT-HITCOND-001"]);

/**
 * 修正担当がすべて入った後も、同じスキルに未完了の関連Issueが残る行。評価シートでは
 * 修正参照と再検証を記録したうえで「再検証待ち」に留め、完了にしない。
 */
export const OPEN_RELATED_ISSUES: Readonly<Record<string, readonly number[]>> = {
  "SR-019": [748],
  "SR-216": [856, 858],
  "SR-217": [858],
  "SR-231": [855],
  "SR-331": [748],
  "SR-414": [748],
};

/**
 * 段階Gの記録で、ユニットごとに未完了のまま残る関連Issue。評価行の修正担当とは別に、
 * 同じユニットのスキルを名指しする未完了Issueを未確認点として残す。
 */
export const UNIT_OPEN_ISSUES: Readonly<Record<string, readonly number[]>> = {
  UNIT_AOI_GUARDIAN: [748],
  UNIT_CHIYURU_MAZE: [748],
  UNIT_DOROTHEA_GRACE: [767],
  UNIT_EVIE_ECO: [856, 858],
  UNIT_FEE_ACTOR: [748, 767],
  UNIT_HIIRO_LONEWOLF: [767, 856, 858],
  UNIT_JUNKA_CHILDHOOD: [748],
  UNIT_LAURA_MOUNTAIN: [748],
  UNIT_LUNA_HUNGRY: [858],
  UNIT_LYDIA_SUMMER: [767],
  UNIT_MAIA_SALON: [748],
  UNIT_MEIYA_FATED: [748],
  UNIT_MERU_FLATSPIN: [748],
  UNIT_MIRIAM_MAGE: [748],
  UNIT_NINA_ZINA_FRONTRUNNER: [748],
  UNIT_OLGA_NADYA_BOND: [686],
  UNIT_RAMI_NEWYEAR: [748],
  UNIT_RAMI_UNYIELDING: [748],
  UNIT_SAYA_LONGING: [748],
  UNIT_SHOUKA_BEACH: [855],
  UNIT_SIENA_OFFSTAGE: [748],
  UNIT_SUIRAN_CHAOS: [748],
  UNIT_URUU_SUMMER: [767],
  UNIT_YURIA_JOKER: [693],
};

export const OPEN_ISSUE_TITLES: Readonly<Record<number, string>> = {
  686: "サブ属性のUI/API表示",
  693: "メモリー由来のバフ・デバフの解除可否",
  748: "チャージ解放直前の攻撃前PS",
  767: "長期戦の計算量とPS連鎖上限",
  855: "最大HP上昇時の現在HP追随",
  856: "かばわれた攻撃のPP削りの適用先",
  858: "攻撃前PSの発動単位と同時発動制限",
};

/** 評価行 → 担当 → その担当の修正を確かめる恒久テストのID。 */
export const SKILL_REVIEW_FIX_ANCHORS: Readonly<
  Record<string, Readonly<Partial<Record<FixId, readonly string[]>>>>
> = {
  "SR-006": {
    "FIX-01": ["IT-CAT-HITCOND-001", "IT-UNIT-RAMI-NEWYEAR-005"],
  },
  "SR-011": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-15": ["IT-UNIT-EVIE-KYONSHI-004"],
  },
  "SR-012": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-013": {
    "FIX-03": ["IT-CAT-HITCOND-017"],
  },
  "SR-014": {
    "FIX-03": ["IT-CAT-HITCOND-018", "IT-CAT-HITCOND-019"],
  },
  "SR-019": {
    "FIX-04": ["IT-CAT-ATKCONS-014"],
  },
  "SR-020": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-026": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-027": {
    "FIX-01": ["IT-CAT-HITCOND-001", "IT-UNIT-SHOUKA-SCHEMER-006"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-SHOUKA-SCHEMER-006"],
  },
  "SR-028": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-MIHIME-SNIPER-001"],
    "FIX-07": [
      "IT-CAT-LIFETIME-001",
      "IT-CAT-LIFETIME-002",
      "IT-CAT-TGTPRI-007",
      "IT-UNIT-MIHIME-SNIPER-001",
    ],
  },
  "SR-029": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
    "FIX-07": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-031": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-032": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-034": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-038": {
    "FIX-13": ["IT-UNIT-ROSIE-ARTIST-001", "IT-UNIT-ROSIE-ARTIST-005"],
  },
  "SR-046": {
    "FIX-02": [
      "IT-UNIT-CLARA-TSUNDERE-001",
      "IT-UNIT-CLARA-TSUNDERE-004",
      "IT-UNIT-CLARA-TSUNDERE-008",
      "IT-UNIT-CLARA-TSUNDERE-009",
    ],
    "FIX-05": [
      "IT-CAT-LIFETIME-001",
      "IT-CAT-LIFETIME-002",
      "IT-UNIT-CLARA-TSUNDERE-001",
      "IT-UNIT-CLARA-TSUNDERE-004",
      "IT-UNIT-CLARA-TSUNDERE-008",
      "IT-UNIT-CLARA-TSUNDERE-009",
    ],
  },
  "SR-047": {
    "FIX-07": ["IT-CAT-TGTPRI-010", "IT-CAT-TGTPRI-011", "IT-CAT-TGTPRI-018"],
  },
  "SR-048": {
    "FIX-13": ["IT-UNIT-ROSIE-ARTIST-005"],
  },
  "SR-052": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-053": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-07": ["IT-CAT-TGTPRI-004"],
  },
  "SR-056": {
    "FIX-04": ["IT-CAT-ATKCONS-006"],
    "FIX-14": ["IT-UNIT-ROSIE-ARTIST-001"],
  },
  "SR-058": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-060": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-064": {
    "FIX-07": ["IT-CAT-TGTPRI-010", "IT-CAT-TGTPRI-011"],
  },
  "SR-068": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-069": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-070": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-071": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-077": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-082": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-087": {
    "FIX-03": ["IT-CAT-HITCOND-011", "IT-CAT-HITCOND-012"],
  },
  "SR-088": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-091": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-092": {
    "FIX-01": ["IT-CAT-HITCOND-001", "IT-UNIT-TARISA-TROUBLEMAKER-011"],
  },
  "SR-094": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-006"],
  },
  "SR-095": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-003"],
  },
  "SR-100": {
    "FIX-07": ["IT-CAT-TGTPRI-005"],
  },
  "SR-102": {
    "FIX-03": ["IT-CAT-HITCOND-020"],
  },
  "SR-110": {
    "FIX-14": ["IT-UNIT-HARRIET-SAGE-006"],
  },
  "SR-113": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-115": {
    "FIX-08": ["IT-CAT-ATKSUM-010", "IT-CAT-ATKSUM-011", "IT-CAT-ATKSUM-012"],
  },
  "SR-116": {
    "FIX-09": ["IT-UNIT-FLUTE-INFLUENCER-004"],
  },
  "SR-117": {
    "FIX-14": ["IT-UNIT-FLUTE-INFLUENCER-001"],
  },
  "SR-119": {
    "FIX-04": ["IT-CAT-ATKCONS-009", "IT-CAT-ATKCONS-010", "IT-CAT-ATKCONS-018"],
  },
  "SR-121": {
    "FIX-04": ["IT-CAT-ATKCONS-005"],
  },
  "SR-127": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-010"],
  },
  "SR-130": {
    "FIX-13": ["IT-UNIT-ROSIE-ARTIST-001", "IT-UNIT-ROSIE-ARTIST-005"],
  },
  "SR-134": {
    "FIX-07": ["IT-CAT-TGTPRI-008", "IT-UNIT-SHIRANA-LUCKY-001"],
  },
  "SR-135": {
    "FIX-05": ["IT-CAT-LIFETIME-003"],
  },
  "SR-136": {
    "FIX-08": ["IT-CAT-ATKSUM-003"],
  },
  "SR-139": {
    "FIX-04": ["IT-CAT-ATKCONS-013", "IT-UNIT-YIFEI-STORM-005"],
  },
  "SR-145": {
    "FIX-07": ["IT-CAT-TGTPRI-003"],
  },
  "SR-152": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-153": {
    "FIX-04": ["IT-CAT-ATKCONS-011"],
  },
  "SR-154": {
    "FIX-13": ["IT-UNIT-NANAE-SOVEREIGN-001"],
  },
  "SR-158": {
    "FIX-09": ["IT-UNIT-YURIA-WILDCARD-004"],
  },
  "SR-160": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-162": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-07": ["IT-CAT-TGTPRI-010", "IT-CAT-TGTPRI-011"],
  },
  "SR-163": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-164": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-008"],
  },
  "SR-165": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-166": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-168": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-169": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-170": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-171": {
    "FIX-09": ["IT-CAT-IMMUNITY-001"],
  },
  "SR-172": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-173": {
    "FIX-09": ["IT-CAT-IMMUNITY-004"],
  },
  "SR-175": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-176": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-177": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-04": ["IT-CAT-ATKCONS-001"],
  },
  "SR-179": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-004", "IT-CAT-HITCOND-005"],
  },
  "SR-181": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-182": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-183": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-184": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-007"],
  },
  "SR-185": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-186": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-190": {
    "FIX-09": ["IT-CAT-IMMUNITY-003"],
  },
  "SR-191": {
    "FIX-04": ["IT-CAT-ATKCONS-007"],
  },
  "SR-192": {
    "FIX-07": [
      "IT-CAT-TGTPRI-014",
      "IT-CAT-TGTPRI-015",
      "IT-UNIT-JULIE-SNOW-001",
      "IT-UNIT-JULIE-SNOW-005",
    ],
  },
  "SR-193": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-194": {
    "FIX-04": ["IT-CAT-ATKCONS-007"],
    "FIX-09": ["IT-CAT-IMMUNITY-006"],
  },
  "SR-195": {
    "FIX-04": ["IT-CAT-ATKCONS-005"],
  },
  "SR-196": {
    "FIX-09": ["IT-CAT-IMMUNITY-005"],
  },
  "SR-207": {
    "FIX-04": ["IT-CAT-ATKCONS-003"],
  },
  "SR-209": {
    "FIX-03": ["IT-CAT-HITCOND-021"],
  },
  "SR-212": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-009"],
  },
  "SR-213": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-215": {
    "FIX-11": ["IT-UNIT-ELENA-MOODMAKER-018"],
    "FIX-14": ["IT-UNIT-ELENA-MOODMAKER-001"],
  },
  "SR-216": {
    "FIX-05": [
      "IT-CAT-LIFETIME-001",
      "IT-CAT-LIFETIME-002",
      "IT-CAT-PROD-002",
      "IT-UNIT-EVIE-ECO-001",
    ],
    "FIX-13": ["IT-CAT-PROD-002", "IT-UNIT-EVIE-ECO-001"],
  },
  "SR-217": {
    "FIX-05": [
      "IT-CAT-LIFETIME-001",
      "IT-CAT-LIFETIME-002",
      "IT-UNIT-LUNA-HUNGRY-001",
      "IT-UNIT-LUNA-HUNGRY-005",
    ],
    "FIX-11": [
      "IT-CAT-LIFETIME-001",
      "IT-CAT-LIFETIME-002",
      "IT-UNIT-LUNA-HUNGRY-001",
      "IT-UNIT-LUNA-HUNGRY-005",
    ],
    "FIX-13": ["IT-UNIT-LUNA-HUNGRY-001", "IT-UNIT-LUNA-HUNGRY-005"],
  },
  "SR-218": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-219": {
    "FIX-10": [
      "IT-CAT-SURVIVAL-001",
      "IT-CAT-SURVIVAL-002",
      "IT-CAT-SURVIVAL-008",
      "IT-CAT-SURVIVAL-009",
      "IT-CAT-SURVIVAL-011",
      "IT-CAT-SURVIVAL-012",
    ],
  },
  "SR-221": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-CHIZURU-DOMESTIC-006"],
    "FIX-11": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-CHIZURU-DOMESTIC-006"],
  },
  "SR-222": {
    "FIX-10": ["IT-CAT-SURVIVAL-005"],
  },
  "SR-223": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-DOROTHEA-PIONEER-006"],
    "FIX-11": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002", "IT-UNIT-DOROTHEA-PIONEER-006"],
  },
  "SR-226": {
    "FIX-10": ["IT-CAT-SURVIVAL-001", "IT-CAT-SURVIVAL-002"],
  },
  "SR-227": {
    "FIX-10": ["IT-CAT-SURVIVAL-005"],
  },
  "SR-229": {
    "FIX-04": ["IT-CAT-ATKCONS-002"],
  },
  "SR-231": {
    "FIX-11": ["IT-UNIT-SHOUKA-BEACH-006"],
  },
  "SR-232": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-11": ["IT-UNIT-SHOUKA-BEACH-007"],
  },
  "SR-233": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
    "FIX-10": ["IT-CAT-SURVIVAL-001"],
  },
  "SR-235": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-236": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-08": ["IT-CAT-ATKSUM-002"],
  },
  "SR-237": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-238": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-239": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-240": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-246": {
    "FIX-03": ["IT-CAT-HITCOND-013"],
  },
  "SR-254": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-255": {
    "FIX-04": ["IT-CAT-ATKCONS-004"],
  },
  "SR-257": {
    "FIX-03": ["IT-CAT-HITCOND-013"],
  },
  "SR-264": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-001", "IT-CAT-MKGRANT-009"],
  },
  "SR-265": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-001", "IT-CAT-MKGRANT-009"],
    "FIX-07": ["IT-CAT-TGTPRI-001"],
  },
  "SR-266": {
    "FIX-06": ["IT-CAT-MKGRANT-002", "IT-CAT-MKGRANT-009"],
  },
  "SR-267": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-268": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-271": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-272": {
    "FIX-03": ["IT-CAT-HITCOND-015", "IT-CAT-HITCOND-016"],
  },
  "SR-273": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-275": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-276": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-282": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-283": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-285": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-286": {
    "FIX-15": ["IT-UNIT-KOTOHA-REBEL-007"],
  },
  "SR-287": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-290": {
    "FIX-07": ["IT-CAT-TGTPRI-012", "IT-CAT-TGTPRI-013"],
  },
  "SR-291": {
    "FIX-03": ["IT-CAT-HITCOND-014", "IT-UNIT-SAYA-BUNNY-001"],
  },
  "SR-292": {
    "FIX-04": ["IT-CAT-ATKCONS-015"],
  },
  "SR-294": {
    "FIX-03": ["IT-CAT-HITCOND-022"],
  },
  "SR-295": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-296": {
    "FIX-09": ["IT-CAT-IMMUNITY-004"],
  },
  "SR-297": {
    "FIX-03": [
      "IT-CAT-HITCOND-023",
      "IT-CAT-HITCOND-024",
      "IT-CAT-HITCOND-028",
      "IT-CAT-HITCOND-029",
    ],
    "FIX-06": ["IT-CAT-MKGRANT-009", "IT-UNIT-HARRIET-SAGE-001", "IT-UNIT-HARRIET-SAGE-004"],
    "FIX-07": ["IT-UNIT-HARRIET-SAGE-001", "IT-UNIT-HARRIET-SAGE-004"],
  },
  "SR-299": {
    "FIX-06": ["IT-CAT-MKGRANT-003", "IT-CAT-MKGRANT-009", "IT-UNIT-LAYLA-NURSE-006"],
    "FIX-11": ["IT-UNIT-LAYLA-NURSE-006"],
  },
  "SR-301": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-304": {
    "FIX-03": ["IT-CAT-HITCOND-013"],
  },
  "SR-308": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-309": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009", "IT-UNIT-URUU-SUMMER-001"],
    "FIX-13": ["IT-UNIT-URUU-SUMMER-001"],
  },
  "SR-310": {
    "FIX-01": ["IT-UNIT-YIFEI-STORM-007"],
    "FIX-03": ["IT-UNIT-YIFEI-STORM-007"],
  },
  "SR-311": {
    "FIX-13": ["IT-UNIT-YIFEI-STORM-001", "IT-UNIT-YIFEI-STORM-008"],
  },
  "SR-317": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-318": {
    "FIX-14": ["IT-UNIT-JULIE-SNOW-006", "IT-UNIT-JULIE-SNOW-007", "UT-R-DMG-04-019"],
  },
  "SR-319": {
    "FIX-09": ["IT-CAT-IMMUNITY-002"],
  },
  "SR-322": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-328": {
    "FIX-03": ["IT-CAT-HITCOND-025", "IT-CAT-HITCOND-026", "IT-CAT-HITCOND-027"],
  },
  "SR-329": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-331": {
    "FIX-04": ["IT-CAT-ATKCONS-017", "IT-UNIT-LAURA-MOUNTAIN-001"],
  },
  "SR-332": {
    "FIX-14": ["IT-UNIT-FLUTE-VAMPIRE-001"],
  },
  "SR-336": {
    "FIX-06": ["IT-CAT-MKGRANT-004", "IT-CAT-MKGRANT-009", "IT-UNIT-HIIRO-FREEWOLF-001"],
    "FIX-07": ["IT-CAT-TGTPRI-009", "IT-UNIT-HIIRO-FREEWOLF-001"],
  },
  "SR-338": {
    "FIX-06": ["IT-CAT-MKGRANT-004"],
    "FIX-07": ["IT-CAT-TGTPRI-016"],
  },
  "SR-339": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-342": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-345": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-10": ["IT-CAT-SURVIVAL-003", "IT-CAT-SURVIVAL-013"],
  },
  "SR-347": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-348": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-351": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-354": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-12": ["IT-CAT-SUBACT-001", "IT-CAT-SUBACT-014"],
  },
  "SR-355": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-12": ["IT-CAT-SUBACT-014"],
  },
  "SR-356": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-12": ["IT-CAT-SUBACT-002", "IT-CAT-SUBACT-014"],
  },
  "SR-357": {
    "FIX-13": ["IT-CAT-PROD-017", "IT-UNIT-NADYA-SUCCESSOR-006"],
  },
  "SR-358": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-12": ["IT-CAT-SUBACT-014"],
  },
  "SR-360": {
    "FIX-07": ["IT-CAT-TGTPRI-017"],
  },
  "SR-361": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-363": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-08": ["IT-CAT-ATKSUM-006", "IT-CAT-ATKSUM-013", "IT-CAT-ATKSUM-015"],
  },
  "SR-364": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
    "FIX-12": ["IT-CAT-SUBACT-005", "IT-CAT-SUBACT-014"],
  },
  "SR-365": {
    "FIX-10": [
      "IT-CAT-SURVIVAL-004",
      "IT-CAT-SURVIVAL-007",
      "IT-CAT-SURVIVAL-008",
      "IT-CAT-SURVIVAL-010",
    ],
    "FIX-12": ["IT-CAT-SUBACT-014"],
  },
  "SR-366": {
    "FIX-12": ["IT-CAT-SUBACT-014", "IT-UNIT-SHIRANA-SORA-001"],
  },
  "SR-367": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-368": {
    "FIX-12": ["IT-CAT-SUBACT-014", "IT-UNIT-SHIRANA-SORA-001"],
  },
  "SR-369": {
    "FIX-12": ["IT-CAT-SUBACT-014", "IT-UNIT-LYDIA-SUMMER-001"],
  },
  "SR-370": {
    "FIX-12": ["IT-CAT-SUBACT-014", "IT-UNIT-LYDIA-SUMMER-001"],
  },
  "SR-371": {
    "FIX-12": [
      "IT-CAT-SUBACT-004",
      "IT-CAT-SUBACT-014",
      "IT-UNIT-LYDIA-SUMMER-001",
      "IT-UNIT-LYDIA-SUMMER-TEX-001",
    ],
  },
  "SR-373": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-374": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-375": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-376": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-12": ["IT-CAT-SUBACT-014"],
  },
  "SR-377": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-378": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-379": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
  },
  "SR-381": {
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-383": {
    "FIX-08": ["IT-CAT-ATKSUM-001"],
  },
  "SR-384": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-07": ["IT-CAT-TGTPRI-006", "IT-UNIT-KOKORO-SPORTSDAY-001"],
  },
  "SR-387": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
  },
  "SR-388": {
    "FIX-01": ["IT-CAT-HITCOND-001", "IT-UNIT-RAVEL-MODEL-005"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-389": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-391": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-394": {
    "FIX-10": ["IT-CAT-SURVIVAL-004"],
  },
  "SR-395": {
    "FIX-04": ["IT-CAT-ATKCONS-016"],
    "FIX-05": ["IT-CAT-LIFETIME-001", "IT-CAT-LIFETIME-002"],
  },
  "SR-397": {
    "FIX-06": ["IT-CAT-MKGRANT-005", "IT-CAT-MKGRANT-009"],
    "FIX-08": ["IT-CAT-ATKSUM-007", "IT-CAT-ATKSUM-008", "IT-CAT-ATKSUM-009"],
  },
  "SR-398": {
    "FIX-03": ["IT-CAT-HITCOND-013"],
  },
  "SR-399": {
    "FIX-02": ["IT-CAT-HITCOND-002", "IT-CAT-HITCOND-008"],
  },
  "SR-403": {
    "FIX-11": ["IT-UNIT-SUIRAN-CASINO-004"],
  },
  "SR-405": {
    "FIX-06": ["IT-CAT-MKGRANT-006", "IT-CAT-MKGRANT-009"],
  },
  "SR-406": {
    "FIX-04": ["IT-CAT-ATKCONS-008", "IT-CAT-ATKCONS-012"],
  },
  "SR-407": {
    "FIX-06": ["IT-CAT-MKGRANT-006", "IT-CAT-MKGRANT-009"],
  },
  "SR-408": {
    "FIX-08": [
      "IT-CAT-ATKSUM-004",
      "IT-CAT-ATKSUM-005",
      "IT-CAT-ATKSUM-014",
      "IT-UNIT-YUI-HEIR-001",
    ],
  },
  "SR-412": {
    "FIX-01": [
      "IT-CAT-HITCOND-001",
      "IT-UNIT-NINA-ZINA-FRONTRUNNER-012",
      "IT-UNIT-NINA-ZINA-FRONTRUNNER-013",
    ],
    "FIX-06": [
      "IT-CAT-MKGRANT-009",
      "IT-UNIT-NINA-ZINA-FRONTRUNNER-012",
      "IT-UNIT-NINA-ZINA-FRONTRUNNER-013",
    ],
  },
  "SR-413": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
    "FIX-09": ["IT-CAT-IMMUNITY-002"],
  },
  "SR-414": {
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-415": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-416": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-417": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-418": {
    "FIX-01": ["IT-CAT-HITCOND-001"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
  "SR-419": {
    "FIX-10": ["IT-CAT-SURVIVAL-004", "IT-CAT-SURVIVAL-006"],
  },
  "SR-420": {
    "FIX-02": ["IT-CAT-HITCOND-002"],
    "FIX-06": ["IT-CAT-MKGRANT-009"],
  },
};
