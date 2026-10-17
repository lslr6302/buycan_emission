import { normalizeSite } from './normalize';

/**
 * Where alternatives may come from. The shopper's own site is always searched
 * first; these four are the only other places we look.
 *
 * All of them are searched from the shopper's browser, not the server: on
 * 2026-10-17 Amazon served the server a blank page, Sobeys and Food Basics a
 * 403, and Walmart a "Verify Your Identity" wall after a handful of requests.
 */
export const ALTERNATIVE_RETAILERS = ['amazon.ca', 'walmart.ca', 'foodbasics.ca', 'sobeys.com'] as const;

/** Names shown on candidate cards. */
export const RETAILER_NAMES: Record<string, string> = {
  'amazon.ca': 'Amazon.ca',
  'walmart.ca': 'Walmart',
  'foodbasics.ca': 'Food Basics',
  'sobeys.com': 'Sobeys',
};

/** "www.amazon.ca" matches "amazon.ca"; "notamazon.ca" does not. */
export function hostMatches(hostname: string, domain: string): boolean {
  const host = normalizeSite(hostname);
  return host === domain || host.endsWith(`.${domain}`);
}

export function hostOf(url: string): string | null {
  try {
    return normalizeSite(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Search order: the site the shopper is on, then the fixed four. */
export function allowedSitesFor(currentSite: string | null | undefined): string[] {
  const current = currentSite ? normalizeSite(currentSite) : null;
  const sites = current ? [current] : [];
  for (const retailer of ALTERNATIVE_RETAILERS) {
    if (!sites.some((s) => hostMatches(retailer, s) || hostMatches(s, retailer))) sites.push(retailer);
  }
  return sites;
}

/** The entry of `sites` this URL belongs to, or null when it is off the list. */
export function siteFor(url: string, sites: readonly string[]): string | null {
  const host = hostOf(url);
  if (!host) return null;
  return sites.find((site) => hostMatches(host, site)) ?? null;
}
