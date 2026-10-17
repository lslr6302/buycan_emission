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

async function runProduct(): Promise<void> {
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
  if (await isDismissed()) {
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
  if (await isDismissed()) {
    report({ pageKind: 'cart', cartLines: lines.length, overlay: 'suppressed_dismissed' });
    return;
  }

  renderCart(response.data);
  report({ pageKind: 'cart', cartLines: lines.length, tier: 'adapter', overlay: 'shown' });
}

function scheduleCart(): void {
  clearTimeout(cartTimer);
  cartTimer = setTimeout(() => void runCart(), 400);
}

// --- entry -----------------------------------------------------------------

function start(): void {
  const kind = adapter.pageKind();
  if (kind === 'none') {
    report({ pageKind: 'none' });
    return;
  }

  if (kind === 'product') {
    void runProduct();
    return;
  }

  if (kind === 'search') {
    void runSearch();
    return;
  }

  scheduleCart();
  // The cart is re-rendered asynchronously on every quantity change, so a
  // one-shot read would miss most of the session.
  new MutationObserver(scheduleCart).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
