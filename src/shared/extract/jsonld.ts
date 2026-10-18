import { normalizeGtin, parsePrice } from '../normalize';
import type { ProductRef } from '../types';

/**
 * Tier 1. Retailers publish schema.org Product markup because they want Google
 * to index it, which is why one extractor covers Shopify, WooCommerce,
 * BigCommerce, Squarespace and most Magento without a line of site-specific
 * code. This is the whole reason the extension is not Amazon-only.
 *
 * Two entry points on purpose: the content script has a real Document, the
 * server has an HTML string from a fetch. Same parser underneath, so a
 * candidate the AI proposes is validated by the exact code path that read the
 * page the user is standing on.
 */

const SCRIPT_RE =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

export function jsonLdNodesFromHtml(html: string): unknown[] {
  const nodes: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) nodes.push(...safeParse(match[1] ?? ''));
  return nodes;
}

export function jsonLdNodesFromDocument(doc: Document): unknown[] {
  const nodes: unknown[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    nodes.push(...safeParse(el.textContent ?? ''));
  });
  return nodes;
}

function safeParse(text: string): unknown[] {
  const trimmed = text.trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  if (!trimmed) return [];
  try {
    return flatten(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

/** Unwraps arrays and @graph containers into a flat node list. */
function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!isRecord(value)) return [];
  const graph = value['@graph'];
  if (graph) return [value, ...flatten(graph)];
  return [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function types(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
}

const PRODUCT_TYPES = new Set(['product', 'productmodel', 'individualproduct', 'productgroup']);

export function findProductNode(nodes: unknown[]): Record<string, unknown> | null {
  const products = nodes.filter(isRecord).filter((n) => types(n).some((t) => PRODUCT_TYPES.has(t)));
  if (products.length === 0) return null;
  // Prefer the node carrying an offer; a ProductGroup often has no price.
  return products.find((n) => n['offers'] !== undefined) ?? products[0]!;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (isRecord(value)) return text(value['name'] ?? value['@value'] ?? value['url']);
  return null;
}

function firstOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const offers = node['offers'];
  const list = Array.isArray(offers) ? offers : [offers];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    if (types(entry).includes('aggregateoffer')) {
      const low = entry['lowPrice'] ?? entry['price'];
      if (low !== undefined) return { price: low, priceCurrency: entry['priceCurrency'] };
      continue;
    }
    return entry;
  }
  return null;
}

/**
 * Shopify's current themes emit a ProductGroup with no offers of its own; the
 * price lives on each entry of hasVariant. The first variant with an offer
 * stands in for the group, which is what the page shows before a choice.
 */
function firstVariantWithOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const variants = node['hasVariant'];
  const list = Array.isArray(variants) ? variants : [variants];
  return list.filter(isRecord).find((v) => v['offers'] !== undefined) ?? null;
}

function gtinFrom(node: Record<string, unknown>): string | null {
  for (const key of ['gtin14', 'gtin13', 'gtin12', 'gtin8', 'gtin', 'ean', 'upc', 'isbn']) {
    const found = normalizeGtin(text(node[key]));
    if (found) return found;
  }
  const ids = node['productID'] ?? node['identifier'];
  const raw = text(ids);
  if (raw) {
    // "gtin13:0763332030243" and bare digits both appear in the wild.
    const stripped = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
    return normalizeGtin(stripped);
  }
  return null;
}

function massFrom(node: Record<string, unknown>): number | null {
  const weight = node['weight'];
  if (!isRecord(weight)) return null;
  const value = Number(text(weight['value']));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (text(weight['unitCode']) ?? text(weight['unitText']) ?? 'kg').toLowerCase();
  if (unit.includes('grm') || unit === 'g' || unit.includes('gram')) return value / 1000;
  if (unit.includes('lbr') || unit.includes('lb') || unit.includes('pound')) return value * 0.4536;
  if (unit.includes('onz') || unit === 'oz' || unit.includes('ounce')) return value * 0.02835;
  return value;
}

export function breadcrumbFrom(nodes: unknown[]): string | null {
  const crumb = nodes
    .filter(isRecord)
    .find((n) => types(n).includes('breadcrumblist'));
  if (!crumb) return null;
  const items = crumb['itemListElement'];
  if (!Array.isArray(items)) return null;
  const names = items
    .map((item) => (isRecord(item) ? text(item['name'] ?? item['item']) : null))
    .filter((n): n is string => !!n);
  return names.length ? names.join(' > ') : null;
}

export interface ExtractContext {
  site: string;
  url: string;
}

export function productFromJsonLd(nodes: unknown[], ctx: ExtractContext): ProductRef | null {
  const node = findProductNode(nodes);
  if (!node) return null;

  const title = text(node['name']);
  if (!title) return null;

  const variant = node['offers'] === undefined ? firstVariantWithOffer(node) : null;
  const offer = firstOffer(variant ?? node);
  const amount = offer ? parsePrice(text(offer['price'])) : null;
  const currency = offer ? text(offer['priceCurrency']) : null;

  return {
    site: ctx.site,
    siteId: text(node['sku']) ?? text(node['mpn']) ?? (variant ? text(variant['sku']) : null) ?? text(node['productGroupID']),
    url: text(offer?.['url']) ?? text(node['url']) ?? ctx.url,
    title,
    brand: text(node['brand']) ?? text(node['manufacturer']),
    gtin: gtinFrom(node) ?? (variant ? gtinFrom(variant) : null),
    price: amount === null ? null : { amount, currency: currency ?? 'CAD' },
    categoryHint: text(node['category']) ?? breadcrumbFrom(nodes),
    imageUrl: text(node['image']),
    massKg: massFrom(node),
    extraction: { tier: 'jsonld', confidence: 'high' },
  };
}

export function extractJsonLdFromHtml(html: string, ctx: ExtractContext): ProductRef | null {
  return productFromJsonLd(jsonLdNodesFromHtml(html), ctx);
}

export function extractJsonLdFromDocument(doc: Document, ctx: ExtractContext): ProductRef | null {
  return productFromJsonLd(jsonLdNodesFromDocument(doc), ctx);
}
