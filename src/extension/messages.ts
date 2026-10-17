import type { CartAnalysis, CartLine, ProductRef, ResolveResponse, Weights } from '../shared/types';

/** Message protocol between the content script, the popup and the worker. */

export type Message =
  | { type: 'report'; report: PageReport }
  | { type: 'resolve'; product: ProductRef }
  | { type: 'analyzeCart'; site: string; lines: CartLine[] }
  | { type: 'getTabState' }
  | { type: 'getSettings' }
  | { type: 'setSettings'; settings: Partial<Settings> };

export type Response =
  | { ok: true; kind: 'resolve'; data: ResolveResponse }
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
  pageKind: 'product' | 'cart' | 'none';
  /** Which extraction tier produced a usable product, if any. */
  tier: string | null;
  title: string | null;
  brand: string | null;
  gtin: string | null;
  priceCad: number | null;
  cartLines: number | null;
  /** Set when the lookup itself failed, e.g. the API is not running. */
  error: string | null;
}

/** What the popup reads for the active tab, including when we stayed silent. */
export interface TabState {
  url: string;
  site: string;
  kind: 'product' | 'cart' | 'none';
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
