import { normalizeBrand } from '../../shared/normalize';
import type { BrandRecord, CfiaClass, Confidence, ProductSpec, Sourced } from '../../shared/types';
import { unknown } from '../../shared/types';
import type {
  AlternativeQuery,
  CatalogueItem,
  Repository,
  RetailerRecord,
} from './repository';

/**
 * TigerData (Postgres) implementation, mapped onto the real Tiger Cloud schema.
 *
 * The dataset is BRAND-level, not product-level:
 *
 *   brands               Canadian brands. Ownership facts are status_tags
 *                        ("Canadian-owned", "Not made in Canada", ...) with one
 *                        `sources` list per row and a `verification` level.
 *   us_brands            Brands people want to replace (trycanadian list).
 *   matches              Curated us_brand -> Canadian brand pairs.
 *   ownership_overrides  Team-researched ultimate owners. Beats status_tags.
 *
 * Consequences the rest of the pipeline should know about:
 *   - There are no products, prices, GTINs or retailers. A candidate is a
 *     Canadian BRAND, its URL is the brand website, and price is null (scored
 *     neutral). findByGtin and findCanadianRetailers have nothing to read.
 *   - Sources are per-row, not per-field, so every tag-derived field cites
 *     the row's first source. That is a real limitation of the dataset.
 *   - There is no spec_cache table; specs are cached in process memory rather
 *     than creating tables in a shared database.
 *
 * Takes a `SqlExecutor` rather than importing a driver, so this file does not
 * depend on `pg` directly; config.ts constructs the pool.
 */

/** Matches node-postgres' Pool.query, deliberately. */
export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Below this, a fuzzy name hit is more likely a different company than a typo. */
const FUZZY_MIN_SIMILARITY = 0.6;

const US_KEY_PREFIX = 'us:';

export class TigerRepository implements Repository {
  readonly name = 'tigerdata';

  private specCache = new Map<string, ProductSpec>();

  constructor(private readonly sql: SqlExecutor) {}

  async init(): Promise<void> {
    await this.sql.query('select 1 from brands limit 1');
  }

  async close(): Promise<void> {
    // Pool lifecycle belongs to whoever constructed it.
  }

  async healthy(): Promise<boolean> {
    try {
      await this.sql.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Canadian brands first, then the US list. Exact name match beats fuzzy, and
   * the fuzzy arm is held to a high similarity bar: linking a product to the
   * wrong company is worse than linking it to none.
   */
  async findBrand(rawBrand: string): Promise<BrandRecord | null> {
    const hit = await this.lookupBrand(rawBrand);
    if (!hit) return null;
    return hit.kind === 'ca' ? this.canadianBrand(hit.slug) : this.usBrand(hit.slug);
  }

  async findBrandsByKeys(keys: string[]): Promise<BrandRecord[]> {
    const out: BrandRecord[] = [];
    for (const key of keys) {
      const record = key.startsWith(US_KEY_PREFIX)
        ? await this.usBrand(key.slice(US_KEY_PREFIX.length))
        : await this.canadianBrand(key);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * The verified path: the product's brand is linked to a US brand, and the
   * curated matches for it are the alternatives. Without a linked US brand
   * there is nothing curated to offer, so this returns nothing rather than
   * guessing from the title.
   */
  async findAlternatives(query: AlternativeQuery): Promise<CatalogueItem[]> {
    if (!query.brand) return [];
    const hit = await this.lookupBrand(query.brand);
    if (!hit || hit.kind !== 'us') return [];

    const { rows } = await this.sql.query(
      `select m.id, m.us_product_name, m.canadian_product_name, m.coverage,
              m.match_verified, b.slug, b.name, b.website
         from matches m
         join brands b on b.slug = m.brand_slug
        where m.us_slug = $1
        order by m.match_verified desc,
                 case m.coverage when 'Broad coverage' then 0
                                 when 'Partial coverage' then 1
                                 when 'Niche coverage' then 2 else 3 end,
                 case b.verification when 'Verified' then 0
                                     when 'Partially verified' then 1 else 2 end,
                 b.name
        limit $2`,
      [hit.slug, query.limit],
    );

    return rows.map((r) => {
      const website = text(r.website);
      return {
        id: `match:${String(r.id)}`,
        title: text(r.canadian_product_name) || String(r.name),
        brand: String(r.name),
        brandKey: String(r.slug),
        url: website ?? '',
        retailer: website ? hostnameOf(website) : String(r.name),
        retailerCanadianOwned: null,
        priceCad: null,
        priceChecked: null,
        // The match itself is the curated equivalence claim. The dataset's
        // categories ("Personal Care") are not the spec vocabulary ("hair
        // care"), and a mismatch there would zero the equivalence score.
        category: null,
        attrs: {},
        massKg: null,
        gtin: null,
        shipsFrom: null,
        similarity: null,
      };
    });
  }

  /** The dataset carries no barcodes. */
  async findByGtin(_gtin: string): Promise<CatalogueItem[]> {
    return [];
  }

  /** The dataset has no retailer table. */
  async findCanadianRetailers(): Promise<RetailerRecord[]> {
    return [];
  }

  async getCachedSpec(key: string): Promise<ProductSpec | null> {
    return this.specCache.get(key) ?? null;
  }

  async putCachedSpec(key: string, spec: ProductSpec): Promise<void> {
    this.specCache.set(key, spec);
  }

  // --- lookups -----------------------------------------------------------

  private async lookupBrand(rawBrand: string): Promise<{ kind: 'ca' | 'us'; slug: string } | null> {
    const raw = rawBrand.trim().toLowerCase();
    const key = normalizeBrand(rawBrand);
    if (!key) return null;

    const { rows } = await this.sql.query(
      `select kind, slug, sim from (
         select 'ca' as kind, slug, greatest(similarity(lower(name), $1), similarity(lower(name), $2)) as sim
           from brands
          where lower(name) in ($1, $2) or lower(name) % $2
         union all
         select 'us' as kind, slug, greatest(similarity(lower(name), $1), similarity(lower(name), $2)) as sim
           from us_brands
          where lower(name) in ($1, $2) or lower(name) % $2
       ) hits
       where sim >= $3
       order by sim desc, kind asc
       limit 1`,
      [raw, key, FUZZY_MIN_SIMILARITY],
    );
    const row = rows[0];
    return row ? { kind: row.kind as 'ca' | 'us', slug: String(row.slug) } : null;
  }

  private async canadianBrand(slug: string): Promise<BrandRecord | null> {
    const { rows } = await this.sql.query(
      `select b.slug, b.name, b.status_tags, b.verification, b.sources, b.profile_url,
              o.owner_name, o.owner_country, o.source_url as owner_source
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where b.slug = $1`,
      [slug],
    );
    return rows[0] ? toCanadianBrandRecord(rows[0]) : null;
  }

  private async usBrand(slug: string): Promise<BrandRecord | null> {
    const { rows } = await this.sql.query(
      `select slug, name, profile_url from us_brands where slug = $1`,
      [slug],
    );
    return rows[0] ? toUsBrandRecord(rows[0]) : null;
  }
}

// --- row mapping -----------------------------------------------------------

/**
 * status_tags -> per-dimension facts. A tag answers its dimension; the absence
 * of a tag answers nothing. "Not X" tags are explicit negatives, which is why
 * those dimensions carry a non-CA marker rather than null.
 */
function toCanadianBrandRecord(row: Record<string, unknown>): BrandRecord {
  const tags = new Set((row.status_tags as string[] | null) ?? []);
  const source = firstSource(row.sources) ?? text(row.profile_url);
  const confidence = confidenceFor(text(row.verification));

  const tagged = (yes: string, no: string, unknownReason: string): Sourced<string> => {
    if (!source) return unknown<string>('value present but uncited');
    if (tags.has(yes)) return { value: 'CA', source, confidence };
    if (tags.has(no)) return { value: NOT_CANADA, source, confidence };
    return unknown<string>(unknownReason);
  };

  // Ownership: a team-researched override beats the tags.
  const ownerCountry = text(row.owner_country);
  const ownerSource = text(row.owner_source);
  let parent: Sourced<string>;
  let parentHq: Sourced<string>;
  if (ownerCountry && ownerSource) {
    parent = { value: text(row.owner_name), source: ownerSource, confidence: 'medium' };
    parentHq = { value: ownerCountry, source: ownerSource, confidence: 'medium' };
  } else {
    parent = unknown<string>('ultimate parent not recorded in the dataset');
    parentHq = tagged('Canadian-owned', 'Not Canadian-owned', 'ownership unconfirmed in the dataset');
  }

  const madeInCanada = tags.has('Partially made in Canada')
    ? unknown<string>('only partially made in Canada')
    : tagged('Made in Canada', 'Not made in Canada', 'manufacturing origin not recorded');

  return {
    key: String(row.slug),
    displayName: String(row.name),
    parent,
    parentHq,
    hqCountry: tagged('HQ in Canada', 'HQ not in Canada', 'HQ not recorded'),
    foundedIn: tagged('Canadian-founded', 'Not Canadian-founded', 'founding country not recorded'),
    mfgOrigin: madeInCanada,
    cfiaClass: tags.has('Product of Canada') ? ('Product of Canada' satisfies CfiaClass) : null,
    lastReviewed: '',
    // "HQ in Canada" without "Canadian-owned" is exactly what the dataset
    // calls unconfirmed. Inferring ownership from HQ here would overclaim.
    inferOwnershipFromHq: false,
  };
}

/**
 * Being on the US-brands list is the one fact we have, cited by its profile
 * page. Everything else stays unknown.
 */
function toUsBrandRecord(row: Record<string, unknown>): BrandRecord {
  const source = text(row.profile_url);
  const none = (reason: string) => unknown<string>(reason);
  return {
    key: `${US_KEY_PREFIX}${String(row.slug)}`,
    displayName: String(row.name),
    parent: none('ultimate parent not recorded in the dataset'),
    parentHq: source
      ? { value: 'US', source, confidence: 'medium' }
      : none('listed as a US brand, but uncited'),
    hqCountry: none('HQ not recorded'),
    foundedIn: none('founding country not recorded'),
    mfgOrigin: none('manufacturing origin not recorded'),
    cfiaClass: null,
    lastReviewed: '',
    inferOwnershipFromHq: false,
  };
}

/** Any value other than "CA" reads as a no in provenance.ts. */
const NOT_CANADA = 'not CA';

function confidenceFor(verification: string | null): Confidence {
  if (verification === 'Verified') return 'high';
  if (verification === 'Partially verified') return 'medium';
  return 'low';
}

/** First cited URL, minus the tracking parameters the scrape left behind. */
function firstSource(sources: unknown): string | null {
  if (!Array.isArray(sources)) return null;
  for (const entry of sources) {
    const url = text((entry as { url?: unknown } | null)?.url);
    if (url) return stripTracking(url);
  }
  return null;
}

function stripTracking(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (name.startsWith('utm_')) parsed.searchParams.delete(name);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
