import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advanceBattle, createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { BattleDefinitions } from "../../domain/battle/model/battle-definitions.js";
import { toGlobalCoordinate } from "../../domain/battle/model/global-coordinate.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type {
  Attribute,
  ConsumptionKind,
  DamageType,
  StatKind,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type { TargetFilterDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  captureBattleState,
  type BattleStateSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "../../domain/catalog/capability/capability-availability.js";

/**
 * M7-008（Issue #176）: `raw/memories/` に残っていた未変換Memory 20件
 * （所属条件11・与ダメージ補正5・TurnStarted発動2・Marker付与1・敵側対象1、
 * 重複分類あり）を近似・省略なく変換した結果を、実際のproduction Catalog
 * （未改変）に対して検証する。これで `raw/memories/` 32件すべてが変換済みになる。
 *
 * - `AFFILIATION` TargetFilter（`18_Affiliation台帳.md`の `AFF_*`）が、Memory由来の
 *   EffectSequenceでも `metadata.affiliations` を引いて実際に効くこと。
 * - `side: "ENEMY"` の効果が、そのMemoryを編成した陣営から見た相対陣営へ解決すること。
 * - `TurnStarted` 発動の triggeredEffect が実 `advanceBattle` でターンごとに発動し、
 *   `BattleStarted` 発動の triggeredEffect は戦闘開始時の1回だけであること。
 *
 * `APPLY_DAMAGE_MOD` を含む9件は `CAP_DAMAGE_MOD` が `PLANNED` の間 preflight で
 * 弾かれていたが、`DMG-002`（Issue #192）が同Capabilityを `IMPLEMENTED` にしたため
 * 編成可能になった。Memory由来Markerを持つ `MEM_ALWAYS_PICO_BESIDE_YOU` はDomain側は
 * 完走できるが、v1 API契約が付与元なしMarkerを表現できないため
 * `CAP_MEMORY_GRANTED_MARKER`（`REL-008`／Issue #263、PR #262レビュー[P1]）で
 * 引き続きpreflightが弾く。いずれもCatalog上の変換が近似なしであることと、
 * 残る1件だけが編成不可であることを固定する。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

/** 本Issueで変換した20件（`17_残作業対応表.json`の`unconvertedMemoryAssignments`と同じ集合）。 */
const M7_008_MEMORY_IDS = [
  "MEM_CHAOS_MAIDEN",
  "MEM_COLORFUL_BOUQUET",
  "MEM_PYXIS_MA_SOEUR",
  "MEM_SIRIUS_SUGAR",
  "MEM_TREBLE_QUINTET",
  "MEM_TRINITY_JEWEL",
  "MEM_FUUKI_IINKAI",
  "MEM_INCOGNITO_SISTER_ADVENTURE",
  "MEM_SHAPING_FAMILY",
  "MEM_TENT_COMMOTION",
  "MEM_ELOPEMENT_FULL_THROTTLE",
  "MEM_NAUGHTY_PENALTY_GAME",
  "MEM_SOOTHING_SCENT",
  "MEM_ENCOUNTER_WITH_GIRLS",
  "MEM_NEW_YEAR_GREETING",
  "MEM_CATS_AND_DOGS_BOND",
  "MEM_DISCONTENT_AND_ANXIETY",
  "MEM_BUSY_DAY_SLUMBER",
  "MEM_ALWAYS_PICO_BESIDE_YOU",
  "MEM_CURIOUS_EQUIPMENT",
] as const;

/**
 * R-MEM-02の順序・`sourceSide`・StateDelta復元をまとめて見るための編成。
 * Capability preflightを通る10件のうち、`SimulationExecutionGuard`の
 * 「1解決スコープ内の効果解決数」上限（50件、`passive-activation-service.ts`）に
 * 収まる6件を、興味のある性質（所属フィルタ・対象0件のskip・ROLEフィルタ・
 * `TurnStarted`のskip・敵側対象）が全部揃うように選ぶ。
 */
const ORDERING_MEMORY_IDS = [
  "MEM_CHAOS_MAIDEN",
  "MEM_TREBLE_QUINTET",
  "MEM_FUUKI_IINKAI",
  "MEM_INCOGNITO_SISTER_ADVENTURE",
  "MEM_DISCONTENT_AND_ANXIETY",
  "MEM_CURIOUS_EQUIPMENT",
] as const;

interface RosterMember {
  readonly battleUnitId: string;
  readonly unitDefinitionId: string;
  readonly attribute: Attribute;
  readonly position: FormationPosition;
}

/**
 * `AFFILIATION`フィルタは静的Catalogの`UnitDefinition.metadata.affiliations`を
 * 引くため、実データのUnitでなければ検証にならない。`18_Affiliation台帳.md`の
 * 40キャラクターから、6つの異なる`affiliationId`・unitType・role・配置を持つ
 * 6体を選ぶ（どのMemoryも1つの所属だけを対象にするため、残り5体がそのまま
 * 非対象の検証になる）。
 */
const ALLY_MEMBERS = [
  {
    battleUnitId: "ally:chaos_maiden",
    unitDefinitionId: "UNIT_YURIA_WILDCARD", // PHYSICAL / PHYSICAL_ATTACKER / AFF_CHAOS_MAIDEN
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "LEFT" },
  },
  {
    battleUnitId: "ally:colorful_bouquet",
    unitDefinitionId: "UNIT_CLARA_SANTA", // ENERGY / EN_ATTACKER / AFF_COLORFUL_BOUQUET
    attribute: "CUTE",
    position: { row: "FRONT", column: "CENTER" },
  },
  {
    battleUnitId: "ally:pyxis_ma_soeur",
    unitDefinitionId: "UNIT_LUCIE_MAID", // PHYSICAL / TANK / AFF_PYXIS_MA_SOEUR
    attribute: "SMART",
    position: { row: "FRONT", column: "RIGHT" },
  },
  {
    battleUnitId: "ally:sirius_sugar",
    unitDefinitionId: "UNIT_NANAE_COMMANDER", // ENERGY / SUPPORT / AFF_SIRIUS_SUGAR
    attribute: "CLEVER",
    position: { row: "BACK", column: "LEFT" },
  },
  {
    battleUnitId: "ally:treble_quintet",
    unitDefinitionId: "UNIT_LAYLA_ENTREPRENEUR", // AGILE / CONTROL / AFF_TREBLE_QUINTET
    attribute: "COMICAL",
    position: { row: "BACK", column: "CENTER" },
  },
  {
    battleUnitId: "ally:trinity_jewel",
    unitDefinitionId: "UNIT_LUNA_HUNGRY", // PHYSICAL / TANK / AFF_TRINITY_JEWEL
    attribute: "SHY",
    position: { row: "BACK", column: "RIGHT" },
  },
] as const satisfies readonly RosterMember[];

/**
 * `enemy:pyxis_ma_soeur`は`AFF_PYXIS_MA_SOEUR`の実メンバー。味方が指定した所属
 * Memoryが、同じ所属に属していても敵陣営には一切適用されないこと（R-MEM-04の
 * source side）の検証に使う。
 */
const ENEMY_MEMBERS = [
  {
    battleUnitId: "enemy:front",
    unitDefinitionId: "UNIT_KEI_JACKKNIFE", // PHYSICAL / PHYSICAL_ATTACKER / 所属なし
    attribute: "AGGRESSIVE",
    position: { row: "FRONT", column: "CENTER" },
  },
  {
    battleUnitId: "enemy:pyxis_ma_soeur",
    unitDefinitionId: "UNIT_HARRIET_SAGE", // ENERGY / SUPPORT / AFF_PYXIS_MA_SOEUR
    attribute: "CLEVER",
    position: { row: "BACK", column: "CENTER" },
  },
] as const satisfies readonly RosterMember[];

/** `AFF_FUUKI_IINKAI`のメンバー1体と、どの所属にも属さない1体。 */
const FUUKI_ALLY_MEMBERS = [
  {
    battleUnitId: "ally:fuuki_iinkai",
    unitDefinitionId: "UNIT_MAO_COMMITTEE", // ENERGY / EN_ATTACKER / AFF_FUUKI_IINKAI
    attribute: "COMICAL",
    position: { row: "FRONT", column: "LEFT" },
  },
  {
    battleUnitId: "ally:unaffiliated",
    unitDefinitionId: "UNIT_KEI_JACKKNIFE", // 所属なし
    attribute: "AGGRESSIVE",
    position: { row: "BACK", column: "LEFT" },
  },
] as const satisfies readonly RosterMember[];

/**
 * `advanceBattle`はAP/PPを回復させるため、production UnitのPSが実際に発動しうる
 * （`startBattle`だけを使うテストと違い、UT-BATTLE-017の「PPが0のまま」という
 * 前提が成り立たない）。TurnStarted検証はMemoryだけの効果を見たいので、
 * `triggers`を1件も持たないPSだけのUnit（`UNIT_MAIA_LAZY`）で編成する。
 */
const TURN_ALLY_MEMBERS = [
  {
    battleUnitId: "ally:turn_front",
    unitDefinitionId: "UNIT_MAIA_LAZY",
    attribute: "SHY",
    position: { row: "FRONT", column: "LEFT" },
  },
  {
    battleUnitId: "ally:turn_back",
    unitDefinitionId: "UNIT_MAIA_LAZY",
    attribute: "SHY",
    position: { row: "BACK", column: "LEFT" },
  },
] as const satisfies readonly RosterMember[];

const TURN_ENEMY_MEMBERS = [
  {
    battleUnitId: "enemy:turn_front",
    unitDefinitionId: "UNIT_MAIA_LAZY",
    attribute: "SHY",
    position: { row: "FRONT", column: "CENTER" },
  },
] as const satisfies readonly RosterMember[];

const UNIT_DEFINITION_IDS = [
  ...new Set(
    [
      ...ALLY_MEMBERS,
      ...ENEMY_MEMBERS,
      ...FUUKI_ALLY_MEMBERS,
      ...TURN_ALLY_MEMBERS,
      ...TURN_ENEMY_MEMBERS,
    ].map((member) => member.unitDefinitionId),
  ),
].map((id) => createUnitDefinitionId(id));

const snapshot = loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(
  UNIT_DEFINITION_IDS,
  M7_008_MEMORY_IDS.map((id) => createMemoryDefinitionId(id)),
);

/** 「三ツ星」（`raw/memories/お傍にいるのはいつでもピコですよ♪.md`）。 */
const PICO_MARKER_ID = "MARKER_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS";

const BASE_ATTACK = 1000;
const BASE_DEFENSE = 100;
const BASE_MAXIMUM_HP = 5000;
const BASE_ACTION_SPEED = 100;
const BASE_CRITICAL_RATE = 0.1;

function battleUnitOf(member: RosterMember, side: Side): BattleUnit {
  const partyMember: BattlePartyMember = {
    battleUnitId: createBattleUnitId(member.battleUnitId),
    unitDefinitionId: createUnitDefinitionId(member.unitDefinitionId),
    attribute: member.attribute,
    position: member.position,
    globalCoordinate: toGlobalCoordinate(side, member.position),
    combatStats: {
      maximumHp: BASE_MAXIMUM_HP,
      attack: BASE_ATTACK,
      defense: BASE_DEFENSE,
      criticalRate: BASE_CRITICAL_RATE,
      actionSpeed: BASE_ACTION_SPEED,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(partyMember, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
  });
}

function memoryOf(memoryDefinitionId: string): MemoryDefinition {
  const memory = snapshot.memories.get(createMemoryDefinitionId(memoryDefinitionId));
  if (memory === undefined) {
    throw new Error(`production Catalog has no Memory "${memoryDefinitionId}"`);
  }
  return memory;
}

function definitionsWith(
  memoriesBySide: Readonly<Record<Side, readonly MemoryDefinition[]>>,
): BattleDefinitions {
  return {
    activeSkillsByUnit: new Map(),
    exSkillByUnit: new Map(),
    effectActions: snapshot.effectActions,
    unitDefinitions: snapshot.units,
    skillDefinitions: snapshot.skills,
    memoriesBySide,
  };
}

interface StartOptions {
  readonly allyMemoryDefinitionIds?: readonly string[];
  readonly enemyMemoryDefinitionIds?: readonly string[];
  readonly allyMembers?: readonly RosterMember[];
  readonly enemyMembers?: readonly RosterMember[];
  readonly turnLimit?: number;
}

function startWith(options: StartOptions) {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const created = createBattle(
    createBattleId("B_1"),
    (options.allyMembers ?? ALLY_MEMBERS).map((member) => battleUnitOf(member, "ALLY")),
    (options.enemyMembers ?? ENEMY_MEMBERS).map((member) => battleUnitOf(member, "ENEMY")),
    createTurnLimit(options.turnLimit ?? 3),
    definitionsWith({
      ALLY: (options.allyMemoryDefinitionIds ?? []).map(memoryOf),
      ENEMY: (options.enemyMemoryDefinitionIds ?? []).map(memoryOf),
    }),
  );
  return {
    created,
    recorder,
    battle: startBattle(created, new SequenceRandomSource([]), recorder),
  };
}

function unitBy(units: readonly BattleUnit[], battleUnitId: string): BattleUnit {
  const unit = units.find((candidate) => candidate.battleUnitId === battleUnitId);
  if (unit === undefined) {
    throw new Error(`no unit "${battleUnitId}"`);
  }
  return unit;
}

function allyBy(battle: { readonly allyUnits: readonly BattleUnit[] }, battleUnitId: string) {
  return unitBy(battle.allyUnits, battleUnitId);
}

function enemyBy(battle: { readonly enemyUnits: readonly BattleUnit[] }, battleUnitId: string) {
  return unitBy(battle.enemyUnits, battleUnitId);
}

function unitSnapshotOf(state: BattleStateSnapshot, battleUnitId: string) {
  return state.units[createBattleUnitId(battleUnitId)];
}

/**
 * 「所属するキャラクターの攻撃力を250上昇させる」+「味方全体の◯◯を上昇させる」
 * という同型の6 Memory。所属側は`affiliationId`だけが異なり、味方全体側は
 * stat・valueType・値がMemoryごとに異なる。
 */
const AFFILIATION_PAIR_MEMORIES = [
  {
    memoryDefinitionId: "MEM_CHAOS_MAIDEN",
    memberBattleUnitId: "ally:chaos_maiden",
    expectedMemberAttack: BASE_ATTACK + 250,
    expectedOtherAttack: BASE_ATTACK,
    partyWide: { stat: "DEFENSE", base: BASE_DEFENSE, expected: BASE_DEFENSE + 200 },
  },
  {
    memoryDefinitionId: "MEM_COLORFUL_BOUQUET",
    memberBattleUnitId: "ally:colorful_bouquet",
    // 効果1（所属+250）と効果2（味方全体+250）が所属メンバーには重ね掛けされる。
    expectedMemberAttack: BASE_ATTACK + 500,
    expectedOtherAttack: BASE_ATTACK + 250,
    partyWide: { stat: "ATTACK", base: BASE_ATTACK, expected: BASE_ATTACK + 250 },
  },
  {
    memoryDefinitionId: "MEM_PYXIS_MA_SOEUR",
    memberBattleUnitId: "ally:pyxis_ma_soeur",
    expectedMemberAttack: BASE_ATTACK + 250,
    expectedOtherAttack: BASE_ATTACK,
    partyWide: { stat: "ACTION_SPEED", base: BASE_ACTION_SPEED, expected: BASE_ACTION_SPEED + 12 },
  },
  {
    memoryDefinitionId: "MEM_SIRIUS_SUGAR",
    memberBattleUnitId: "ally:sirius_sugar",
    expectedMemberAttack: BASE_ATTACK + 250,
    expectedOtherAttack: BASE_ATTACK,
    partyWide: { stat: "MAXIMUM_HP", base: BASE_MAXIMUM_HP, expected: BASE_MAXIMUM_HP + 300 },
  },
  {
    memoryDefinitionId: "MEM_TREBLE_QUINTET",
    memberBattleUnitId: "ally:treble_quintet",
    expectedMemberAttack: BASE_ATTACK + 250,
    expectedOtherAttack: BASE_ATTACK,
    // 「会心率を1%上昇」は`MEM_WALK_TOGETHER`（Issue #47）以来の変換慣習どおり
    // `valueType: RATIO`（基礎値に対する割合）で表す。
    partyWide: {
      stat: "CRITICAL_RATE",
      base: BASE_CRITICAL_RATE,
      expected: BASE_CRITICAL_RATE * 1.01,
    },
  },
  {
    memoryDefinitionId: "MEM_TRINITY_JEWEL",
    memberBattleUnitId: "ally:trinity_jewel",
    expectedMemberAttack: BASE_ATTACK + 250,
    expectedOtherAttack: BASE_ATTACK,
    partyWide: { stat: "DEFENSE", base: BASE_DEFENSE, expected: BASE_DEFENSE + 200 },
  },
] as const satisfies readonly {
  memoryDefinitionId: string;
  memberBattleUnitId: string;
  expectedMemberAttack: number;
  expectedOtherAttack: number;
  partyWide: { stat: StatKind; base: number; expected: number };
}[];

function statOf(unit: BattleUnit, stat: StatKind): number {
  switch (stat) {
    case "MAXIMUM_HP":
      return unit.combatStats.maximumHp;
    case "ATTACK":
      return unit.combatStats.attack;
    case "DEFENSE":
      return unit.combatStats.defense;
    case "CRITICAL_RATE":
      return unit.combatStats.criticalRate;
    case "CRITICAL_DAMAGE_BONUS":
      return unit.combatStats.criticalDamageBonus;
    case "AFFINITY_BONUS":
      return unit.combatStats.affinityBonus;
    case "ACTION_SPEED":
      return unit.combatStats.actionSpeed;
  }
}

/**
 * 変換の「近似なし」を1行ずつ固定するための、raw原文→定義の対応表。
 * `APPLY_DAMAGE_MOD`を含む9件は`DMG-002`（Issue #192）以降Capability preflightを
 * 通る（実ライフサイクルでの与ダメージ補正の適用そのものは
 * `damage-modifier-policy.ts`側テストが担う）。Domain解決を完走できる各件についても、
 * 実行結果の期待値がraw原文のどこ由来かをここで固定する。
 * `MEM_ALWAYS_PICO_BESIDE_YOU`だけはDomainは完走するがv1 API契約の都合で
 * `CAP_MEMORY_GRANTED_MARKER`が編成を弾く。
 */
interface ActionExpectation {
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
  readonly marker?: { readonly markerId: string; readonly stackMax: number | null };
  /**
   * 省略時は「戦闘終了まで残る」（`{ unit: "BATTLE", count: 1 }`）。`null`は
   * 期限そのものを持たない（`consumption`で失効する）ことを表す。
   */
  readonly timeLimit?: {
    readonly unit: string;
    readonly count: number;
    readonly owner?: string;
  } | null;
  readonly consumption?: { readonly kind: ConsumptionKind; readonly maxCount: number };
}

interface TriggeredEffectExpectation {
  readonly eventType: "BattleStarted" | "TurnStarted";
  readonly targetBindingId: string;
  readonly side: "ALLY" | "ENEMY";
  readonly filters: readonly TargetFilterDefinition[];
  readonly actions: readonly ActionExpectation[];
}

interface MemoryExpectation {
  readonly memoryDefinitionId: string;
  readonly displayName: string;
  /**
   * Capability preflightがこのMemoryを編成不可として弾く原因のCapability。
   * `CAP_MEMORY_GRANTED_MARKER`はv1 API契約が付与元なしMarkerを表現できないこと
   * （`REL-008`／Issue #263、PR #262レビュー[P1]）による。空配列なら編成可能
   * （`CAP_DAMAGE_MOD`は`DMG-002`／Issue #192で`IMPLEMENTED`になった）。
   */
  readonly gatedBy: readonly string[];
  readonly triggeredEffects: readonly TriggeredEffectExpectation[];
}

const AFFILIATION_ATTACK_UP: ActionExpectation["statMod"] = {
  stat: "ATTACK",
  valueType: "FIXED",
  value: 250,
};

const MEMORY_EXPECTATIONS: readonly MemoryExpectation[] = [
  {
    // 「効果１：カオスメイデンに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の防御力を200上昇させる」
    memoryDefinitionId: "MEM_CHAOS_MAIDEN",
    displayName: "Chaos Maiden",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_CHAOS_MAIDEN_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_CHAOS_MAIDEN" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CHAOS_MAIDEN_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CHAOS_MAIDEN_ALL_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 200 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：カラフルブーケに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の攻撃力を250上昇させる」
    memoryDefinitionId: "MEM_COLORFUL_BOUQUET",
    displayName: "Colorful Bouquet",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_COLORFUL_BOUQUET_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_COLORFUL_BOUQUET" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_COLORFUL_BOUQUET_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_COLORFUL_BOUQUET_ALL_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "FIXED", value: 250 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：ピクシス・マスールに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の行動速度を12上昇させる」
    memoryDefinitionId: "MEM_PYXIS_MA_SOEUR",
    displayName: "Pyxis Ma Soeur",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_PYXIS_MA_SOEUR_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_PYXIS_MA_SOEUR" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_PYXIS_MA_SOEUR_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_PYXIS_MA_SOEUR_ALL_SPEED_UP",
            statMod: { stat: "ACTION_SPEED", valueType: "FIXED", value: 12 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：シリウスシュガーに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体のHPを300上昇させる」
    memoryDefinitionId: "MEM_SIRIUS_SUGAR",
    displayName: "Sirius Sugar",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_SIRIUS_SUGAR_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_SIRIUS_SUGAR" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SIRIUS_SUGAR_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SIRIUS_SUGAR_ALL_HP_UP",
            statMod: { stat: "MAXIMUM_HP", valueType: "FIXED", value: 300 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：トレブルクインテットに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の会心率を1%上昇させる」
    memoryDefinitionId: "MEM_TREBLE_QUINTET",
    displayName: "Treble Quintet",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_TREBLE_QUINTET_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_TREBLE_QUINTET" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TREBLE_QUINTET_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TREBLE_QUINTET_ALL_CRIT_UP",
            statMod: { stat: "CRITICAL_RATE", valueType: "RATIO", value: 0.01 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：トリニティ・ジュエルに所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の防御力を200上昇させる」
    memoryDefinitionId: "MEM_TRINITY_JEWEL",
    displayName: "Trinity Jewel",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_TRINITY_JEWEL_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_TRINITY_JEWEL" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TRINITY_JEWEL_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TRINITY_JEWEL_ALL_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 200 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：風紀委員会に所属するキャラクターの攻撃力を250上昇させる
    //   効果２：味方全体の行動速度を12上昇させる」
    memoryDefinitionId: "MEM_FUUKI_IINKAI",
    displayName: "風紀委員会",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_FUUKI_IINKAI_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_FUUKI_IINKAI" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_FUUKI_IINKAI_AFFILIATION_ATK_UP",
            statMod: AFFILIATION_ATTACK_UP,
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_FUUKI_IINKAI_ALL_SPEED_UP",
            statMod: { stat: "ACTION_SPEED", valueType: "FIXED", value: 12 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：ピクシス・マスールに所属するキャラクターの防御力を800上昇させる
    //   効果２：物理アタッカーの攻撃力を2.5％上昇させる」
    memoryDefinitionId: "MEM_INCOGNITO_SISTER_ADVENTURE",
    displayName: "お忍びシスターの冒険",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_PYXIS_MA_SOEUR_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_PYXIS_MA_SOEUR" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_INCOGNITO_SISTER_ADVENTURE_AFFILIATION_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 800 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_PHYSICAL_ATTACKER_ALLIES",
        side: "ALLY",
        filters: [{ kind: "ROLE", role: "PHYSICAL_ATTACKER" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_INCOGNITO_SISTER_ADVENTURE_PHYSICAL_ATTACKER_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "RATIO", value: 0.025 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：クラスナに所属するキャラクターの与えるダメージを2.5%上昇させる
    //   効果２：コントロールの味方全員の攻撃力を1250上昇させる」
    memoryDefinitionId: "MEM_SHAPING_FAMILY",
    displayName: "家族のかたちを象りながら",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_KURASUNA_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_KURASUNA" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SHAPING_FAMILY_AFFILIATION_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: null, value: 0.025 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_CONTROL_ALLIES",
        side: "ALLY",
        filters: [{ kind: "ROLE", role: "CONTROL" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SHAPING_FAMILY_CONTROL_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "FIXED", value: 1250 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：プレ・クラスーＡに所属するキャラクターの与えるダメージを2.5％上昇させる
    //   効果２：味方前衛の防御力を2.5％上昇させる」
    memoryDefinitionId: "MEM_TENT_COMMOTION",
    displayName: "密着！？テントの中の珍騒動",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_PRE_KURASU_A_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_PRE_KURASU_A" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TENT_COMMOTION_AFFILIATION_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: null, value: 0.025 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_FRONT_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_TENT_COMMOTION_FRONT_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "RATIO", value: 0.025 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：カオスメイデンに所属するキャラクターの与えるダメージを2.5％上昇させる
    //   効果２：敵後衛の行動速度を70下降させる」
    memoryDefinitionId: "MEM_ELOPEMENT_FULL_THROTTLE",
    displayName: "駆け落ちフルスロットル！",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_AFF_CHAOS_MAIDEN_ALLIES",
        side: "ALLY",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_CHAOS_MAIDEN" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ELOPEMENT_FULL_THROTTLE_AFFILIATION_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: null, value: 0.025 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_BACK_ENEMIES",
        side: "ENEMY",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ELOPEMENT_FULL_THROTTLE_ENEMY_BACK_SPEED_DOWN",
            statMod: { stat: "ACTION_SPEED", valueType: "FIXED", value: -70 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：コントロールの味方全員に対し、物理攻撃で与えるダメージを3.5%上昇させる
    //   効果２：タンクの防御力を1000上昇させる」
    memoryDefinitionId: "MEM_NAUGHTY_PENALTY_GAME",
    displayName: "エッ◯な罰ゲームやってみた",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_CONTROL_ALLIES",
        side: "ALLY",
        filters: [{ kind: "ROLE", role: "CONTROL" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_NAUGHTY_PENALTY_GAME_CONTROL_PHYSICAL_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: "PHYSICAL", value: 0.035 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_TANK_ALLIES",
        side: "ALLY",
        filters: [{ kind: "ROLE", role: "TANK" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_NAUGHTY_PENALTY_GAME_TANK_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 1000 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：ENアタッカーの味方全員に対し、EN攻撃で与えるダメージを3.5%上昇させる
    //   効果２：左列後衛の味方の攻撃力を1行動の間2500上昇させる」
    memoryDefinitionId: "MEM_SOOTHING_SCENT",
    displayName: "安心する香り",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_EN_ATTACKER_ALLIES",
        side: "ALLY",
        filters: [{ kind: "ROLE", role: "EN_ATTACKER" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SOOTHING_SCENT_EN_ATTACKER_EN_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: "EN", value: 0.035 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_BACK_LEFT_ALLIES",
        side: "ALLY",
        filters: [
          { kind: "POSITION_ROW", row: "BACK" },
          { kind: "POSITION_COLUMN", column: "LEFT" },
        ],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_SOOTHING_SCENT_BACK_LEFT_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "FIXED", value: 2500 },
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：味方全体の与ダメージを2％上昇させる
    //   効果２：味方全体の会心率を1％上昇させる」
    memoryDefinitionId: "MEM_ENCOUNTER_WITH_GIRLS",
    displayName: "少女たちとの邂逅",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ENCOUNTER_WITH_GIRLS_ALL_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: null, value: 0.02 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ENCOUNTER_WITH_GIRLS_ALL_CRIT_UP",
            statMod: { stat: "CRITICAL_RATE", valueType: "RATIO", value: 0.01 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：味方全体のEN攻撃で与えるダメージを1.75％上昇させる
    //   効果２：味方全体の攻撃力を250上昇させる」
    memoryDefinitionId: "MEM_NEW_YEAR_GREETING",
    displayName: "新年のご挨拶",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_NEW_YEAR_GREETING_ALL_EN_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: "EN", value: 0.0175 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_NEW_YEAR_GREETING_ALL_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "FIXED", value: 250 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：前衛の味方全員に対し、物理攻撃で与えるダメージを3%上昇させる
    //   効果２：味方前衛のHPを1500上昇させる」
    memoryDefinitionId: "MEM_CATS_AND_DOGS_BOND",
    displayName: "腐れ縁で犬猿の仲？",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_FRONT_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CATS_AND_DOGS_BOND_FRONT_PHYSICAL_DMG_UP",
            damageMod: { direction: "OUTGOING", damageType: "PHYSICAL", value: 0.03 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_FRONT_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CATS_AND_DOGS_BOND_FRONT_HP_UP",
            statMod: { stat: "MAXIMUM_HP", valueType: "FIXED", value: 1500 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：ターン開始時に発動。味方前衛の攻撃力を1%上昇させる
    //   効果２：戦闘開始時に発動。味方後衛のHPを1500上昇させる」
    memoryDefinitionId: "MEM_DISCONTENT_AND_ANXIETY",
    displayName: "不満と不安",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "TurnStarted",
        targetBindingId: "TGT_FRONT_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_DISCONTENT_AND_ANXIETY_FRONT_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "RATIO", value: 0.01 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_BACK_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_DISCONTENT_AND_ANXIETY_BACK_HP_UP",
            statMod: { stat: "MAXIMUM_HP", valueType: "FIXED", value: 1500 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：ターン開始時に発動。味方後衛に次に受ける被ダメージを5％減少させるバフを付与する
    //   効果２：戦闘開始時に発動。味方後衛の防御力を1000上昇させる」
    memoryDefinitionId: "MEM_BUSY_DAY_SLUMBER",
    displayName: "忙しい時のまどろみ",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "TurnStarted",
        targetBindingId: "TGT_BACK_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DMG_DOWN",
            damageMod: { direction: "INCOMING", damageType: null, value: -0.05 },
            // 「次に受ける被ダメージ」= 1回の被弾で消費して失効する（期限は持たない）。
            timeLimit: null,
            consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_BACK_ALLIES",
        side: "ALLY",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 1000 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：中央列後衛の味方の攻撃力を1行動の間3000上昇させる。さらに「三ツ星」を付与する
    //   効果２：味方のHPと防御力を300上昇させる」
    memoryDefinitionId: "MEM_ALWAYS_PICO_BESIDE_YOU",
    displayName: "お傍にいるのはいつでもピコですよ♪",
    gatedBy: ["CAP_MEMORY_GRANTED_MARKER"],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_BACK_CENTER_ALLIES",
        side: "ALLY",
        filters: [
          { kind: "POSITION_ROW", row: "BACK" },
          { kind: "POSITION_COLUMN", column: "CENTER" },
        ],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_BACK_CENTER_ATK_UP",
            statMod: { stat: "ATTACK", valueType: "FIXED", value: 3000 },
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
          },
          {
            effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS",
            marker: { markerId: PICO_MARKER_ID, stackMax: null },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_HP_UP",
            statMod: { stat: "MAXIMUM_HP", valueType: "FIXED", value: 300 },
          },
          {
            effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_DEF_UP",
            statMod: { stat: "DEFENSE", valueType: "FIXED", value: 300 },
          },
        ],
      },
    ],
  },
  {
    // 「効果１：味方全体のHPを2500上昇させる
    //   効果２：敵前衛の防御力を1％下降させる」
    memoryDefinitionId: "MEM_CURIOUS_EQUIPMENT",
    displayName: "気になる装備",
    gatedBy: [],
    triggeredEffects: [
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_ALL_ALLIES",
        side: "ALLY",
        filters: [],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CURIOUS_EQUIPMENT_ALL_HP_UP",
            statMod: { stat: "MAXIMUM_HP", valueType: "FIXED", value: 2500 },
          },
        ],
      },
      {
        eventType: "BattleStarted",
        targetBindingId: "TGT_FRONT_ENEMIES",
        side: "ENEMY",
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
        actions: [
          {
            effectActionDefinitionId: "ACT_MEM_CURIOUS_EQUIPMENT_ENEMY_FRONT_DEF_DOWN",
            statMod: { stat: "DEFENSE", valueType: "RATIO", value: -0.01 },
          },
        ],
      },
    ],
  },
];

describe("production Catalog M7-008 affiliation / dynamic Memory conversions (Issue #176)", () => {
  it("IT-CAP-MEMORY-DYNAMIC-PROD-001: the six affiliation-pair Memories raise ATTACK by 250 only for their own affiliation members and apply their party-wide buff to every ally, never to the enemy party", () => {
    for (const expectation of AFFILIATION_PAIR_MEMORIES) {
      const { battle } = startWith({
        allyMemoryDefinitionIds: [expectation.memoryDefinitionId],
      });

      for (const member of ALLY_MEMBERS) {
        const unit = allyBy(battle, member.battleUnitId);
        const isMember = member.battleUnitId === expectation.memberBattleUnitId;
        // 効果1: 所属するキャラクターだけ攻撃力+250。
        expect(unit.combatStats.attack).toBeCloseTo(
          isMember ? expectation.expectedMemberAttack : expectation.expectedOtherAttack,
          6,
        );
        // 効果2: 味方全体（ATTACK対象のMemoryは上の行が既に重ね掛けを確認している）。
        if (expectation.partyWide.stat !== "ATTACK") {
          expect(statOf(unit, expectation.partyWide.stat)).toBeCloseTo(
            expectation.partyWide.expected,
            6,
          );
        }
      }

      // R-MEM-04のsource side: 敵は同じ所属に属していても一切影響を受けない。
      for (const enemy of battle.enemyUnits) {
        expect(enemy.appliedEffects).toHaveLength(0);
        expect(enemy.combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
        expect(statOf(enemy, expectation.partyWide.stat)).toBeCloseTo(
          expectation.partyWide.base,
          6,
        );
      }
    }
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-002: MEM_FUUKI_IINKAI raises ATTACK only for its AFF_FUUKI_IINKAI member, and its affiliation triggeredEffect emits no MemoryTriggered at all when the party has no member", () => {
    const withMember = startWith({
      allyMemoryDefinitionIds: ["MEM_FUUKI_IINKAI"],
      allyMembers: FUUKI_ALLY_MEMBERS,
    });

    expect(allyBy(withMember.battle, "ally:fuuki_iinkai").combatStats.attack).toBeCloseTo(
      BASE_ATTACK + 250,
      6,
    );
    expect(allyBy(withMember.battle, "ally:unaffiliated").combatStats.attack).toBeCloseTo(
      BASE_ATTACK,
      6,
    );
    // 効果2「味方全体の行動速度を12上昇」は所属に関係なく両方へ乗る。
    for (const member of FUUKI_ALLY_MEMBERS) {
      expect(allyBy(withMember.battle, member.battleUnitId).combatStats.actionSpeed).toBeCloseTo(
        BASE_ACTION_SPEED + 12,
        6,
      );
    }
    expect(
      withMember.recorder
        .getEvents()
        .filter((event) => event.eventType === "MemoryTriggered")
        .map((event) => (event.payload as { triggeredEffectIndex: number }).triggeredEffectIndex),
    ).toEqual([0, 1]);

    // 境界: 誰も所属していない編成では、対象0件の効果1は`MemoryTriggered`自体を
    // 発行しない（`08_ドメインイベント.md`「発動直前の再確認」）。効果2は発動する。
    const withoutMember = startWith({ allyMemoryDefinitionIds: ["MEM_FUUKI_IINKAI"] });
    expect(
      withoutMember.recorder
        .getEvents()
        .filter((event) => event.eventType === "MemoryTriggered")
        .map((event) => (event.payload as { triggeredEffectIndex: number }).triggeredEffectIndex),
    ).toEqual([1]);
    for (const member of ALLY_MEMBERS) {
      expect(allyBy(withoutMember.battle, member.battleUnitId).combatStats.attack).toBeCloseTo(
        BASE_ATTACK,
        6,
      );
      expect(allyBy(withoutMember.battle, member.battleUnitId).combatStats.actionSpeed).toBeCloseTo(
        BASE_ACTION_SPEED + 12,
        6,
      );
    }
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-003: MEM_INCOGNITO_SISTER_ADVENTURE combines an AFFILIATION-filtered fixed DEFENSE buff with a ROLE-filtered ratio ATTACK buff over disjoint ally sets", () => {
    const { battle } = startWith({
      allyMemoryDefinitionIds: ["MEM_INCOGNITO_SISTER_ADVENTURE"],
    });

    // 効果1「ピクシス・マスールに所属するキャラクターの防御力を800上昇」
    expect(allyBy(battle, "ally:pyxis_ma_soeur").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE + 800,
      6,
    );
    expect(allyBy(battle, "ally:chaos_maiden").combatStats.defense).toBeCloseTo(BASE_DEFENSE, 6);
    // 効果2「物理アタッカーの攻撃力を2.5％上昇」— TANKのPyxisメンバーには乗らない
    expect(allyBy(battle, "ally:chaos_maiden").combatStats.attack).toBeCloseTo(
      BASE_ATTACK * 1.025,
      6,
    );
    expect(allyBy(battle, "ally:pyxis_ma_soeur").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);
    expect(allyBy(battle, "ally:pyxis_ma_soeur").appliedEffects).toHaveLength(1);
    expect(allyBy(battle, "ally:chaos_maiden").appliedEffects).toHaveLength(1);
    expect(allyBy(battle, "ally:sirius_sugar").appliedEffects).toHaveLength(0);
    // 敵側の`AFF_PYXIS_MA_SOEUR`メンバーには適用されない。
    expect(enemyBy(battle, "enemy:pyxis_ma_soeur").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE,
      6,
    );
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-004: MEM_CURIOUS_EQUIPMENT buffs its own party's MAXIMUM_HP and debuffs only the opposing FRONT row, resolving side: ENEMY relative to the party that equipped it", () => {
    const equippedByAlly = startWith({ allyMemoryDefinitionIds: ["MEM_CURIOUS_EQUIPMENT"] });

    for (const member of ALLY_MEMBERS) {
      expect(allyBy(equippedByAlly.battle, member.battleUnitId).combatStats.maximumHp).toBeCloseTo(
        BASE_MAXIMUM_HP + 2500,
        6,
      );
    }
    // 効果2「敵前衛の防御力を1％下降」— 敵の前衛だけ、味方の前衛には乗らない。
    expect(enemyBy(equippedByAlly.battle, "enemy:front").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE * 0.99,
      6,
    );
    expect(enemyBy(equippedByAlly.battle, "enemy:pyxis_ma_soeur").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE,
      6,
    );
    expect(enemyBy(equippedByAlly.battle, "enemy:front").combatStats.maximumHp).toBeCloseTo(
      BASE_MAXIMUM_HP,
      6,
    );
    expect(allyBy(equippedByAlly.battle, "ally:chaos_maiden").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE,
      6,
    );

    // 同じMemoryを敵陣営が指定した場合、`side: ENEMY`は味方陣営へ解決する。
    const equippedByEnemy = startWith({ enemyMemoryDefinitionIds: ["MEM_CURIOUS_EQUIPMENT"] });
    for (const enemy of equippedByEnemy.battle.enemyUnits) {
      expect(enemy.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 2500, 6);
    }
    expect(allyBy(equippedByEnemy.battle, "ally:chaos_maiden").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE * 0.99,
      6,
    );
    expect(allyBy(equippedByEnemy.battle, "ally:sirius_sugar").combatStats.defense).toBeCloseTo(
      BASE_DEFENSE,
      6,
    );
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-005: MEM_DISCONTENT_AND_ANXIETY applies its BattleStarted back-row buff exactly once and re-applies its TurnStarted front-row buff on every turn", () => {
    const { battle, recorder } = startWith({
      allyMemoryDefinitionIds: ["MEM_DISCONTENT_AND_ANXIETY"],
      allyMembers: TURN_ALLY_MEMBERS,
      enemyMembers: TURN_ENEMY_MEMBERS,
      turnLimit: 3,
    });

    // 戦闘開始時点: 効果2（後衛HP+1500）だけが適用され、効果1はまだ発動しない。
    expect(allyBy(battle, "ally:turn_back").combatStats.maximumHp).toBeCloseTo(
      BASE_MAXIMUM_HP + 1500,
      6,
    );
    expect(allyBy(battle, "ally:turn_front").combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP, 6);
    expect(allyBy(battle, "ally:turn_front").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);

    const afterTurn1 = advanceBattle(battle, new SequenceRandomSource([]), recorder);
    expect(allyBy(afterTurn1, "ally:turn_front").combatStats.attack).toBeCloseTo(
      BASE_ATTACK * 1.01,
      6,
    );
    expect(allyBy(afterTurn1, "ally:turn_back").combatStats.attack).toBeCloseTo(BASE_ATTACK, 6);

    const afterTurn2 = advanceBattle(afterTurn1, new SequenceRandomSource([]), recorder);
    // 「ターン開始時に発動」は毎ターン重ねて付与される（raw原文に期間の指定はない）。
    expect(allyBy(afterTurn2, "ally:turn_front").appliedEffects).toHaveLength(2);
    expect(allyBy(afterTurn2, "ally:turn_front").combatStats.attack).toBeCloseTo(
      BASE_ATTACK * 1.02,
      6,
    );
    // 効果2は`BattleStarted`のみ — ターンが進んでも増えない。
    expect(allyBy(afterTurn2, "ally:turn_back").appliedEffects).toHaveLength(1);
    expect(allyBy(afterTurn2, "ally:turn_back").combatStats.maximumHp).toBeCloseTo(
      BASE_MAXIMUM_HP + 1500,
      6,
    );
    // 敵前衛はMemoryを指定していないので一切影響を受けない。
    expect(enemyBy(afterTurn2, "enemy:turn_front").appliedEffects).toHaveLength(0);
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-006: M7-008 Memories emit MemoryTriggered/MemoryResolved with a sourceSide instead of a granter unit, and their StateDeltas alone reconstruct the started battle", () => {
    const { created, battle, recorder } = startWith({
      allyMemoryDefinitionIds: ORDERING_MEMORY_IDS,
    });

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
    // R-MEM-02: API指定順 → 同一Memory内のtriggeredEffects定義順。
    // `MEM_FUUKI_IINKAI#0`（所属メンバー0件）と`MEM_DISCONTENT_AND_ANXIETY#0`
    // （`TurnStarted`発動）は`BattleStarted`では発動しない。
    expect(triggered).toEqual([
      "MEM_CHAOS_MAIDEN#0",
      "MEM_CHAOS_MAIDEN#1",
      "MEM_TREBLE_QUINTET#0",
      "MEM_TREBLE_QUINTET#1",
      "MEM_FUUKI_IINKAI#1",
      "MEM_INCOGNITO_SISTER_ADVENTURE#0",
      "MEM_INCOGNITO_SISTER_ADVENTURE#1",
      "MEM_DISCONTENT_AND_ANXIETY#1",
      "MEM_CURIOUS_EQUIPMENT#0",
      "MEM_CURIOUS_EQUIPMENT#1",
    ]);
    expect(
      recorder.getEvents().filter((event) => event.eventType === "MemoryResolved"),
    ).toHaveLength(triggered.length);
    for (const unit of [...battle.allyUnits, ...battle.enemyUnits]) {
      for (const effect of unit.appliedEffects) {
        expect(effect.sourceId).toBeUndefined();
        expect(effect.sourceSide).toBe("ALLY");
      }
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
    expect(before).not.toEqual(after);
    // 復元側にも重ね掛けが乗っている: `ally:chaos_maiden`はFRONT/PHYSICAL_ATTACKER/
    // AFF_CHAOS_MAIDEN。ATTACK は +250（Chaos Maiden 効果1）と
    // +2.5%（お忍びシスターの冒険 効果2）。
    const restoredChaos = unitSnapshotOf(reconstructed, "ally:chaos_maiden");
    expect(restoredChaos?.combatStats.attack).toBeCloseTo(BASE_ATTACK * 1.025 + 250, 6);
    expect(restoredChaos?.combatStats.defense).toBeCloseTo(BASE_DEFENSE + 200, 6);
    expect(restoredChaos?.combatStats.actionSpeed).toBeCloseTo(BASE_ACTION_SPEED + 12, 6);
    expect(restoredChaos?.combatStats.criticalRate).toBeCloseTo(BASE_CRITICAL_RATE * 1.01, 6);
    // 「気になる装備」効果1（味方全体HP+2500）は乗るが、「不満と不安」効果2
    // （味方後衛HP+1500）はFRONT列のこのユニットには乗らない。
    expect(restoredChaos?.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 2500, 6);
    // ATTACK 2件（Chaos Maiden 効果1 / お忍びシスターの冒険 効果2）と
    // DEFENSE・CRITICAL_RATE・ACTION_SPEED・MAXIMUM_HP 各1件。
    expect(restoredChaos?.effects).toHaveLength(6);
    // 敵前衛は「気になる装備」効果2の防御力-1%だけを受ける。
    const restoredEnemyFront = unitSnapshotOf(reconstructed, "enemy:front");
    expect(restoredEnemyFront?.effects).toHaveLength(1);
    expect(restoredEnemyFront?.combatStats.defense).toBeCloseTo(BASE_DEFENSE * 0.99, 6);
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-007: MEM_ALWAYS_PICO_BESIDE_YOU grants the BACK CENTER ally a one-action ATTACK buff and the 三ツ星 Marker with a sourceSide and no granter unit (R-MEM-04), and its StateDeltas alone reconstruct that Marker", () => {
    const { created, battle, recorder } = startWith({
      allyMemoryDefinitionIds: ["MEM_ALWAYS_PICO_BESIDE_YOU"],
    });

    // 効果1「中央列後衛の味方の攻撃力を1行動の間3000上昇させる。さらに「三ツ星」を付与する」
    const backCenter = allyBy(battle, "ally:treble_quintet");
    expect(backCenter.combatStats.attack).toBeCloseTo(BASE_ATTACK + 3000, 6);
    expect(backCenter.markerStates).toHaveLength(1);
    const marker = backCenter.markerStates[0]!;
    expect(marker.markerId).toBe(PICO_MARKER_ID);
    expect(marker.stackCount).toBe(1);
    expect(marker.sourceId).toBeUndefined();
    expect(marker.sourceSide).toBe("ALLY");
    // raw原文の「1行動の間」は攻撃力バフだけに掛かる修飾で、「三ツ星」自体には
    // 期間の指定がないため戦闘終了まで残る。
    expect(marker.duration.definition.timeLimit).toEqual({ unit: "BATTLE", count: 1 });
    // 攻撃力バフ側は保持者自身の1行動で減算する（Memoryは付与者ユニットを持たないため
    // `timeLimit.owner`は`EFFECT_TARGET`）。
    const attackBuff = backCenter.appliedEffects.find(
      (effect) =>
        effect.effectActionDefinitionId === "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_BACK_CENTER_ATK_UP",
    );
    expect(attackBuff?.duration.timeLimitRemaining).toBe(1);

    // 効果2「味方のHPと防御力を300上昇させる」は味方全体、Markerは中央列後衛だけ。
    for (const member of ALLY_MEMBERS) {
      const ally = allyBy(battle, member.battleUnitId);
      expect(ally.combatStats.maximumHp).toBeCloseTo(BASE_MAXIMUM_HP + 300, 6);
      expect(ally.combatStats.defense).toBeCloseTo(BASE_DEFENSE + 300, 6);
      expect(ally.markerStates).toHaveLength(member.battleUnitId === "ally:treble_quintet" ? 1 : 0);
    }
    for (const enemy of battle.enemyUnits) {
      expect(enemy.markerStates).toHaveLength(0);
      expect(enemy.appliedEffects).toHaveLength(0);
    }

    const applied = recorder.getEvents().filter((event) => event.eventType === "MarkerApplied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.sourceUnitId).toBeUndefined();
    expect(applied[0]!.sourceSide).toBe("ALLY");

    const before = captureBattleState(created);
    const after = captureBattleState(battle);
    const deltas = recorder
      .getEvents()
      .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta]));
    const reconstructed = reduceStateDeltas(before, deltas);

    expect(reconstructed).toEqual(after);
    const restored = unitSnapshotOf(reconstructed, "ally:treble_quintet");
    expect(restored?.markers).toHaveLength(1);
    expect(restored?.markers?.[0]?.markerId).toBe(PICO_MARKER_ID);
    expect(restored?.markers?.[0]?.sourceUnitId).toBeUndefined();
    expect(restored?.markers?.[0]?.sourceSide).toBe("ALLY");
  });

  it("IT-CAP-MEMORY-DYNAMIC-PROD-008: every M7-008 Memory converts each raw filter, trigger timing and magnitude without approximation, and only MEM_ALWAYS_PICO_BESIDE_YOU stays gated by an unimplemented Capability", () => {
    expect(MEMORY_EXPECTATIONS.map((expectation) => expectation.memoryDefinitionId)).toEqual([
      ...M7_008_MEMORY_IDS,
    ]);

    for (const expectation of MEMORY_EXPECTATIONS) {
      const memory = memoryOf(expectation.memoryDefinitionId);
      expect(memory.metadata.displayName).toBe(expectation.displayName);
      expect(memory.triggeredEffects).toHaveLength(expectation.triggeredEffects.length);

      expectation.triggeredEffects.forEach((expected, index) => {
        const triggeredEffect = memory.triggeredEffects[index]!;
        expect(triggeredEffect.trigger.eventType).toBe(expected.eventType);
        expect(triggeredEffect.trigger.condition).toEqual({ kind: "TRUE" });

        const bindings = triggeredEffect.effectSequence.targetBindings;
        expect(bindings).toHaveLength(1);
        const binding = bindings[0]!;
        expect(binding.targetBindingId).toBe(expected.targetBindingId);
        expect(binding.selector.kind).toBe("SELECT");
        expect(binding.selector.side).toBe(expected.side);
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
        expect(step.actions.map((action) => action.effectActionDefinitionId)).toEqual(
          expected.actions.map((action) => action.effectActionDefinitionId),
        );

        for (const expectedAction of expected.actions) {
          const action = snapshot.effectActions.get(
            createEffectActionDefinitionId(expectedAction.effectActionDefinitionId),
          );
          if (action === undefined) {
            throw new Error(
              `production Catalog has no EffectAction "${expectedAction.effectActionDefinitionId}"`,
            );
          }
          if (expectedAction.damageMod !== undefined) {
            if (action.kind !== "APPLY_DAMAGE_MOD") {
              throw new Error(`expected APPLY_DAMAGE_MOD, got "${action.kind}"`);
            }
            expect(action.payload.direction).toBe(expectedAction.damageMod.direction);
            // 「物理攻撃で与えるダメージ」「EN攻撃で与えるダメージ」はdamageType限定、
            // 種別を書いていない「与えるダメージ」は`null`（全種別）として区別する。
            expect(action.payload.damageType).toBe(expectedAction.damageMod.damageType);
            expect(action.payload.formula).toEqual({
              kind: "CONSTANT",
              value: expectedAction.damageMod.value,
            });
          } else if (expectedAction.marker !== undefined) {
            if (action.kind !== "APPLY_MARKER") {
              throw new Error(`expected APPLY_MARKER, got "${action.kind}"`);
            }
            expect(action.payload.markerId).toBe(expectedAction.marker.markerId);
            expect(action.payload.stack).toEqual({
              policy: "ADD",
              max: expectedAction.marker.stackMax,
            });
          } else if (expectedAction.statMod !== undefined) {
            if (action.kind !== "APPLY_STAT_MOD") {
              throw new Error(`expected APPLY_STAT_MOD, got "${action.kind}"`);
            }
            expect(action.payload.stat).toBe(expectedAction.statMod.stat);
            expect(action.payload.valueType).toBe(expectedAction.statMod.valueType);
            expect(action.payload.formula).toEqual({
              kind: "CONSTANT",
              value: expectedAction.statMod.value,
            });
          } else {
            throw new Error("expectation must declare a damageMod, a marker or a statMod");
          }
          // 「1行動の間」のように期間が明記されたものだけがACTION単位の期限を持ち、
          // 「次に受ける被ダメージ」は消費で失効し、それ以外は戦闘終了まで残る。
          expect(action.payload.duration.timeLimit).toEqual(
            expectedAction.timeLimit === null
              ? undefined
              : (expectedAction.timeLimit ?? { unit: "BATTLE", count: 1 }),
          );
          expect(action.payload.duration.consumption).toEqual(expectedAction.consumption);
        }
      });

      const unimplemented = findUnimplementedCapabilities(
        collectRequiredCapabilities(snapshot, [], [memory.memoryDefinitionId]),
        snapshot.capabilities,
      ).map((capability) => capability.capabilityId);
      // gate対象のCapabilityは宣言もされていること（宣言漏れならpreflightをすり抜ける）。
      for (const capabilityId of expectation.gatedBy) {
        expect(memory.requiredCapabilities).toContain(capabilityId);
      }
      expect(unimplemented).toEqual([...expectation.gatedBy]);
    }
  });
});
