import {
  AI_STORE_TTL_DAYS,
  type AiStore,
  type AiStoreQuery,
  type StoredAlternative,
  type StoredAlternativeInput,
} from './ai-store';
import type { SqlExecutor } from './tiger-repository';

/**
 * Postgres implementation of the AI-discovery store.
 *
 * Lives in its own schema, `ai_fallback`, so it is a separate database in
 * every sense that matters (own tables, own grants, droppable without touching
 * the curated data) while still able to share one Tiger Cloud service. Point
 * AI_STORE_URL at a different service to split them physically.
 *
 * This is the one place the server writes to Postgres. The schema is created
 * on startup if missing; every statement is idempotent.
 */

const SCHEMA = 'ai_fallback';
const TABLE = `${SCHEMA}.alternatives`;

const DDL = [
  `create schema if not exists ${SCHEMA}`,
  `create table if not exists ${TABLE} (
     id                 bigserial primary key,
     product_key        text        not null,
     original_brand_key text,
     original_title     text        not null,
     original_site      text        not null,
     category           text,
     url                text        not null,
     title              text        not null,
     brand              text,
     retailer           text        not null,
     price_cad          numeric,
     gtin               text,
     mass_kg            numeric,
     source_url         text        not null,
     claim              text        not null,
     ai_backend         text        not null,
     verified_at        timestamptz not null default now(),
     created_at         timestamptz not null default now(),
     hit_count          integer     not null default 0,
     last_used_at       timestamptz,
     unique (product_key, url)
   )`,
  `create index if not exists alternatives_brand_category_idx
     on ${TABLE} (original_brand_key, category)`,
];

export class TigerAiStore implements AiStore {
  readonly name = 'tigerdata:ai_fallback';

  constructor(private readonly sql: SqlExecutor) {}

  async init(): Promise<void> {
    for (const statement of DDL) await this.sql.query(statement);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.sql.query(`select 1 from ${TABLE} limit 1`);
      return true;
    } catch {
      return false;
    }
  }

  async find(query: AiStoreQuery): Promise<StoredAlternative[]> {
    const { rows } = await this.sql.query(
      `update ${TABLE} a
          set hit_count = a.hit_count + 1, last_used_at = now()
         from (
           select id from ${TABLE}
            where verified_at > now() - make_interval(days => $4)
              and (product_key = $1
                   or ($2::text is not null and $3::text is not null
                       and original_brand_key = $2 and category = $3))
            order by (product_key = $1) desc, verified_at desc
            limit $5
         ) hit
        where a.id = hit.id
       returning a.*`,
      [query.productKey, query.brandKey, query.category, AI_STORE_TTL_DAYS, query.limit],
    );
    return rows.map(toStoredAlternative);
  }

  async save(entries: StoredAlternativeInput[]): Promise<void> {
    for (const e of entries) {
      await this.sql.query(
        `insert into ${TABLE}
           (product_key, original_brand_key, original_title, original_site, category,
            url, title, brand, retailer, price_cad, gtin, mass_kg, source_url, claim, ai_backend)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (product_key, url) do update set
           title = excluded.title, brand = excluded.brand, retailer = excluded.retailer,
           price_cad = excluded.price_cad, gtin = excluded.gtin, mass_kg = excluded.mass_kg,
           source_url = excluded.source_url, claim = excluded.claim,
           ai_backend = excluded.ai_backend, category = excluded.category,
           verified_at = now()`,
        [
          e.productKey, e.originalBrandKey, e.originalTitle, e.originalSite, e.category,
          e.url, e.title, e.brand, e.retailer, e.priceCad, e.gtin, e.massKg,
          e.sourceUrl, e.claim, e.aiBackend,
        ],
      );
    }
  }
}

function toStoredAlternative(row: Record<string, unknown>): StoredAlternative {
  return {
    id: String(row.id),
    productKey: String(row.product_key),
    originalBrandKey: (row.original_brand_key as string) ?? null,
    originalTitle: String(row.original_title),
    originalSite: String(row.original_site),
    category: (row.category as string) ?? null,
    url: String(row.url),
    title: String(row.title),
    brand: (row.brand as string) ?? null,
    retailer: String(row.retailer),
    priceCad: numberOrNull(row.price_cad),
    gtin: (row.gtin as string) ?? null,
    massKg: numberOrNull(row.mass_kg),
    sourceUrl: String(row.source_url),
    claim: String(row.claim),
    aiBackend: String(row.ai_backend),
    verifiedAt: new Date(row.verified_at as string | Date).toISOString(),
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
