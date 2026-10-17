import type { ProductRef } from './types';

/**
 * GTIN normalization. UPC-12, EAN-13 and GTIN-14 are the same number at
 * different lengths, so everything is left-padded to 14 before comparison.
 * The check digit is verified because leading-zero loss and transcription
 * errors are endemic in scraped product feeds.
 */
export function normalizeGtin(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  const padded = digits.padStart(14, '0');
  return gtinCheckDigitValid(padded) ? padded : null;
}

export function gtinCheckDigitValid(padded14: string): boolean {
  if (!/^\d{14}$/.test(padded14)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = Number(padded14[i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(padded14[13]);
}

const BRAND_NOISE = [
  /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|nv|bv|plc|holdings?|group|brands?)\b/g,
  /\bcanada\b/g,
  /\bthe\b/g,
];

/** Messy brand string -> canonical key. Entity linking lives on top of this. */
export function normalizeBrand(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[&]/g, ' and ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  for (const re of BRAND_NOISE) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Visit-by-hostname label, e.g. "www.well.ca" -> "well.ca". */
export function normalizeSite(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Stable cache key, best available identifier first. GTIN wins because it is
 * the only one that recognizes the same product on a different storefront.
 */
export function productKey(ref: Pick<ProductRef, 'gtin' | 'site' | 'siteId' | 'brand' | 'title'>): string {
  if (ref.gtin) return `gtin:${ref.gtin}`;
  if (ref.siteId) return `site:${ref.site}:${ref.siteId}`;
  return `hash:${hashString(`${normalizeBrand(ref.brand)}|${normalizeTitle(ref.title)}`)}`;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to',
  'new', 'pack', 'size', 'count', 'ct', 'pc', 'pcs', 'set', 'free',
]);

export function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(/[\s.]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** "CA$54.99", "$54.99 CAD", "54,99 $" -> 54.99 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s| /g, '');

  // Grab the whole number first. An earlier version capped the leading run
  // at three digits unless a thousands separator followed, so "1234.50" read
  // as 123 and "250000.00" as 250 - wrong by three orders of magnitude, and
  // silent.
  const match = cleaned.match(/\d[\d.,]*/);
  if (!match) return null;

  let num = match[0].replace(/[.,]+$/, '');
  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator.
    if (lastComma > lastDot) num = num.replace(/\./g, '').replace(',', '.');
    else num = num.replace(/,/g, '');
  } else {
    const sep = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
    if (sep) {
      const parts = num.split(sep);
      const trailing = parts[parts.length - 1]!;
      // One separator with 1-2 trailing digits is a decimal point;
      // anything else (1,234 / 1.234.567) is thousands grouping.
      const isDecimal = parts.length === 2 && trailing.length <= 2;
      num = isDecimal
        ? `${parts[0]}.${trailing}`
        : parts.join('');
    }
  }

  const value = Number(num);
  return Number.isFinite(value) ? value : null;
}

const PROVINCE_REGIONS: Record<string, string> = {
  AB: 'CA-AB', BC: 'CA-BC', MB: 'CA-MB', NB: 'CA-NB', NL: 'CA-NL',
  NS: 'CA-NS', NT: 'CA-NT', NU: 'CA-NU', ON: 'CA-ON', PE: 'CA-PE',
  QC: 'CA-QC', SK: 'CA-SK', YT: 'CA-YT',
};

export function provinceToRegion(province: string | null | undefined): string | null {
  if (!province) return null;
  return PROVINCE_REGIONS[province.trim().toUpperCase()] ?? null;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
