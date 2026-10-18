import { normalizeBrand, normalizeTitle, titleTokens } from './normalize';
import { hostMatches } from './retailers';
import type { AiLead } from './types';

/**
 * Searching the allowed stores for an AI lead. Shared because the server
 * searches the stores that let it (Walmart) and the extension searches the
 * ones that only answer a real browser (Amazon, Sobeys, Food Basics) - and
 * both must accept exactly the same listings.
 */

/** One row of a store's search results. Verified by opening the page before it is shown. */
export interface Listing {
  title: string;
  url: string;
  priceCad: number | null;
}

/**
 * Search page for a query on one of the allowed sites. Food Basics and Sobeys
 * could not be inspected from the server (they block it), so their URLs are
 * best knowledge and untested; the browser check drops anything that fails.
 */
export function searchUrl(site: string, query: string): string {
  const q = encodeURIComponent(query);
  if (hostMatches(site, 'amazon.ca')) return `https://www.amazon.ca/s?k=${q}`;
  if (hostMatches(site, 'walmart.ca')) return `https://www.walmart.ca/en/search?q=${q}`;
  if (hostMatches(site, 'foodbasics.ca')) return `https://www.foodbasics.ca/search?filter=${q}`;
  if (hostMatches(site, 'sobeys.com')) return `https://www.sobeys.com/en/search/?query=${q}`;
  // The shopper's own site: /search?q= is the near-universal default.
  return `https://www.${site}/search?q=${q}`;
}

/**
 * A store search for "Green Beaver antiperspirant" happily returns Dove and
 * Axe first. A listing only counts when it is the suggested brand AND names
 * the product type - otherwise a foreign brand would be shown as the Canadian
 * alternative, which is the one mistake this project cannot make.
 */
export function listingMatchesLead(title: string, lead: Pick<AiLead, 'brand' | 'query'>): boolean {
  const brandKey = normalizeBrand(lead.brand);
  if (!brandKey) return false;
  const normalized = normalizeTitle(title);
  const brandOk =
    normalized.includes(brandKey) || normalized.replace(/\s+/g, '').includes(brandKey.replace(/\s+/g, ''));
  if (!brandOk) return false;

  const brandWords = new Set(brandKey.split(' '));
  const typeWords = [...titleTokens(lead.query)].filter((w) => !brandWords.has(w));
  if (typeWords.length === 0) return true;
  const words = titleTokens(title);
  return typeWords.some((w) => words.has(w) || [...words].some((t) => t.startsWith(w) || w.startsWith(t)));
}

/** First listing that is really this lead, or null. Store order is kept - it is the store's own relevance. */
export function pickListing(listings: Listing[], lead: Pick<AiLead, 'brand' | 'query'>): Listing | null {
  return listings.find((l) => listingMatchesLead(l.title, lead)) ?? null;
}

/**
 * Walmart Canada's search page embeds its results as JSON (__NEXT_DATA__), so
 * it parses from a string - on the server, and in the browser if needed.
 */
export function parseWalmartSearch(html: string): Listing[] {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return [];
  }
  const stacks = dig(data, ['props', 'pageProps', 'initialData', 'searchResult', 'itemStacks']);
  if (!Array.isArray(stacks)) return [];

  const listings: Listing[] = [];
  for (const stack of stacks) {
    const items = dig(stack, ['items']);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const name = dig(item, ['name']);
      const path = dig(item, ['canonicalUrl']);
      if (typeof name !== 'string' || typeof path !== 'string') continue;
      const url = new URL(path, 'https://www.walmart.ca');
      url.search = '';
      const price = dig(item, ['price']);
      listings.push({
        title: name,
        url: url.toString(),
        priceCad: typeof price === 'number' && price > 0 ? price : null,
      });
    }
  }
  return listings;
}

function dig(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
