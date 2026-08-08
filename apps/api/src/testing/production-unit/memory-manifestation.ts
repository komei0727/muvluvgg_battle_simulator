import { createBattle, startBattle } from "../../domain/battle/lifecycle/battle.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { createTurnLimit } from "../../domain/battle/model/turn-limit.js";
import { createBattleId } from "../../domain/shared/ids.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import type { CombatStats } from "../../domain/battle/model/starting-combat-stats.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { Role, UnitType } from "../../domain/catalog/definitions/catalog-enums.js";
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

const MEMORY_COMBAT_STATS: CombatStats = {
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

function slotUnitDefinition(slot: MemorySlot): UnitDefinition {
  return testUnitDefinition(slotUnitDefinitionId(slot), {
    role: slot.role,
    unitType: slot.unitType,
    positionAptitudes: ["FRONT", "BACK"],
  });
}

function slotBattleUnit(slot: MemorySlot, side: Side): BattleUnit {
  return testBattleUnit({
    battleUnitId: memoryUnitId(side, slot.key),
    unitDefinitionId: slotUnitDefinitionId(slot),
    side,
    position: slot.position,
    combatStats: MEMORY_COMBAT_STATS,
    limits: MEMORY_LIMITS,
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
 * 実`catalog/`のMemoryを片陣営が宣言した状態で`startBattle`を通し、
 * `BattleStarted`から配られた効果をEffectAction単位で観測する。
 * 効果を1件も受け取らなかったユニットは結果に現れない。
 */
export interface MemoryObservation {
  readonly grants: readonly MemoryGrant[];
  /**
   * `MemoryTriggered` の発火順（`<memoryDefinitionId>#<triggeredEffectIndex>`）。
   * R-MEM-02の解決順（API宣言順 → `triggeredEffects` 定義順）が、対象0件の
   * `triggeredEffect` を飛ばさずに現れることまで固定する。
   */
  readonly triggeredOrder: readonly string[];
  /** 実際に実行されたEffectAction ID（実行ベース網羅監査が使う）。 */
  readonly executedActionIds: readonly string[];
}

/** 付与結果だけが要る呼び出し向けの薄い入口。 */
export function observeMemoryGrants(
  memoryDefinitionId: string,
  side: Side,
): readonly MemoryGrant[] {
  return observeMemory(memoryDefinitionId, side).grants;
}

export function observeMemory(memoryDefinitionId: string, side: Side): MemoryObservation {
  const snapshot: BattleCatalogSnapshot = loadProductionSnapshot(
    PRODUCTION_CATALOG_DIR,
    [],
    [memoryDefinitionId],
  );
  const memory = memoryFrom(snapshot, memoryDefinitionId);
  const battleId = createBattleId("B_MEMORY");
  const battle = createBattle(
    battleId,
    MEMORY_SLOTS.map((slot) => slotBattleUnit(slot, "ALLY")),
    MEMORY_SLOTS.map((slot) => slotBattleUnit(slot, "ENEMY")),
    createTurnLimit(1),
    definitionsWith(snapshot, {
      units: MEMORY_SLOTS.map(slotUnitDefinition),
      overrides: {
        memoriesBySide: {
          ALLY: side === "ALLY" ? [memory] : [],
          ENEMY: side === "ENEMY" ? [memory] : [],
        },
      },
    }),
  );
  const recorder = new EventRecorder(battleId);
  const started = startBattle(battle, new SequenceRandomSource([]), recorder);
  const triggeredOrder = recorder
    .getEvents()
    .filter((event) => event.eventType === "MemoryTriggered")
    .map((event) => {
      const payload = event.payload as {
        readonly memoryDefinitionId: string;
        readonly triggeredEffectIndex: number;
      };
      return `${payload.memoryDefinitionId}#${payload.triggeredEffectIndex}`;
    });
  const executedActionIds = [
    ...new Set(
      recorder
        .getEvents()
        .filter((event) => event.eventType === "EffectActionCompleted")
        .map(
          (event) =>
            (event.payload as { readonly effectActionDefinitionId: string })
              .effectActionDefinitionId,
        ),
    ),
  ].sort();

  const grants = new Map<string, { unitIds: string[]; magnitude: number; sourceSide: Side }>();
  for (const unit of [...started.allyUnits, ...started.enemyUnits]) {
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
  // EffectAction IDで整列する。付与順はどちらの陣営がMemoryを宣言したかで
  // 入れ替わるため（宣言側から見た`ALLY`は反対陣営の走査で先に現れる）、
  // 表と`-002`のミラー比較を順序に依存させない。
  return {
    grants: [...grants]
      .map(([effectActionDefinitionId, grant]) => ({
        effectActionDefinitionId,
        unitIds: grant.unitIds,
        magnitude: grant.magnitude,
        sourceSide: grant.sourceSide,
      }))
      .sort((left, right) =>
        left.effectActionDefinitionId.localeCompare(right.effectActionDefinitionId),
      ),
    triggeredOrder,
    executedActionIds,
  };
}

/** ALLY宣言時の観測を、ENEMY宣言時に期待される観測（陣営を入れ替えたもの）へ写す。 */
export function mirroredForEnemyDeclaration(
  grants: readonly MemoryGrant[],
): readonly MemoryGrant[] {
  const flip = (unitId: string): string =>
    unitId.startsWith("ally:")
      ? `enemy:${unitId.slice("ally:".length)}`
      : `ally:${unitId.slice("enemy:".length)}`;
  return grants.map((grant) => ({
    ...grant,
    unitIds: grant.unitIds.map(flip),
    sourceSide: "ENEMY",
  }));
}
