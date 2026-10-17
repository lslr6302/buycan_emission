import { parsePrice } from '../normalize';

/**
 * Last-resort DOM reads: the price - and the brand - a human can see.
 *
 * Structured data is preferred everywhere else, but large retailers publish
 * a schema.org Product with no price in it - Walmart.ca does exactly this -
 * and then the whole pipeline stalls on a page that plainly shows "$8.97".
 *
 * The hard part is not finding a dollar sign, it is avoiding the wrong one.
 * A product page is full of prices that are not the price: unit pricing
 * ("$1.61/100ml"), struck-out list prices, other sizes of the same item,
 * recommended products, financing offers. So candidates are weighted by how
 * strongly their markup claims to be *the* current price, and disqualified
 * on the patterns that reliably mean something else.
 */

export interface PriceCandidate {
  text: string;
  /** Higher means the markup makes a stronger claim to be the real price. */
  weight: number;
}

/** Per-unit pricing: "$1.61/100ml", "$0.04 per ml". */
const PER_UNIT = /\/\s*\d*\s*[a-z]|per\s+\d*\s*[a-z]/i;

/** Savings and finance copy that contains a number but is not the price. */
const NOT_A_PRICE = /%|save|off\b|was\b|reg\.|list price|\bper\s+month\b|\/mo\b|financ/i;

/** A page with a five-figure "price" has given us the wrong element. */
const MAX_PLAUSIBLE_CAD = 100_000;

/**
 * Chooses the best candidate. Pure, so the hard part is testable without a
 * browser - which matters here, because the sites that need this are the
 * ones that refuse to serve a readable page to anything but a real browser.
 */
export function pickPrice(candidates: PriceCandidate[]): number | null {
  let best: { value: number; weight: number } | null = null;

  for (const candidate of candidates) {
    const text = candidate.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) continue;
    if (PER_UNIT.test(text) || NOT_A_PRICE.test(text)) continue;

    const value = parsePrice(text);
    if (value === null || value <= 0 || value > MAX_PLAUSIBLE_CAD) continue;

    if (!best || candidate.weight > best.weight) best = { value, weight: candidate.weight };
  }

  return best?.value ?? null;
}

/**
 * Selectors ordered by how explicitly they identify the current price.
 * Attribute hooks beat class names, which retailers generate and churn.
 */
const PRICE_SELECTORS: Array<[string, number]> = [
  ['[itemprop="price"]', 100],
  ['meta[property="product:price:amount"]', 95],
  ['[data-automation-id*="current-price" i]', 90],
  ['[data-testid*="current-price" i]', 90],
  ['[aria-label*="current price" i]', 85],
  ['[data-automation-id*="price" i]', 70],
  ['[data-testid*="price" i]', 70],
  ['[itemprop="offers"] [content]', 65],
  ['[class*="current-price" i]', 60],
  ['[id*="price" i]', 40],
  ['[class*="price" i]', 30],
];

/** Struck-out or comparison prices, whatever the markup calls them. */
const STRIKETHROUGH = 's, del, strike, [class*="strike" i], [class*="was-price" i], [class*="list-price" i]';

/** Stop scanning once we have plenty; big retail pages have thousands. */
const MAX_CANDIDATES = 60;

export function findVisiblePrice(doc: Document): number | null {
  const candidates: PriceCandidate[] = [];

  for (const [selector, weight] of PRICE_SELECTORS) {
    if (candidates.length >= MAX_CANDIDATES) break;
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue; // A selector this browser dislikes is not worth dying for.
    }

    for (const node of Array.from(nodes).slice(0, 25)) {
      if (node.closest(STRIKETHROUGH)) continue;

      const text =
        node.getAttribute('content') ??
        node.getAttribute('aria-label') ??
        node.textContent ??
        '';
      if (text) candidates.push({ text, weight });
    }
  }

  return pickPrice(candidates);
}


// ---------------------------------------------------------------------------

/** Brand hooks, strongest claim first. */
const BRAND_SELECTORS = [
  '[itemprop="brand"]',
  'meta[property="product:brand"]',
  'meta[name="brand"]',
  '[data-automation-id*="brand" i]',
  '[data-testid*="brand" i]',
  'a[href*="/brand/"]',
  'a[href*="/brands/"]',
  '[class*="brand-name" i]',
];

/** Link text that is navigation, not a brand. */
const NOT_A_BRAND = /^(shop|all|view|more|see|visit|brands?|home)/i;

/**
 * The brand as rendered on the page.
 *
 * Worth having even though the ownership lookup can recover a brand from the
 * title: an unlinked brand means the whole curated brand-to-brand match is
 * unreachable, and the user gets "Unknown brand" over a verdict we could
 * have given confidently.
 */
export function findVisibleBrand(doc: Document): string | null {
  for (const selector of BRAND_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of Array.from(nodes).slice(0, 5)) {
      const raw =
        node.getAttribute('content') ?? node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const value = raw.replace(/^(brand|by)\s*:?\s*/i, '').trim();
      if (!value || value.length > 60 || NOT_A_BRAND.test(value)) continue;
      return value;
    }
  }
  return null;
}
