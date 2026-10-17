import type { ProductRef } from '../types';
import { type ExtractContext, extractJsonLdFromDocument, extractJsonLdFromHtml } from './jsonld';
import { extractMicrodata } from './microdata';
import { extractOpenGraph } from './opengraph';

export * from './jsonld';
export { extractMicrodata, breadcrumbFromDom } from './microdata';
export { extractOpenGraph } from './opengraph';

export type DocumentExtractor = (doc: Document, ctx: ExtractContext) => ProductRef | null;

/**
 * The generic ladder, cheapest and most standardized first. A site adapter can
 * splice itself in as tier 4 by passing `adapterExtractor`; the LLM tier 5 is
 * deliberately not here, because it belongs on the server behind a cache and
 * never on the hot path.
 */
export const GENERIC_EXTRACTORS: DocumentExtractor[] = [
  extractJsonLdFromDocument,
  extractMicrodata,
  extractOpenGraph,
];

export function extractFromDocument(
  doc: Document,
  ctx: ExtractContext,
  adapterExtractor?: DocumentExtractor | null,
): ProductRef | null {
  const ladder = adapterExtractor
    ? [extractJsonLdFromDocument, extractMicrodata, adapterExtractor, extractOpenGraph]
    : GENERIC_EXTRACTORS;

  for (const extractor of ladder) {
    try {
      const product = extractor(doc, ctx);
      if (isUsable(product)) return product;
    } catch {
      // A broken extractor must never take the page down with it.
    }
  }
  return null;
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
