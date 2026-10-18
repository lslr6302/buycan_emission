import type { BrandRecord, ProductSpec } from '../../shared/types';

/**
 * THE DATA SEAM.
 *
 * Everything upstream of this file is storage-agnostic. Swapping the mock for
 * TigerData means implementing this interface once, in one file, and changing
 * one environment variable. No route, pipeline stage or type changes.
 *
 * Keep this interface shaped by what the pipeline needs, not by what the
 * database happens to store. If the real schema disagrees, the translation
 * belongs inside the implementation, not out here.
 */
export interface Repository {
  /** Identifies itself in /v1/health and in diagnostics, so the demo can prove which backend is live. */
  readonly name: string;

  init(): Promise<void>;
  close(): Promise<void>;
  healthy(): Promise<boolean>;

  /**
   * Entity linking target. Receives a raw, messy brand string off a product
   * page ("Klean Kanteen Canada", "KLEANKANTEEN"); returns the canonical
   * record or null. Normalization helpers live in shared/normalize.
   */
  findBrand(rawBrand: string): Promise<BrandRecord | null>;

  findBrandsByKeys(keys: string[]): Promise<BrandRecord[]>;

  /**
   * The brand whose own storefront this domain is, if the directory knows
   * it. Lets us say something true about a page whose product brand is
   * unknown: the shop itself may be a listed Canadian business.
   */
  findBrandByDomain(domain: string): Promise<BrandRecord | null>;

  /**
   * The verified path. Hard constraints gate, embedding similarity ranks.
   * Implementations backed by Postgres should push the category filter and the
   * pgvector ORDER BY into SQL rather than filtering in Node.
   */
  findAlternatives(query: AlternativeQuery): Promise<CatalogueItem[]>;

  /**
   * Exact cross-storefront match. The strongest claim the system can make, and
   * the backbone of the retailer-swap path.
   */
  findByGtin(gtin: string): Promise<CatalogueItem[]>;

  /** Canadian-owned retailer table, for the "same product, different store" fallback. */
  findCanadianRetailers(): Promise<RetailerRecord[]>;

  /** Cached output of the LLM spec parse, keyed by shared/normalize productKey. */
  getCachedSpec(key: string): Promise<ProductSpec | null>;
  putCachedSpec(key: string, spec: ProductSpec): Promise<void>;
}

export interface AlternativeQuery {
  category: string | null;
  /** Must match exactly on the candidate, when the candidate declares the attribute. */
  hard: Record<string, string | number | boolean>;
  /** Free-text fallback when there is no usable category. */
  text: string;
  /** Raw brand off the page. Brand-level datasets look alternatives up by it. */
  brand?: string | null;
  /** Precomputed query embedding, when the caller has one. */
  embedding?: number[] | null;
  limit: number;
}

export interface CatalogueItem {
  id: string;
  title: string;
  brand: string | null;
  brandKey: string | null;
  url: string;
  retailer: string;
  retailerCanadianOwned: boolean | null;
  priceCad: number | null;
  priceChecked: string | null;
  category: string | null;
  attrs: Record<string, string | number | boolean>;
  massKg: number | null;
  gtin: string | null;
  shipsFrom: string | null;
  /** Cosine similarity from the vector search, when the backend supplies one. */
  similarity?: number | null;
}

export interface RetailerRecord {
  name: string;
  domain: string;
  canadianOwned: boolean;
  source: string;
  note?: string;
}
