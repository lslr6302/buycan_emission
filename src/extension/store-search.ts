import { normalizeSite } from '../shared/normalize';
import { ALTERNATIVE_RETAILERS, RETAILER_NAMES, hostMatches, siteFor } from '../shared/retailers';
import { equivalenceScore, priceScore, rankPreferringSite } from '../shared/scoring';
import { type Listing, listingMatchesLead, pickListing, searchUrl } from '../shared/stores';
import type { BrowserLead, Candidate, GateRejection, ProductRef, ResolveResponse, Weights } from '../shared/types';
import type { OffscreenParse } from './messages';

/**
 * The second half of the AI fallback, run in the shopper's browser.
 *
 * The server asked the AI which Canadian products to look for and sent back
 * the leads. Here each lead is searched for on the shopper's own site first,
 * then Amazon, Walmart, Food Basics and Sobeys, in that order, stopping at the
 * first store that has it. These stores block servers but serve a real
 * browser, which is why this runs here.
 *
 * A listing is only accepted when it is the suggested brand and product type,
 * and only shown once its own page has loaded with a readable price. Facts on
 * the card come from that page, never from the AI.
 */

const MAX_CANDIDATES = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface StoreSearchResult {
  data: ResolveResponse;
  /** True when a store could not be reached at all - worth retrying, so not worth caching. */
  transientFailure: boolean;
}

export async function searchStoresInBrowser(data: ResolveResponse, weights: Weights): Promise<StoreSearchResult> {
  const search = data.browserSearch;
  if (!search || search.leads.length === 0) return { data, transientFailure: false };

  const rejections: GateRejection[] = [];
  let transientFailure = false;

  // Leads in parallel; stores within a lead in order, so the shopper's own
  // site is always tried first and the others only when it has nothing.
  const found = await Promise.all(
    search.leads.map(async (lead) => {
      for (const site of search.sites) {
        const listings = await searchSite(site, lead.query);
        if ('rejection' in listings) {
          transientFailure = true;
          rejections.push(listings.rejection);
          continue;
        }
        const listing = pickListing(listings, lead);
        if (!listing) continue;

        const page = await checkPage(listing.url, search.sites);
        if ('rejection' in page) {
          rejections.push(page.rejection);
          continue;
        }
        // The page itself has to agree it is that brand and product, not just the result tile.
        if (!listingMatchesLead(page.product.title, lead) && !listingMatchesLead(`${page.product.brand ?? ''} ${page.product.title}`, lead)) {
          rejections.push({ gate: 'brand_mismatch', url: page.url, detail: `page reads "${page.product.title}", not ${lead.brand}` });
          continue;
        }
        return toCandidate(lead, page.product, page.url, site, data);
      }
      return null;
    }),
  );

  const unique = new Map<string, Candidate>();
  for (const candidate of found) if (candidate && !unique.has(candidate.url)) unique.set(candidate.url, candidate);

  const candidates = rankPreferringSite([...data.candidates, ...unique.values()], weights, data.product.site).slice(
    0,
    MAX_CANDIDATES,
  );
  const diagnostics = {
    ...data.diagnostics,
    aiCandidatesRejected: data.diagnostics.aiCandidatesRejected + rejections.length,
    rejections: [...data.diagnostics.rejections, ...rejections],
  };

  if (candidates.length > 0) {
    return {
      data: { ...data, candidates, abstained: false, abstentionReason: null, abstentionMessage: null, diagnostics },
      transientFailure,
    };
  }

  const brands = [...new Set(search.leads.map((l) => l.brand))].join(', ');
  const stores = search.sites.map((s) => RETAILER_NAMES[s] ?? s).join(', ');
  return {
    data: {
      ...data,
      candidates,
      abstained: true,
      abstentionReason: 'not_in_allowed_stores',
      abstentionMessage:
        `Nothing in our database matched, so we asked the AI for Canadian alternatives. ` +
        `It suggested ${brands}, but we could not find ${search.leads.length === 1 ? 'it' : 'any of them'} ` +
        `on ${stores}` +
        (transientFailure ? ' (some stores could not be reached - try again later).' : '.'),
      diagnostics,
    },
    transientFailure,
  };
}

// --- stores --------------------------------------------------------------------

async function searchSite(site: string, query: string): Promise<Listing[] | { rejection: GateRejection }> {
  // The shopper's own store, when it is not one of the four: Shopify's
  // predictive search returns clean JSON, so try that before scraping HTML.
  if (!ALTERNATIVE_RETAILERS.some((r) => hostMatches(site, r))) {
    const shopify = await shopifySuggest(site, query);
    if (shopify) return shopify;
  }

  const url = searchUrl(site, query);
  const response = await load(url);
  if ('rejection' in response) return { rejection: { ...response.rejection, gate: 'store_search_failed' } };
  return parse<Listing[]>({ kind: 'listings', html: response.html, url: response.url, site });
}

async function shopifySuggest(site: string, query: string): Promise<Listing[] | null> {
  const url =
    `https://www.${site}/search/suggest.json?q=${encodeURIComponent(query)}` +
    '&resources[type]=product&resources[limit]=10';
  try {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      resources?: { results?: { products?: Array<{ title?: string; url?: string; price?: string }> } };
    };
    const products = body.resources?.results?.products;
    if (!Array.isArray(products)) return null;
    return products
      .filter((p) => p.title && p.url)
      .map((p) => {
        const product = new URL(p.url!, `https://www.${site}`);
        product.search = '';
        return { title: p.title!, url: product.toString(), priceCad: p.price ? Number(p.price) || null : null };
      });
  } catch {
    return null; // Not Shopify. Fall back to the HTML search page.
  }
}

async function checkPage(
  url: string,
  allowed: string[],
): Promise<{ product: ProductRef; url: string } | { rejection: GateRejection }> {
  const response = await load(url);
  if ('rejection' in response) return response;

  // A redirect can land somewhere else entirely - a sign-in wall, a bot check
  // on another host, a different store. The final page has to be on the list.
  if (!siteFor(response.url, allowed)) {
    return reject('site_not_allowed', url, `redirected to ${response.url}`);
  }
  const product = await parse<ProductRef | null>({
    kind: 'product',
    html: response.html,
    url: response.url,
    site: normalizeSite(new URL(response.url).hostname),
  });
  if (!product) return reject('not_a_product_page', url, 'no product with a price could be read from the page');
  return { product, url: response.url };
}

async function load(url: string): Promise<{ html: string; url: string } | { rejection: GateRejection }> {
  try {
    const response = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return reject('browser_unreachable', url, `HTTP ${response.status}`);
    return { html: await response.text(), url: response.url || url };
  } catch (error) {
    return reject('browser_unreachable', url, error instanceof Error ? error.message : 'fetch failed');
  }
}

/** Card for a verified listing. Title, price and barcode are the store's; the claim and source are the lead's. */
function toCandidate(lead: BrowserLead, page: ProductRef, url: string, site: string, data: ResolveResponse): Candidate {
  const priceCad = page.price?.amount ?? null;
  return {
    id: `ai:${site}:${page.siteId ?? page.title.slice(0, 40)}`,
    origin: 'ai',
    matchType: 'equivalent',
    title: page.title,
    brand: page.brand ?? lead.brand,
    url,
    retailer: RETAILER_NAMES[site] ?? site,
    retailerCanadianOwned: null,
    priceCad,
    priceChecked: new Date().toISOString().slice(0, 10),
    gtin: page.gtin,
    massKg: page.massKg,
    shipsFrom: null,
    provenance: lead.provenance,
    components: {
      equivalence: equivalenceScore(
        { gtin: data.product.gtin, title: data.product.title, spec: data.spec },
        { gtin: page.gtin, title: page.title, category: null, attrs: {} },
      ),
      canadian: lead.provenance.canadianScore ?? 0.5,
      price: priceScore(data.product.price?.amount ?? null, priceCad),
    },
    score: 0,
    sourceUrl: lead.sourceUrl,
    rationale: lead.claim,
  };
}

function reject(gate: string, url: string, detail: string): { rejection: GateRejection } {
  return { rejection: { gate, url, detail } };
}

// --- offscreen document ------------------------------------------------------

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse store search results and product pages to find and verify Canadian alternatives.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function parse<T>(message: Omit<OffscreenParse, 'type'>): Promise<T> {
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage({ type: 'offscreen:parse', ...message } satisfies OffscreenParse)) as T;
}
