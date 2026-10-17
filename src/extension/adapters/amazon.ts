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

/**
 * Brand, from whichever of Amazon's several presentations is on this page.
 *
 * The byline alone is not enough: plenty of listings render the brand as a
 * logo image with no text node, and an unread brand costs us the curated
 * brand-to-brand match entirely - which is the good path.
 */
function brandFromPage(): string | null {
  const byline = cleanBrand(firstText('#bylineInfo', 'a#bylineInfo', '#brand', '#bylineInfo_feature_div'));
  if (byline) return byline;

  // The "Brand" row of the product-overview table. Stable and text-based.
  const fromTable = brandFromLabelledRow();
  if (fromTable) return fromTable;

  // Byline rendered as a logo: the alt text usually carries the brand.
  const logo = document.querySelector<HTMLImageElement>(
    '#bylineInfo_feature_div img, #brandLogo img, a[id*="byline" i] img',
  );
  const alt = cleanBrand(logo?.alt ?? null);
  if (alt) return alt;

  return null;
}

/** Scans label/value pairs for a row literally labelled "Brand". */
function brandFromLabelledRow(): string | null {
  const rows = document.querySelectorAll(
    '#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, ' +
      '#detailBullets_feature_div li, .a-normal.a-spacing-micro tr',
  );
  for (const row of rows) {
    const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const match = text.match(/^Brand\s*:?\s*(.+)$/i);
    if (match) {
      const value = cleanBrand(match[1] ?? null);
      if (value) return value;
    }
  }
  return null;
}

/** "Visit the Dove Store" / "Brand: Dove" / "Redken Logo" -> "Dove" / "Redken" */
function cleanBrand(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Brand\s*:?\s*/i, '')
    .replace(/\s+(logo|brand)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Guard against scraping a whole paragraph out of a mislabelled row.
  if (!cleaned || cleaned.length > 60) return null;
  return cleaned;
}

export const amazonAdapter: SiteAdapter = {
  id: 'amazon',
  match: /(^|\.)amazon\.(ca|com)$/,

  pageKind: () => {
    const path = location.pathname;
    if (/\/gp\/cart\/|\/cart\b/.test(path)) return 'cart';
    if (/\/(dp|gp\/product|gp\/aw\/d)\//.test(path)) return 'product';
    if (/^\/s\b/.test(path) || location.search.includes('k=')) return 'search';

    // URL shapes change and vary by locale. If the page is serving a product
    // title and an ASIN, it is a product page whatever the path looks like.
    if (document.querySelector('#productTitle, input#ASIN, input[name="ASIN"]')) return 'product';

    // Likewise, a results grid is a search page even on /b/ or /gp/bestsellers.
    if (document.querySelector('.s-search-results, [data-component-type="s-search-result"]')) {
      return 'search';
    }
    return 'none';
  },

  searchQuery: () => {
    const fromUrl = new URLSearchParams(location.search).get('k');
    if (fromUrl) return fromUrl.trim() || null;
    const box = document.querySelector<HTMLInputElement>('#twotabsearchtextbox');
    return box?.value?.trim() || null;
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
      brand: brandFromPage(),
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
