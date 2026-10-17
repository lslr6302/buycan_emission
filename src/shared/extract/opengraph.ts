import { parsePrice } from '../normalize';
import type { ProductRef } from '../types';
import { breadcrumbFromDom } from './microdata';
import type { ExtractContext } from './jsonld';

/**
 * Tier 3. Thin but widespread. Often the only thing a site publishes, and a
 * title plus a price is enough to run the pipeline.
 */

function meta(doc: Document, ...names: string[]): string | null {
  for (const name of names) {
    const el =
      doc.querySelector(`meta[property="${name}"]`) ?? doc.querySelector(`meta[name="${name}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  return null;
}

export function extractOpenGraph(doc: Document, ctx: ExtractContext): ProductRef | null {
  const title = meta(doc, 'og:title', 'twitter:title') ?? doc.title?.trim() ?? null;
  if (!title) return null;

  const amount = parsePrice(
    meta(doc, 'product:price:amount', 'og:price:amount', 'twitter:data1'),
  );
  // A page with no price is probably not a product page; refuse rather than guess.
  if (amount === null) return null;

  return {
    site: ctx.site,
    siteId: meta(doc, 'product:retailer_item_id'),
    url: meta(doc, 'og:url') ?? ctx.url,
    title,
    brand: meta(doc, 'product:brand', 'og:brand'),
    gtin: null,
    price: { amount, currency: meta(doc, 'product:price:currency', 'og:price:currency') ?? 'CAD' },
    categoryHint: meta(doc, 'product:category', 'article:section') ?? breadcrumbFromDom(doc),
    imageUrl: meta(doc, 'og:image', 'twitter:image'),
    massKg: null,
    extraction: { tier: 'opengraph', confidence: 'low' },
  };
}
