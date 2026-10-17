import { normalizeBrand, normalizeGtin } from '../../shared/normalize';
import type { BrandRecord, Confidence, ProductSpec, Sourced } from '../../shared/types';
import type {
  AlternativeQuery,
  CatalogueItem,
  Repository,
  RetailerRecord,
} from './repository';

/**
 * TigerData (Postgres) implementation. UNFINISHED BY DESIGN - the schema is
 * owned by someone else, so this file holds the shape of the integration and
 * the queries we expect to run, with every assumption about column names
 * quarantined in COLUMNS below.
 *
 * It takes a `SqlExecutor` rather than importing a driver, so nothing here
 * depends on `pg` being installed. Wiring is one line once the DB exists:
 *
 *     import { Pool } from 'pg';
 *     new TigerRepository(new Pool({ connectionString: process.env.TIGER_URL }));
 *
 * INTEGRATION CHECKLIST
 *   1. Fill in COLUMNS to match the real schema (or add a view that matches it).
 *   2. Confirm pgvector is enabled and the embedding column + index exist.
 *   3. Decide where embeddings are produced - this repo assumes the caller
 *      passes `query.embedding`, so something upstream must embed the query.
 *   4. Set DATA_BACKEND=tiger and TIGER_URL, then run `npm run server`.
 *      /v1/health reports which backend is actually live.
 */

/** Matches node-postgres' Pool.query, deliberately. */
export interface SqlExecutor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * EVERY schema assumption lives here. If the real tables disagree, change this
 * object and nothing else in the file.
 */
export const COLUMNS = {
  brands: {
    table: 'brands',
    key: 'brand_key',
    displayName: 'display_name',
    parent: 'parent_name',
    parentSource: 'parent_source_url',
    parentConfidence: 'parent_confidence',
    parentHq: 'parent_hq_country',
    hqCountry: 'hq_country',
    foundedIn: 'founded_in_country',
    mfgOrigin: 'mfg_origin_country',
    cfiaClass: 'cfia_class',
    lastReviewed: 'last_reviewed',
  },
  catalogue: {
    table: 'catalogue',
    id: 'id',
    title: 'title',
    brand: 'brand',
    brandKey: 'brand_key',
    url: 'url',
    retailer: 'retailer',
    retailerCanadianOwned: 'retailer_canadian_owned',
    priceCad: 'price_cad',
    priceChecked: 'price_checked',
    category: 'category',
    attrs: 'attrs',
    massKg: 'mass_kg',
    gtin: 'gtin',
    shipsFrom: 'ships_from',
    embedding: 'embedding',
  },
  retailers: {
    table: 'retailers',
    name: 'name',
    domain: 'domain',
    canadianOwned: 'canadian_owned',
    source: 'source_url',
  },
  specCache: {
    table: 'spec_cache',
    key: 'product_key',
    spec: 'spec',
    updatedAt: 'updated_at',
  },
} as const;

export class TigerRepository implements Repository {
  readonly name = 'tigerdata';

  constructor(private readonly sql: SqlExecutor) {}

  async init(): Promise<void> {
    await this.sql.query('select 1');
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

  async findBrand(rawBrand: string): Promise<BrandRecord | null> {
    const key = normalizeBrand(rawBrand);
    if (!key) return null;
    const c = COLUMNS.brands;

    // Exact normalized key, then trigram similarity. The fuzzy arm needs
    // pg_trgm and an index on the normalized key, or it will table-scan.
    const { rows } = await this.sql.query(
      `select * from ${c.table}
        where ${c.key} = $1
        order by 1
        limit 1`,
      [key],
    );
    if (rows[0]) return this.toBrandRecord(rows[0]);

    const fuzzy = await this.sql.query(
      `select *, similarity(${c.key}, $1) as sim from ${c.table}
        where ${c.key} % $1
        order by sim desc
        limit 1`,
      [key],
    );
    return fuzzy.rows[0] ? this.toBrandRecord(fuzzy.rows[0]) : null;
  }

  async findBrandsByKeys(keys: string[]): Promise<BrandRecord[]> {
    if (keys.length === 0) return [];
    const c = COLUMNS.brands;
    const { rows } = await this.sql.query(
      `select * from ${c.table} where ${c.key} = any($1)`,
      [keys.map(normalizeBrand)],
    );
    return rows.map((r) => this.toBrandRecord(r));
  }

  async findAlternatives(query: AlternativeQuery): Promise<CatalogueItem[]> {
    const c = COLUMNS.catalogue;

    // Hard constraints are a JSONB containment check so they push down into
    // the index instead of being filtered in Node.
    const filters: string[] = [];
    const params: unknown[] = [];

    if (query.category) {
      params.push(query.category);
      filters.push(`${c.category} = $${params.length}`);
    }
    if (Object.keys(query.hard).length > 0) {
      params.push(JSON.stringify(query.hard));
      filters.push(`(${c.attrs} @> $${params.length}::jsonb)`);
    }

    const where = filters.length ? `where ${filters.join(' and ')}` : '';

    if (query.embedding) {
      params.push(toVectorLiteral(query.embedding));
      const vec = `$${params.length}::vector`;
      params.push(query.limit);
      const { rows } = await this.sql.query(
        `select *, 1 - (${c.embedding} <=> ${vec}) as similarity
           from ${c.table} ${where}
          order by ${c.embedding} <=> ${vec}
          limit $${params.length}`,
        params,
      );
      return rows.map((r) => this.toCatalogueItem(r));
    }

    // No embedding supplied: fall back to full-text ranking.
    params.push(query.text);
    const textParam = `$${params.length}`;
    params.push(query.limit);
    const { rows } = await this.sql.query(
      `select *, ts_rank(to_tsvector('english', ${c.title}),
                         plainto_tsquery('english', ${textParam})) as similarity
         from ${c.table} ${where}
        order by similarity desc
        limit $${params.length}`,
      params,
    );
    return rows.map((r) => this.toCatalogueItem(r));
  }

  async findByGtin(gtin: string): Promise<CatalogueItem[]> {
    const normalized = normalizeGtin(gtin);
    if (!normalized) return [];
    const c = COLUMNS.catalogue;
    const { rows } = await this.sql.query(
      `select * from ${c.table} where ${c.gtin} = $1 limit 20`,
      [normalized],
    );
    return rows.map((r) => this.toCatalogueItem(r));
  }

  async findCanadianRetailers(): Promise<RetailerRecord[]> {
    const c = COLUMNS.retailers;
    const { rows } = await this.sql.query(
      `select * from ${c.table} where ${c.canadianOwned} = true`,
    );
    return rows.map((r) => ({
      name: String(r[c.name] ?? ''),
      domain: String(r[c.domain] ?? ''),
      canadianOwned: Boolean(r[c.canadianOwned]),
      source: String(r[c.source] ?? ''),
    }));
  }

  async getCachedSpec(key: string): Promise<ProductSpec | null> {
    const c = COLUMNS.specCache;
    const { rows } = await this.sql.query(
      `select ${c.spec} from ${c.table} where ${c.key} = $1 limit 1`,
      [key],
    );
    const raw = rows[0]?.[c.spec];
    if (!raw) return null;
    return typeof raw === 'string' ? (JSON.parse(raw) as ProductSpec) : (raw as ProductSpec);
  }

  async putCachedSpec(key: string, spec: ProductSpec): Promise<void> {
    const c = COLUMNS.specCache;
    await this.sql.query(
      `insert into ${c.table} (${c.key}, ${c.spec}, ${c.updatedAt})
       values ($1, $2::jsonb, now())
       on conflict (${c.key}) do update set ${c.spec} = excluded.${c.spec},
                                            ${c.updatedAt} = now()`,
      [key, JSON.stringify(spec)],
    );
  }

  // --- row mapping -------------------------------------------------------

  private toBrandRecord(row: Record<string, unknown>): BrandRecord {
    const c = COLUMNS.brands;
    const confidence = (row[c.parentConfidence] as Confidence) ?? 'medium';
    const source = (row[c.parentSource] as string) ?? null;

    return {
      key: String(row[c.key] ?? ''),
      displayName: String(row[c.displayName] ?? row[c.key] ?? ''),
      parent: field(row[c.parent], source, confidence),
      parentHq: field(row[c.parentHq], source, confidence),
      hqCountry: field(row[c.hqCountry], source, confidence),
      foundedIn: field(row[c.foundedIn], source, confidence),
      mfgOrigin: field(row[c.mfgOrigin], source, confidence),
      cfiaClass: (row[c.cfiaClass] as BrandRecord['cfiaClass']) ?? null,
      lastReviewed: String(row[c.lastReviewed] ?? ''),
    };
  }

  private toCatalogueItem(row: Record<string, unknown>): CatalogueItem {
    const c = COLUMNS.catalogue;
    const attrs = row[c.attrs];
    return {
      id: String(row[c.id] ?? ''),
      title: String(row[c.title] ?? ''),
      brand: (row[c.brand] as string) ?? null,
      brandKey: (row[c.brandKey] as string) ?? null,
      url: String(row[c.url] ?? ''),
      retailer: String(row[c.retailer] ?? ''),
      retailerCanadianOwned: (row[c.retailerCanadianOwned] as boolean) ?? null,
      priceCad: numberOrNull(row[c.priceCad]),
      priceChecked: (row[c.priceChecked] as string) ?? null,
      category: (row[c.category] as string) ?? null,
      attrs:
        typeof attrs === 'string'
          ? (JSON.parse(attrs) as Record<string, string | number | boolean>)
          : ((attrs as Record<string, string | number | boolean>) ?? {}),
      massKg: numberOrNull(row[c.massKg]),
      gtin: normalizeGtin(row[c.gtin] as string),
      shipsFrom: (row[c.shipsFrom] as string) ?? null,
      similarity: numberOrNull(row['similarity']),
    };
  }
}

/**
 * Per-field sources are the point (a brand can have verified ownership and
 * unknown manufacturing). If the real schema stores one source per row rather
 * than per field, this is the function to fix - and it is worth fixing.
 */
function field(value: unknown, source: string | null, confidence: Confidence): Sourced<string> {
  if (value === null || value === undefined || value === '') {
    return { value: null, source: null, confidence: 'low', reason: 'null in source dataset' };
  }
  if (!source) {
    return { value: null, source: null, confidence: 'low', reason: 'value present but uncited' };
  }
  return { value: String(value), source, confidence };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
