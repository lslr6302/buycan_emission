import { jaccard, round, titleTokens } from '../../shared/normalize';

/**
 * Turns a brand homepage into a link to an actual product.
 *
 * The ownership dataset only knows a brand's website, so every suggestion
 * used to land on a homepage. architecture.md is blunt about why that is not
 * good enough: a judge will click it, and dropping someone on a homepage
 * makes them do the search themselves - which is the work the extension
 * exists to remove.
 *
 * Nearly every Canadian DTC brand in this dataset runs Shopify, and Shopify
 * publishes `/products.json`: real handles, titles, prices and images. One
 * cached request per brand turns a homepage into a deep link, and hands us
 * the prices the ownership dataset does not carry - which is also what makes
 * the price weighting mean anything again.
 *
 * Shopify's default robots.txt disallows /recommendations/products and not
 * /products.json, so this is permitted. We still send a real user-agent, cap
 * it at one request per brand per hour, and cache misses as well as hits so
 * a non-Shopify site is never re-fetched in a loop.
 */

export interface StorefrontProduct {
  url: string;
  title: string;
  priceCad: number | null;
  imageUrl: string | null;
  available: boolean;
  /** 0..1 overlap with the search terms. Low scores are discarded. */
  score: number;
}

interface ShopifyVariant {
  price?: string;
  available?: boolean;
}

interface ShopifyProduct {
  handle?: string;
  title?: string;
  product_type?: string;
  tags?: string[];
  variants?: ShopifyVariant[];
  images?: { src?: string }[];
}

interface CacheEntry {
  at: number;
  products: ShopifyProduct[] | null; // null = not a Shopify storefront
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const USER_AGENT = 'buycan-emission/0.1 (+hackathon project; one cached request per brand)';

/** A match this weak is a random product off the shelf, not an answer. */
const MIN_SCORE = 0.08;

/** How many top candidates to confirm with a HEAD before giving up. */
const MAX_VERIFY = 5;

/**
 * Hard price ceiling for a suggested product.
 *
 * Direct-to-consumer brands sell cases, and a 12-pack is a truthful listing
 * and a useless suggestion: $59.99 of tortilla chips is not an alternative
 * to a $4.49 bag, however well the words match. This was a scoring penalty
 * first, which was wrong - when the case pack is the only match it still
 * won. It is not a weaker answer, it is the wrong kind of answer, so it is
 * rejected outright and the card falls back to the brand link.
 *
 * The floor keeps very cheap items matchable: 3x of $1.50 would rule out
 * every real product.
 */
const PRICE_CEILING_MULTIPLE = 3;
const PRICE_CEILING_FLOOR_CAD = 12;

export function priceCeiling(referencePriceCad: number): number {
  return Math.max(referencePriceCad * PRICE_CEILING_MULTIPLE, PRICE_CEILING_FLOOR_CAD);
}

/**
 * Multi-product packs. They match on words, cost several times the item
 * being replaced, and are not what anyone asked for - a $128 "Ultimate
 * Self-Care Bundle" is not an alternative to a $9 body wash.
 */
const BUNDLE_PATTERN =
  /\b(bundle|kit|gift\s*set|variety\s*pack|sampler|collection|subscription|wholesale|case\s*of)\b/i;

/**
 * The noun the product has to actually be. Token overlap cannot tell a body
 * oil from a body wash - they share "body" and both are liquids in bottles -
 * so the product category gates the match rather than merely scoring it.
 */
const REQUIRED_NOUNS: Record<string, string[]> = {
  personal_care_hair: ['shampoo', 'conditioner', 'hair'],
  personal_care_body_wash: ['wash', 'cleanser', 'soap', 'shower'],
  personal_care_oral: ['toothpaste', 'tooth', 'mouthwash', 'floss'],
  personal_care_deodorant: ['deodorant', 'antiperspirant'],
  personal_care_lotion: ['lotion', 'cream', 'moisturizer', 'balm'],
  home_cleaning_laundry: ['laundry', 'detergent'],
  snacks_chips: ['chip', 'chips', 'crisp'],
  pantry_coffee: ['coffee', 'bean', 'beans', 'roast'],
  supplements_vitamin_d: ['vitamin', 'supplement'],
  apparel_basics_tee: ['shirt', 'tee', 'crewneck'],
  insulated_drinkware: ['bottle', 'tumbler', 'mug', 'flask'],
};

/**
 * What the candidate must be, given the shopper's product. A specific type
 * from the spec wins over the broader category: on a shampoo listing we want
 * shampoo, not merely something from the hair aisle.
 */
export function requiredNouns(category: string | null, type: string | null): string[] {
  if (type) return [type.toLowerCase()];
  if (category && REQUIRED_NOUNS[category]) return REQUIRED_NOUNS[category]!;
  return [];
}

const cache = new Map<string, CacheEntry>();

export function clearStorefrontCache(): void {
  cache.clear();
}

async function loadCatalogue(
  origin: string,
  fetchImpl: typeof fetch,
): Promise<ShopifyProduct[] | null> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  let products: ShopifyProduct[] | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${origin}/products.json?limit=250`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (response.ok) {
        const body = (await response.json()) as { products?: ShopifyProduct[] };
        if (Array.isArray(body.products)) products = body.products;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    products = null;
  }

  // Negative results are cached too: a non-Shopify brand should cost one
  // failed request per hour, not one per lookup.
  cache.set(origin, { at: Date.now(), products });
  return products;
}

/**
 * Market suffix on a Shopify handle, e.g. "...-qp-us" / "...-qp-ca".
 *
 * Stores using Shopify Markets list every market's products in one feed, but
 * serve each only under its own locale path. A US-market handle 404s for a
 * Canadian shopper - and because the redirect is client-side JavaScript, the
 * URL looks right for a second before dumping them on the homepage. That is
 * the bug this exists to prevent, and no amount of server-side checking from
 * our side would have caught it: curl sees a clean 200.
 */
const FOREIGN_MARKET = /-(us|uk|eu|au|de|fr|jp)$/i;
const CANADIAN_MARKET = /-ca$/i;

/** Locale paths to try, best first. */
const MARKET_PREFIXES = ['/en-ca', ''];

/**
 * Confirms a product really exists at this path, via Shopify's per-product
 * endpoint (`/products/<handle>.js`).
 *
 * An HTTP status check is not good enough, which cost a round of debugging:
 * the product page for a foreign-market handle answers 200 to Node's fetch
 * and 404 to curl, then client-side JavaScript bounces the visitor to the
 * homepage. The `.js` endpoint is unambiguous - it 404s when the handle is
 * not in that market - and it is a few hundred bytes instead of a full page.
 */
async function verifyProduct(
  origin: string,
  prefix: string,
  handle: string,
  fetchImpl: typeof fetch,
): Promise<{ title: string; priceCad: number | null; available: boolean } | null> {
  const key = `${origin}${prefix}/products/${handle}`;
  const cached = productCache.get(key);
  if (cached !== undefined) return cached;

  let result: { title: string; priceCad: number | null; available: boolean } | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${key}.js`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });
      if (response.ok) {
        const body = (await response.json()) as {
          title?: string;
          price?: number;
          available?: boolean;
        };
        if (body.title) {
          // Shopify reports prices in cents on this endpoint.
          const cents = typeof body.price === 'number' ? body.price : null;
          result = {
            title: body.title,
            priceCad: cents !== null && cents > 0 ? round(cents / 100) : null,
            available: body.available !== false,
          };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    result = null;
  }

  productCache.set(key, result);
  return result;
}

const productCache = new Map<
  string,
  { title: string; priceCad: number | null; available: boolean } | null
>();

export async function findProductLink(
  website: string,
  terms: string,
  /** The product must be one of these. Empty means no type gate. */
  mustBe: string[] = [],
  /** What the shopper is looking at, for sanity-checking case packs. */
  referencePriceCad: number | null = null,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StorefrontProduct | null> {
  let origin: string;
  try {
    origin = new URL(website).origin;
  } catch {
    return null;
  }

  const products = await loadCatalogue(origin, fetchImpl);
  if (!products || products.length === 0) return null;

  const wanted = titleTokens(terms);
  if (wanted.size === 0) return null;

  // Score everything first, then verify links for the best few. Verifying
  // all 250 would be absurd; verifying none is how we shipped a link that
  // 404s into a homepage redirect.
  const scored: Array<{ product: ShopifyProduct; score: number }> = [];

  for (const product of products) {
    if (!product.handle || !product.title) continue;
    if (BUNDLE_PATTERN.test(product.title)) continue;

    const haystack = [product.title, product.product_type ?? '', (product.tags ?? []).join(' ')]
      .join(' ')
      .trim();

    // Type gate before scoring: a body oil is not a body wash however many
    // words the two titles happen to share.
    if (mustBe.length > 0) {
      const lower = haystack.toLowerCase();
      if (!mustBe.some((noun) => lower.includes(noun))) continue;
    }

    // A foreign-market handle is excluded, not demoted. It resolves fine
    // from a server, which is what made this hard to see - but the store's
    // client-side market redirect bounces a Canadian visitor to the
    // homepage, so it is a product they cannot buy. Scoring it lower is not
    // enough: when it is the only match left it still wins, which is
    // exactly what happened.
    if (FOREIGN_MARKET.test(product.handle)) continue;

    let score = jaccard(wanted, titleTokens(haystack));
    if (score < MIN_SCORE) continue;

    const variant = product.variants?.find((v) => v.available) ?? product.variants?.[0];
    if (variant?.available) score += 0.05;

    // Case packs are excluded, not demoted. The title rarely says "case";
    // the price is the only reliable tell.
    const price = variant?.price === undefined ? null : Number(variant.price);
    if (referencePriceCad && price && price > priceCeiling(referencePriceCad)) continue;

    // An explicitly Canadian-market product is the ideal case.
    if (CANADIAN_MARKET.test(product.handle)) score += 0.15;

    scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score);

  for (const { product, score } of scored.slice(0, MAX_VERIFY)) {
    for (const prefix of MARKET_PREFIXES) {
      const verified = await verifyProduct(origin, prefix, product.handle!, fetchImpl);
      if (!verified) continue;

      // Re-apply the ceiling against the price the market actually charges,
      // which can differ from the one in the bulk feed.
      if (
        referencePriceCad &&
        verified.priceCad &&
        verified.priceCad > priceCeiling(referencePriceCad)
      ) {
        continue;
      }

      return {
        url: `${origin}${prefix}/products/${product.handle}`,
        title: verified.title,
        priceCad: verified.priceCad,
        imageUrl: product.images?.[0]?.src ?? null,
        available: verified.available,
        score,
      };
    }
  }

  // Everything scored well and nothing resolved. Better to send someone to a
  // working homepage than a product page that bounces them.
  return null;
}

/**
 * Search terms for a candidate: what the shopper is looking at, minus the
 * foreign brand name. "Head & Shoulders Classic Clean Shampoo" should search
 * a Canadian storefront for "classic clean shampoo", not for a competitor's
 * trademark, which would match nothing.
 */
export function searchTermsFor(
  originalTitle: string,
  originalBrand: string | null,
  category: string | null,
): string {
  const brandTokens = titleTokens(originalBrand ?? '');
  const kept = [...titleTokens(originalTitle)].filter((t) => !brandTokens.has(t));

  // The category carries the product noun when the title is all marketing.
  const categoryWords = (category ?? '').split('_').filter((w) => w.length > 2);
  return [...kept, ...categoryWords].join(' ');
}
