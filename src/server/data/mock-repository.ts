import brandsSeed from './seed/brands.json';
import catalogueSeed from './seed/catalogue.json';
import retailersSeed from './seed/retailers.json';
import { jaccard, normalizeBrand, titleTokens } from '../../shared/normalize';
import type { BrandRecord, Confidence, ProductSpec, Sourced } from '../../shared/types';
import type {
  AlternativeQuery,
  CatalogueItem,
  Repository,
  RetailerRecord,
} from './repository';

/**
 * In-memory implementation over the seed files. Exists so the extension, the
 * pipeline and the UI can be built and demoed before the TigerData dataset is
 * connected, and so the eval harness has something deterministic to run on.
 *
 * Retrieval here is token overlap rather than embeddings. That is a stand-in
 * for the pgvector query the real repository will run, and it is why
 * `similarity` is reported as null - better an absent number than a fake one.
 */
export class MockRepository implements Repository {
  readonly name = 'mock(seed)';

  private brands = new Map<string, BrandRecord>();
  private items: CatalogueItem[] = [];
  private retailers: RetailerRecord[] = [];
  private specCache = new Map<string, ProductSpec>();

  async init(): Promise<void> {
    for (const raw of brandsSeed.brands) {
      const record = toBrandRecord(raw);
      this.brands.set(record.key, record);
      // Index the display name too, so entity linking hits on either spelling.
      this.brands.set(normalizeBrand(record.displayName), record);
    }
    this.items = catalogueSeed.items.map(toCatalogueItem);
    this.retailers = retailersSeed.retailers.map((r) => ({
      name: r.name,
      domain: r.domain,
      canadianOwned: r.canadianOwned,
      source: r.source,
      note: 'note' in r ? (r.note as string) : undefined,
    }));
  }

  async close(): Promise<void> {
    this.brands.clear();
    this.items = [];
  }

  async healthy(): Promise<boolean> {
    return this.items.length > 0;
  }

  async findBrand(rawBrand: string): Promise<BrandRecord | null> {
    const key = normalizeBrand(rawBrand);
    if (!key) return null;

    const exact = this.brands.get(key);
    if (exact) return exact;

    // Containment catches "green beaver canada" and "the green beaver company".
    for (const [candidateKey, record] of this.brands) {
      if (!candidateKey) continue;
      if (key.includes(candidateKey) || candidateKey.includes(key)) return record;
    }

    // Token overlap is the last resort before admitting we cannot link it.
    let best: { record: BrandRecord; score: number } | null = null;
    const keyTokens = titleTokens(key);
    for (const record of new Set(this.brands.values())) {
      const score = jaccard(keyTokens, titleTokens(record.displayName));
      if (score >= 0.6 && (!best || score > best.score)) best = { record, score };
    }
    return best?.record ?? null;
  }

  async findBrandsByKeys(keys: string[]): Promise<BrandRecord[]> {
    const out: BrandRecord[] = [];
    for (const key of keys) {
      const record = this.brands.get(normalizeBrand(key));
      if (record) out.push(record);
    }
    return out;
  }

  /** Seed brands carry no storefront domains, so this is always a miss. */
  async findBrandByDomain(): Promise<BrandRecord | null> {
    return null;
  }

  async findAlternatives(query: AlternativeQuery): Promise<CatalogueItem[]> {
    const queryTokens = titleTokens(query.text);

    const scored = this.items
      .filter((item) => (query.category ? item.category === query.category : true))
      .filter((item) => satisfiesHardConstraints(item, query.hard))
      .map((item) => ({ item, overlap: jaccard(queryTokens, titleTokens(item.title)) }));

    // With a category match, a zero-overlap title is still a legitimate
    // alternative - different brand, same thing. Without one, demand overlap.
    const usable = query.category ? scored : scored.filter((s) => s.overlap > 0.1);

    return usable
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, query.limit)
      .map((s) => ({ ...s.item, similarity: null }));
  }

  async findByGtin(gtin: string): Promise<CatalogueItem[]> {
    return this.items.filter((item) => item.gtin === gtin);
  }

  async findCanadianRetailers(): Promise<RetailerRecord[]> {
    return this.retailers.filter((r) => r.canadianOwned);
  }

  async getCachedSpec(key: string): Promise<ProductSpec | null> {
    return this.specCache.get(key) ?? null;
  }

  async putCachedSpec(key: string, spec: ProductSpec): Promise<void> {
    this.specCache.set(key, spec);
  }
}

function satisfiesHardConstraints(
  item: CatalogueItem,
  hard: Record<string, string | number | boolean>,
): boolean {
  for (const [key, want] of Object.entries(hard)) {
    const got = item.attrs[key];
    if (got === undefined) continue; // Silent on an attribute is not a violation.
    if (typeof want === 'string' && typeof got === 'string') {
      if (want.toLowerCase() !== got.toLowerCase()) return false;
    } else if (want !== got) {
      return false;
    }
  }
  return true;
}

// --- seed -> typed -------------------------------------------------------

interface RawSourced {
  value: string | null;
  source: string | null;
  confidence: string;
  reason?: string;
}

function toSourced(raw: RawSourced | undefined): Sourced<string> {
  if (!raw) return { value: null, source: null, confidence: 'low', reason: 'absent from seed data' };
  return {
    value: raw.value,
    source: raw.source,
    confidence: (raw.confidence as Confidence) ?? 'low',
    ...(raw.reason ? { reason: raw.reason } : {}),
  };
}

function toBrandRecord(raw: (typeof brandsSeed.brands)[number]): BrandRecord {
  return {
    key: raw.key,
    displayName: raw.displayName,
    parent: toSourced(raw.parent as RawSourced),
    parentHq: toSourced(raw.parentHq as RawSourced),
    hqCountry: toSourced(raw.hqCountry as RawSourced),
    foundedIn: toSourced(raw.foundedIn as RawSourced),
    mfgOrigin: toSourced(raw.mfgOrigin as RawSourced),
    listedCanadian: {
      value: toSourced(raw.hqCountry as RawSourced).value === 'CA',
      source: toSourced(raw.hqCountry as RawSourced).source,
      confidence: 'medium',
    },
    cfiaClass: (raw.cfiaClass as BrandRecord['cfiaClass']) ?? null,
    lastReviewed: raw.lastReviewed,
  };
}

function toCatalogueItem(raw: (typeof catalogueSeed.items)[number]): CatalogueItem {
  return {
    id: raw.id,
    title: raw.title,
    brand: raw.brand,
    brandKey: raw.brandKey,
    url: raw.url,
    retailer: raw.retailer,
    retailerCanadianOwned: raw.retailerCanadianOwned,
    priceCad: raw.priceCad,
    priceChecked: raw.priceChecked,
    category: raw.category,
    attrs: raw.attrs as unknown as Record<string, string | number | boolean>,
    massKg: raw.massKg,
    gtin: raw.gtin,
    shipsFrom: raw.shipsFrom,
    similarity: null,
    // The seed file is explicitly unverified placeholder data.
    verification: 'unverified',
  };
}
