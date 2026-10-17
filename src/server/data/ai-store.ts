/**
 * THE AI-DISCOVERY STORE. A second database, deliberately separate from the
 * curated one behind `Repository`.
 *
 * When the verified dataset has nothing and the AI fallback finds an
 * alternative that survives every gate, the provenance filter and the sanity
 * veto, it is written here so the next lookup for the same product does not
 * need the model at all.
 *
 * Kept apart from the main data on purpose:
 *   - Nothing here was reviewed by a person. Entries are served with
 *     origin 'ai' forever; they are never promoted to 'verified' by reuse.
 *   - The curated dataset stays read-only and is never polluted by model
 *     output. Promoting an entry is a human decision made elsewhere.
 *   - Entries expire. A product page that resolved last month may be gone or
 *     repriced, so a stale entry is dropped and the fallback re-runs.
 *
 * Provenance is NOT stored. It is looked up in the main dataset on every
 * read, so a correction there applies to AI discoveries immediately.
 */
export interface AiStore {
  /** Identifies itself in /v1/health and in diagnostics. */
  readonly name: string;

  init(): Promise<void>;
  healthy(): Promise<boolean>;

  /**
   * Fresh discoveries for this product: an exact product-key match, or the
   * same brand in the same spec category (a different size or listing of the
   * same item). Results still run provenance, ranking and the sanity veto.
   */
  find(query: AiStoreQuery): Promise<StoredAlternative[]>;

  /** Upsert on (productKey, url). Re-saving refreshes verifiedAt. */
  save(entries: StoredAlternativeInput[]): Promise<void>;
}

export interface AiStoreQuery {
  productKey: string;
  /** normalizeBrand() of the original product's brand. */
  brandKey: string | null;
  category: string | null;
  limit: number;
}

export interface StoredAlternativeInput {
  /** What the shopper was looking at. */
  productKey: string;
  originalBrandKey: string | null;
  originalTitle: string;
  originalSite: string;
  category: string | null;

  /** The alternative, as re-read from the retailer page by the gates. */
  url: string;
  title: string;
  brand: string | null;
  retailer: string;
  priceCad: number | null;
  gtin: string | null;
  massKg: number | null;
  sourceUrl: string;
  claim: string;
  /** Which AI backend found it, e.g. "gemini". */
  aiBackend: string;
}

export interface StoredAlternative extends StoredAlternativeInput {
  id: string;
  /** ISO date the gates last passed. */
  verifiedAt: string;
}

/** Past this, a discovery is re-searched rather than trusted. */
export const AI_STORE_TTL_DAYS = 30;

/** Process-local store, used with the mock dataset and in tests. */
export class MemoryAiStore implements AiStore {
  readonly name = 'memory';

  private entries = new Map<string, StoredAlternative>();
  private nextId = 1;

  async init(): Promise<void> {}

  async healthy(): Promise<boolean> {
    return true;
  }

  async find(query: AiStoreQuery): Promise<StoredAlternative[]> {
    const cutoff = Date.now() - AI_STORE_TTL_DAYS * 24 * 60 * 60 * 1000;
    return [...this.entries.values()]
      .filter((e) => Date.parse(e.verifiedAt) >= cutoff)
      .filter(
        (e) =>
          e.productKey === query.productKey ||
          (!!query.brandKey &&
            !!query.category &&
            e.originalBrandKey === query.brandKey &&
            e.category === query.category),
      )
      .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))
      .slice(0, query.limit);
  }

  async save(entries: StoredAlternativeInput[]): Promise<void> {
    for (const entry of entries) {
      const key = `${entry.productKey}|${entry.url}`;
      const id = this.entries.get(key)?.id ?? String(this.nextId++);
      this.entries.set(key, { ...entry, id, verifiedAt: new Date().toISOString() });
    }
  }
}
