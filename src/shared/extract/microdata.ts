import { normalizeGtin, parsePrice } from '../normalize';
import type { ProductRef } from '../types';
import type { ExtractContext } from './jsonld';

/** Tier 2. Older custom builds that never migrated to JSON-LD. */

function propValue(scope: Element, name: string): string | null {
  const el = scope.querySelector(`[itemprop="${name}"]`);
  if (!el) return null;
  const attr =
    el.getAttribute('content') ??
    el.getAttribute('datetime') ??
    (el instanceof HTMLMetaElement ? el.content : null) ??
    (el instanceof HTMLImageElement ? el.src : null) ??
    (el instanceof HTMLAnchorElement ? el.href : null);
  const value = attr ?? el.textContent;
  return value?.trim() || null;
}

export function extractMicrodata(doc: Document, ctx: ExtractContext): ProductRef | null {
  const scope = doc.querySelector('[itemtype*="schema.org/Product" i]');
  if (!scope) return null;

  const title = propValue(scope, 'name');
  if (!title) return null;

  const offerScope = scope.querySelector('[itemtype*="schema.org/Offer" i]') ?? scope;
  const amount = parsePrice(propValue(offerScope, 'price'));

  return {
    site: ctx.site,
    siteId: propValue(scope, 'sku') ?? propValue(scope, 'mpn'),
    url: ctx.url,
    title,
    brand: propValue(scope, 'brand'),
    gtin:
      normalizeGtin(propValue(scope, 'gtin13')) ??
      normalizeGtin(propValue(scope, 'gtin12')) ??
      normalizeGtin(propValue(scope, 'gtin')) ??
      normalizeGtin(propValue(scope, 'productID')),
    price: amount === null ? null : { amount, currency: propValue(offerScope, 'priceCurrency') ?? 'CAD' },
    categoryHint: propValue(scope, 'category') ?? breadcrumbFromDom(doc),
    imageUrl: propValue(scope, 'image'),
    massKg: null,
    extraction: { tier: 'microdata', confidence: 'medium' },
  };
}

/** Last-ditch breadcrumb read for sites with no structured category. */
export function breadcrumbFromDom(doc: Document): string | null {
  const nav = doc.querySelector(
    'nav[aria-label*="readcrumb" i], .breadcrumb, .breadcrumbs, #breadcrumb, [class*="breadcrumb" i]',
  );
  if (!nav) return null;
  const parts = [...nav.querySelectorAll('a, li, span')]
    .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter((t) => t.length > 1 && t !== '/' && t !== '>')
    .filter((t, i, arr) => arr.indexOf(t) === i);
  return parts.length ? parts.slice(0, 6).join(' > ') : null;
}
