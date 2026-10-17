import type { ProductRef, ProductSpec } from '../../shared/types';

/**
 * THE AI SEAM.
 *
 * Three calls, three jobs, each one narrow on purpose:
 *
 *   extractSpec     - parse messy listing text into a structured spec
 *   searchAlternative - web-grounded search, used ONLY when the verified
 *                     dataset came up empty
 *   sanityCheck     - yes/no veto on a top candidate
 *
 * What is deliberately absent: anything that ranks, and anything that recalls
 * ownership. Ranking is arithmetic (shared/scoring.ts) because it has to be
 * reproducible on stage. Ownership is a database lookup because models
 * approximate facts and cannot cite.
 *
 * Whoever owns the Gemini integration implements this interface and nothing
 * else. Every output is treated as untrusted and runs the gates in
 * pipeline/gates.ts before it reaches a user.
 */
export interface AiClient {
  readonly name: string;
  healthy(): Promise<boolean>;

  extractSpec(product: ProductRef): Promise<ProductSpec | null>;

  /**
   * Must return real, resolvable product URLs. Fabricated storefronts are the
   * expected failure mode, so every result is validated before display -
   * callers must not trust this output.
   */
  searchAlternative(input: AlternativeSearchInput): Promise<AiCandidate[]>;

  /** "Would a shopper buying X reasonably accept Y?" A filter, never a ranker. */
  sanityCheck(original: ProductRef, candidateTitle: string): Promise<SanityVerdict>;
}

export interface AlternativeSearchInput {
  product: ProductRef;
  spec: ProductSpec | null;
  /** How many to ask for before validation culls them. */
  limit: number;
}

export interface AiCandidate {
  title: string;
  brand: string | null;
  /** Direct product URL. A search page or a homepage fails the gates. */
  url: string;
  retailer: string | null;
  priceCad: number | null;
  /** Mandatory. A candidate with no citation is discarded, not downgraded. */
  sourceUrl: string | null;
  claim: string;
}

export interface SanityVerdict {
  acceptable: boolean;
  reason: string;
}

/** Used when no AI backend is configured. Abstains rather than inventing. */
export class NullAiClient implements AiClient {
  readonly name = 'null';
  async healthy(): Promise<boolean> {
    return false;
  }
  async extractSpec(): Promise<ProductSpec | null> {
    return null;
  }
  async searchAlternative(): Promise<AiCandidate[]> {
    return [];
  }
  async sanityCheck(): Promise<SanityVerdict> {
    return { acceptable: true, reason: 'no ai backend configured; veto skipped' };
  }
}
