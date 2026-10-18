import { normalizeBrand, titleTokens } from '../../shared/normalize';
import { requiredNouns } from '../pipeline/storefront';
import { clamp01 } from '../../shared/normalize';
import type { BrandRecord, Confidence, ProductSpec, Sourced } from '../../shared/types';
import type {
  AlternativeQuery,
  CatalogueItem,
  Repository,
  RetailerRecord,
} from './repository';

/**
 * TigerData (Postgres) implementation, written against the live schema.
 *
 * IMPORTANT - this dataset is BRAND-level, not product-level:
 *
 *   us_brands (1250)   the foreign brand on the page
 *   matches   (2431)   us_slug -> brand_slug, with coverage + verification
 *   brands    (1404)   the Canadian alternative, with status_tags + sources
 *   ownership_overrides (5)  foreign owners of Canadian-looking brands
 *
 * There are no SKUs, prices, barcodes or embeddings. So:
 *
 *   - price scoring is inert (every candidate price is null -> neutral)
 *   - the GTIN retailer-swap path cannot fire
 *   - equivalence comes from the dataset's own `coverage` and `match_verified`
 *     columns rather than from attribute overlap, and is returned as
 *     `similarity` so the pipeline uses it instead of comparing titles
 *
 * That last point matters: a Canadian alternative is a *different product*,
 * so token overlap between "Dove Body Wash" and "Crate 61 Organics" is ~0.
 * Curated coverage is a far better signal than anything we could compute.
 */

export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Exact tag strings as they appear in brands.status_tags. */
const TAG = {
  owned: 'Canadian-owned',
  notOwned: 'Not Canadian-owned',
  founded: 'Canadian-founded',
  notFounded: 'Not Canadian-founded',
  hq: 'HQ in Canada',
  notHq: 'HQ not in Canada',
  made: 'Made in Canada',
  notMade: 'Not made in Canada',
  partlyMade: 'Partially made in Canada',
  notPartlyMade: 'Not partially made in Canada',
  productOf: 'Product of Canada',
  notProductOf: 'Not a Product of Canada',
} as const;

/**
 * Quality floor for a row to be shown. The matches table carries a long tail
 * of stub rows - no website, no status tags, unverified - which are worse
 * than nothing, because a link we cannot resolve is exactly the failure the
 * project exists to avoid.
 */
const QUALITY_FILTER = `b.website is not null and cardinality(b.status_tags) > 0`;

/**
 * Minimum trigram similarity for a fuzzy brand match. pg_trgm's default of
 * 0.3 is far too loose for short brand names - "Dove" reaches it against
 * "Dove Men+Care" - and a wrong brand produces a confidently wrong verdict,
 * which is worse than no answer at all.
 */
const FUZZY_BRAND_THRESHOLD = 0.6;

/**
 * Our internal categories mapped onto the ones the brands table uses.
 *
 * Without this the free-text search ranges over all 1404 brands, and a
 * search for "heads and shoulders" returns an insurance company because the
 * loose OR query matched "head" inside "head office". A wrong answer that
 * confident is worse than no answer at all.
 */
const CATEGORY_MAP: Record<string, string[]> = {
  personal_care_hair: ['Personal Care'],
  personal_care_body_wash: ['Personal Care'],
  personal_care_oral: ['Personal Care'],
  personal_care_deodorant: ['Personal Care'],
  personal_care_lotion: ['Personal Care'],
  supplements_vitamin_d: ['Personal Care', 'Groceries'],
  snacks_chips: ['Groceries', 'Food & Drink'],
  pantry_coffee: ['Groceries', 'Food & Drink'],
  pantry_condiments: ['Groceries', 'Food & Drink'],
  home_cleaning_laundry: ['Household'],
  apparel_basics_tee: ['Clothing'],
  insulated_drinkware: ['Home & Garden', 'Shopping'],
  electronics_peripherals: ['Technology'],
};

/**
 * Never returned for a physical-product search, whatever the words match.
 * Nobody shopping for shampoo wants a bank.
 */
const SERVICE_CATEGORIES = [
  'Financial Services',
  'Business Services',
  'Travel',
  'Automotive',
  'Entertainment',
];

export class TigerRepository implements Repository {
  readonly name = 'tigerdata';

  constructor(private readonly sql: SqlExecutor) {}

  async init(): Promise<void> {
    await this.sql.query('select 1');
  }

  async close(): Promise<void> {
    // The pool belongs to whoever constructed it.
  }

  async healthy(): Promise<boolean> {
    try {
      await this.sql.query('select 1 from brands limit 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A brand on a page can be either side of this dataset: a Canadian brand
   * (in `brands`) or a foreign one someone wants an alternative to (in
   * `us_brands`). Check Canadian first - it carries far more evidence.
   */
  async findBrand(rawBrand: string): Promise<BrandRecord | null> {
    const name = rawBrand.trim();
    if (name.length < 2) return null;

    // Order matters, and getting it wrong is subtle. An exact hit on either
    // table must beat a fuzzy hit on the other: "Dove" trigram-matches the
    // stub row "Dove Men+Care" in the Canadian table at 0.36, which would
    // otherwise outrank the exact "Dove" in us_brands and report a
    // Unilever brand as an unverified Canadian one.
    const exactCanadian = await this.sql.query(
      `select b.*, o.owner_name, o.owner_country, o.note as owner_note,
              o.source_url as owner_source, o.team_confirmed
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where lower(b.name) = lower($1)
        order by cardinality(b.status_tags) desc
        limit 1`,
      [name],
    );
    if (exactCanadian.rows[0]) return this.canadianBrandRecord(exactCanadian.rows[0]);

    const exactForeign = await this.sql.query(
      `select * from us_brands where lower(name) = lower($1) limit 1`,
      [name],
    );
    if (exactForeign.rows[0]) return this.foreignBrandRecord(exactForeign.rows[0]);

    // Fuzzy, and only over rows carrying actual evidence. A stub with no
    // status tags cannot answer any question we care about, so matching it
    // is strictly worse than returning "unknown".
    const fuzzyCanadian = await this.sql.query(
      `select b.*, o.owner_name, o.owner_country, o.note as owner_note,
              o.source_url as owner_source, o.team_confirmed,
              similarity(lower(b.name), lower($1)) as sim
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where lower(b.name) % lower($1)
          and cardinality(b.status_tags) > 0
          and similarity(lower(b.name), lower($1)) >= $2
        order by sim desc
        limit 1`,
      [name, FUZZY_BRAND_THRESHOLD],
    );
    if (fuzzyCanadian.rows[0]) return this.canadianBrandRecord(fuzzyCanadian.rows[0]);

    const fuzzyForeign = await this.sql.query(
      `select *, similarity(lower(name), lower($1)) as sim
         from us_brands
        where lower(name) % lower($1)
          and similarity(lower(name), lower($1)) >= $2
        order by sim desc
        limit 1`,
      [name, FUZZY_BRAND_THRESHOLD],
    );
    if (fuzzyForeign.rows[0]) return this.foreignBrandRecord(fuzzyForeign.rows[0]);

    return null;
  }

  /**
   * A brand recorded only under its product lines. The team added rows like
   * "Gay Lea Butter" and "Gay Lea Whipped Cream" but no plain "Gay Lea", so
   * the page's "Gay Lea" misses findBrand entirely. A row named
   * "<brand> <words>" counts only when every one of those words is in the
   * product title - the page IS that product line. Matching on the brand
   * alone read "Kraft" as Canadian through a "Kraft Real Mayo" row.
   *
   * Only rows with evidence or team entries; never bare stubs.
   */
  async findBrandByProductLine(rawBrand: string, title: string): Promise<BrandRecord | null> {
    const name = rawBrand.trim();
    if (name.length < 3) return null;
    const { rows } = await this.sql.query(
      `select b.*, o.owner_name, o.owner_country, o.note as owner_note,
              o.source_url as owner_source, o.team_confirmed
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where lower(b.name) like $1 escape '\\'
          and (cardinality(b.status_tags) > 0 or b.slug like 'team-%')
        order by length(b.name) desc
        limit 25`,
      [`${escapeLike(name.toLowerCase())} %`],
    );
    const titleWords = titleTokens(title);
    const brandWords = new Set(titleTokens(name));
    // Longest first, so "Gay Lea Real Whipped Cream" beats "Gay Lea Whipped Cream" when both fit.
    const row = rows.find((r) => {
      const rest = [...titleTokens(String(r['name'] ?? ''))].filter((w) => !brandWords.has(w));
      return rest.length > 0 && rest.every((w) => titleWords.has(w));
    });
    return row ? { ...this.canadianBrandRecord(row), displayName: name } : null;
  }

  async findBrandsByKeys(keys: string[]): Promise<BrandRecord[]> {
    if (keys.length === 0) return [];
    const { rows } = await this.sql.query(
      `select b.*, o.owner_name, o.owner_country, o.note as owner_note,
              o.source_url as owner_source, o.team_confirmed
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where b.slug = any($1)`,
      [keys],
    );
    return rows.map((r) => this.canadianBrandRecord(r));
  }

  /**
   * Two retrieval paths:
   *
   *   1. A brand was read off the page -> walk us_brands -> matches -> brands.
   *      This is the curated path and the one that produces good answers.
   *   2. No brand, e.g. a search-results page -> text search over Canadian
   *      brands by name, description and category.
   */
  async findBrandByDomain(domain: string): Promise<BrandRecord | null> {
    const host = domain.replace(/^www\./, '').toLowerCase();
    if (host.length < 4) return null;
    const { rows } = await this.sql.query(
      `select b.*, o.owner_name, o.owner_country, o.note as owner_note,
              o.source_url as owner_source, o.team_confirmed
         from brands b
         left join ownership_overrides o on o.brand_slug = b.slug
        where b.website is not null
          and replace(replace(lower(b.website), 'https://', ''), 'www.', '') like $1 || '%'
        limit 1`,
      [host],
    );
    return rows[0] ? this.canadianBrandRecord(rows[0]) : null;
  }

  async findAlternatives(query: AlternativeQuery): Promise<CatalogueItem[]> {
    const brand = query.brand?.trim();
    if (brand && brand.length >= 2) {
      const viaMatches = await this.alternativesForBrand(brand, query.limit);
      if (viaMatches.length > 0) return viaMatches;
    }
    const byText = await this.alternativesByText(query.text, query.limit, query.category);
    if (byText.length >= query.limit) return byText;

    // Top up from the category, do not merely fall back to it.
    //
    // A listing title is mostly words identifying the *product*, not the
    // kind of thing it is: "Grizzly Claw Blend, Ground 100% Arabica" has
    // one useful token. Matching on those terms surfaced a single brand out
    // of the 41 Canadian coffee companies in the directory - and because it
    // found *something*, a plain fallback would never have run.
    const byCategory = await this.alternativesByCategory(query.category, query.limit);
    const seen = new Set(byText.map((item) => item.id));
    return [...byText, ...byCategory.filter((item) => !seen.has(item.id))].slice(0, query.limit);
  }

  private async alternativesForBrand(brand: string, limit: number): Promise<CatalogueItem[]> {
    const { rows } = await this.sql.query(
      `with target as (
         select slug from us_brands
          where lower(name) = lower($1) or lower(name) % lower($1)
          order by (lower(name) = lower($1)) desc,
                   similarity(lower(name), lower($1)) desc
          limit 1
       )
       select b.*, m.coverage, m.match_verified, m.match_partial, m.notes,
              m.canadian_product_name, m.us_product_name,
              o.owner_name, o.owner_country, o.source_url as owner_source
         from matches m
         join target t on t.slug = m.us_slug
         join brands b on b.slug = m.brand_slug
         left join ownership_overrides o on o.brand_slug = b.slug
        where ${QUALITY_FILTER}
        order by m.match_verified desc,
                 case m.coverage
                   when 'Broad coverage' then 3
                   when 'Partial coverage' then 2
                   when 'Niche coverage' then 1
                   else 0 end desc,
                 b.verification = 'Verified' desc
        limit $2`,
      [brand, limit],
    );
    return rows.map((r) => this.toCatalogueItem(r));
  }

  /**
   * Search-results pages, where we have the user's words but no brand.
   *
   * Full-text search, not trigram. Trigram similarity between a two-word
   * query and a sentence-long description is near zero by construction -
   * "shampoo" scored 0 against four brands whose descriptions are literally
   * about shampoo. Stemming also earns its keep: "potato chips" finds a
   * description reading "kettle-style potato chip".
   *
   * The curated `matches` notes are searched too, because they describe what
   * a brand substitutes for in words the brand's own blurb may not use.
   */
  /**
   * Search by words, used on search-results pages and whenever a brand could
   * not be read off a product page.
   *
   * Two passes, because the two inputs are completely different shapes:
   *
   *   1. STRICT (`websearch_to_tsquery`, AND semantics) - right for what a
   *      user types, like "shampoo" or "laundry detergent".
   *   2. LOOSE (OR of the significant terms, ranked) - necessary for a real
   *      listing title. "Redken All Soft Shampoo, For Dry/Brittle Hair,
   *      Moisturizes & Provides" under AND requires every one of those words
   *      in a single brand description, which matches nothing, ever. Ranking
   *      is what keeps OR from returning noise.
   */
  private async alternativesByText(
    text: string,
    limit: number,
    category: string | null = null,
  ): Promise<CatalogueItem[]> {
    const strict = await this.textSearch(text, limit, 'websearch_to_tsquery', category);
    if (strict.length > 0) return strict;

    const loose = orTsQuery(text);
    if (!loose) return [];
    return this.textSearch(loose, limit, 'to_tsquery', category);
  }

  private async textSearch(
    query: string,
    limit: number,
    // Not user input - one of two hardcoded function names.
    tsFn: 'websearch_to_tsquery' | 'to_tsquery',
    category: string | null = null,
  ): Promise<CatalogueItem[]> {
    const loose = tsFn === 'to_tsquery';

    // Confine the search to plausible shelves. With a known category that is
    // an allow-list; without one, at least rule out the service industries.
    const allowed = category ? CATEGORY_MAP[category] : undefined;
    const categoryClause = allowed
      ? `and b.category = any($4)`
      : `and (b.category is null or b.category <> all($4))`;
    const categoryParam = allowed ?? SERVICE_CATEGORIES;

    // The curated notes are searched by substring, which only makes sense for
    // a user's own short phrasing. A whole listing title would never appear
    // verbatim in a note, so that arm is omitted in loose mode rather than
    // passed an impossible sentinel.
    const notesClause = loose
      ? ''
      : `or exists (
             select 1 from matches m
              where m.brand_slug = b.slug
                and (m.canadian_product_name ilike '%' || $1 || '%'
                     or array_to_string(m.notes, ' ') ilike '%' || $1 || '%')
           )`;

    const { rows } = await this.sql.query(
      `with q as (select ${tsFn}('english', $1) as tsq)
       select b.*, null::text as coverage, false as match_verified, false as match_partial,
              array[]::text[] as notes, '' as canadian_product_name, '' as us_product_name,
              o.owner_name, o.owner_country, o.source_url as owner_source,
              ts_rank(
                to_tsvector('english',
                  b.name || ' ' || coalesce(b.description,'') || ' ' || coalesce(b.category,'')),
                q.tsq
              ) as rank
         from brands b
         cross join q
         left join ownership_overrides o on o.brand_slug = b.slug
        where ${QUALITY_FILTER}
          ${categoryClause}
          and (
            to_tsvector('english',
              b.name || ' ' || coalesce(b.description,'') || ' ' || coalesce(b.category,''))
              @@ q.tsq
            ${notesClause}
          )
          -- A loose OR match on a single common word is noise, not a result.
          and ($3::boolean = false or ts_rank(
                to_tsvector('english',
                  b.name || ' ' || coalesce(b.description,'') || ' ' || coalesce(b.category,'')),
                q.tsq) >= 0.02)
        order by rank desc, (b.verification = 'Verified') desc, b.name
        limit $2`,
      [query, limit, loose, categoryParam],
    );

    // A loose OR match is weaker evidence than a strict one, and the score
    // has to say so or a tangential brand looks as good as a real match.
    return rows.map((r) => {
      const item = this.toCatalogueItem(r);
      const rank = Number(r['rank'] ?? 0);
      const base = loose ? 0.45 : 0.6;
      const lift = Math.min(0.3, rank * 4);
      return { ...item, similarity: clamp01(base + lift) };
    });
  }

  /**
   * Everything in a category, ranked by how well verified it is.
   *
   * Deliberately blunt. It only runs when the sharper passes found nothing,
   * and "here are verified Canadian coffee roasters" is a far more useful
   * answer on a bag of coffee than silence.
   */
  private async alternativesByCategory(
    category: string | null,
    limit: number,
  ): Promise<CatalogueItem[]> {
    if (!category) return [];
    const allowed = CATEGORY_MAP[category];
    const nouns = requiredNouns(category, null);
    if (!allowed || nouns.length === 0) return [];

    const { rows } = await this.sql.query(
      `with q as (select to_tsquery('english', $1) as tsq)
       select b.*, null::text as coverage, false as match_verified, false as match_partial,
              array[]::text[] as notes, '' as canadian_product_name, '' as us_product_name,
              o.owner_name, o.owner_country, o.source_url as owner_source,
              0.5::float as text_sim
         from brands b
         cross join q
         left join ownership_overrides o on o.brand_slug = b.slug
        where ${QUALITY_FILTER}
          and b.category = any($3)
          and to_tsvector('english', b.name || ' ' || coalesce(b.description,'')) @@ q.tsq
        order by (b.verification = 'Verified') desc,
                 (b.verification = 'Partially verified') desc,
                 cardinality(b.status_tags) desc,
                 b.name
        limit $2`,
      [nouns.join(' | '), limit, allowed],
    );
    return rows.map((r) => this.toCatalogueItem(r));
  }

  /** No barcode data in this dataset, so cross-store matching cannot run. */
  async findByGtin(): Promise<CatalogueItem[]> {
    return [];
  }

  /** No retailer table yet. The retailer-swap fallback stays inert. */
  async findCanadianRetailers(): Promise<RetailerRecord[]> {
    return [];
  }

  /**
   * No spec_cache table exists, and creating tables in someone else's
   * database is not this layer's call. Caching degrades to "off".
   */
  async getCachedSpec(): Promise<ProductSpec | null> {
    return null;
  }

  async putCachedSpec(): Promise<void> {
    /* no-op */
  }

  // --- row mapping ---------------------------------------------------------

  private canadianBrandRecord(row: Record<string, unknown>): BrandRecord {
    const tags = toStringArray(row['status_tags']);
    const confidence = verificationConfidence(String(row['verification'] ?? ''));
    const source = primarySource(row) ?? (row['profile_url'] as string) ?? null;

    const ownerName = (row['owner_name'] as string) ?? null;
    const ownerCountry = (row['owner_country'] as string) ?? null;
    const ownerSource = (row['owner_source'] as string) ?? null;

    // An override always wins: it is the whole point of following the
    // ultimate parent rather than the brand's own marketing.
    const parent: Sourced<string> = ownerName
      ? { value: ownerName, source: ownerSource, confidence: 'medium' }
      : { value: null, source: null, confidence: 'low', reason: 'no parent recorded for this brand' };

    const parentHq: Sourced<string> = ownerCountry
      ? { value: ownerCountry, source: ownerSource, confidence: 'medium' }
      : tagged(tags, TAG.owned, TAG.notOwned)
        ? { value: 'CA', source, confidence }
        : { value: null, source: null, confidence: 'low', reason: 'ownership not recorded' };

    return {
      key: String(row['slug'] ?? ''),
      displayName: String(row['name'] ?? ''),
      parent,
      parentHq,
      hqCountry: tagField(tags, TAG.hq, TAG.notHq, 'CA', source, confidence),
      foundedIn: tagField(tags, TAG.founded, TAG.notFounded, 'CA', source, confidence),
      mfgOrigin: manufacturing(tags, source, confidence),
      // Present in the Canadian brands table, which is the directory's own
      // claim about it. Cited to the profile so it is checkable.
      listedCanadian: {
        value: true,
        source: source ?? (row['profile_url'] as string) ?? null,
        confidence: tags.length > 0 ? confidence : 'low',
      },
      cfiaClass: tags.includes(TAG.productOf)
        ? 'Product of Canada'
        : tags.includes(TAG.made)
          ? 'Made in Canada'
          : null,
      lastReviewed: String(row['verification'] ?? 'Unverified'),
    };
  }

  /**
   * A row in `us_brands` is, by this dataset's own construction, a foreign
   * brand someone is seeking an alternative to. That is evidence, not proof,
   * so it is recorded at medium confidence and cited to the profile URL
   * rather than asserted outright.
   */
  private foreignBrandRecord(row: Record<string, unknown>): BrandRecord {
    const source = (row['profile_url'] as string) ?? null;
    const reason = 'listed as a foreign brand in the alternatives dataset; no ownership chain recorded';
    return {
      key: String(row['slug'] ?? ''),
      displayName: String(row['name'] ?? ''),
      parent: { value: null, source: null, confidence: 'low', reason },
      parentHq: { value: 'US', source, confidence: 'medium' },
      hqCountry: { value: 'US', source, confidence: 'medium' },
      foundedIn: { value: null, source: null, confidence: 'low', reason },
      mfgOrigin: { value: null, source: null, confidence: 'low', reason },
      listedCanadian: { value: false, source, confidence: 'medium' },
      cfiaClass: null,
      lastReviewed: 'from us_brands',
    };
  }

  private toCatalogueItem(row: Record<string, unknown>): CatalogueItem {
    const tags = toStringArray(row['status_tags']);
    const region = (row['region'] as string) ?? null;
    const productName = String(row['canadian_product_name'] ?? '').trim();
    const name = String(row['name'] ?? '');

    return {
      id: String(row['slug'] ?? ''),
      // The curated product name when there is one, otherwise the brand.
      title: productName || name,
      brand: name,
      brandKey: String(row['slug'] ?? ''),
      url: String(row['website'] ?? ''),
      retailer: name,
      retailerCanadianOwned: tagged(tags, TAG.owned, TAG.notOwned),
      priceCad: null,
      priceChecked: null,
      category: (row['category'] as string) ?? null,
      attrs: {},
      massKg: null,
      gtin: null,
      shipsFrom: region ? `CA-${region}` : null,
      similarity: matchStrength(row),
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Equivalence, taken from the dataset's own judgement rather than computed.
 * A curator who wrote "Broad coverage, verified" knows more about whether
 * these two brands substitute for each other than any string comparison.
 */
function matchStrength(row: Record<string, unknown>): number {
  // The text path already emits a calibrated 0..1 value; do not rescale it.
  const textSim = row['text_sim'];
  if (typeof textSim === 'number') return clamp01(textSim);
  if (typeof textSim === 'string' && textSim !== '') return clamp01(Number(textSim));

  const coverage = String(row['coverage'] ?? '');
  const base =
    coverage === 'Broad coverage'
      ? 0.9
      : coverage === 'Partial coverage'
        ? 0.7
        : coverage === 'Niche coverage'
          ? 0.5
          : 0.45;

  const verified = row['match_verified'] === true;
  const partial = row['match_partial'] === true;
  return clamp01(base + (verified ? 0.08 : -0.12) - (partial ? 0.08 : 0));
}

/**
 * Words too generic to narrow anything down in a listing title. Marketing
 * filler mostly, plus units - "300 ml" matches half the catalogue.
 */
const TITLE_NOISE = new Set([
  'the', 'and', 'for', 'with', 'from', 'pack', 'size', 'count', 'new', 'free',
  'oz', 'ml', 'fl', 'kg', 'lb', 'gram', 'grams', 'litre', 'liter',
  'all', 'soft', 'daily', 'natural', 'original', 'classic', 'premium', 'plus',
  'provides', 'moisturizes', 'moisturizing', 'formula', 'value', 'bottle',
]);

/**
 * Turns a listing title into an OR tsquery of its distinctive terms.
 * Sanitized to alphanumerics because to_tsquery parses its input as an
 * expression and would throw on stray punctuation.
 */
function orTsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !TITLE_NOISE.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)].slice(0, 12).join(' | ');
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Returns true / false / null (not recorded) for a positive-negative tag pair. */
function tagged(tags: string[], positive: string, negative: string): boolean | null {
  if (tags.includes(positive)) return true;
  if (tags.includes(negative)) return false;
  return null;
}

function tagField(
  tags: string[],
  positive: string,
  negative: string,
  positiveValue: string,
  source: string | null,
  confidence: Confidence,
): Sourced<string> {
  const verdict = tagged(tags, positive, negative);
  if (verdict === null) {
    return { value: null, source: null, confidence: 'low', reason: `"${positive}" not recorded` };
  }
  if (!verdict) {
    return { value: 'non-CA', source, confidence };
  }
  return { value: positiveValue, source, confidence };
}

/**
 * Manufacturing has three states here, not two. "Partially made in Canada" is
 * its own answer and collapsing it to yes or no would be the exact
 * oversimplification this project exists to avoid.
 */
function manufacturing(tags: string[], source: string | null, confidence: Confidence): Sourced<string> {
  if (tags.includes(TAG.made) || tags.includes(TAG.productOf)) {
    return { value: 'CA', source, confidence };
  }
  if (tags.includes(TAG.partlyMade)) {
    return { value: 'CA-partial', source, confidence };
  }
  if (tags.includes(TAG.notMade) || tags.includes(TAG.notPartlyMade)) {
    return { value: 'non-CA', source, confidence };
  }
  return { value: null, source: null, confidence: 'low', reason: 'manufacturing not recorded' };
}

function verificationConfidence(verification: string): Confidence {
  if (verification === 'Verified') return 'high';
  if (verification === 'Partially verified') return 'medium';
  return 'low';
}

/** brands.sources is a jsonb array of { url, title }. */
function primarySource(row: Record<string, unknown>): string | null {
  const sources = row['sources'];
  const list = typeof sources === 'string' ? safeParse(sources) : sources;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string') {
      return (entry as { url: string }).url;
    }
  }
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { normalizeBrand };

/** Escapes LIKE wildcards so a brand name is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
