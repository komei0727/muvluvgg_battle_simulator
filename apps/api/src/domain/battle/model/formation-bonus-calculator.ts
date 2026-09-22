import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import { createPercentage, type Percentage } from "../../shared/percentage.js";

export interface FormationBonus {
  readonly attackBonus: Percentage;
  readonly hpBonus: Percentage;
  readonly defenseBonus: Percentage;
  readonly criticalRateBonus: Percentage;
}

/** R-ATR-03/R-BON-04: 編成ボーナス判定に使うユニット1体分のメイン・サブ属性。 */
export interface UnitAttributePair {
  readonly main: Attribute;
  readonly sub?: Attribute;
}

interface HandBonus {
  readonly attack: number;
  readonly hp: number;
}

/** R-BON-01: priority order, highest first. Index doubles as rank (lower = higher priority). */
const HAND_PRIORITY: readonly HandBonus[] = [
  { attack: 0.25, hp: 0.25 }, // five card
  { attack: 0.15, hp: 0.2 }, // four card
  { attack: 0.15, hp: 0.15 }, // full house
  { attack: 0.1, hp: 0.1 }, // three card
  { attack: 0, hp: 0 }, // no role
];
const NO_HAND = HAND_PRIORITY[4]!;

function handRank(hand: HandBonus): number {
  return HAND_PRIORITY.findIndex((h) => h.attack === hand.attack && h.hp === hand.hp);
}

function betterHand(a: HandBonus, b: HandBonus): HandBonus {
  return handRank(a) <= handRank(b) ? a : b;
}

/** R-BON-01: judges the highest hand for a fixed (non-Comical) attribute count map. */
function rankHand(counts: ReadonlyMap<Attribute, number>): HandBonus {
  let max = 0;
  let secondMax = 0;
  for (const count of counts.values()) {
    if (count > max) {
      secondMax = max;
      max = count;
    } else if (count > secondMax) {
      secondMax = count;
    }
  }
  if (max >= 5) return HAND_PRIORITY[0]!;
  if (max >= 4) return HAND_PRIORITY[1]!;
  if (max === 3 && secondMax === 2) return HAND_PRIORITY[2]!;
  if (max === 3) return HAND_PRIORITY[3]!;
  return NO_HAND;
}

/** R-BON-02: attributes Comical can be assigned as, excluding Comical and Clever themselves. */
const NORMAL_ATTRIBUTES: readonly Attribute[] = ["AGGRESSIVE", "SHY", "CUTE", "SMART"];

function incrementCount(
  counts: ReadonlyMap<Attribute, number>,
  attribute: Attribute,
): ReadonlyMap<Attribute, number> {
  const next = new Map(counts);
  next.set(attribute, (next.get(attribute) ?? 0) + 1);
  return next;
}

/**
 * R-BON-04: a member's candidate attributes for hand-ranking purposes — its
 * main attribute plus its sub attribute (if present and distinct), excluding
 * Clever from either (Clever never joins the hand pool, R-BON-03).
 */
function handCandidates(unit: UnitAttributePair): readonly Attribute[] {
  const candidates: Attribute[] = [];
  if (unit.main !== "CLEVER") {
    candidates.push(unit.main);
  }
  if (unit.sub !== undefined && unit.sub !== "CLEVER" && unit.sub !== unit.main) {
    candidates.push(unit.sub);
  }
  return candidates;
}

/**
 * R-BON-02/R-BON-04: evaluates every candidate assignment — each member
 * contributes its main attribute, its sub attribute, or (if either resolves
 * to Comical) any of the four normal attributes as a wildcard — and returns
 * the highest-ranked resulting hand. A member with no hand-eligible candidate
 * (Clever on both main and sub) is skipped, same as the original Clever
 * exclusion.
 */
function evaluateUnitCandidates(
  units: readonly UnitAttributePair[],
  index: number,
  counts: ReadonlyMap<Attribute, number>,
): HandBonus {
  if (index === units.length) {
    return rankHand(counts);
  }
  const candidates = handCandidates(units[index]!);
  if (candidates.length === 0) {
    return evaluateUnitCandidates(units, index + 1, counts);
  }
  let best = NO_HAND;
  for (const candidate of candidates) {
    if (candidate === "COMICAL") {
      for (const normalAttribute of NORMAL_ATTRIBUTES) {
        const nextCounts = incrementCount(counts, normalAttribute);
        best = betterHand(best, evaluateUnitCandidates(units, index + 1, nextCounts));
      }
    } else {
      const nextCounts = incrementCount(counts, candidate);
      best = betterHand(best, evaluateUnitCandidates(units, index + 1, nextCounts));
    }
  }
  return best;
}

/**
 * R-BON-01/02/R-BON-04: only judged when the formation has exactly 5
 * members. Each member's main and sub attribute both enter the candidate
 * search (`evaluateUnitCandidates`), and the highest-ranked hand across every
 * combination is adopted.
 */
function calculateNormalAttributeHand(units: readonly UnitAttributePair[]): HandBonus {
  if (units.length !== 5) {
    return NO_HAND;
  }
  return evaluateUnitCandidates(units, 0, new Map());
}

interface CleverStage {
  readonly threshold: number;
  readonly attack: number;
  readonly hp: number;
  readonly defense: number;
  readonly criticalRate: number;
}

/** R-BON-03: every stage the Clever count reaches is accumulated, not just the highest. */
const CLEVER_STAGES: readonly CleverStage[] = [
  { threshold: 1, attack: 0, hp: 0, defense: 0.3, criticalRate: 0 },
  { threshold: 2, attack: 0.1, hp: 0.1, defense: 0, criticalRate: 0 },
  { threshold: 3, attack: 0, hp: 0, defense: 0, criticalRate: 0.15 },
  { threshold: 4, attack: 0.15, hp: 0.15, defense: 0, criticalRate: 0 },
  { threshold: 5, attack: 0.25, hp: 0.25, defense: 0, criticalRate: 0 },
];

interface CleverBonus {
  readonly attack: number;
  readonly hp: number;
  readonly defense: number;
  readonly criticalRate: number;
}

/** R-BON-03/R-BON-04: a member counts toward Clever if either its main or sub attribute is Clever. */
function calculateCleverBonus(units: readonly UnitAttributePair[]): CleverBonus {
  const cleverCount = units.filter(
    (unit) => unit.main === "CLEVER" || unit.sub === "CLEVER",
  ).length;
  const reached = CLEVER_STAGES.filter((stage) => cleverCount >= stage.threshold);
  return reached.reduce<CleverBonus>(
    (acc, stage) => ({
      attack: acc.attack + stage.attack,
      hp: acc.hp + stage.hp,
      defense: acc.defense + stage.defense,
      criticalRate: acc.criticalRate + stage.criticalRate,
    }),
    { attack: 0, hp: 0, defense: 0, criticalRate: 0 },
  );
}

export function calculateFormationBonus(units: readonly UnitAttributePair[]): FormationBonus {
  const hand = calculateNormalAttributeHand(units);
  const clever = calculateCleverBonus(units);
  return {
    attackBonus: createPercentage(hand.attack + clever.attack),
    hpBonus: createPercentage(hand.hp + clever.hp),
    defenseBonus: createPercentage(clever.defense),
    criticalRateBonus: createPercentage(clever.criticalRate),
  };
}
