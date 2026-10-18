import { jsonLdNodesFromDocument, findProductNode } from '../../shared/extract';
import { amazonAdapter } from './amazon';
import { shopifyAdapter } from './shopify';
import type { SiteAdapter } from './types';

export type { SiteAdapter, PageKind } from './types';

/**
 * The generic adapter. Not a fallback of last resort - the expected path for
 * most of the web, because retailers publish structured product markup for
 * Google's benefit and we get to read it for free.
 *
 * No cart support: carts are per-site work by definition.
 */
export const genericAdapter: SiteAdapter = {
  id: 'generic',

  pageKind: (doc = document) => {
    if (/\/(cart|checkout|panier|basket)(\/|$)/i.test(location.pathname)) {
      // A cart we have no adapter for. Saying 'none' keeps us quiet rather
      // than half-reading a page and reporting a wrong total.
      return 'none';
    }
    // The honest product-page test: does the page claim to be one?
    if (findProductNode(jsonLdNodesFromDocument(doc))) return 'product';

    // Search before URL shape, because a search page can sit under a path
    // that also looks product-ish.
    if (genericSearchQuery()) return 'search';

    // URL shape as a fallback. Single-page apps inject their structured
    // data after the first render, so checking only for JSON-LD means a
    // product page looks like "none" purely because we arrived early -
    // which is exactly what happens when you click a search result.
    if (PRODUCT_PATH.test(location.pathname)) return 'product';

    return 'none';
  },

  searchQuery: () => genericSearchQuery(),

  product: null,
};

/**
 * Path shapes retailers use for a single product. Deliberately narrow:
 * a false "product" here costs one failed extraction, but a false negative
 * means we never look at the page at all.
 */
const PRODUCT_PATH = /\/(ip|dp|product|products|item|itm|pd|p)\/[^/]+/i;

/** The query parameters essentially every storefront search uses. */
const SEARCH_PARAMS = ['q', 'k', 's', 'query', 'search', 'keyword', 'keywords', 'term'];

function genericSearchQuery(): string | null {
  const looksLikeSearch = /\/(search|results|catalogsearch|recherche)(\/|$)/i.test(
    location.pathname,
  );
  const params = new URLSearchParams(location.search);

  for (const name of SEARCH_PARAMS) {
    const value = params.get(name)?.trim();
    // A bare `?s=` on a non-search path is usually a sort or size parameter,
    // so short values only count when the path already says "search".
    if (value && value.length >= 2 && (looksLikeSearch || name === 'q' || name === 'query')) {
      return value;
    }
  }

  if (looksLikeSearch) {
    const box = document.querySelector<HTMLInputElement>(
      'input[type="search"], input[name="q"], input[name="query"]',
    );
    const typed = box?.value?.trim();
    if (typed && typed.length >= 2) return typed;
  }
  return null;
}

/**
 * Hostname-matched adapters run first, then capability-detected ones, then
 * the generic path.
 *
 * TODO - the team owes a v1 site list. Walmart.ca, Canadian Tire and Indigo
 * are the obvious next three, weighted by how likely a judge is to open them.
 * Each needs a saved HTML fixture and a test, because a silently broken
 * selector looks exactly like "no alternative found" - and that output is the
 * one we have promised means something.
 */
const HOST_ADAPTERS: SiteAdapter[] = [amazonAdapter];
const DETECTED_ADAPTERS: SiteAdapter[] = [shopifyAdapter];

/**
 * For pages that are not the live tab - parsed from a fetch, where there is no
 * window to run `detect()` against. Hostname-matched adapters only; everything
 * else gets the generic ladder.
 */
export function adapterForHost(hostname: string): SiteAdapter | null {
  return HOST_ADAPTERS.find((adapter) => adapter.match?.test(hostname)) ?? null;
}

export function resolveAdapter(hostname: string): SiteAdapter {
  for (const adapter of HOST_ADAPTERS) {
    if (adapter.match?.test(hostname)) return adapter;
  }
  for (const adapter of DETECTED_ADAPTERS) {
    try {
      if (adapter.detect?.()) return adapter;
    } catch {
      // A detector that throws is a detector that said no.
    }
  }
  return genericAdapter;
}
