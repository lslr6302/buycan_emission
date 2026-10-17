import type { DocumentExtractor } from '../../shared/extract';
import type { CartLine } from '../../shared/types';

export type PageKind = 'product' | 'cart' | 'search' | 'none';

/**
 * THE SITE SEAM.
 *
 * Everything storefront-specific lives behind this interface. Adding a site is
 * writing one file and registering it - no route, pipeline or UI changes.
 *
 * Most adapters are a few lines of URL matching and nothing else, because the
 * generic schema.org extractor already handles their product pages. The two
 * reasons an adapter needs real code:
 *
 *   1. The site publishes no structured product markup (Amazon).
 *   2. You want cart support. Carts have no schema.org equivalent, because no
 *      retailer has an SEO reason to mark up a page Google never sees.
 */
export interface SiteAdapter {
  id: string;

  /** Hostname test. Cheap, runs first. */
  match?: RegExp;

  /**
   * Runtime capability test, for platforms that are not identifiable by
   * hostname. Shopify is the case that matters: thousands of storefronts on
   * their own domains, all speaking the same cart API.
   */
  detect?: () => boolean;

  /**
   * Defaults to the live page. The content script may pass a freshly fetched
   * copy instead, when a single-page app left the live DOM without markup.
   */
  pageKind: (doc?: Document) => PageKind;

  /**
   * What the user typed, on a search-results page. Their own words are
   * cleaner input than any listing title, so this is the best signal the
   * extension ever gets.
   */
  searchQuery?: () => string | null;

  /** Tier-4 extraction. Null means the generic ladder handles this site. */
  product?: DocumentExtractor | null;

  /** Omit when the site has no cart support yet. */
  cart?: () => Promise<CartLine[]>;
}
