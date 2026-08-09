import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type {
  Attribute,
  DamageType,
  StatKind,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type { TargetFilterDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  captureBattleState,
  type BattleStateSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import {
  definitionsWith,
  effectActionFrom,
  loadProductionSnapshot,
  memoryFrom,
  testBattleUnit,
} from "../../testing/fixtures/index.js";

/**
 * M7-007（Issue #178）: `raw/memories/` の未変換Memoryのうち、所属条件を持たず
 * 静的なstat補正を中心にした6件を近似なしで変換した結果を、実際の
 * production Catalog（未改変）と実`startBattle`（`BattleStarted`）で検証する。
 *
 * `UNIT_TYPE`/`ROLE`/`ATTRIBUTE`/`POSITION_ROW`+`POSITION_COLUMN`の各
 * TargetFilterがMemory由来のEffectSequenceでも実際に効き、対象外のユニットと
 * 敵陣営には一切適用されないことを、対象・非対象の両方で確認する。
 *
 * `MEM_THREE_MAIDS_HOSPITALITY`・`MEM_ABSOLUTE_ORDER`の与ダメージ補正は
 * `APPLY_DAMAGE_MOD`（`CAP_DAMAGE_MOD`）を要する。`DMG-002`（Issue #192）が
 * このCapabilityを`IMPLEMENTED`にしたため、Catalog上の変換が近似なしであることに
 * 加えて、この2件がCapability preflightを通過することをここで固定する。
 *
 * 単一Memoryへ閉じていた旧`-001`（`MEM_PANTS_STRAY_CAT`）は、対象Memoryが
 * ユニット効果軸へ載った時点で`memories/MEM_PANTS_STRAY_CAT.test.ts`へ移して
 * retireした（`12_テスト戦略.md`「`IT-CAP-*` の retire 基準」）。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

const M7_007_MEMORY_IDS = [
  "MEM_PANTS_STRAY_CAT",
  "MEM_CHAOS_MAIDEN_TWINTAIL_FEST",
  "MEM_THREE_MAIDS_HOSPITALITY",
  "MEM_MOMOZONO_NEW_YEAR",
  "MEM_ABSOLUTE_ORDER",
  "MEM_EURO_TOWER_DAY",
] as const;

/** `APPLY_DAMAGE_MOD`を持たず、実ライフサイクルで最後まで解決できる4件。 */
const RUNNABLE_MEMORY_IDS = [
  "MEM_PANTS_STRAY_CAT",
  "MEM_CHAOS_MAIDEN_TWINTAIL_FEST",
  "MEM_MOMOZONO_NEW_YEAR",
  "MEM_EURO_TOWER_DAY",
] as const;

/**
 * production Unitの`unitType`/`role`（`UNIT_TYPE`/`ROLE`フィルタは静的Catalogの
 * `UnitDefinition`を引くため、実データのUnitでなければ検証にならない）。
 * `attribute`は編成時の値なのでBattlePartyMember側で与える。
 */
const ALLY_MEMBERS = [
  {
    battleUnitId: "ally:en_attacker",
    unitDefinitionId: "UNIT_CLARA_SANTA", // ENERGY / EN_ATTACKER
    attribute: "CUTE",
    position: { row: "FRONT", column: "LEFT" },
  },
  {
    battleUnitId: "ally:en_support",
    unitDefinitionId: "UNIT_HARRIET_SAGE", // ENERGY / SUPPORT
    attribute: "SMART",
    position: { row: "BACK", column: "LEFT" },
  },
  {
    battleUnitId: "ally:physical_attacker",
    unitDefinitionId: "UNIT_KEI_JACKKNIFE", // PHYSICAL / PHYSICAL_ATTACKER
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "CENTER" },
  },
  {
    battleUnitId: "ally:physical_tank",
    unitDefinitionId: "UNIT_AOI_GUARDIAN", // PHYSICAL / TANK
    attribute: "CUTE",
    position: { row: "BACK", column: "CENTER" },
  },
  {
    battleUnitId: "ally:agile_control",
    unitDefinitionId: "UNIT_ANIS_TROUBLEMAKER", // AGILE / CONTROL
    attribute: "SMART",
    position: { row: "BACK", column: "RIGHT" },
  },
] as const satisfies readonly {
  battleUnitId: string;
  unitDefinitionId: string;
  attribute: Attribute;
  position: FormationPosition;
}[];

const ENEMY_MEMBER = {
  battleUnitId: "enemy:en_attacker",
  unitDefinitionId: "UNIT_CLARA_SANTA",
  attribute: "CUTE",
  position: { row: "FRONT", column: "CENTER" },
} as const;

const UNIT_DEFINITION_IDS = [
  ...new Set([...ALLY_MEMBERS.map((m) => m.unitDefinitionId), ENEMY_MEMBER.unitDefinitionId]),
];

const snapshot = loadProductionSnapshot(CATALOG_DIR, UNIT_DEFINITION_IDS, M7_007_MEMORY_IDS);

const BASE_ATTACK = 1000;
const BASE_DEFENSE = 100;
const BASE_MAXIMUM_HP = 5000;

function battleUnitOf(
  member: {
    readonly battleUnitId: string;
    readonly unitDefinitionId: string;
    readonly attribute: Attribute;
    readonly position: FormationPosition;
  },
  side: Side,
): BattleUnit {
  return testBattleUnit({
    battleUnitId: member.battleUnitId,
    unitDefinitionId: member.unitDefinitionId,
    side,
    position: member.position,
    attribute: member.attribute,
    combatStats: {
      maximumHp: BASE_MAXIMUM_HP,
      attack: BASE_ATTACK,
      defense: BASE_DEFENSE,
      criticalRate: 0.1,
      actionSpeed: 100,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
    limits: { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 },
  });
}

function createdBattleWith(allyMemoryDefinitionIds: readonly string[]) {
  return createBattle(
    createBattleId("B_1"),
    ALLY_MEMBERS.map((member) => battleUnitOf(member, "ALLY")),
    [battleUnitOf(ENEMY_MEMBER, "ENEMY")],
    createTurnLimit(3),
    definitionsWith(snapshot, {
      overrides: {
        memoriesBySide: {
          ALLY: allyMemoryDefinitionIds.map((id) => memoryFrom(snapshot, id)),
          ENEMY: [],
        },
      },
    }),
  );
}

function startWith(allyMemoryDefinitionIds: readonly string[]) {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const created = createdBattleWith(allyMemoryDefinitionIds);
  return {
    created,
    recorder,
    battle: startBattle(created, new SequenceRandomSource([]), recorder),
  };
}

function allyBy(battle: { readonly allyUnits: readonly BattleUnit[] }, battleUnitId: string) {
  const unit = battle.allyUnits.find((candidate) => candidate.battleUnitId === battleUnitId);
  if (unit === undefined) {
    throw new Error(`no ally unit "${battleUnitId}"`);
  }
  return unit;
}

function unitSnapshotOf(snapshot: BattleStateSnapshot, battleUnitId: string) {
  return snapshot.units[createBattleUnitId(battleUnitId)];
}

/**
 * `APPLY_DAMAGE_MOD`を含む2件について、raw原文の各要素（属性・ロール・unitTypeの
 * 絞り込み、ダメージ種別の有無、倍率・固定値）が定義のどこへ写っているかを固定し、
 * 「近似なし」の変換内容が黙って変わらないようにする。実ライフサイクルでの
 * 与ダメージ補正の適用そのものは`DMG-002`（Issue #192）の
 * `damage-modifier-policy.ts`側テストが担う。
 */
interface TriggeredEffectExpectation {
  readonly targetBindingId: string;
  readonly filters: readonly TargetFilterDefinition[];
  readonly effectActionDefinitionId: string;
  readonly damageMod?: {
    readonly direction: "OUTGOING" | "INCOMING";
    readonly damageType: DamageType | null;
    readonly value: number;
  };
  readonly statMod?: {
    readonly stat: StatKind;
    readonly valueType: "RATIO" | "FIXED";
    readonly value: number;
  };
}

const DAMAGE_MOD_MEMORY_EXPECTATIONS: readonly {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
  readonly triggeredEffects: readonly TriggeredEffectExpectation[];
}[] = [
  {
    memoryDefinitionId: "MEM_THREE_MAIDS_HOSPITALITY",
    displayName: "メイド３人のおもてなし？",
    triggeredEffects: [
      {
        // 効果1「キュート属性の味方全員に対し、与ダメージを2.5%上昇させる」
        targetBindingId: "TGT_CUTE_ALLIES",
        filters: [{ kind: "ATTRIBUTE", attribute: "CUTE" }],
        effectActionDefinitionId: "ACT_MEM_THREE_MAIDS_HOSPITALITY_CUTE_DMG_UP",
        damageMod: { direction: "OUTGOING", damageType: null, value: 0.025 },
      },
      {
        // 効果2「スマート属性の味方全員の攻撃力を1250上昇させる」
        targetBindingId: "TGT_SMART_ALLIES",
        filters: [{ kind: "ATTRIBUTE", attribute: "SMART" }],
        effectActionDefinitionId: "ACT_MEM_THREE_MAIDS_HOSPITALITY_SMART_ATK_UP",
        statMod: { stat: "ATTACK", valueType: "FIXED", value: 1250 },
      },
    ],
  },
  {
    memoryDefinitionId: "MEM_ABSOLUTE_ORDER",
    displayName: "絶対命令行使権！",
    triggeredEffects: [
      {
        // 効果1「物理アタッカーの味方全員に対し、物理攻撃で与えるダメージを2.5%上昇させる」
        targetBindingId: "TGT_PHYSICAL_ATTACKER_ALLIES",
        filters: [{ kind: "ROLE", role: "PHYSICAL_ATTACKER" }],
        effectActionDefinitionId: "ACT_MEM_ABSOLUTE_ORDER_PHYSICAL_ATTACKER_DMG_UP",
        damageMod: { direction: "OUTGOING", damageType: "PHYSICAL", value: 0.025 },
      },
      {
        // 効果2「物理タイプの味方の会心率を5%上昇させる」
        targetBindingId: "TGT_PHYSICAL_ALLIES",
        filters: [{ kind: "UNIT_TYPE", unitType: "PHYSICAL" }],
        effectActionDefinitionId: "ACT_MEM_ABSOLUTE_ORDER_PHYSICAL_CRIT_UP",
        statMod: { stat: "CRITICAL_RATE", valueType: "RATIO", value: 0.05 },
      },
    ],
  },
];

describe("production Catalog M7-007 static Memory conversions (Issue #178)", () => {
  it("IT-CAP-MEMORY-STATIC-PROD-002: MEM_CHAOS_MAIDEN_TWINTAIL_FEST raises ATTACK for ENERGY allies only and MAXIMUM_HP for the whole ally party", () => {
    const { battle } = startWith(["MEM_CHAOS_MAIDEN_TWINTAIL_FEST"]);

    // 効果1「EN型の味方の攻撃力を750上昇させる」
    expect(allyBy(battle, "ally:en_attacker").combatStats.attack).toBeCloseTo(BASE_ATTACK + 750, 6);
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);

    // 効果2「味方全体のHPを300上昇させる」
    for (const ally of battle.allyUnits) {
      expect(ally.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 300, 6);
    }
    expect(battle.enemyUnits[0]!.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP, 6);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-003: MEM_MOMOZONO_NEW_YEAR raises ATTACK for PHYSICAL and AGILE allies through two separate triggeredEffects, never for ENERGY allies", () => {
    const { battle } = startWith(["MEM_MOMOZONO_NEW_YEAR"]);

    expect(allyBy(battle, "ally:physical_attacker").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:agile_control").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:en_attacker").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    expect(allyBy(battle, "ally:en_support").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    // 同一ユニットが両方のtriggeredEffectに該当することはない（PHYSICALかAGILEの一方）
    expect(allyBy(battle, "ally:physical_tank").appliedEffects).toHaveLength(1);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-004: MEM_EURO_TOWER_DAY applies a ROLE-filtered ratio buff and a BACK CENTER/RIGHT slot-filtered fixed buff to disjoint ally sets", () => {
    const { battle } = startWith(["MEM_EURO_TOWER_DAY"]);

    // 効果1「サポートの攻撃力を4%上昇させる」— SUPPORTロールはBACK LEFTの1体だけ
    expect(allyBy(battle, "ally:en_support").combatStats.attack).toBeCloseTo(BASE_ATTACK * 1.04, 6);
    // 効果2「右列後衛・中央列後衛の攻撃力を1250上昇させる」
    expect(allyBy(battle, "ally:physical_tank").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    expect(allyBy(battle, "ally:agile_control").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 1250,
      6,
    );
    // BACK LEFT は効果2の対象外、FRONT列はどちらの対象でもない
    expect(allyBy(battle, "ally:en_support").appliedEffects).toHaveLength(1);
    expect(allyBy(battle, "ally:en_attacker").appliedEffects).toHaveLength(0);
    expect(allyBy(battle, "ally:physical_attacker").appliedEffects).toHaveLength(0);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-005: the four runnable M7-007 Memories emit MemoryTriggered/MemoryResolved with a sourceSide instead of a granter unit, and their StateDeltas alone reconstruct the started battle", () => {
    const { created, battle, recorder } = startWith(RUNNABLE_MEMORY_IDS);

    const triggered = recorder
      .getEvents()
      .filter((event) => event.eventType === "MemoryTriggered")
      .map((event) => {
        const payload = event.payload as {
          memoryDefinitionId: string;
          triggeredEffectIndex: number;
        };
        return `${payload.memoryDefinitionId}#${payload.triggeredEffectIndex}`;
      });
    // API指定順 → 同一Memory内のtriggeredEffects定義順（R-MEM-02）
    expect(triggered).toEqual([
      "MEM_PANTS_STRAY_CAT#0",
      "MEM_PANTS_STRAY_CAT#1",
      "MEM_CHAOS_MAIDEN_TWINTAIL_FEST#0",
      "MEM_CHAOS_MAIDEN_TWINTAIL_FEST#1",
      "MEM_MOMOZONO_NEW_YEAR#0",
      "MEM_MOMOZONO_NEW_YEAR#1",
      "MEM_EURO_TOWER_DAY#0",
      "MEM_EURO_TOWER_DAY#1",
    ]);
    expect(
      recorder.getEvents().filter((event) => event.eventType === "MemoryResolved"),
    ).toHaveLength(8);
    for (const effect of allyBy(battle, "ally:en_support").appliedEffects) {
      expect(effect.sourceUnitId).toBeUndefined();
      expect(effect.sourceSide).toBe("ALLY");
    }

    // 独立Reducer復元: 開始前スナップショットへ`BattleStarted`以降のStateDeltaだけを
    // 適用すると、実際に開始した戦闘と同じ状態が再構成できる。
    const before = captureBattleState(created);
    const after = captureBattleState(battle);
    const deltas = recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]));
    const reconstructed = reduceStateDeltas(before, deltas);

    expect(reconstructed).toEqual(after);
    // 復元が空回りしていないこと: 開始前後で状態は実際に変わっており、復元側にも
    // 4 Memory分の重ね掛け（RATIO 4% + FIXED 1250 + 750）が乗っている。
    expect(before).not.toEqual(after);
    const restoredSupport = unitSnapshotOf(reconstructed, "ally:en_support");
    expect(restoredSupport?.combatStats.attack).toBeCloseTo(BASE_ATTACK * 1.04 + 1250 + 750, 6);
    // ATTACK 3件（+1250 / +750 / +4%）と MAXIMUM_HP 1件（+300）。
    expect(restoredSupport?.effects).toHaveLength(4);
    expect(restoredSupport?.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 300, 6);
  });

  it("IT-CAP-MEMORY-STATIC-PROD-006: MEM_THREE_MAIDS_HOSPITALITY/MEM_ABSOLUTE_ORDER convert every raw filter and magnitude without approximation, and pass Capability preflight now that CAP_DAMAGE_MOD is implemented", () => {
    for (const expectation of DAMAGE_MOD_MEMORY_EXPECTATIONS) {
      const memory = memoryFrom(snapshot, expectation.memoryDefinitionId);
      expect(memory.metadata.displayName).toBe(expectation.displayName);
      expect(memory.triggeredEffects).toHaveLength(expectation.triggeredEffects.length);

      expectation.triggeredEffects.forEach((expected, index) => {
        const triggeredEffect = memory.triggeredEffects[index]!;
        // 発動タイミング「戦闘開始時に発動」
        expect(triggeredEffect.trigger.eventType).toBe("BattleStarted");
        expect(triggeredEffect.trigger.condition).toEqual({ kind: "TRUE" });

        // 装備条件（対象集合）: 味方全体を`side: ALLY`/`count: ALL`で取り、
        // raw記載の絞り込みだけをfilterで表現する。
        const bindings = triggeredEffect.effectSequence.targetBindings;
        expect(bindings).toHaveLength(1);
        const binding = bindings[0]!;
        expect(binding.targetBindingId).toBe(expected.targetBindingId);
        expect(binding.selector.kind).toBe("SELECT");
        expect(binding.selector.side).toBe("ALLY");
        expect(binding.selector.count).toBe("ALL");
        expect(binding.selector.filters).toEqual(expected.filters);

        const steps = triggeredEffect.effectSequence.steps;
        expect(steps).toHaveLength(1);
        const step = steps[0]!;
        if (step.kind !== "ACTION") {
          throw new Error(`unexpected step kind "${step.kind}"`);
        }
        expect(step.target).toEqual({
          kind: "BINDING",
          targetBindingId: expected.targetBindingId,
        });
        expect(step.actions.map((action) => action.effectActionDefinitionId)).toEqual([
          expected.effectActionDefinitionId,
        ]);

        // 補正値: raw記載の倍率・固定値をそのまま`CONSTANT`へ写す（丸め・近似なし）。
        const action = effectActionFrom(snapshot, expected.effectActionDefinitionId);
        if (expected.damageMod !== undefined) {
          if (action.kind !== "APPLY_DAMAGE_MOD") {
            throw new Error(`expected APPLY_DAMAGE_MOD, got "${action.kind}"`);
          }
          expect(action.payload.direction).toBe(expected.damageMod.direction);
          // 「物理攻撃で与えるダメージ」はdamageType限定、種別を書いていない
          // 「与ダメージ」は`null`（全ダメージ種別）として区別する。
          expect(action.payload.damageType).toBe(expected.damageMod.damageType);
          expect(action.payload.formula).toEqual({
            kind: "CONSTANT",
            value: expected.damageMod.value,
          });
        } else {
          const statMod = expected.statMod;
          if (statMod === undefined) {
            throw new Error("expectation must declare either damageMod or statMod");
          }
          if (action.kind !== "APPLY_STAT_MOD") {
            throw new Error(`expected APPLY_STAT_MOD, got "${action.kind}"`);
          }
          expect(action.payload.stat).toBe(statMod.stat);
          expect(action.payload.valueType).toBe(statMod.valueType);
          expect(action.payload.formula).toEqual({ kind: "CONSTANT", value: statMod.value });
        }
        // 「戦闘開始時に発動」の補正は戦闘終了まで残る（期間指定はraw原文に無い）。
        expect(action.payload.duration.timeLimit).toEqual({ unit: "BATTLE", count: 1 });
      });
    }
  });
});
