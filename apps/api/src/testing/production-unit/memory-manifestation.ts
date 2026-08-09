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
import type { Attribute, Role, UnitType } from "../../domain/catalog/definitions/catalog-enums.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { Side } from "../../domain/shared/side.js";
import { SequenceRandomSource } from "../random/sequence-random-source.js";
import {
  definitionsWith,
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
  /** R-MEM-04: `MemoryGrant.sourceSide`と同じ規約。 */
  readonly sourceSide: Side;
}

/**
 * 実`catalog/`のMemoryを片陣営が宣言した状態で`startBattle`を通し、
 * `BattleStarted`から配られた効果をEffectAction単位で観測する。
 * 効果を1件も受け取らなかったユニットは結果に現れない。
 */
export interface MemoryObservation {
  readonly grants: readonly MemoryGrant[];
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
}

function createMemoryBattle(
  memoryDefinitionId: string,
  side: Side,
  overrides: MemoryBoardOverrides,
  turnLimit: number,
): MemoryBattle {
  const snapshot: BattleCatalogSnapshot = loadProductionSnapshot(
    PRODUCTION_CATALOG_DIR,
    [],
    [memoryDefinitionId],
  );
  const memory = memoryFrom(snapshot, memoryDefinitionId);
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
            ALLY: side === "ALLY" ? [memory] : [],
            ENEMY: side === "ENEMY" ? [memory] : [],
          },
        },
      }),
    ),
    recorder: new EventRecorder(battleId),
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

function grantsOf(units: readonly BattleUnit[]): readonly MemoryGrant[] {
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
    })),
  );
}

function markersOf(units: readonly BattleUnit[]): readonly MemoryMarkerGrant[] {
  const markers = new Map<string, { unitIds: string[]; stackCount: number; sourceSide: Side }>();
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
      sourceSide: marker.sourceSide,
    }))
    .sort((left, right) => left.markerId.localeCompare(right.markerId));
}

export function observeMemory(
  memoryDefinitionId: string,
  side: Side,
  overrides: MemoryBoardOverrides = {},
): MemoryObservation {
  const { created, recorder } = createMemoryBattle(memoryDefinitionId, side, overrides, 1);
  const started = startBattle(created, new SequenceRandomSource([]), recorder);
  const units = [...started.allyUnits, ...started.enemyUnits];
  return {
    grants: grantsOf(units),
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
  const { created, recorder } = createMemoryBattle(memoryDefinitionId, side, overrides, turns);
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
          })),
        ),
        triggeredOrder: triggeredOrderOf(scoped),
        executedActionIds: executedActionIdsOf(scoped),
      };
    });
  return { turnStarts, battle };
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
