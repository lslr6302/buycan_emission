import { extractFromDocument } from '../shared/extract';
import { normalizeSite } from '../shared/normalize';
import { isStrongMatch } from '../shared/scoring';
import type { CartLine, ProductRef } from '../shared/types';
import { resolveAdapter } from './adapters';
import {
  DEFAULT_SETTINGS,
  type Message,
  type PageReport,
  type Response,
  type Settings,
} from './messages';
import {
  isDismissed,
  removeOverlay,
  renderCart,
  renderProduct,
  renderSearch,
  setPageKey,
} from './overlay';

/**
 * Content script. Resolves which site we are on, extracts, asks the worker,
 * renders. It makes no network calls of its own - the page it runs inside must
 * never be able to observe our traffic, and API keys live on the server.
 */

const site = normalizeSite(location.hostname);
const adapter = resolveAdapter(location.hostname);

/**
 * Deliberately console.info, not a debug flag. When the overlay does not
 * appear there are half a dozen possible reasons and no way to tell them
 * apart from outside; this makes the page console say which one it was.
 */
function log(...args: unknown[]): void {
  console.info('[buycan]', ...args);
}

/**
 * Never throws. An unhandled rejection here is invisible: the page stays
 * blank, no log appears, and every diagnostic still claims success. The
 * usual cause is the service worker having failed to start, which produces
 * "Could not establish connection. Receiving end does not exist."
 */
async function send(message: Message): Promise<Response> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as Response | undefined;
    if (!response) {
      return { ok: false, error: 'no response from the extension service worker' };
    }
    return response;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[buycan] could not reach the service worker:', detail);
    return { ok: false, error: `service worker unreachable: ${detail}` };
  }
}

/**
 * Sent on every page, including ones we do nothing on. The popup renders it,
 * which is what makes testing a new storefront possible: "generic / none"
 * means the site publishes no product markup, "jsonld / product" with no
 * candidates means the dataset has no match. Those need different fixes and
 * look identical without this.
 */
function report(patch: Partial<PageReport>): void {
  const base: PageReport = {
    site,
    url: location.href,
    adapterId: adapter.id,
    pageKind: 'none',
    tier: null,
    title: null,
    brand: null,
    gtin: null,
    priceCad: null,
    cartLines: null,
    searchQuery: null,
    overlay: 'not_attempted',
    error: null,
  };
  void send({ type: 'report', report: { ...base, ...patch } }).catch(() => undefined);
}

async function settings(): Promise<Settings> {
  try {
    const response = await send({ type: 'getSettings' });
    return response.ok && response.kind === 'settings' ? response.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// --- product pages ---------------------------------------------------------

/**
 * Extraction, retried while the page hydrates.
 *
 * Single-page apps inject their structured data and render their price
 * after the first paint, so one early attempt reports "nothing here" on a
 * page that is about to be perfectly readable - which is what happens when
 * you click through from a search result rather than loading the URL
 * directly. Backs off quickly and gives up rather than polling forever.
 */
async function extractWithRetry(): Promise<ProductRef | null> {
  const delays = [0, 300, 700, 1200, 2000];
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const found = extractFromDocument(document, { site, url: location.href }, adapter.product ?? null);
    if (found) {
      if (delay > 0) log(`extracted after ${delay}ms (page was still hydrating)`);
      return found;
    }
    // The URL changed under us; the navigation handler owns it now.
    if (location.href !== currentUrl) return null;
  }
  return null;
}

async function runProduct(): Promise<void> {
  const product = await extractWithRetry();

  if (!product) {
    log('product page, but nothing extractable (no JSON-LD, microdata, OG price, or adapter match)');
    report({ pageKind: 'product', error: 'no product could be extracted from this page' });
    return; // Nothing readable here. Stay silent on the page itself.
  }

  log('extracted', {
    tier: product.extraction.tier,
    brand: product.brand,
    price: product.price?.amount ?? null,
    title: product.title.slice(0, 60),
  });

  report({
    pageKind: 'product',
    tier: product.extraction.tier,
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    priceCad: product.price?.amount ?? null,
  });

  const response = await send({ type: 'resolve', product });
  if (!response.ok || response.kind !== 'resolve') {
    const detail = response.ok ? 'unexpected reply' : response.error;
    log('lookup failed:', detail);
    report({ pageKind: 'product', tier: product.extraction.tier, title: product.title, error: detail });
    return;
  }

  const base = {
    pageKind: 'product' as const,
    tier: product.extraction.tier,
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    priceCad: product.price?.amount ?? null,
  };

  log('resolved', {
    ownStatus: response.data.ownStatus,
    candidates: response.data.candidates.length,
    abstained: response.data.abstained,
  });

  if (response.data.abstained) {
    log('not rendering: abstained -', response.data.abstentionReason);
    report({ ...base, overlay: 'suppressed_abstained' });
    return;
  }
  if (isDismissed()) {
    log('not rendering: dismissed on', site, '- clear it from the popup');
    report({ ...base, overlay: 'suppressed_dismissed' });
    return;
  }

  // Already Canadian: always worth showing, and always worth showing open.
  if (response.data.alreadyCanadian) {
    renderProduct(response.data, true);
    report({ ...base, overlay: 'shown' });
    return;
  }
  // Auto-expand only on a strong match. Anything weaker opens collapsed and
  // waits to be asked.
  renderProduct(response.data, isStrongMatch(response.data.candidates[0]));
  report({ ...base, overlay: 'shown' });
}

// --- cart pages ------------------------------------------------------------

async function readCart(): Promise<CartLine[]> {
  const config = await settings();

  // Demo mode exists because a live cart can fail on stage for reasons that
  // have nothing to do with the code: sign-out, a captcha, a layout test,
  // venue wifi. Same code path, same output, no dependency on the room.
  if (config.demoMode) {
    try {
      const fixture = await fetch(chrome.runtime.getURL('demo-cart.json'));
      return (await fixture.json()) as CartLine[];
    } catch {
      return [];
    }
  }

  if (!adapter.cart) return [];
  try {
    return await adapter.cart();
  } catch (error) {
    console.debug('[buycan] cart read failed', error);
    return [];
  }
}

// --- search results pages --------------------------------------------------

/**
 * The user typed what they want. That is cleaner input than any listing
 * title, so a search page is the single best place to offer an alternative -
 * and it is the moment the original pitch describes: search for a product,
 * get shown the Canadian option before you have committed to a brand.
 */
async function runSearch(): Promise<void> {
  const query = adapter.searchQuery?.() ?? null;
  if (!query) {
    report({ pageKind: 'search', error: 'could not read the search query from this page' });
    return;
  }

  report({ pageKind: 'search', searchQuery: query, tier: 'adapter' });

  const response = await send({ type: 'search', site, query });
  if (!response.ok || response.kind !== 'search') {
    report({
      pageKind: 'search',
      searchQuery: query,
      error: response.ok ? 'unexpected reply' : response.error,
    });
    return;
  }

  if (response.data.abstained || response.data.candidates.length === 0) {
    report({ pageKind: 'search', searchQuery: query, overlay: 'suppressed_abstained' });
    return;
  }
  if (isDismissed()) {
    report({ pageKind: 'search', searchQuery: query, overlay: 'suppressed_dismissed' });
    return;
  }
  renderSearch(response.data, query);
  report({ pageKind: 'search', searchQuery: query, tier: 'adapter', overlay: 'shown' });
}

let cartTimer: ReturnType<typeof setTimeout> | undefined;
let lastCartSignature = '';

async function runCart(): Promise<void> {
  const lines = await readCart();
  if (lines.length === 0) {
    report({ pageKind: 'cart', cartLines: 0, error: 'no cart lines could be read' });
    removeOverlay();
    return;
  }

  // Carts re-render constantly; only re-analyze when the contents changed.
  const signature = lines.map((l) => `${l.product.siteId}x${l.qty}`).join('|');
  if (signature === lastCartSignature) return;
  lastCartSignature = signature;

  report({ pageKind: 'cart', cartLines: lines.length, tier: 'adapter' });

  const response = await send({ type: 'analyzeCart', site, lines });
  if (!response.ok || response.kind !== 'cart') {
    report({
      pageKind: 'cart',
      cartLines: lines.length,
      error: response.ok ? 'unexpected reply' : response.error,
    });
    return;
  }
  if (isDismissed()) {
    report({ pageKind: 'cart', cartLines: lines.length, overlay: 'suppressed_dismissed' });
    return;
  }

  renderCart(response.data);
  report({ pageKind: 'cart', cartLines: lines.length, tier: 'adapter', overlay: 'shown' });
}

function scheduleCart(): void {
  clearTimeout(cartTimer);
  cartTimer = setTimeout(() => void guard('runCart', runCart), 400);
}

/**
 * Runs an async step and reports failures as a labelled console error.
 *
 * An unhandled rejection in a content script surfaces as a bare minified
 * stack in chrome://extensions, which says nothing about which step broke -
 * and the extension then silently does nothing on that page.
 */
async function guard(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`[buycan] ${label} failed on ${location.href}`, detail);
    report({ error: `${label} failed: ${detail.split('\n')[0]}` });
  }
}

// --- entry -----------------------------------------------------------------

let cartObserver: MutationObserver | undefined;

function start(): void {
  // Scopes dismissal to this page view: a different product, or the same
  // one revisited, gets a fresh panel.
  setPageKey(pageIdentity(location.href));

  const kind = adapter.pageKind();
  log(`adapter=${adapter.id} pageKind=${kind} url=${location.pathname.slice(0, 60)}`);
  if (kind === 'none') {
    report({ pageKind: 'none' });
    return;
  }

  if (kind === 'product') {
    void guard('runProduct', runProduct);
    return;
  }

  if (kind === 'search') {
    void guard('runSearch', runSearch);
    return;
  }

  scheduleCart();
  // The cart is re-rendered asynchronously on every quantity change, so a
  // one-shot read would miss most of the session.
  cartObserver = new MutationObserver(scheduleCart);
  cartObserver.observe(document.body, { childList: true, subtree: true });
}

/** Undo everything the previous page set up, before looking at the new one. */
function teardown(): void {
  cartObserver?.disconnect();
  cartObserver = undefined;
  clearTimeout(cartTimer);
  lastCartSignature = '';
  removeOverlay();
}

/**
 * Re-run on client-side navigation.
 *
 * Walmart and Amazon both swap products without a page load, so the content
 * script runs exactly once per tab. Without this the panel from the previous
 * product simply stays on screen - a Doritos page showing Head & Shoulders
 * alternatives, which is worse than showing nothing at all.
 *
 * The overlay is torn down the instant the URL changes, before the new
 * lookup finishes, so a stale verdict is never left sitting under a new
 * product.
 */
/**
 * Params retailers rewrite into the URL for their own tracking. Amazon in
 * particular mutates these constantly on a single product page, and
 * comparing raw hrefs made every rewrite look like a navigation - the
 * overlay was torn down and rebuilt eleven times on one page.
 */
const TRACKING_PARAMS =
  /^(ref_?|_encoding|th|psc|pd_rd_\w+|pf_rd_\w+|content-id|qid|sr|sprefix|crid|dib\w*|linkCode|tag|utm_\w+|gclid|fbclid|athbdg|smid)$/i;

/** The part of the URL that actually identifies which product we are on. */
function pageIdentity(href: string): string {
  try {
    const url = new URL(href);
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAMS.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return `${url.origin}${url.pathname}${params ? `?${params}` : ''}`;
  } catch {
    return href;
  }
}

let currentUrl = location.href;
let currentIdentity = pageIdentity(location.href);

/** A cheap fingerprint of what the page is currently showing. */
function pageSignature(): string {
  const heading = document.querySelector('h1')?.textContent?.trim().slice(0, 80) ?? '';
  return `${document.title.slice(0, 80)}|${heading}`;
}

function onNavigated(): void {
  if (location.href === currentUrl) return;
  currentUrl = location.href;

  // Same product, just a rewritten tracking URL. Rebuilding here would
  // throw away a perfectly good panel and re-query the API for nothing.
  const identity = pageIdentity(location.href);
  if (identity === currentIdentity) return;
  currentIdentity = identity;

  log('navigated, re-running');

  // Clear immediately: a stale panel under a new product is worse than no
  // panel at all, and the new lookup takes a moment.
  const before = pageSignature();
  teardown();

  // On a single-page app the URL changes before the new product renders, so
  // extracting straight away reads the OLD page and produces a result that
  // looks exactly like the bug we just fixed. Wait for the content to
  // actually change, then run.
  const deadline = Date.now() + 4000;
  const poll = setInterval(() => {
    const changed = pageSignature() !== before;
    if (changed || Date.now() > deadline) {
      clearInterval(poll);
      if (!changed) log('page content never changed after navigation; reading anyway');
      startWhenIdle();
    }
  }, 150);
}

function watchNavigation(): void {
  // The Navigation API reports SPA route changes directly where available.
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  if (nav && typeof nav.addEventListener === 'function') {
    nav.addEventListener('navigate', () => setTimeout(onNavigated, 150));
  }

  // History moves the Navigation API does not cover, plus older browsers.
  window.addEventListener('popstate', () => setTimeout(onNavigated, 150));

  // Backstop. A content script lives in an isolated world, so patching
  // history.pushState here would not intercept the page's own calls -
  // polling is the only thing guaranteed to notice every route change.
  setInterval(onNavigated, 700);
}

/**
 * Run when the browser is idle, never in the critical path.
 *
 * Extraction reads whatever the page gives us, and some of that is large.
 * Doing that work synchronously on load once froze a tab badly enough to
 * make the browser UI unresponsive; the timeout still guarantees we run on
 * a busy page.
 */
function startWhenIdle(): void {
  const run = () => {
    try {
      start();
    } catch (error) {
      console.warn('[buycan] startup failed', error);
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 0);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    startWhenIdle();
    watchNavigation();
  }, { once: true });
} else {
  startWhenIdle();
  watchNavigation();
}
