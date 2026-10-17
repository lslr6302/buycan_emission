import { extractFromHtml } from '../../shared/extract';
import { normalizeSite } from '../../shared/normalize';
import type { GateRejection, ProductRef } from '../../shared/types';
import type { AiCandidate } from '../ai/client';

/**
 * Validation gates for AI-proposed candidates.
 *
 * This is the highest-risk path in the system. A model asked to find a
 * Canadian alternative will cheerfully invent a company, a storefront and a
 * product URL - which is precisely the failure the project exists to beat.
 *
 * So nothing the model returns is trusted. Each candidate must independently
 * clear every gate below, and anything that fails is DROPPED, never downgraded
 * and never shown with a warning label. A single hallucinated storefront in
 * front of a judge undoes the entire accuracy thesis.
 */

export interface GateResult {
  passed: boolean;
  rejection?: GateRejection;
  /** Re-extracted from the live page, so displayed facts come from the retailer. */
  verified?: ProductRef;
}

export interface GateOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Hostnames that are never a Canadian retailer's product page. */
const NON_STOREFRONT = [
  /(^|\.)example\.(com|org|net)$/,
  /(^|\.)example$/,
  /(^|\.)test$/,
  /(^|\.)localhost$/,
  /(^|\.)wikipedia\.org$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)pinterest\./,
  /(^|\.)blogspot\./,
  /(^|\.)medium\.com$/,
  /(^|\.)youtube\.com$/,
];

/** Search and category pages are not products, however plausible the URL. */
const NON_PRODUCT_PATH = /\/(search|s\/|results|category|categories|collections\/all|blog|news|about)(\/|$|\?)/i;

export async function runGates(
  candidate: AiCandidate,
  options: GateOptions = {},
): Promise<GateResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 6000;

  // Gate 0: a citation is mandatory. No source, no claim.
  if (!candidate.sourceUrl) {
    return reject('source_url_required', candidate.url, 'candidate carried no source_url');
  }

  // Gate 1: the URL has to be a real, parseable URL on a plausible storefront.
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return reject('url_malformed', candidate.url, 'not a parseable URL');
  }
  if (url.protocol !== 'https:') {
    return reject('url_not_https', candidate.url, `protocol was ${url.protocol}`);
  }

  const host = normalizeSite(url.hostname);
  if (NON_STOREFRONT.some((re) => re.test(host))) {
    return reject('not_a_storefront', candidate.url, `${host} is not a retail domain`);
  }
  if (NON_PRODUCT_PATH.test(url.pathname)) {
    return reject('not_a_product_page', candidate.url, `path "${url.pathname}" looks like a search or category page`);
  }

  // Gate 2: the page must actually resolve, and it must parse as a product
  // through the SAME extractor the content script uses. "We could not read a
  // price off it" therefore means the same thing on both sides of the wire.
  let html: string;
  try {
    const response = await withTimeout(
      fetchImpl(url.toString(), {
        redirect: 'follow',
        headers: { 'user-agent': 'buycan-emission/0.1 (+hackathon project; contact via repo)' },
      }),
      timeoutMs,
    );
    if (!response.ok) {
      return reject('url_unreachable', candidate.url, `HTTP ${response.status}`);
    }
    html = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'fetch failed';
    return reject('url_unreachable', candidate.url, detail);
  }

  const verified = extractFromHtml(html, { site: host, url: url.toString() });
  if (!verified) {
    return reject(
      'not_a_product_page',
      candidate.url,
      'no schema.org Product with a price could be extracted from the page',
    );
  }

  // Gate 3: it has to be purchasable in Canada. A Canadian brand sold only
  // into the US is not an alternative for a Canadian shopper.
  if (!shipsToCanada(host, verified, html)) {
    return reject('not_available_in_canada', candidate.url, 'no evidence the page sells into Canada');
  }

  return { passed: true, verified };
}

/**
 * Deliberately conservative. A .ca domain or an explicit CAD price counts;
 * anything else is treated as unproven, because a wrong "ships to Canada" is a
 * user who cannot actually buy the thing we recommended.
 */
function shipsToCanada(host: string, verified: ProductRef, html: string): boolean {
  if (host.endsWith('.ca')) return true;
  if (verified.price?.currency?.toUpperCase() === 'CAD') return true;
  return /\b(ships?\s+to\s+canada|canadian\s+(shipping|orders)|CAD)\b/i.test(html.slice(0, 200_000));
}

function reject(gate: string, url: string, detail: string): GateResult {
  return { passed: false, rejection: { gate, url, detail } };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
