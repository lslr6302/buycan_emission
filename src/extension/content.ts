import { extractFromDocument } from '../shared/extract';
import { normalizeSite } from '../shared/normalize';
import { isStrongMatch } from '../shared/scoring';
import type { CartLine } from '../shared/types';
import { resolveAdapter } from './adapters';
import {
  DEFAULT_SETTINGS,
  type Message,
  type PageReport,
  type Response,
  type Settings,
} from './messages';
import { isDismissed, removeOverlay, renderCart, renderProduct, renderSearch } from './overlay';

/**
 * Content script. Resolves which site we are on, extracts, asks the worker,
 * renders. It makes no network calls of its own - the page it runs inside must
 * never be able to observe our traffic, and API keys live on the server.
 */

const site = normalizeSite(location.hostname);
const adapter = resolveAdapter(location.hostname);

/**
 * Bumped on every in-site navigation. A lookup that finishes after the
 * shopper has moved on must not paint the previous page's result.
 */
let runId = 0;
const stale = (id: number) => id !== runId;

function send(message: Message): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
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

async function runProduct(id: number): Promise<void> {
  const product = extractFromDocument(
    document,
    { site, url: location.href },
    adapter.product ?? null,
  );

  if (!product) {
    report({ pageKind: 'product', error: 'no product could be extracted from this page' });
    return; // Nothing readable here. Stay silent on the page itself.
  }

  report({
    pageKind: 'product',
    tier: product.extraction.tier,
    title: product.title,
    brand: product.brand,
    gtin: product.gtin,
    priceCad: product.price?.amount ?? null,
  });

  const response = await send({ type: 'resolve', product });
  if (stale(id)) return;
  if (!response.ok || response.kind !== 'resolve') {
    const detail = response.ok ? 'unexpected reply' : response.error;
    console.debug('[buycan]', detail);
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

  if (response.data.abstained) {
    report({ ...base, overlay: 'suppressed_abstained' });
    return;
  }
  if (await isDismissed()) {
    report({ ...base, overlay: 'suppressed_dismissed' });
    return;
  }
  if (stale(id)) return;

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
async function runSearch(id: number): Promise<void> {
  const query = adapter.searchQuery?.() ?? null;
  if (!query) {
    report({ pageKind: 'search', error: 'could not read the search query from this page' });
    return;
  }

  report({ pageKind: 'search', searchQuery: query, tier: 'adapter' });

  const response = await send({ type: 'search', site, query });
  if (stale(id)) return;
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
  if (await isDismissed()) {
    report({ pageKind: 'search', searchQuery: query, overlay: 'suppressed_dismissed' });
    return;
  }
  if (stale(id)) return;
  renderSearch(response.data, query);
  report({ pageKind: 'search', searchQuery: query, tier: 'adapter', overlay: 'shown' });
}

let cartTimer: ReturnType<typeof setTimeout> | undefined;
let cartObserver: MutationObserver | null = null;
let lastCartSignature = '';

async function runCart(id: number): Promise<void> {
  const lines = await readCart();
  if (stale(id)) return;
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
  if (stale(id)) return;
  if (!response.ok || response.kind !== 'cart') {
    report({
      pageKind: 'cart',
      cartLines: lines.length,
      error: response.ok ? 'unexpected reply' : response.error,
    });
    return;
  }
  if (await isDismissed()) {
    report({ pageKind: 'cart', cartLines: lines.length, overlay: 'suppressed_dismissed' });
    return;
  }

  renderCart(response.data);
  report({ pageKind: 'cart', cartLines: lines.length, tier: 'adapter', overlay: 'shown' });
}

function scheduleCart(): void {
  clearTimeout(cartTimer);
  const id = runId;
  cartTimer = setTimeout(() => void runCart(id), 400);
}

// --- entry -----------------------------------------------------------------

function start(): void {
  const id = runId;
  const kind = adapter.pageKind();
  if (kind === 'none') {
    report({ pageKind: 'none' });
    return;
  }

  if (kind === 'product') {
    void runProduct(id);
    return;
  }

  if (kind === 'search') {
    void runSearch(id);
    return;
  }

  scheduleCart();
  // The cart is re-rendered asynchronously on every quantity change, so a
  // one-shot read would miss most of the session.
  cartObserver = new MutationObserver(scheduleCart);
  cartObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Walmart, Amazon's newer pages and most modern storefronts are single-page
 * apps: going from results to a product swaps the URL without a page load,
 * so the content script never runs again on its own. Watch the URL and start
 * over when it changes. Polling, because a content script cannot hook the
 * page's own history.pushState.
 */
let lastUrl = location.href;
const NAVIGATION_POLL_MS = 1000;
/** Give the app time to render the new page (and its JSON-LD) before reading it. */
const SETTLE_MS = 1200;

function onNavigate(): void {
  runId++;
  clearTimeout(cartTimer);
  cartObserver?.disconnect();
  cartObserver = null;
  lastCartSignature = '';
  removeOverlay();
  setTimeout(() => {
    if (location.href === lastUrl) start();
  }, SETTLE_MS);
}

setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  onNavigate();
}, NAVIGATION_POLL_MS);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
