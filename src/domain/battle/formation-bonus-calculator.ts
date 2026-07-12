import type { Attribute } from "../catalog/catalog-enums.js";
import { createPercentage, type Percentage } from "./percentage.js";

export interface FormationBonus {
  readonly attackBonus: Percentage;
  readonly hpBonus: Percentage;
  readonly defenseBonus: Percentage;
  readonly criticalRateBonus: Percentage;
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

/**
 * R-BON-02: evaluates every candidate assignment of the remaining Comical
 * members to a normal attribute and returns the highest-ranked resulting hand.
 */
function evaluateComicalCandidates(
  counts: ReadonlyMap<Attribute, number>,
  comicalCount: number,
): HandBonus {
  if (comicalCount === 0) {
    return rankHand(counts);
  }
  let best = NO_HAND;
  for (const attribute of NORMAL_ATTRIBUTES) {
    const candidateCounts = new Map(counts);
    candidateCounts.set(attribute, (candidateCounts.get(attribute) ?? 0) + 1);
    best = betterHand(best, evaluateComicalCandidates(candidateCounts, comicalCount - 1));
  }
  return best;
}

/**
 * R-BON-01/02: only judged when the formation has exactly 5 members; Clever
 * members are excluded from the pool, and Comical members are wildcards
 * evaluated across every possible normal-attribute assignment.
 */
function calculateNormalAttributeHand(attributes: readonly Attribute[]): HandBonus {
  if (attributes.length !== 5) {
    return NO_HAND;
  }
  const counts = new Map<Attribute, number>();
  let comicalCount = 0;
  for (const attribute of attributes) {
    if (attribute === "CLEVER") continue;
    if (attribute === "COMICAL") {
      comicalCount += 1;
      continue;
    }
    counts.set(attribute, (counts.get(attribute) ?? 0) + 1);
  }
  return evaluateComicalCandidates(counts, comicalCount);
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

function calculateCleverBonus(attributes: readonly Attribute[]): CleverBonus {
  const cleverCount = attributes.filter((attribute) => attribute === "CLEVER").length;
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

export function calculateFormationBonus(attributes: readonly Attribute[]): FormationBonus {
  const hand = calculateNormalAttributeHand(attributes);
  const clever = calculateCleverBonus(attributes);
  return {
    attackBonus: createPercentage(hand.attack + clever.attack),
    hpBonus: createPercentage(hand.hp + clever.hp),
    defenseBonus: createPercentage(clever.defense),
    criticalRateBonus: createPercentage(clever.criticalRate),
  };
}
