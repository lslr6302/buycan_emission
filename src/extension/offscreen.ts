import { extractFromDocument, jsonLdNodesFromDocument } from '../shared/extract';
import { normalizeSite, parsePrice } from '../shared/normalize';
import { hostMatches } from '../shared/retailers';
import { type Listing, parseWalmartSearch } from '../shared/stores';
import type { ProductRef } from '../shared/types';
import { adapterForHost } from './adapters';
import type { OffscreenParse } from './messages';

/**
 * Offscreen document. Exists for one reason: MV3 service workers have no
 * DOMParser, and both jobs here need a real DOM - reading a product page with
 * the same extractor ladder as the live tab (Amazon's DOM adapter included),
 * and reading a store's search results.
 *
 * Every extension message reaches this listener too; anything that is not a
 * parse request is left for the service worker to answer.
 */
chrome.runtime.onMessage.addListener((message: OffscreenParse, _sender, sendResponse) => {
  if (message?.type !== 'offscreen:parse') return false;
  try {
    const doc = new DOMParser().parseFromString(message.html, 'text/html');
    sendResponse(message.kind === 'listings' ? listingsFrom(doc, message) : productFrom(doc, message));
  } catch {
    sendResponse(message.kind === 'listings' ? [] : null);
  }
  return false;
});

function productFrom(doc: Document, message: OffscreenParse): ProductRef | null {
  const host = new URL(message.url).hostname;
  return extractFromDocument(doc, { site: message.site, url: message.url }, adapterForHost(host)?.product ?? null);
}

// --- search results ----------------------------------------------------------

const MAX_LISTINGS = 30;

function listingsFrom(doc: Document, message: OffscreenParse): Listing[] {
  if (hostMatches(message.site, 'walmart.ca')) return parseWalmartSearch(message.html);
  if (hostMatches(message.site, 'amazon.ca')) return amazonListings(doc);
  // Food Basics, Sobeys and the shopper's own store: no site-specific code,
  // because their markup could not be inspected (they block the server).
  // Structured data first, then product-looking links.
  const structured = jsonLdListings(doc, message.url);
  return structured.length > 0 ? structured : linkListings(doc, message.url);
}

/** Amazon result tiles. Anchored on data attributes, which Amazon churns far less than class names. */
function amazonListings(doc: Document): Listing[] {
  const listings: Listing[] = [];
  doc.querySelectorAll<HTMLElement>('[data-component-type="s-search-result"][data-asin]').forEach((tile) => {
    const asin = tile.getAttribute('data-asin');
    const title = tile.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim();
    if (!asin || !title) return;
    listings.push({
      title,
      url: `https://www.amazon.ca/dp/${asin}`,
      priceCad: parsePrice(tile.querySelector('.a-price .a-offscreen')?.textContent),
    });
  });
  return listings.slice(0, MAX_LISTINGS);
}

/** schema.org ItemList or Product nodes on a results page, which some grocers publish for SEO. */
function jsonLdListings(doc: Document, pageUrl: string): Listing[] {
  const listings: Listing[] = [];
  const add = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const item = (record['item'] ?? record) as Record<string, unknown>;
    const name = item['name'];
    const url = item['url'] ?? record['url'];
    if (typeof name !== 'string' || typeof url !== 'string') return;
    const offers = item['offers'] as Record<string, unknown> | undefined;
    listings.push({
      title: name.trim(),
      url: absolute(url, pageUrl),
      priceCad: parsePrice(typeof offers?.['price'] === 'string' || typeof offers?.['price'] === 'number' ? String(offers['price']) : null),
    });
  };
  for (const node of jsonLdNodesFromDocument(doc)) {
    if (typeof node !== 'object' || node === null) continue;
    const record = node as Record<string, unknown>;
    const elements = record['itemListElement'];
    if (Array.isArray(elements)) elements.forEach(add);
    else if (String(record['@type']).toLowerCase() === 'product') add(record);
  }
  return dedupe(listings);
}

/** Path shapes product pages use on most storefronts: /p/123, /ip/, /dp/, /product/, /products/. */
const PRODUCT_PATH = /\/(p|ip|dp|product|products)\/|\/p\/\d|-p-\d/i;

/** Last resort: links that look like product pages, titled by their text or image. */
function linkListings(doc: Document, pageUrl: string): Listing[] {
  const site = normalizeSite(new URL(pageUrl).hostname);
  const listings: Listing[] = [];
  doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? '';
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!hostMatches(url.hostname, site) || !PRODUCT_PATH.test(url.pathname)) return;
    const title = (
      anchor.textContent?.replace(/\s+/g, ' ').trim() ||
      anchor.getAttribute('aria-label') ||
      anchor.querySelector('img')?.getAttribute('alt') ||
      ''
    ).trim();
    if (title.length < 6) return;
    url.search = '';
    url.hash = '';
    listings.push({ title, url: url.toString(), priceCad: null });
  });
  return dedupe(listings);
}

/** One entry per URL, keeping the most descriptive title. */
function dedupe(listings: Listing[]): Listing[] {
  const byUrl = new Map<string, Listing>();
  for (const listing of listings) {
    const existing = byUrl.get(listing.url);
    if (!existing || listing.title.length > existing.title.length) byUrl.set(listing.url, listing);
  }
  return [...byUrl.values()].slice(0, MAX_LISTINGS);
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}
