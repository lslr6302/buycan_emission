import type { ProductRef, ProductSpec } from '../../shared/types';
import type { AiCandidate, AiClient, AlternativeSearchInput, SanityVerdict } from './client';

/**
 * Gemini implementation. STUB - owned by whoever built the Gemini integration.
 *
 * Drop the real calls into the three marked methods. Nothing outside this file
 * needs to change: the pipeline already treats every output as untrusted and
 * runs it through pipeline/gates.ts before display.
 *
 * Activate with AI_BACKEND=gemini and GEMINI_API_KEY. The key is read here, on
 * the server, and never reaches the extension - a shipped extension is a zip
 * anyone can open, so it is not a place secrets can live.
 *
 * Prompting notes that are not negotiable, because they are the project thesis:
 *
 *   - Never ask the model who owns a brand. That is a database lookup.
 *     A model will answer confidently and wrongly, and cannot cite.
 *   - Never ask the model to rank or order candidates. Ranking is arithmetic
 *     in shared/scoring.ts so it is reproducible on stage and testable in the
 *     eval harness.
 *   - Always demand a real, resolvable product URL plus a source URL, and
 *     expect to throw away results that do not have them.
 *   - Instruct the model that returning nothing is a correct answer. The
 *     cost of an invented Canadian storefront is far higher than a miss.
 */
export class GeminiClient implements AiClient {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly model = 'gemini-2.0-flash',
  ) {}

  async healthy(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  /** TIER 5 extraction. Cached by productKey, so this runs once per product ever. */
  async extractSpec(_product: ProductRef): Promise<ProductSpec | null> {
    throw new NotImplemented('extractSpec');
  }

  /** Only called when the verified dataset returned nothing. */
  async searchAlternative(_input: AlternativeSearchInput): Promise<AiCandidate[]> {
    throw new NotImplemented('searchAlternative');
  }

  /** Yes/no veto on a top-3 candidate. A filter, never a ranker. */
  async sanityCheck(_original: ProductRef, _candidateTitle: string): Promise<SanityVerdict> {
    throw new NotImplemented('sanityCheck');
  }
}

export class NotImplemented extends Error {
  constructor(method: string) {
    super(
      `GeminiClient.${method}() is not implemented yet. ` +
        `Implement it in src/server/ai/gemini-client.ts, or run with AI_BACKEND=mock.`,
    );
    this.name = 'NotImplemented';
  }
}
