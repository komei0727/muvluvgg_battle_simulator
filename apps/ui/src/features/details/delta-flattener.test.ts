import { describe, expect, it } from "vitest";
import { flattenDelta } from "./delta-flattener.js";
import { createEffectLabeler } from "../../lib/effect-display-label.js";

describe("flattenDelta", () => {
  it("returns nothing for a non-object delta", () => {
    expect(flattenDelta(undefined)).toEqual([]);
    expect(flattenDelta(null)).toEqual([]);
    expect(flattenDelta(42)).toEqual([]);
  });

  it("emits a before/after line for a ValueChange leaf", () => {
    expect(flattenDelta({ battleStatus: { before: "READY", after: "RUNNING" } })).toEqual([
      { path: "battleStatus", text: "READY → RUNNING" },
    ]);
  });

  it("recurses through nested objects, building a dotted path", () => {
    expect(flattenDelta({ units: { "ally:1": { hp: { before: 100, after: 80 } } } })).toEqual([
      { path: "units.ally:1.hp", text: "100 → 80" },
    ]);
  });

  it("summarizes an EntityCollectionDelta as add/update/remove counts", () => {
    expect(
      flattenDelta({
        effects: { added: [{ id: "e1" }], updated: [], removed: [{ id: "e2" }] },
      })[0],
    ).toEqual({ path: "effects", text: "+1 / ~0 / -1" });
  });

  it("produces no lines for an empty delta object", () => {
    expect(flattenDelta({})).toEqual([]);
  });
});

// DMG-010（Issue #191）: 完了条件「subUnit/effect
// collection deltaを汎用JSONだけでなく意味のある表示へ変換する」。件数だけの
// `+1 / ~1 / -1`では、何が付いて何が消えたかを状態遷移から辿れない。
describe("flattenDelta entity collection entries (DMG-010)", () => {
  // UI-UT-DLT-001
  it("names each added and removed effect instance instead of only counting them", () => {
    const lines = flattenDelta({
      units: {
        "ally:1": {
          effects: {
            added: [
              {
                effectInstanceId: "battle-1:effect:9",
                effectDefinitionId: "ACT_SUBUNIT_DRONE",
                effectKindKey: "ACT_SUBUNIT_DRONE",
                category: "BUFF",
                isEffective: true,
                value: { magnitude: 50 },
                appliedTurnNumber: 1,
              },
            ],
            updated: [],
            removed: [
              {
                id: "battle-1:effect:3",
                before: {
                  effectInstanceId: "battle-1:effect:3",
                  effectDefinitionId: "ACT_POISON",
                  effectKindKey: "ACT_POISON",
                  category: "STATUS_ABNORMALITY",
                  isEffective: true,
                  value: { magnitude: 0.05 },
                  appliedTurnNumber: 1,
                },
              },
            ],
          },
        },
      },
    });

    expect(lines).toEqual([
      { path: "units.ally:1.effects", text: "+1 / ~0 / -1" },
      {
        path: "units.ally:1.effects.added[0]",
        text: "+ ACT_SUBUNIT_DRONE（battle-1:effect:9）",
      },
      {
        path: "units.ally:1.effects.removed[0]",
        text: "- ACT_POISON（battle-1:effect:3）",
      },
    ]);
  });

  // UI-UT-DLT-002
  it("shows which fields changed on an updated entry rather than the whole JSON", () => {
    const lines = flattenDelta({
      units: {
        "enemy:1": {
          effects: {
            added: [],
            updated: [
              {
                id: "battle-1:effect:3",
                before: {
                  effectInstanceId: "battle-1:effect:3",
                  effectDefinitionId: "ACT_POISON",
                  value: { magnitude: 0.05 },
                  duration: { unit: "TURN", remaining: 3 },
                },
                after: {
                  effectInstanceId: "battle-1:effect:3",
                  effectDefinitionId: "ACT_POISON",
                  value: { magnitude: 0.1 },
                  duration: { unit: "TURN", remaining: 2 },
                },
              },
            ],
            removed: [],
          },
        },
      },
    });

    expect(lines[1]).toEqual({
      path: "units.enemy:1.effects.updated[0]",
      text: "~ ACT_POISON（battle-1:effect:3）: value.magnitude 0.05 → 0.1、duration.remaining 3 → 2",
    });
  });

  // UI-UT-DLT-003: サブユニットは`subUnitInstanceId`/`subUnitDefinitionId`を持つ
  // （`10_API設計.md`「SubUnitStateResponse」、R-SUB-01第3項）。
  it("names a sub unit entry by its own id fields", () => {
    const lines = flattenDelta({
      units: {
        "ally:1": {
          subUnits: {
            added: [
              {
                subUnitInstanceId: "battle-1:effect:9",
                subUnitDefinitionId: "ACT_SUBUNIT_DRONE",
                durability: { current: 50, maximum: 50 },
                appliedTurnNumber: 1,
              },
            ],
            updated: [],
            removed: [],
          },
        },
      },
    });

    expect(lines[1]).toEqual({
      path: "units.ally:1.subUnits.added[0]",
      text: "+ ACT_SUBUNIT_DRONE（battle-1:effect:9）",
    });
  });

  // UI-UT-DLT-004: 何も変わらない更新（差分が公開projectionに現れないケース）を
  // 「変わった」と読ませない。
  it("says an updated entry has no visible field change instead of printing an empty diff", () => {
    const lines = flattenDelta({
      units: {
        "ally:1": {
          effects: {
            added: [],
            updated: [
              {
                id: "battle-1:effect:4",
                before: { effectInstanceId: "battle-1:effect:4", value: { magnitude: 1 } },
                after: { effectInstanceId: "battle-1:effect:4", value: { magnitude: 1 } },
              },
            ],
            removed: [],
          },
        },
      },
    });

    expect(lines[1]?.text).toBe("~ battle-1:effect:4: 表示可能な変更項目なし");
  });

  // UI-UT-DLT-005: 未知の要素shapeでもクラッシュせず、JSONへ退避する
  // （01_UI要求・画面設計.md §11 UI-AC-011）。
  it("falls back to compact JSON for an entry with no recognizable id", () => {
    const lines = flattenDelta({
      units: {
        "ally:1": {
          markers: { added: [{ unknownShape: 1 }], updated: [], removed: [] },
        },
      },
    });

    expect(lines[1]).toEqual({
      path: "units.ally:1.markers.added[0]",
      text: '+ {"unknownShape":1}',
    });
  });
});

// UI-UT-TWR-018（03_API・データ連携設計.md §12.2）。
describe("flattenDelta total war deltas (UI-UT-TWR-018)", () => {
  const delta = {
    addedUnits: [
      { battleUnitId: "enemy:2", unitDefinitionId: "UNIT_E", hp: { current: 1, maximum: 1 } },
      { battleUnitId: "enemy:3", unitDefinitionId: "UNIT_F", hp: { current: 1, maximum: 1 } },
    ],
    formations: { enemy: { activeFormationNumber: { before: 1, after: 2 } } },
  };

  it("emits one deploy line per added unit, named by the resolver, and formations as value changes", () => {
    const names: Readonly<Record<string, string>> = { "enemy:2": "エネミー" };
    const lines = flattenDelta(delta, { resolveUnitName: (id) => names[id] ?? id });

    expect(lines).toEqual([
      { path: "addedUnits[0]", text: "+ エネミー 出撃" },
      { path: "addedUnits[1]", text: "+ enemy:3 出撃" },
      { path: "formations.enemy.activeFormationNumber", text: "1 → 2" },
    ]);
  });

  it("names added units by battleUnitId without a resolver", () => {
    expect(flattenDelta({ addedUnits: delta.addedUnits })).toEqual([
      { path: "addedUnits[0]", text: "+ enemy:2 出撃" },
      { path: "addedUnits[1]", text: "+ enemy:3 出撃" },
    ]);
  });

  it("falls back to compact JSON for an added unit without a battleUnitId", () => {
    expect(flattenDelta({ addedUnits: [{ side: "ENEMY" }] })).toEqual([
      { path: "addedUnits[0]", text: '+ {"side":"ENEMY"} 出撃' },
    ]);
  });
});

// docs/ui-design/01_UI要求・画面設計.md §8.2: 状態遷移のツリー表示もスキル・効果を表示名で表し、
// 論理名は行のツールチップ（`logicalNames`）へ回す。
describe("flattenDelta display labels", () => {
  const labeler = createEffectLabeler(
    {
      skills: [{ skillDefinitionId: "SKL_A_AS1", slotLabel: "AS1" }],
      effects: [
        {
          effectActionDefinitionId: "ACT_POISON",
          kind: "APPLY_CONTINUOUS_DAMAGE",
        },
      ],
    },
    new Map([
      ["ally:1", { displayName: "エー" }],
      ["enemy:1", { displayName: "ビー" }],
    ]),
    [],
  );

  it("UI-UT-LBL-036: 効果エントリを表示名とインスタンスIDで表し、論理名をlogicalNamesへ回す", () => {
    const lines = flattenDelta(
      {
        units: {
          "enemy:1": {
            effects: {
              added: [
                {
                  effectInstanceId: "battle-1:effect:3",
                  effectDefinitionId: "ACT_POISON",
                  sourceUnitId: "ally:1",
                  category: "STATUS_ABNORMALITY",
                },
              ],
              updated: [],
              removed: [],
            },
          },
        },
      },
      { labeler },
    );

    expect(lines[1]).toEqual({
      path: "units.enemy:1.effects.added[0]",
      text: "+ エー-継続ダメージ（battle-1:effect:3）",
      logicalNames: ["ACT_POISON"],
    });
  });

  it("UI-UT-LBL-037: クールタイムとチャージのスキルを、そのユニットのキャラ名-スキル種別番号で表す", () => {
    const lines = flattenDelta(
      {
        units: {
          "ally:1": {
            cooldowns: {
              added: [{ skillDefinitionId: "SKL_A_AS1", unit: "TURN", remaining: 2 }],
              // 実応答の更新・削除は、ラッパーの`id`がスキル定義IDで、値は残り回数だけを持つ。
              updated: [{ id: "SKL_A_AS1", before: 2, after: 1 }],
              removed: [{ id: "SKL_A_AS1", before: 1 }],
            },
            charge: { before: null, after: { skillDefinitionId: "SKL_A_AS1" } },
          },
        },
      },
      { labeler },
    );

    expect(lines).toEqual([
      { path: "units.ally:1.cooldowns", text: "+1 / ~1 / -1" },
      {
        path: "units.ally:1.cooldowns.added[0]",
        text: "+ エー-AS1",
        logicalNames: ["SKL_A_AS1"],
      },
      {
        path: "units.ally:1.cooldowns.updated[0]",
        text: "~ エー-AS1: 2 → 1",
        logicalNames: ["SKL_A_AS1"],
      },
      {
        path: "units.ally:1.cooldowns.removed[0]",
        text: "- エー-AS1",
        logicalNames: ["SKL_A_AS1"],
      },
      {
        path: "units.ally:1.charge",
        text: "null → エー-AS1",
        logicalNames: ["SKL_A_AS1"],
      },
    ]);
  });

  it("UI-UT-LBL-046: 効果の更新で定義が変わったら、変更前後を表示名で表し論理名をlogicalNamesへ回す", () => {
    const local = createEffectLabeler(
      {
        effects: [
          { effectActionDefinitionId: "ACT_POISON_A", kind: "APPLY_CONTINUOUS_DAMAGE" },
          { effectActionDefinitionId: "ACT_POISON_B", kind: "APPLY_CONTINUOUS_DAMAGE" },
        ],
      },
      new Map([
        ["ally:1", { displayName: "エー" }],
        ["ally:2", { displayName: "ビー" }],
      ]),
      [],
    );
    const lines = flattenDelta(
      {
        units: {
          "enemy:1": {
            effects: {
              added: [],
              updated: [
                {
                  id: "ei-p",
                  before: {
                    effectInstanceId: "ei-p",
                    effectDefinitionId: "ACT_POISON_A",
                    sourceUnitId: "ally:1",
                  },
                  after: {
                    effectInstanceId: "ei-p",
                    effectDefinitionId: "ACT_POISON_B",
                    sourceUnitId: "ally:2",
                  },
                },
              ],
              removed: [],
            },
          },
        },
      },
      { labeler: local },
    );

    expect(lines[1]).toEqual({
      path: "units.enemy:1.effects.updated[0]",
      text: "~ ビー-継続ダメージ（ei-p）: effectDefinitionId エー-継続ダメージ → ビー-継続ダメージ、sourceUnitId ally:1 → ally:2",
      logicalNames: ["ACT_POISON_B", "ACT_POISON_A"],
    });
  });
});
