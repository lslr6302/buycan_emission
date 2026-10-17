import type { CartAnalysis, CartLine, ProductRef, ResolveResponse, Weights } from '../shared/types';

/** Message protocol between the content script, the popup and the worker. */

export type Message =
  | { type: 'report'; report: PageReport }
  | { type: 'resolve'; product: ProductRef }
  | { type: 'search'; site: string; query: string }
  | { type: 'analyzeCart'; site: string; lines: CartLine[] }
  | { type: 'getTabState' }
  | { type: 'resetSite'; site: string }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Partial<Settings> };

export type Response =
  | { ok: true; kind: 'resolve'; data: ResolveResponse }
  | { ok: true; kind: 'search'; data: ResolveResponse }
  | { ok: true; kind: 'cart'; data: CartAnalysis }
  | { ok: true; kind: 'tabState'; data: TabState | null }
  | { ok: true; kind: 'settings'; data: Settings }
  | { ok: false; error: string };

/**
 * What the content script observed, sent on EVERY page even when we do
 * nothing. Without it, "no Canadian alternative" and "extraction failed" look
 * identical from the outside - and one of those is a feature while the other
 * is a bug.
 */
export interface PageReport {
  site: string;
  url: string;
  /** Which adapter claimed the page: amazon, shopify, generic. */
  adapterId: string;
  pageKind: 'product' | 'cart' | 'search' | 'none';
  /** Which extraction tier produced a usable product, if any. */
  tier: string | null;
  title: string | null;
  brand: string | null;
  gtin: string | null;
  priceCad: number | null;
  cartLines: number | null;
  /** What the user typed, on a search-results page. */
  searchQuery: string | null;
  /**
   * Whether the overlay actually reached the screen. "It did not pop up" has
   * several causes that look identical from the outside; this separates them.
   */
  overlay: 'shown' | 'suppressed_dismissed' | 'suppressed_abstained' | 'not_attempted';
  /** Set when the lookup itself failed, e.g. the API is not running. */
  error: string | null;
}

/**
 * Service worker -> offscreen document: parse a fetched page, either as one
 * product page or as a store's search results.
 */
export interface OffscreenParse {
  type: 'offscreen:parse';
  kind: 'product' | 'listings';
  html: string;
  url: string;
  site: string;
}

/** What the popup reads for the active tab, including when we stayed silent. */
export interface TabState {
  url: string;
  site: string;
  kind: 'product' | 'cart' | 'search' | 'none';
  resolve?: ResolveResponse;
  cart?: CartAnalysis;
  report?: PageReport;
  updatedAt: number;
}

export interface Settings {
  apiBaseUrl: string;
  weights: Weights;
  /** Null until the user sets one; the server will not guess a destination. */
  province: string | null;
  /** Skip the AI fallback entirely. */
  verifiedOnly: boolean;
  /** Load a saved fixture instead of reading the live page. */
  demoMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: 'http://localhost:8787',
  weights: { equivalence: 0.45, canadian: 0.35, price: 0.2 },
  province: null,
  verifiedOnly: false,
  demoMode: false,
};
