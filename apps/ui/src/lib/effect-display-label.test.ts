import { describe, expect, it } from "vitest";
import { createEffectLabeler } from "./effect-display-label.js";
import type { EffectLabelCatalog, EffectLabelEvent } from "./effect-display-label.js";

const UNITS = new Map([
  ["bu-ally-1", { displayName: "【幼き日の約束】鑑純夏" }],
  ["bu-enemy-1", { displayName: "エネミーα" }],
]);

const CATALOG: EffectLabelCatalog = {
  skills: [
    {
      skillDefinitionId: "SKL_SUMIKA_PS1",
      slotLabel: "PS1",
    },
    { skillDefinitionId: "SKL_SUMIKA_AS2", slotLabel: "AS2" },
    // 複数ユニットが宣言するスキルは枠を持たない。
    { skillDefinitionId: "SKL_SHARED" },
  ],
  effects: [
    {
      effectActionDefinitionId: "ACT_ATK_UP",
      kind: "APPLY_STAT_MOD",
      stat: "ATTACK",
      valueType: "RATIO",
      constantMagnitude: 0.05,
    },
    {
      effectActionDefinitionId: "ACT_DEF_DOWN",
      kind: "APPLY_STAT_MOD",
      stat: "DEFENSE",
      valueType: "RATIO",
      constantMagnitude: -0.15,
    },
    {
      effectActionDefinitionId: "ACT_ATK_FLAT",
      kind: "APPLY_STAT_MOD",
      stat: "ATTACK",
      valueType: "FIXED",
    },
    {
      effectActionDefinitionId: "ACT_CRIT_UP",
      kind: "APPLY_STAT_MOD",
      stat: "CRITICAL_RATE",
      valueType: "FIXED",
      constantMagnitude: 0.3,
    },
    {
      effectActionDefinitionId: "ACT_DMG_TAKEN_UP",
      kind: "APPLY_DAMAGE_MOD",
      direction: "INCOMING",
      constantMagnitude: 0.7,
    },
    {
      effectActionDefinitionId: "ACT_EN_DMG_UP",
      kind: "APPLY_DAMAGE_MOD",
      direction: "OUTGOING",
      damageType: "EN",
      constantMagnitude: 0.1,
    },
    { effectActionDefinitionId: "ACT_STUN", kind: "APPLY_STATUS", status: "STUN" },
    { effectActionDefinitionId: "ACT_SHIELD", kind: "APPLY_SHIELD" },
    { effectActionDefinitionId: "ACT_REGEN", kind: "APPLY_CONTINUOUS_HEAL" },
    { effectActionDefinitionId: "ACT_FUTURE", kind: "APPLY_SOMETHING_NEW" },
  ],
  memories: [{ memoryDefinitionId: "MEM_SCHOOL", displayName: "取り戻した学園生活" }],
};

const EVENTS: readonly EffectLabelEvent[] = [
  {
    sequence: 1,
    type: "PASSIVE_ACTIVATED",
    skillUseId: "su-ps",
    details: { skillDefinitionId: "SKL_SUMIKA_PS1", actorUnitId: "bu-ally-1" },
  },
  {
    sequence: 2,
    type: "EFFECT_APPLIED",
    skillUseId: "su-ps",
    details: { effectActionDefinitionId: "ACT_ATK_UP" },
  },
  {
    sequence: 3,
    type: "SKILL_USE_STARTED",
    skillUseId: "su-as",
    details: { skillDefinitionId: "SKL_SUMIKA_AS2" },
  },
  {
    sequence: 4,
    type: "MEMORY_TRIGGERED",
    skillUseId: "su-mem",
    details: { memoryDefinitionId: "MEM_SCHOOL" },
  },
  {
    sequence: 5,
    type: "MEMORY_TRIGGERED",
    skillUseId: "su-mem-unknown",
    details: { memoryDefinitionId: "MEM_NOT_IN_CATALOG" },
  },
  {
    sequence: 6,
    type: "SKILL_USE_STARTED",
    skillUseId: "su-unknown-skill",
    details: { skillDefinitionId: "SKL_NOT_IN_CATALOG" },
  },
  {
    sequence: 7,
    type: "SKILL_USE_STARTED",
    skillUseId: "su-shared",
    details: { skillDefinitionId: "SKL_SHARED" },
  },
];

const labeler = createEffectLabeler(CATALOG, UNITS, EVENTS);

describe("createEffectLabeler.grantLabel", () => {
  it("UI-UT-LBL-001: キャラ正式名-スキル種別番号-効果内容で表し、量は付与時点のmagnitudeを使う", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originUnitId: "bu-ally-1",
        skillUseId: "su-ps",
        magnitude: 0.08,
      }),
    ).toBe("【幼き日の約束】鑑純夏-PS1-攻撃力+8%");
  });

  it("UI-UT-LBL-002: 減少は負号で、割合の浮動小数誤差を表示に出さない", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_DEF_DOWN",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: -0.07,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-防御力-7%");
  });

  it("UI-UT-LBL-003: 固定値は実数で、ポイント加算ステータスの固定値は%で表す", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_ATK_FLAT",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: 1200,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-攻撃力+1200");
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_CRIT_UP",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: 0.3,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-会心率+30%");
  });

  it("UI-UT-LBL-004: ダメージ補正は与ダメ/被ダメとダメージ種別で表す", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_DMG_TAKEN_UP",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: 0.7,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-被ダメージ+70%");
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_EN_DMG_UP",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: 0.1,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-与ENダメージ+10%");
  });

  it("UI-UT-LBL-005: 状態は状態名、シールドは量、その他のkindは種別名で表す", () => {
    const origin = { originUnitId: "bu-ally-1", skillUseId: "su-as" } as const;
    expect(
      labeler.grantLabel({ ...origin, effectActionDefinitionId: "ACT_STUN", magnitude: 0 }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-気絶");
    expect(
      labeler.grantLabel({ ...origin, effectActionDefinitionId: "ACT_SHIELD", magnitude: 12000.4 }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-シールド(12000)");
    expect(
      labeler.grantLabel({ ...origin, effectActionDefinitionId: "ACT_REGEN", magnitude: 500 }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-継続回復");
  });

  it("UI-UT-LBL-006: メモリー由来はメモリー名-効果内容で表す", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originSide: "ALLY",
        skillUseId: "su-mem",
        magnitude: 0.05,
      }),
    ).toBe("取り戻した学園生活-攻撃力+5%");
  });

  it("UI-UT-LBL-007: メモリー名が引けなければ陣営名で代替する", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originSide: "ENEMY",
        skillUseId: "su-mem-unknown",
        magnitude: 0.05,
      }),
    ).toBe("ENEMY陣営のMemory-攻撃力+5%");
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originSide: "ALLY",
        magnitude: 0.05,
      }),
    ).toBe("ALLY陣営のMemory-攻撃力+5%");
  });

  it("UI-UT-LBL-008: スキルが引けない場合はキャラ名と効果内容だけで表す", () => {
    for (const skillUseId of ["su-unknown-skill", "su-shared", "su-not-in-log", undefined]) {
      expect(
        labeler.grantLabel({
          effectActionDefinitionId: "ACT_ATK_UP",
          originUnitId: "bu-ally-1",
          ...(skillUseId !== undefined ? { skillUseId } : {}),
          magnitude: 0.05,
        }),
      ).toBe("【幼き日の約束】鑑純夏-攻撃力+5%");
    }
  });

  it("UI-UT-LBL-009: 効果内容が引けなければ論理名を効果内容の位置に出す", () => {
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_FUTURE",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
        magnitude: 1,
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-ACT_FUTURE");
    expect(
      labeler.grantLabel({
        effectActionDefinitionId: "ACT_NOT_IN_CATALOG",
        originUnitId: "bu-ally-1",
        skillUseId: "su-as",
      }),
    ).toBe("【幼き日の約束】鑑純夏-AS2-ACT_NOT_IN_CATALOG");
  });

  it("UI-UT-LBL-010: Catalog要約が無い（旧API）場合はキャラ名と論理名で表す", () => {
    const legacy = createEffectLabeler({ memories: [] }, UNITS, EVENTS);
    expect(
      legacy.grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originUnitId: "bu-ally-1",
        skillUseId: "su-ps",
        magnitude: 0.05,
      }),
    ).toBe("【幼き日の約束】鑑純夏-ACT_ATK_UP");
    expect(
      createEffectLabeler(undefined, UNITS, EVENTS).grantLabel({
        effectActionDefinitionId: "ACT_ATK_UP",
        originSide: "ALLY",
        skillUseId: "su-mem",
      }),
    ).toBe("ALLY陣営のMemory-ACT_ATK_UP");
  });

  it("UI-UT-LBL-011: 付与元が何も分からなければ効果内容だけで表す", () => {
    expect(labeler.grantLabel({ effectActionDefinitionId: "ACT_STUN" })).toBe("気絶");
  });
});

describe("createEffectLabeler.definitionLabel", () => {
  it("UI-UT-LBL-012: 全付与の付与元が同じならその付与元と、定義上の固定値で表す", () => {
    const grant = {
      effectActionDefinitionId: "ACT_ATK_UP",
      originUnitId: "bu-ally-1",
      skillUseId: "su-ps",
      magnitude: 0.08,
    };
    expect(labeler.definitionLabel("ACT_ATK_UP", [grant, grant])).toBe(
      "【幼き日の約束】鑑純夏-PS1-攻撃力+5%",
    );
  });

  it("UI-UT-LBL-013: 定義上の固定値が無ければ量を出さない", () => {
    expect(
      labeler.definitionLabel("ACT_ATK_FLAT", [
        {
          effectActionDefinitionId: "ACT_ATK_FLAT",
          originUnitId: "bu-ally-1",
          skillUseId: "su-as",
          magnitude: 1200,
        },
      ]),
    ).toBe("【幼き日の約束】鑑純夏-AS2-攻撃力");
  });

  it("UI-UT-LBL-014: 付与元が複数に分かれる定義は付与元を出さない", () => {
    expect(
      labeler.definitionLabel("ACT_ATK_UP", [
        { effectActionDefinitionId: "ACT_ATK_UP", originUnitId: "bu-ally-1", skillUseId: "su-ps" },
        { effectActionDefinitionId: "ACT_ATK_UP", originSide: "ALLY", skillUseId: "su-mem" },
      ]),
    ).toBe("攻撃力+5%");
  });

  it("UI-UT-LBL-015: Catalog要約が無ければ論理名で表す", () => {
    expect(createEffectLabeler(undefined, UNITS, EVENTS).definitionLabel("ACT_ATK_UP", [])).toBe(
      "ACT_ATK_UP",
    );
  });
});

describe("createEffectLabeler.skillLabel", () => {
  it("UI-UT-LBL-016: スキルをキャラ正式名-スキル種別番号で表す", () => {
    expect(labeler.skillLabel("bu-ally-1", "SKL_SUMIKA_PS1")).toBe("【幼き日の約束】鑑純夏-PS1");
  });

  it("UI-UT-LBL-017: スキル種別番号が引けなければその位置に論理名を出す", () => {
    expect(labeler.skillLabel("bu-ally-1", "SKL_NOT_IN_CATALOG")).toBe(
      "【幼き日の約束】鑑純夏-SKL_NOT_IN_CATALOG",
    );
    expect(labeler.skillLabel("bu-ally-1", "SKL_SHARED")).toBe("【幼き日の約束】鑑純夏-SKL_SHARED");
    expect(
      createEffectLabeler(undefined, UNITS, EVENTS).skillLabel("bu-ally-1", "SKL_SUMIKA_PS1"),
    ).toBe("【幼き日の約束】鑑純夏-SKL_SUMIKA_PS1");
  });

  it("UI-UT-LBL-018: 使用者が分からなければスキル種別番号だけで表す", () => {
    expect(labeler.skillLabel(undefined, "SKL_SUMIKA_AS2")).toBe("AS2");
  });

  it("UI-UT-LBL-019: 定義単位では、使用者が全員同じ表示名のときだけキャラ名を出す", () => {
    const units = new Map([...UNITS, ["bu-ally-2", { displayName: "【幼き日の約束】鑑純夏" }]]);
    const local = createEffectLabeler(CATALOG, units, EVENTS);
    expect(local.skillDefinitionLabel("SKL_SUMIKA_PS1", ["bu-ally-1", "bu-ally-2"])).toBe(
      "【幼き日の約束】鑑純夏-PS1",
    );
    expect(local.skillDefinitionLabel("SKL_SUMIKA_PS1", ["bu-ally-1", "bu-enemy-1"])).toBe("PS1");
  });
});

describe("createEffectLabeler.instanceLabel", () => {
  const instanceEvents: readonly EffectLabelEvent[] = [
    ...EVENTS,
    {
      sequence: 10,
      type: "EFFECT_APPLIED",
      skillUseId: "su-ps",
      sourceUnitId: "bu-ally-1",
      details: {
        effectInstanceId: "ei-1",
        effectActionDefinitionId: "ACT_ATK_UP",
        targetUnitId: "bu-ally-1",
        magnitude: 0.08,
      },
    },
    {
      sequence: 11,
      type: "EFFECT_APPLIED",
      details: {
        effectInstanceId: "ei-mem",
        effectActionDefinitionId: "ACT_DEF_DOWN",
        targetUnitId: "bu-enemy-1",
        sourceSide: "ALLY",
        magnitude: -0.15,
      },
    },
  ];
  const local = createEffectLabeler(CATALOG, UNITS, instanceEvents);

  it("UI-UT-LBL-020: 付与イベントを引けるインスタンスは付与元スキルと付与時点の量で表す", () => {
    expect(local.instanceLabel("ei-1")).toBe("【幼き日の約束】鑑純夏-PS1-攻撃力+8%");
    expect(local.instanceLabel("ei-mem")).toBe("ALLY陣営のMemory-防御力-15%");
  });

  it("UI-UT-LBL-021: 付与イベントを引けなければ代替の付与情報と定義上の固定値で表す", () => {
    expect(
      local.instanceLabel("ei-unseen", {
        effectActionDefinitionId: "ACT_ATK_UP",
        originUnitId: "bu-enemy-1",
      }),
    ).toBe("エネミーα-攻撃力+5%");
  });

  it("UI-UT-LBL-022: 付与イベントも代替も無ければインスタンスIDを出す", () => {
    expect(local.instanceLabel("ei-unseen")).toBe("ei-unseen");
  });

  it("UI-UT-LBL-035: インスタンスの論理名は付与イベントから引き、引けなければundefined", () => {
    expect(local.instanceDefinitionId("ei-1")).toBe("ACT_ATK_UP");
    expect(local.instanceDefinitionId("ei-unseen")).toBeUndefined();
  });
});

describe("createEffectLabeler: 毒の統合（R-DOT-04）", () => {
  const catalog: EffectLabelCatalog = {
    skills: [
      { skillDefinitionId: "SKL_A_AS1", slotLabel: "AS1" },
      { skillDefinitionId: "SKL_B_AS2", slotLabel: "AS2" },
    ],
    effects: [
      { effectActionDefinitionId: "ACT_POISON_A", kind: "APPLY_CONTINUOUS_DAMAGE" },
      { effectActionDefinitionId: "ACT_POISON_B", kind: "APPLY_CONTINUOUS_DAMAGE" },
    ],
  };
  const units = new Map([
    ["ally:1", { displayName: "エー" }],
    ["ally:2", { displayName: "ビー" }],
  ]);
  const base: readonly EffectLabelEvent[] = [
    {
      sequence: 1,
      type: "SKILL_USE_STARTED",
      skillUseId: "su-a",
      details: { skillDefinitionId: "SKL_A_AS1" },
    },
    {
      sequence: 2,
      type: "EFFECT_APPLIED",
      skillUseId: "su-a",
      sourceUnitId: "ally:1",
      details: {
        effectInstanceId: "ei-p",
        effectActionDefinitionId: "ACT_POISON_A",
        magnitude: 0.05,
      },
    },
    {
      sequence: 3,
      type: "SKILL_USE_STARTED",
      skillUseId: "su-b",
      details: { skillDefinitionId: "SKL_B_AS2" },
    },
  ];
  const merged = (tickDamageBefore: number, tickDamageAfter: number, definition: string) => ({
    sequence: 4,
    type: "EFFECT_MERGED",
    skillUseId: "su-b",
    sourceUnitId: "ally:2",
    details: {
      effectInstanceId: "ei-p",
      effectActionDefinitionId: definition,
      reason: "POISON_REAPPLY",
      magnitudeBefore: 0.05,
      magnitudeAfter: 0.1,
      tickDamageBefore,
      tickDamageAfter,
    },
  });

  it("UI-UT-LBL-040: 新しい付与の効果量が採られた統合の後は、その付与元スキルと定義で表す", () => {
    const labeler = createEffectLabeler(catalog, units, [...base, merged(50, 100, "ACT_POISON_B")]);
    expect(labeler.instanceLabel("ei-p")).toBe("ビー-AS2-継続ダメージ");
    expect(labeler.instanceDefinitionId("ei-p")).toBe("ACT_POISON_B");
  });

  it("UI-UT-LBL-041: 統合より前の時点を指定すれば、その時点の付与で表す", () => {
    const labeler = createEffectLabeler(catalog, units, [...base, merged(50, 100, "ACT_POISON_B")]);
    expect(labeler.instanceLabel("ei-p", undefined, 3)).toBe("エー-AS1-継続ダメージ");
    expect(labeler.instanceDefinitionId("ei-p", 3)).toBe("ACT_POISON_A");
  });

  it("UI-UT-LBL-042: 既存の効果量が残った統合では付与元を変えない", () => {
    const labeler = createEffectLabeler(catalog, units, [
      ...base,
      merged(100, 100, "ACT_POISON_A"),
    ]);
    expect(labeler.instanceLabel("ei-p")).toBe("エー-AS1-継続ダメージ");
  });

  it("UI-UT-LBL-043: 状態スナップショットの定義・付与元と一致する付与で表す", () => {
    const labeler = createEffectLabeler(catalog, units, [...base, merged(50, 100, "ACT_POISON_B")]);
    expect(
      labeler.instanceLabel("ei-p", {
        effectActionDefinitionId: "ACT_POISON_A",
        originUnitId: "ally:1",
      }),
    ).toBe("エー-AS1-継続ダメージ");
    expect(
      labeler.instanceLabel("ei-p", {
        effectActionDefinitionId: "ACT_POISON_B",
        originUnitId: "ally:2",
      }),
    ).toBe("ビー-AS2-継続ダメージ");
  });
});
