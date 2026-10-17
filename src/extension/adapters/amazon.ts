import { breadcrumbFromDom } from '../../shared/extract';
import { normalizeSite, parsePrice } from '../../shared/normalize';
import type { CartLine, ProductRef } from '../../shared/types';
import type { SiteAdapter } from './types';

/**
 * The tier-4 case. Amazon publishes no schema.org Product markup, so the
 * generic ladder comes back empty and everything has to be read off the DOM.
 *
 * Anchor on stable hooks - `data-asin`, `#productTitle`, `#bylineInfo` - and
 * never on class names, which Amazon churns and A/B tests continuously. Each
 * selector is tried in a list so a single rename degrades one field instead of
 * the whole feature.
 *
 * This is one site among several. It is not the design centre.
 */

function firstText(...selectors: string[]): string | null {
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

function asinFromPage(): string | null {
  const fromUrl = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (fromUrl) return fromUrl[1]!.toUpperCase();
  const input = document.querySelector<HTMLInputElement>('input#ASIN, input[name="ASIN"]');
  return input?.value?.toUpperCase() ?? null;
}

/** "Visit the Dove Store" / "Brand: Dove" -> "Dove" */
function brandFromByline(): string | null {
  const raw = firstText('#bylineInfo', '#brand', 'a#bylineInfo_feature_div');
  if (!raw) return null;
  return (
    raw
      .replace(/^Visit the\s+/i, '')
      .replace(/\s+Store$/i, '')
      .replace(/^Brand:\s*/i, '')
      .trim() || null
  );
}

export const amazonAdapter: SiteAdapter = {
  id: 'amazon',
  match: /(^|\.)amazon\.(ca|com)$/,

  pageKind: () => {
    const path = location.pathname;
    if (/\/gp\/cart\/|\/cart\b/.test(path)) return 'cart';
    if (/\/(dp|gp\/product)\//.test(path)) return 'product';
    return 'none';
  },

  product: (_doc, ctx): ProductRef | null => {
    const title = firstText('#productTitle', '#title span');
    if (!title) return null;

    const amount = parsePrice(
      firstText(
        '#corePrice_feature_div .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-offscreen',
        '.priceToPay .a-offscreen',
        '#price_inside_buybox',
        '#priceblock_ourprice',
      ),
    );

    return {
      site: ctx.site,
      siteId: asinFromPage(),
      url: ctx.url,
      title,
      brand: brandFromByline(),
      gtin: null, // Amazon does not expose barcodes; the ASIN is the only key.
      price: amount === null ? null : { amount, currency: 'CAD' },
      categoryHint: breadcrumbFromDom(document) ?? firstText('#wayfinding-breadcrumbs_feature_div'),
      imageUrl:
        document.querySelector<HTMLImageElement>('#landingImage, #imgTagWrapperId img')?.src ?? null,
      massKg: null,
      extraction: { tier: 'adapter', confidence: 'medium' },
    };
  },

  cart: async (): Promise<CartLine[]> => {
    const site = normalizeSite(location.hostname);

    return [...document.querySelectorAll<HTMLElement>('[data-asin]')]
      .filter((el) => el.closest('[data-name="Active Items"]')) // skip saved-for-later
      .filter((el) => !!el.dataset.asin)
      .map((el) => {
        const title =
          el.querySelector('.sc-product-title, .sc-grid-item-product-title, [data-a-size="base-plus"]')
            ?.textContent?.replace(/\s+/g, ' ')
            .trim() ?? '';

        const qtySelect = el.querySelector<HTMLSelectElement>('select[name*="quantity"]');
        const qtyText = el.querySelector('[data-a-selector="value"], .sc-quantity-textfield')?.textContent;
        const qty = Number(qtySelect?.value ?? qtyText?.trim() ?? 1) || 1;

        const amount = parsePrice(
          el.querySelector('.sc-product-price, .sc-price, .a-price .a-offscreen')?.textContent,
        );

        const product: ProductRef = {
          site,
          siteId: el.dataset.asin!,
          url: `https://${location.hostname}/dp/${el.dataset.asin}`,
          title,
          brand: null, // Not in the cart DOM; the server resolves it from the ASIN.
          gtin: null,
          price: amount === null ? null : { amount, currency: 'CAD' },
          categoryHint: null,
          imageUrl: null,
          massKg: null,
          extraction: { tier: 'adapter', confidence: 'medium' },
        };
        return { product, qty };
      })
      .filter((line) => line.product.title.length > 0);
  },
};
