import { clamp01, jaccard, titleTokens } from './normalize';
import type {
  Candidate,
  ProductSpec,
  ProvenanceVerdict,
  ScoreComponents,
  Weights,
} from './types';

/**
 * Deterministic scoring. No model anywhere in this file - the ranking has to be
 * reproducible across runs and explainable on stage, and once both sides are
 * structured, ranking is arithmetic.
 *
 * This lives in shared/ so the extension can re-rank locally when a weight
 * slider moves. Dragging a slider must never cost a round trip.
 */

export const DEFAULT_WEIGHTS: Weights = {
  equivalence: 0.45,
  canadian: 0.35,
  price: 0.20,
};

/** Unknown is deliberately neutral, not penalized. We do not punish honesty. */
const NEUTRAL = 0.5;

export function totalScore(c: ScoreComponents, w: Weights): number {
  const sum = w.equivalence + w.canadian + w.price;
  if (sum <= 0) return 0;
  const raw = w.equivalence * c.equivalence + w.canadian * c.canadian + w.price * c.price;
  return clamp01(raw / sum);
}

/** Re-rank an existing candidate list. Pure; returns a sorted copy. */
export function rank(candidates: Candidate[], weights: Weights): Candidate[] {
  return candidates
    .map((c) => ({ ...c, score: totalScore(c.components, weights) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * How interchangeable are these two products? A shared GTIN is proof, not a
 * guess, so it short-circuits to 1. Everything else is attribute overlap.
 */
export function equivalenceScore(
  original: { gtin: string | null; title: string; spec: ProductSpec | null },
  candidate: { gtin: string | null; title: string; category: string | null; attrs: Record<string, unknown> },
): number {
  if (original.gtin && candidate.gtin && original.gtin === candidate.gtin) return 1;

  const spec = original.spec;
  if (spec && candidate.category && spec.category !== candidate.category) return 0;

  // Hard constraints gate. A single violation disqualifies.
  if (spec) {
    for (const [key, want] of Object.entries(spec.hard)) {
      const got = candidate.attrs[key];
      if (got !== undefined && !looselyEqual(want, got)) return 0;
    }
  }

  const textual = jaccard(titleTokens(original.title), titleTokens(candidate.title));

  if (!spec) return clamp01(0.3 + 0.7 * textual);

  const softKeys = Object.keys(spec.soft);
  if (softKeys.length === 0) return clamp01(0.4 + 0.6 * textual);

  let matched = 0;
  let comparable = 0;
  for (const key of softKeys) {
    const got = candidate.attrs[key];
    if (got === undefined) continue;
    comparable++;
    matched += attributeSimilarity(spec.soft[key], got);
  }
  const attribute = comparable === 0 ? NEUTRAL : matched / comparable;
  return clamp01(0.6 * attribute + 0.4 * textual);
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function attributeSimilarity(want: unknown, got: unknown): number {
  if (typeof want === 'number' && typeof got === 'number') {
    if (want === 0 && got === 0) return 1;
    const ratio = Math.min(want, got) / Math.max(want, got || 1);
    // Within 15% reads as the same product to a shopper.
    return ratio >= 0.85 ? 1 : clamp01((ratio - 0.5) / 0.35);
  }
  return looselyEqual(want, got) ? 1 : 0;
}

/**
 * Weighted over the dimensions we could actually answer. Unanswered dimensions
 * are excluded from the denominator rather than scored as zero - absence of
 * evidence is not evidence of foreign ownership.
 */
export function canadianScore(p: ProvenanceVerdict): number | null {
  const dims: Array<[boolean | null, number]> = [
    [p.dimensions.canadianOwned.value, 0.40],
    [p.dimensions.madeInCanada.value, 0.30],
    [p.dimensions.hqInCanada.value, 0.20],
    [p.dimensions.canadianFounded.value, 0.10],
  ];
  let weighted = 0;
  let answered = 0;
  for (const [value, weight] of dims) {
    if (value === null) continue;
    answered += weight;
    if (value) weighted += weight;
  }
  if (answered === 0) return null;
  return clamp01(weighted / answered);
}

/** Share of the verdict backed by sourced evidence, 0..1. */
export function coverageScore(p: Pick<ProvenanceVerdict, 'dimensions'>): number {
  const values = Object.values(p.dimensions);
  const answered = values.filter((d) => d.value !== null).length;
  return values.length === 0 ? 0 : answered / values.length;
}

/** Cheaper or equal is full marks; 50% more expensive is zero. */
export function priceScore(originalCad: number | null, candidateCad: number | null): number {
  if (originalCad === null || candidateCad === null || originalCad <= 0) return NEUTRAL;
  if (candidateCad <= originalCad) return 1;
  const premium = (candidateCad - originalCad) / originalCad;
  return clamp01(1 - premium / 0.5);
}

export function componentsFor(args: {
  equivalence: number;
  provenance: ProvenanceVerdict;
  originalPriceCad: number | null;
  candidatePriceCad: number | null;
}): ScoreComponents {
  return {
    equivalence: args.equivalence,
    canadian: canadianScore(args.provenance) ?? NEUTRAL,
    price: priceScore(args.originalPriceCad, args.candidatePriceCad),
  };
}

/** Threshold for auto-expanding the overlay. Below this we stay collapsed. */
export const STRONG_MATCH_EQUIVALENCE = 0.8;

export function isStrongMatch(candidate: Candidate | undefined): boolean {
  return !!candidate && candidate.components.equivalence >= STRONG_MATCH_EQUIVALENCE;
}
