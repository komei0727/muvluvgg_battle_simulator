import { advanceBattle, createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import type { Battle } from "../../domain/battle/lifecycle/battle.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type {
  Attribute,
  DamageType,
  Role,
  Side as SelectorSide,
  StatKind,
  UnitType,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type { TargetFilterDefinition } from "../../domain/catalog/definitions/target-selector-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";
import {
  captureBattleState,
  type BattleStateSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { reduceStateDeltas } from "../../domain/battle/lifecycle/state-delta-reducer.js";
import {
  definitionsWith,
  effectActionFrom,
  loadProductionSnapshot,
  memoryFrom,
  testBattleUnit,
  testUnitDefinition,
} from "../fixtures/index.js";
import { PRODUCTION_CATALOG_DIR } from "./skill-behaviour.js";

/**
 * ユニット単位production結合テストのMemory側（`__tests__/production-catalog/memories/`）
 * が共有する盤面と観測（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * production Memoryの`triggeredEffects`はすべて`BattleStarted`を契機に、
 * 「陣形上の位置」「ロール」「ユニット種別」で絞った対象群へEffectActionを配る。
 * したがって効果発現の検証は「実`startBattle`を通したとき、**どのスロットが**
 * その効果を受け取り、**どのスロットが受け取らないか**」に尽きる。6スロット×両陣営を
 * 常に埋め、絞り込み軸（row / column / role / unitType）が互いに区別できるよう
 * 割り付けた固定盤面を1つ用意して、全Memoryがそれを共有する。
 */

export interface MemorySlot {
  readonly key: string;
  readonly position: FormationPosition;
  readonly role: Role;
  readonly unitType: UnitType;
}

/**
 * 6スロットの割り付け。`role`・`unitType`は行・列と相関しないように配り、
 * 「ROLEで絞ったつもりが実は行で絞れていた」という偽陽性を成立させない
 * （例: SUPPORTは前衛と後衛に1体ずつ、PHYSICALは前列と後列に1体ずつ）。
 */
export const MEMORY_SLOTS: readonly MemorySlot[] = [
  {
    key: "FRONT_LEFT",
    position: { row: "FRONT", column: "LEFT" },
    role: "PHYSICAL_ATTACKER",
    unitType: "PHYSICAL",
  },
  {
    key: "FRONT_CENTER",
    position: { row: "FRONT", column: "CENTER" },
    role: "TANK",
    unitType: "AGILE",
  },
  {
    key: "FRONT_RIGHT",
    position: { row: "FRONT", column: "RIGHT" },
    role: "SUPPORT",
    unitType: "ENERGY",
  },
  {
    key: "BACK_LEFT",
    position: { row: "BACK", column: "LEFT" },
    role: "EN_ATTACKER",
    unitType: "ENERGY",
  },
  {
    key: "BACK_CENTER",
    position: { row: "BACK", column: "CENTER" },
    role: "SUPPORT",
    unitType: "PHYSICAL",
  },
  {
    key: "BACK_RIGHT",
    position: { row: "BACK", column: "RIGHT" },
    role: "CONTROL",
    unitType: "AGILE",
  },
];

/** 全スロット共通の基礎値。重ね掛けを実効値で確かめる`-00N`が基準として読む。 */
export const MEMORY_COMBAT_STATS: CombatStats = {
  maximumHp: 10000,
  attack: 1000,
  defense: 500,
  criticalRate: 0,
  actionSpeed: 100,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

const MEMORY_LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

/** `ally:FRONT_LEFT` のような、スロットと1対1に対応する戦闘ユニットID。 */
export function memoryUnitId(side: Side, slotKey: string): string {
  return `${side === "ALLY" ? "ally" : "enemy"}:${slotKey}`;
}

function slotUnitDefinitionId(slot: MemorySlot): string {
  return `UNIT_TEST_MEMORY_${slot.key}`;
}

/**
 * 盤面の既定（`MEMORY_SLOTS`）から、そのMemoryの検証に必要な軸だけを動かす上書き。
 *
 * `AFFILIATION` TargetFilterは静的Catalogの`UnitDefinition.metadata.affiliations`を
 * 引くため、既定の「所属なし」6スロットのままでは対象0件になり、効果が一度も
 * 発現しない。所属は`18_Affiliation台帳.md`の`AFF_*`ごとに異なり、全所属を6スロットへ
 * 常設することはできないため、Memoryごとに「どのスロットが名乗るか」を宣言する。
 */
export interface MemoryBoardOverrides {
  /** スロットキー → そのスロットのUnitDefinitionが名乗る所属ID。 */
  readonly affiliationsBySlot?: Readonly<Record<string, readonly string[]>>;
  /**
   * スロットキー → そのスロットの戦闘ユニットが持つ属性。`ATTRIBUTE` TargetFilterは
   * `UnitDefinition`ではなく`BattleUnit.attribute`（編成時に決まる）を読むため、
   * 所属と同じく検証したいMemoryごとに宣言する。既定は`testBattleUnit`の
   * `AGGRESSIVE`で、盤面全体を実属性へ寄せると属性相性倍率が観測へ混ざるため
   * opt-inに留める。
   */
  readonly attributesBySlot?: Readonly<Record<string, Attribute>>;
}

function slotUnitDefinition(slot: MemorySlot, overrides: MemoryBoardOverrides): UnitDefinition {
  const affiliations = overrides.affiliationsBySlot?.[slot.key];
  return testUnitDefinition(slotUnitDefinitionId(slot), {
    role: slot.role,
    unitType: slot.unitType,
    positionAptitudes: ["FRONT", "BACK"],
    ...(affiliations === undefined ? {} : { metadata: { affiliations } }),
  });
}

function slotBattleUnit(slot: MemorySlot, side: Side, overrides: MemoryBoardOverrides): BattleUnit {
  const attribute = overrides.attributesBySlot?.[slot.key];
  return testBattleUnit({
    battleUnitId: memoryUnitId(side, slot.key),
    unitDefinitionId: slotUnitDefinitionId(slot),
    side,
    position: slot.position,
    combatStats: MEMORY_COMBAT_STATS,
    limits: MEMORY_LIMITS,
    ...(attribute === undefined ? {} : { attribute }),
  });
}

/**
 * 「戦闘終了まで残る」既定の期間宣言。原文が期間を書いていないMemory効果は
 * すべてこれになるため、表からはキーごと落として**逸脱だけを目立たせる**
 * （`toEqual`の完全一致なので、既定から外れた瞬間にキーが現れて落ちる）。
 */
const BATTLE_LONG_TIME_LIMIT = { unit: "BATTLE", count: 1 } as const;

/** 期間宣言（`duration.timeLimit`）の観測形。`null`は「期限を持たない」。 */
export interface MemoryTimeLimit {
  readonly unit: string;
  readonly count: number;
  readonly owner?: string;
}

/** Memory 1件が配った効果を、EffectAction単位でまとめた観測結果。 */
export interface MemoryGrant {
  readonly effectActionDefinitionId: string;
  /** 効果を受け取った戦闘ユニットID（付与順）。 */
  readonly unitIds: readonly string[];
  readonly magnitude: number;
  /**
   * R-MEM-04: Memory由来の付与は付与者ユニットを持たず、Memoryを指定した陣営を
   * 持つ。宣言側の陣営がそのまま現れることを表に固定する。
   */
  readonly sourceSide: Side;
  /**
   * `APPLY_STAT_MOD`由来だけが持つ、補正先と倍率／固定値の区別。`magnitude`は
   * Formula評価結果なので、`RATIO 0.025`と`FIXED 0.025`はこの欄でしか区別できない。
   */
  readonly statMod?: { readonly stat: StatKind; readonly valueType: "RATIO" | "FIXED" };
  /**
   * `APPLY_DAMAGE_MOD`由来だけが持つ、補正の向きと対象ダメージ種別。
   * 「物理攻撃で与えるダメージ」はdamageType限定、種別を書いていない
   * 「与えるダメージ」は`null`（全種別）で、両者は効果量では区別できない。
   */
  readonly damageMod?: {
    readonly direction: "OUTGOING" | "INCOMING";
    readonly damageType: DamageType | null;
  };
  /**
   * 既定（戦闘終了まで＝`{ unit: "BATTLE", count: 1 }`）と異なるときだけ現れる。
   * `null`は期限そのものを持たない（消費でだけ失効する）ことを表す。
   */
  readonly timeLimit?: MemoryTimeLimit | null;
  /** 消費で失効する効果だけが持つ。 */
  readonly consumption?: { readonly kind: string; readonly maxCount: number };
}

/**
 * Memory 1件が配ったMarkerを、Marker単位でまとめた観測結果。Markerは
 * `appliedEffects`ではなく`markerStates`へ載るため、`MemoryGrant`とは別に持つ。
 */
export interface MemoryMarkerGrant {
  readonly markerId: string;
  /** Markerを受け取った戦闘ユニットID（保持順）。 */
  readonly unitIds: readonly string[];
  readonly stackCount: number;
  /** R-EFF-10の段数上限（`stack.max`）。`null`は上限なし。1回の付与では出ない宣言。 */
  readonly stackMax: number | null;
  /** R-MEM-04: `MemoryGrant.sourceSide`と同じ規約。 */
  readonly sourceSide: Side;
}

/**
 * `triggeredEffect` が対象集合をどう宣言しているか（`targetBindings` の selector）。
 *
 * 当たったスロット（`MemoryGrant.unitIds`）は「対象となる味方**全員**」を
 * 保証しない — 固定盤面で一致対象が1体だけになる行（production 66付与のうち24件。
 * `ROLE: SUPPORT`以外のロール絞り込み・所属条件・属性条件はどれも1スロットしか
 * 引かない）では、`count: "ALL"` が `count: 1` へ退行しても `unitIds` が変わらない。
 * 対象集合の宣言そのものを観測へ載せてこの死角を塞ぐ。
 *
 * `filters` も同じ理由で持つ。当たったスロットが1体だけの行では**別の絞り込みへ
 * 差し替えても同じ1体を引く**（`MEM_ABSOLUTE_ORDER` の `ROLE: PHYSICAL_ATTACKER` を
 * `POSITION_ROW: FRONT`＋`POSITION_COLUMN: LEFT` にしても固定盤面では同じ
 * `ally:FRONT_LEFT` が当たる）ため、`unitIds` では原文の「物理アタッカーの味方全員」
 * という契約の退行を検出できない。
 *
 * `triggeredEffect` 1件につき `targetBindings` 1件が定義順に並ぶため、binding が
 * 増減した場合も表の行数が変わって落ちる。
 */
export interface MemoryTargetSelection {
  readonly triggeredEffectIndex: number;
  readonly kind: string;
  /**
   * `kind: "SELECT"` だけが持つ（他のkindへ退行するとキーごと落ちて表と食い違う）。
   * `catalog-enums` の `Side` は対象選択用で、陣営2種のほかに `"ALL"` を取る。
   */
  readonly side?: SelectorSide;
  readonly count?: number | "ALL";
  /** 絞り込み。空配列は「陣営全体から絞り込まない」という宣言そのもの。 */
  readonly filters: readonly TargetFilterDefinition[];
}

/**
 * 発動した`triggeredEffect` 1件が、EffectActionを**実際に発行した順**。
 *
 * `grants`はEffectAction ID順、`markers`は別配列、`executedActionIds`は集合なので、
 * どれも適用順を表さない。しかしR-MEM-04が委譲するR-SKL-06 #4は同じACTION stepの
 * `actions`を**定義順**に適用する契約で、順序が入れ替わると
 * `EffectApplied`／`MarkerApplied`の発行順が変わり、各イベントを契機にする
 * PS・Memory連鎖の観測が変わり得る（`MEM_ALWAYS_PICO_BESIDE_YOU#0` の
 * 「攻撃力バフ → 三ツ星Marker」など）。宣言ではなく実発行順を観測して固定する。
 */
export interface MemoryActionOrder {
  readonly triggeredEffectIndex: number;
  /**
   * `EffectActionCompleted` が最初に発行された順のEffectAction ID。対象ごとの
   * 繰り返しは畳む（下記 {@link actionOrderOf}）。production Memoryはどの
   * `triggeredEffect` も同じEffectActionを2度宣言しないため、これは宣言された
   * `actions` の並びと1対1に対応する。
   */
  readonly actionIds: readonly string[];
}

/**
 * 実`catalog/`のMemoryを片陣営が宣言した状態で`startBattle`を通し、
 * `BattleStarted`から配られた効果をEffectAction単位で観測する。
 * 効果を1件も受け取らなかったユニットは結果に現れない。
 */
export interface MemoryObservation {
  readonly grants: readonly MemoryGrant[];
  /** 発動した`triggeredEffect`ごとの、EffectActionの実発行順。 */
  readonly actionOrder: readonly MemoryActionOrder[];
  /**
   * 全`triggeredEffect`の対象集合の宣言（定義順）。発動しなかった
   * `triggeredEffect`（`TurnStarted`発動・対象0件）の分も含む。
   */
  readonly targetSelections: readonly MemoryTargetSelection[];
  /** 付与されたMarker（Marker ID順）。1件も無ければ空配列。 */
  readonly markers: readonly MemoryMarkerGrant[];
  /**
   * `MemoryTriggered` の発火順（`<memoryDefinitionId>#<triggeredEffectIndex>`）。
   * R-MEM-02の解決順（API宣言順 → `triggeredEffects` 定義順）が、対象0件の
   * `triggeredEffect` を飛ばさずに現れることまで固定する。
   */
  readonly triggeredOrder: readonly string[];
  /** 実際に実行されたEffectAction ID（実行ベース網羅監査が使う）。 */
  readonly executedActionIds: readonly string[];
  /** 追加の機構検証（付与効果の期間・StateDelta復元）が使う、開始前後の戦闘と記録。 */
  readonly created: Battle;
  readonly started: Battle;
  readonly recorder: EventRecorder;
}

/** 付与結果だけが要る呼び出し向けの薄い入口。 */
export function observeMemoryGrants(
  memoryDefinitionId: string,
  side: Side,
  overrides: MemoryBoardOverrides = {},
): readonly MemoryGrant[] {
  return observeMemory(memoryDefinitionId, side, overrides).grants;
}

interface MemoryBattle {
  readonly created: Battle;
  readonly recorder: EventRecorder;
  readonly snapshot: BattleCatalogSnapshot;
}

/** 陣営ごとに宣言するMemory ID列（API指定順そのもの）。 */
export type MemoriesBySide = Readonly<Record<Side, readonly string[]>>;

function createMemoryBattleFor(
  memoriesBySide: MemoriesBySide,
  overrides: MemoryBoardOverrides,
  turnLimit: number,
): MemoryBattle {
  const declared = [...new Set([...memoriesBySide.ALLY, ...memoriesBySide.ENEMY])];
  const snapshot: BattleCatalogSnapshot = loadProductionSnapshot(
    PRODUCTION_CATALOG_DIR,
    [],
    declared,
  );
  const battleId = createBattleId("B_MEMORY");
  return {
    created: createBattle(
      battleId,
      MEMORY_SLOTS.map((slot) => slotBattleUnit(slot, "ALLY", overrides)),
      MEMORY_SLOTS.map((slot) => slotBattleUnit(slot, "ENEMY", overrides)),
      createTurnLimit(turnLimit),
      definitionsWith(snapshot, {
        units: MEMORY_SLOTS.map((slot) => slotUnitDefinition(slot, overrides)),
        overrides: {
          memoriesBySide: {
            ALLY: memoriesBySide.ALLY.map((id) => memoryFrom(snapshot, id)),
            ENEMY: memoriesBySide.ENEMY.map((id) => memoryFrom(snapshot, id)),
          },
        },
      }),
    ),
    recorder: new EventRecorder(battleId),
    snapshot,
  };
}

function createMemoryBattle(
  memoryDefinitionId: string,
  side: Side,
  overrides: MemoryBoardOverrides,
  turnLimit: number,
): MemoryBattle {
  return createMemoryBattleFor(
    {
      ALLY: side === "ALLY" ? [memoryDefinitionId] : [],
      ENEMY: side === "ENEMY" ? [memoryDefinitionId] : [],
    },
    overrides,
    turnLimit,
  );
}

/**
 * 1回の発現では観測に出ない**宣言**（補正先・倍率区分・ダメージ種別・期間・消費）を
 * EffectActionDefinitionから写す。効果量や当たったスロットと違い、これらは実行結果を
 * 見ても読めないため、観測へ載せて`-001`の`toEqual`に載せる
 * （`12_テスト戦略.md`「ユニット効果軸の標準形」の「結果と宣言」）。
 */
function declarationOf(
  snapshot: BattleCatalogSnapshot,
  effectActionDefinitionId: string,
): Partial<MemoryGrant> {
  const action = effectActionFrom(snapshot, effectActionDefinitionId);
  const kindDeclaration =
    action.kind === "APPLY_STAT_MOD"
      ? { statMod: { stat: action.payload.stat, valueType: action.payload.valueType } }
      : action.kind === "APPLY_DAMAGE_MOD"
        ? {
            damageMod: {
              direction: action.payload.direction,
              damageType: action.payload.damageType,
            },
          }
        : {};
  const duration = "duration" in action.payload ? action.payload.duration : undefined;
  const timeLimit = duration?.timeLimit;
  const isBattleLong =
    timeLimit !== undefined &&
    timeLimit.unit === BATTLE_LONG_TIME_LIMIT.unit &&
    timeLimit.count === BATTLE_LONG_TIME_LIMIT.count &&
    timeLimit.owner === undefined;
  return {
    ...kindDeclaration,
    ...(isBattleLong
      ? {}
      : {
          timeLimit:
            timeLimit === undefined
              ? null
              : {
                  unit: timeLimit.unit,
                  count: timeLimit.count,
                  ...(timeLimit.owner === undefined ? {} : { owner: timeLimit.owner }),
                },
        }),
    ...(duration?.consumption === undefined
      ? {}
      : {
          consumption: {
            kind: duration.consumption.kind,
            maxCount: duration.consumption.maxCount,
          },
        }),
  };
}

function triggeredOrderOf(events: readonly BattleDomainEvent[]): readonly string[] {
  return events
    .filter((event) => event.eventType === "MemoryTriggered")
    .map((event) => {
      const payload = event.payload as {
        readonly memoryDefinitionId: string;
        readonly triggeredEffectIndex: number;
      };
      return `${payload.memoryDefinitionId}#${payload.triggeredEffectIndex}`;
    });
}

/**
 * 実行ベース網羅監査（`-003`）が数える集合。ユニット効果軸と同じく、
 * `SKIPPED`/`MISSED`/`REJECTED`/`INTERRUPTED` は効果が一度も発現していないため
 * 数えない — 数えるとその定義やresolverが壊れていても監査を通してしまう。
 */
function executedActionIdsOf(events: readonly BattleDomainEvent[]): readonly string[] {
  return [
    ...new Set(
      events.flatMap((event) => {
        if (event.eventType !== "EffectActionCompleted") {
          return [];
        }
        const payload = event.payload as {
          readonly effectActionDefinitionId: string;
          readonly resultKind: string;
        };
        return payload.resultKind === "APPLIED" ? [payload.effectActionDefinitionId] : [];
      }),
    ),
  ].sort();
}

/**
 * EffectAction IDで整列する。付与順はどちらの陣営がMemoryを宣言したかで
 * 入れ替わるため（宣言側から見た`ALLY`は反対陣営の走査で先に現れる）、
 * 表とミラー比較を順序に依存させない。
 */
function sortedById<T extends { readonly effectActionDefinitionId: string }>(
  grants: readonly T[],
): readonly T[] {
  return [...grants].sort((left, right) =>
    left.effectActionDefinitionId.localeCompare(right.effectActionDefinitionId),
  );
}

/**
 * `MemoryTriggered` から次の `MemoryTriggered` までに発行された
 * `EffectActionCompleted` を、その `triggeredEffect` の適用順として拾う。
 * 解決スコープIDに依存しないため、`BattleStarted`・`TurnStarted` のどちらでも同じ形で読める。
 */
function actionOrderOf(events: readonly BattleDomainEvent[]): readonly MemoryActionOrder[] {
  const order: { triggeredEffectIndex: number; actionIds: string[] }[] = [];
  for (const event of events) {
    if (event.eventType === "MemoryTriggered") {
      const payload = event.payload as { readonly triggeredEffectIndex: number };
      order.push({ triggeredEffectIndex: payload.triggeredEffectIndex, actionIds: [] });
      continue;
    }
    if (event.eventType !== "EffectActionCompleted") {
      continue;
    }
    const current = order[order.length - 1];
    if (current === undefined) {
      continue;
    }
    const payload = event.payload as { readonly effectActionDefinitionId: string };
    // `EffectActionCompleted`は**対象1体につき1件**発行され、対象が複数ある
    // ACTION stepでは対象ごとに`actions`を一巡する（`MEM_ALWAYS_PICO_BESIDE_YOU#1`は
    // 6スロット×2アクションで12件になる）。ここで見たいのはEffectAction同士の
    // 前後関係なので初回の実行位置だけを残す — 何体へ当たったかは`grants.unitIds`が持つ。
    if (current.actionIds.includes(payload.effectActionDefinitionId)) {
      continue;
    }
    current.actionIds.push(payload.effectActionDefinitionId);
  }
  return order;
}

function targetSelectionsOf(
  snapshot: BattleCatalogSnapshot,
  memoryDefinitionId: string,
): readonly MemoryTargetSelection[] {
  return memoryFrom(snapshot, memoryDefinitionId).triggeredEffects.flatMap(
    (triggeredEffect, triggeredEffectIndex) =>
      triggeredEffect.effectSequence.targetBindings.map((binding) => ({
        triggeredEffectIndex,
        kind: binding.selector.kind,
        ...(binding.selector.side === undefined ? {} : { side: binding.selector.side }),
        ...(binding.selector.count === undefined ? {} : { count: binding.selector.count }),
        filters: binding.selector.filters ?? [],
      })),
  );
}

function grantsOf(
  units: readonly BattleUnit[],
  snapshot: BattleCatalogSnapshot,
): readonly MemoryGrant[] {
  const grants = new Map<string, { unitIds: string[]; magnitude: number; sourceSide: Side }>();
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const id = effect.effectActionDefinitionId as string;
      if (effect.sourceSide === undefined) {
        throw new Error(`memory-derived effect "${id}" has no sourceSide (R-MEM-04)`);
      }
      const existing = grants.get(id);
      if (existing === undefined) {
        grants.set(id, {
          unitIds: [unit.battleUnitId],
          magnitude: effect.magnitude,
          sourceSide: effect.sourceSide,
        });
        continue;
      }
      existing.unitIds.push(unit.battleUnitId);
    }
  }
  return sortedById(
    [...grants].map(([effectActionDefinitionId, grant]) => ({
      effectActionDefinitionId,
      unitIds: grant.unitIds,
      magnitude: grant.magnitude,
      sourceSide: grant.sourceSide,
      ...declarationOf(snapshot, effectActionDefinitionId),
    })),
  );
}

function markersOf(units: readonly BattleUnit[]): readonly MemoryMarkerGrant[] {
  const markers = new Map<
    string,
    { unitIds: string[]; stackCount: number; stackMax: number | null; sourceSide: Side }
  >();
  for (const unit of units) {
    for (const marker of unit.markerStates) {
      const id = marker.markerId as string;
      if (marker.sourceSide === undefined) {
        throw new Error(`memory-derived marker "${id}" has no sourceSide (R-MEM-04)`);
      }
      const existing = markers.get(id);
      if (existing === undefined) {
        markers.set(id, {
          unitIds: [unit.battleUnitId],
          stackCount: marker.stackCount,
          stackMax: marker.stackMax,
          sourceSide: marker.sourceSide,
        });
        continue;
      }
      existing.unitIds.push(unit.battleUnitId);
    }
  }
  return [...markers]
    .map(([markerId, marker]) => ({
      markerId,
      unitIds: marker.unitIds,
      stackCount: marker.stackCount,
      stackMax: marker.stackMax,
      sourceSide: marker.sourceSide,
    }))
    .sort((left, right) => left.markerId.localeCompare(right.markerId));
}

export function observeMemory(
  memoryDefinitionId: string,
  side: Side,
  overrides: MemoryBoardOverrides = {},
): MemoryObservation {
  const { created, recorder, snapshot } = createMemoryBattle(
    memoryDefinitionId,
    side,
    overrides,
    1,
  );
  const started = startBattle(created, new SequenceRandomSource([]), recorder);
  const units = [...started.allyUnits, ...started.enemyUnits];
  return {
    grants: grantsOf(units, snapshot),
    actionOrder: actionOrderOf(recorder.getEvents()),
    targetSelections: targetSelectionsOf(snapshot, memoryDefinitionId),
    markers: markersOf(units),
    triggeredOrder: triggeredOrderOf(recorder.getEvents()),
    executedActionIds: executedActionIdsOf(recorder.getEvents()),
    created,
    started,
    recorder,
  };
}

/** `advanceBattle` のターン開始解決スコープ1つ分だけを切り出した観測。 */
export interface MemoryTurnStartObservation {
  readonly turnNumber: number;
  readonly grants: readonly MemoryGrant[];
  readonly triggeredOrder: readonly string[];
  readonly executedActionIds: readonly string[];
}

export interface MemoryTurnObservation {
  /** ターンごとの、ターン開始解決スコープだけの観測（進めた順）。 */
  readonly turnStarts: readonly MemoryTurnStartObservation[];
  /** 全ターンを進めきったあとの戦闘。積み上がりを実効値で見るために使う。 */
  readonly battle: Battle;
}

/**
 * `TurnStarted` 発動の `triggeredEffect` を、実 `advanceBattle` を `turns` ターン
 * 回して観測する。
 *
 * `turnStarts` は**ターン開始の解決スコープへ閉じる** — `advanceBattle` は同じ
 * 呼び出しの中で行動フェーズまで進めるため、最終的なユニット状態を見ると
 * 行動フェーズの被弾で消費された効果（`consumption: NEXT_INCOMING_ATTACK` など）が
 * 消えており、「ターン開始時に何が配られたか」を表せない。`TurnStarted` イベント
 * 自身の `resolutionScopeId` に属する `EffectApplied` だけを拾うことで、
 * 配られた事実を行動フェーズの結果から切り離す。
 */
export function observeMemoryTurnStarts(
  memoryDefinitionId: string,
  side: Side,
  turns: number,
  overrides: MemoryBoardOverrides = {},
): MemoryTurnObservation {
  const { created, recorder, snapshot } = createMemoryBattle(
    memoryDefinitionId,
    side,
    overrides,
    turns,
  );
  let battle = startBattle(created, new SequenceRandomSource([]), recorder);
  for (let turn = 0; turn < turns; turn += 1) {
    battle = advanceBattle(battle, new SequenceRandomSource([]), recorder);
  }
  const turnStarts = recorder
    .getEvents()
    .filter((event) => event.eventType === "TurnStarted")
    .map((turnStarted) => {
      const scoped = recorder
        .getEvents()
        .filter((event) => event.resolutionScopeId === turnStarted.resolutionScopeId);
      const grants = new Map<string, { unitIds: string[]; magnitude: number; sourceSide: Side }>();
      for (const event of scoped) {
        if (event.eventType !== "EffectApplied") {
          continue;
        }
        const payload = event.payload as {
          readonly effectActionDefinitionId: string;
          readonly targetUnitId: string;
          readonly magnitude: number;
          readonly sourceSide?: Side;
        };
        if (payload.sourceSide === undefined) {
          throw new Error(
            `memory-derived effect "${payload.effectActionDefinitionId}" has no sourceSide (R-MEM-04)`,
          );
        }
        const existing = grants.get(payload.effectActionDefinitionId);
        if (existing === undefined) {
          grants.set(payload.effectActionDefinitionId, {
            unitIds: [payload.targetUnitId],
            magnitude: payload.magnitude,
            sourceSide: payload.sourceSide,
          });
          continue;
        }
        existing.unitIds.push(payload.targetUnitId);
      }
      return {
        turnNumber: turnStarted.turnNumber,
        grants: sortedById(
          [...grants].map(([effectActionDefinitionId, grant]) => ({
            effectActionDefinitionId,
            unitIds: grant.unitIds,
            magnitude: grant.magnitude,
            sourceSide: grant.sourceSide,
            ...declarationOf(snapshot, effectActionDefinitionId),
          })),
        ),
        triggeredOrder: triggeredOrderOf(scoped),
        executedActionIds: executedActionIdsOf(scoped),
      };
    });
  return { turnStarts, battle };
}

/**
 * 複数Memoryを**同時に**編成したときにだけ現れる性質の観測。単体では
 * `observeMemory`が見ている範囲に収まるが、跨Memoryの解決順（R-MEM-02）と
 * 同一ユニットへの重ね掛けはここでしか出ない。
 */
export interface CoDeclaredMemoryObservation {
  /** `MemoryTriggered` の発火順（`<memoryDefinitionId>#<triggeredEffectIndex>`）。 */
  readonly triggeredOrder: readonly string[];
  /**
   * 開始前から実際に変化した戦闘ステータス（戦闘ユニットID → stat → 変化後の値）。
   * 変化しなかったユニット・statはキーごと落ちるため、重ね掛けの実効値を
   * `toEqual`の完全一致で固定できる（`RATIO`と`FIXED`の取り違えもここで落ちる）。
   */
  readonly statChanges: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly stateBefore: BattleStateSnapshot;
  readonly stateAfter: BattleStateSnapshot;
  /** 開始前スナップショットへ`BattleStarted`以降のStateDeltaだけを当てた復元結果。 */
  readonly stateFromDeltas: BattleStateSnapshot;
}

/** 実効値の比較を浮動小数の最下位ビットに引きずられないよう、6桁で丸める。 */
function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function statChangesOf(
  created: Battle,
  started: Battle,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const before = new Map(
    [...created.allyUnits, ...created.enemyUnits].map((unit) => [
      unit.battleUnitId as string,
      unit.combatStats,
    ]),
  );
  const changes: Record<string, Record<string, number>> = {};
  for (const unit of [...started.allyUnits, ...started.enemyUnits]) {
    const baseline = before.get(unit.battleUnitId);
    if (baseline === undefined) {
      continue;
    }
    const changed: Record<string, number> = {};
    for (const stat of Object.keys(baseline) as (keyof CombatStats)[]) {
      if (rounded(unit.combatStats[stat]) !== rounded(baseline[stat])) {
        changed[stat] = rounded(unit.combatStats[stat]);
      }
    }
    if (Object.keys(changed).length > 0) {
      changes[unit.battleUnitId] = changed;
    }
  }
  return changes;
}

export function observeCoDeclaredMemories(
  memoriesBySide: MemoriesBySide,
  overrides: MemoryBoardOverrides = {},
): CoDeclaredMemoryObservation {
  const { created, recorder } = createMemoryBattleFor(memoriesBySide, overrides, 1);
  const started = startBattle(created, new SequenceRandomSource([]), recorder);
  const stateBefore = captureBattleState(created);
  return {
    triggeredOrder: triggeredOrderOf(recorder.getEvents()),
    statChanges: statChangesOf(created, started),
    stateBefore,
    stateAfter: captureBattleState(started),
    stateFromDeltas: reduceStateDeltas(
      stateBefore,
      recorder
        .getEvents()
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    ),
  };
}

function flipSlotOwner(unitId: string): string {
  return unitId.startsWith("ally:")
    ? `enemy:${unitId.slice("ally:".length)}`
    : `ally:${unitId.slice("enemy:".length)}`;
}

/** ALLY宣言時の観測を、ENEMY宣言時に期待される観測（陣営を入れ替えたもの）へ写す。 */
export function mirroredForEnemyDeclaration(
  grants: readonly MemoryGrant[],
): readonly MemoryGrant[] {
  return grants.map((grant) => ({
    ...grant,
    unitIds: grant.unitIds.map(flipSlotOwner),
    sourceSide: "ENEMY",
  }));
}

/** Marker側の同じ写像。 */
export function mirroredMarkersForEnemyDeclaration(
  markers: readonly MemoryMarkerGrant[],
): readonly MemoryMarkerGrant[] {
  return markers.map((marker) => ({
    ...marker,
    unitIds: marker.unitIds.map(flipSlotOwner),
    sourceSide: "ENEMY",
  }));
}
