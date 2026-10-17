/**
 * Shared vocabulary for the extension and the API. Nothing in here knows which
 * storefront a product came from, or where the ownership data is stored.
 */

export type Confidence = 'high' | 'medium' | 'low';

export type ExtractionTier = 'jsonld' | 'microdata' | 'opengraph' | 'adapter' | 'llm';

/**
 * Principle 1: never state a fact without a source. A value with no source is
 * not a claim, it is a `null` with a reason attached.
 */
export interface Sourced<T> {
  value: T | null;
  source: string | null;
  confidence: Confidence;
  /** Why the value is null. Required whenever it is. */
  reason?: string;
}

export function unknown<T>(reason: string): Sourced<T> {
  return { value: null, source: null, confidence: 'low', reason };
}

export function sourced<T>(value: T, source: string, confidence: Confidence = 'high'): Sourced<T> {
  return { value, source, confidence };
}

export interface Money {
  amount: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Normalized product reference. Every extractor emits this shape. */
export interface ProductRef {
  site: string;
  siteId: string | null;
  url: string;
  title: string;
  brand: string | null;
  /** Normalized to 14 digits. The only key that crosses storefronts. */
  gtin: string | null;
  price: Money | null;
  categoryHint: string | null;
  imageUrl: string | null;
  massKg: number | null;
  extraction: { tier: ExtractionTier; confidence: Confidence };
}

/** Output of the one genuine LLM parse. Cached by stable product key. */
export interface ProductSpec {
  category: string;
  /** Gate retrieval. A mismatch disqualifies a candidate outright. */
  hard: Record<string, string | number | boolean>;
  /** Score retrieval. A mismatch costs points. */
  soft: Record<string, string | number | boolean>;
  originRegion: string | null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type CfiaClass = 'Product of Canada' | 'Made in Canada' | 'Prepared in Canada';

export interface BrandRecord {
  key: string;
  displayName: string;
  /** Ultimate parent, not immediate. Principle 4. */
  parent: Sourced<string>;
  parentHq: Sourced<string>;
  hqCountry: Sourced<string>;
  foundedIn: Sourced<string>;
  mfgOrigin: Sourced<string>;
  cfiaClass: CfiaClass | null;
  lastReviewed: string;
  /**
   * Whether a brand with no identified parent but a Canadian HQ may be read as
   * Canadian-owned. Defaults to true; a dataset that tracks ownership
   * explicitly sets false so "unconfirmed" stays unknown.
   */
  inferOwnershipFromHq?: boolean;
}

/**
 * Principle 3: "Canadian" is never one boolean. Each dimension is answered
 * separately and can independently be unknown.
 */
export interface ProvenanceVerdict {
  brandKey: string | null;
  displayName: string;
  dimensions: {
    canadianOwned: Sourced<boolean>;
    canadianFounded: Sourced<boolean>;
    hqInCanada: Sourced<boolean>;
    madeInCanada: Sourced<boolean>;
  };
  ultimateParent: Sourced<string>;
  cfiaClass: CfiaClass | null;
  /** 0..1 over the dimensions we could answer. Null when we answered none. */
  canadianScore: number | null;
  /** How much of the verdict rests on evidence, 0..1. */
  coverage: number;
  summary: string;
  /** True when we have nothing sourced to say. Renders as "Unknown". */
  isUnknown: boolean;
}

// ---------------------------------------------------------------------------
// Candidates and scoring
// ---------------------------------------------------------------------------

export type CandidateOrigin = 'verified' | 'ai';

export type MatchType = 'gtin_exact' | 'equivalent' | 'retailer_swap';

export interface Weights {
  equivalence: number;
  canadian: number;
  price: number;
}

/** Sub-scores travel with the candidate so the client can re-rank offline. */
export interface ScoreComponents {
  equivalence: number;
  canadian: number;
  price: number;
}

export interface Candidate {
  id: string;
  /** Verified dataset or AI fallback. Must be visually distinct in the UI. */
  origin: CandidateOrigin;
  matchType: MatchType;
  title: string;
  brand: string | null;
  url: string;
  retailer: string;
  retailerCanadianOwned: boolean | null;
  priceCad: number | null;
  priceChecked: string | null;
  gtin: string | null;
  massKg: number | null;
  shipsFrom: string | null;
  provenance: ProvenanceVerdict;
  components: ScoreComponents;
  /** Recomputed client-side whenever the weight sliders move. */
  score: number;
  /** Mandatory for AI-origin candidates. */
  sourceUrl: string | null;
  /** Human-readable reason this was surfaced, shown under the card. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface ResolveRequest {
  product: ProductRef;
  weights?: Weights;
  /** Skip the AI fallback. Used by the eval harness for reproducible runs. */
  verifiedOnly?: boolean;
  /**
   * The "product" was synthesised from a search box, so its title is a query
   * and not a listing. Brand recovery must not run on it.
   */
  fromSearch?: boolean;
  destinationRegion?: string | null;
}

export type AbstentionReason =
  | 'no_canadian_alternative'
  | 'category_out_of_scope'
  | 'insufficient_product_data'
  | 'all_candidates_failed_validation';

/**
 * What the product in front of the user already is. Drives whether we offer
 * alternatives at all - there is no point suggesting a Canadian option for
 * something that is already Canadian-owned.
 *
 * `mixed` is deliberately its own state rather than being folded into
 * `canadian`. A Canadian-founded brand with a foreign parent still sends the
 * money abroad, so it gets the nuance AND the alternatives.
 */
export type OwnStatus = 'canadian' | 'mixed' | 'foreign' | 'unknown';

export interface ResolveResponse {
  key: string;
  product: ProductRef;
  spec: ProductSpec | null;
  provenance: ProvenanceVerdict;
  ownStatus: OwnStatus;
  /** True when ownStatus is 'canadian'. No alternatives are retrieved. */
  alreadyCanadian: boolean;
  candidates: Candidate[];
  /** True when we have nothing to offer. The overlay stays hidden. */
  abstained: boolean;
  abstentionReason: AbstentionReason | null;
  /** Shown when the user clicks the toolbar icon on an abstained page. */
  abstentionMessage: string | null;
  diagnostics: ResolveDiagnostics;
}

export interface ResolveDiagnostics {
  extractionTier: ExtractionTier;
  brandLinked: boolean;
  verifiedCandidates: number;
  aiCandidates: number;
  aiCandidatesRejected: number;
  rejections: GateRejection[];
  elapsedMs: number;
  dataSource: string;
  /** Which AI backend answered. "mock" means the fallback is a stub. */
  aiSource: string;
}

export interface GateRejection {
  gate: string;
  url: string;
  detail: string;
}

export interface CartLine {
  product: ProductRef;
  qty: number;
}

export interface CartRequest {
  site: string;
  lines: CartLine[];
  weights?: Weights;
  verifiedOnly?: boolean;
  destinationRegion?: string | null;
}

export interface CartLineAnalysis {
  line: CartLine;
  provenance: ProvenanceVerdict;
  /** qty * unit price, in CAD. */
  lineTotalCad: number | null;
  /** Where this line's money goes. */
  flow: 'stays_in_canada' | 'leaves_canada' | 'unknown';
  bestSwap: Candidate | null;
  abstained: boolean;
}

export interface CartAnalysis {
  currency: 'CAD';
  totalCad: number;
  staysInCanadaCad: number;
  leavesCanadaCad: number;
  unknownCad: number;
  swapCount: number;
  /** Positive means the swaps cost more. */
  swapPriceDeltaCad: number;
  afterSwapStaysInCanadaCad: number;
  lines: CartLineAnalysis[];
  headline: string;
  diagnostics: { linesAnalyzed: number; abstentions: number; elapsedMs: number };
}
