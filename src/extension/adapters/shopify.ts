import { normalizeGtin, normalizeSite } from '../../shared/normalize';
import type { CartLine, ProductRef } from '../../shared/types';
import type { SiteAdapter } from './types';

/**
 * The single best coverage-per-hour adapter in the project.
 *
 * Every Shopify store serves its cart as JSON at /cart.js, on its own domain,
 * with the same shape. One adapter therefore gets working cart support on
 * thousands of storefronts at once - including most Canadian independents,
 * which is exactly where the alternatives live.
 *
 * Product pages need no code here: Shopify emits schema.org Product markup, so
 * the generic tier-1 extractor already handles them.
 */

interface ShopifyCartItem {
  id: number;
  key: string;
  title: string;
  product_title?: string;
  variant_title?: string | null;
  quantity: number;
  /** Cents. */
  price: number;
  line_price: number;
  sku: string | null;
  vendor?: string;
  product_type?: string;
  url: string;
  barcode?: string | null;
}

interface ShopifyCart {
  items: ShopifyCartItem[];
  currency?: string;
}

function isShopify(): boolean {
  if ((window as unknown as { Shopify?: unknown }).Shopify) return true;
  return !!document.querySelector(
    'script[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"], #shopify-section-header',
  );
}

export const shopifyAdapter: SiteAdapter = {
  id: 'shopify',
  detect: isShopify,

  pageKind: () => {
    const path = location.pathname;
    if (/\/cart(\/|$)/.test(path)) return 'cart';
    if (/\/products\//.test(path)) return 'product';
    if (/\/search(\/|$)/.test(path)) return 'search';
    return 'none';
  },

  searchQuery: () => new URLSearchParams(location.search).get('q')?.trim() || null,

  product: null, // Shopify publishes JSON-LD; the generic ladder handles it.

  cart: async (): Promise<CartLine[]> => {
    const response = await fetch('/cart.js', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return [];

    const cart = (await response.json()) as ShopifyCart;
    const site = normalizeSite(location.hostname);
    const currency = cart.currency ?? 'CAD';

    return (cart.items ?? []).map((item) => {
      const product: ProductRef = {
        site,
        siteId: item.sku || String(item.id),
        url: new URL(item.url, location.origin).toString(),
        title: item.product_title ?? item.title,
        brand: item.vendor ?? null,
        gtin: normalizeGtin(item.barcode ?? null),
        price: { amount: item.price / 100, currency },
        categoryHint: item.product_type ?? null,
        imageUrl: null,
        massKg: null,
        extraction: { tier: 'adapter', confidence: 'high' },
      };
      return { product, qty: item.quantity };
    });
  },
};
