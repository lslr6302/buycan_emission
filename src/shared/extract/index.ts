import type { ProductRef } from '../types';
import { type ExtractContext, extractJsonLdFromDocument, extractJsonLdFromHtml } from './jsonld';
import { extractMicrodata } from './microdata';
import { extractOpenGraph } from './opengraph';
import { findVisibleBrand, findVisiblePrice } from './dom-price';

export * from './jsonld';
export { extractMicrodata, breadcrumbFromDom } from './microdata';
export { extractOpenGraph } from './opengraph';
export { findVisiblePrice, findVisibleBrand, pickPrice, type PriceCandidate } from './dom-price';

export type DocumentExtractor = (doc: Document, ctx: ExtractContext) => ProductRef | null;

/**
 * The generic ladder, cheapest and most standardized first. A site adapter can
 * splice itself in as tier 4 by passing `adapterExtractor`; the LLM tier 5 is
 * deliberately not here, because it belongs on the server behind a cache and
 * never on the hot path.
 */
/**
 * Last resort: the price a shopper can actually see.
 *
 * Large retailers publish a schema.org Product with no price in it -
 * walmart.ca does exactly this - and the pipeline then stalls on a page
 * plainly showing "$10.47". This contributes a price (and a rough title)
 * that merging folds into the better structured read.
 *
 * It deliberately reads only the DOM. An earlier attempt walked Walmart's
 * multi-megabyte `__NEXT_DATA__` blob and froze the browser; nothing here
 * touches page-supplied JSON.
 */
export const extractVisiblePrice: DocumentExtractor = (doc, ctx) => {
  const amount = findVisiblePrice(doc);
  if (amount === null) return null;

  const title =
    doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || doc.title?.trim() || '';
  if (!title) return null;

  return {
    site: ctx.site,
    siteId: null,
    url: ctx.url,
    title,
    brand: findVisibleBrand(doc),
    gtin: null,
    price: { amount, currency: 'CAD' },
    categoryHint: null,
    imageUrl: null,
    massKg: null,
    extraction: { tier: 'adapter', confidence: 'low' },
  };
};

export const GENERIC_EXTRACTORS: DocumentExtractor[] = [
  extractJsonLdFromDocument,
  extractMicrodata,
  extractOpenGraph,
  extractVisiblePrice,
];

export function extractFromDocument(
  doc: Document,
  ctx: ExtractContext,
  adapterExtractor?: DocumentExtractor | null,
): ProductRef | null {
  const ladder = adapterExtractor
    ? [
        extractJsonLdFromDocument,
        extractMicrodata,
        adapterExtractor,
        extractOpenGraph,
        extractVisiblePrice,
      ]
    : GENERIC_EXTRACTORS;

  const partials: ProductRef[] = [];
  for (const extractor of ladder) {
    try {
      const product = extractor(doc, ctx);
      // Return early on a complete read; otherwise keep it as a donor.
      if (isUsable(product)) return mergeProducts([product, ...partials]);
      if (product) partials.push(product);
    } catch {
      // A broken extractor must never take the page down with it.
    }
  }

  if (partials.length === 0) return null;

  // Nothing was complete on its own. Large retailers routinely split the
  // facts across tiers - Walmart publishes a schema.org Product with the
  // name and no price, and the price lives elsewhere on the page - so
  // combine them rather than discarding a page we could nearly read.
  const merged = mergeProducts(partials);
  return isUsable(merged) ? merged : null;
}

/**
 * Field-by-field merge, earlier sources winning. Order is the tier order, so
 * a high-confidence JSON-LD title is never overwritten by an OpenGraph one,
 * but a missing price can be filled from anywhere.
 */
export function mergeProducts(partials: ProductRef[]): ProductRef {
  const base = { ...partials[0]! };
  for (const next of partials.slice(1)) {
    base.title ||= next.title;
    base.brand ??= next.brand;
    base.gtin ??= next.gtin;
    base.siteId ??= next.siteId;
    base.categoryHint ??= next.categoryHint;
    base.imageUrl ??= next.imageUrl;
    base.massKg ??= next.massKg;
    if (base.price === null && next.price !== null) base.price = next.price;
  }
  return base;
}

/**
 * Server-side counterpart, used to validate URLs the AI fallback proposes.
 * Same parser as the content script, so "we could not read a price off it"
 * means the same thing in both places.
 */
export function extractFromHtml(html: string, ctx: ExtractContext): ProductRef | null {
  const product = extractJsonLdFromHtml(html, ctx);
  return isUsable(product) ? product : null;
}

/** Title and price. Without both, downstream has nothing to work with. */
export function isUsable(product: ProductRef | null): product is ProductRef {
  return !!product && !!product.title && product.price !== null && product.price.amount > 0;
}
