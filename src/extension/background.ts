import { productKey } from '../shared/normalize';
import type { CartAnalysis, CartLine, ProductRef, ResolveResponse } from '../shared/types';
import {
  DEFAULT_SETTINGS,
  type Message,
  type PageReport,
  type Response,
  type Settings,
  type TabState,
} from './messages';
import { searchStoresInBrowser } from './store-search';

/**
 * Service worker. Holds every network call, so the content script never talks
 * to the API directly and the page it runs in can never see our traffic.
 *
 * Also owns the toolbar icon state, which is how abstention becomes visible:
 * when we have nothing to say the overlay never appears, but the badge
 * changes and the popup explains why.
 */

/**
 * Bump when the response shape or the dataset changes. Without this, a stale
 * abstention cached before a data fix keeps being served for a day, and the
 * fix looks like it did not work.
 */
const CACHE_VERSION = 'v4';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

// --- per-tab state ---------------------------------------------------------

/**
 * Kept in session storage, not in memory: Chrome stops an idle service worker
 * after ~30s, and an in-memory map died with it - so opening the popup a
 * minute after the page loaded said "no supported shopping page".
 *
 * Updates for one tab are chained so a report landing mid-lookup cannot
 * overwrite the lookup's result with a stale read.
 */
const tabQueues = new Map<number, Promise<unknown>>();

async function getTab(tabId: number): Promise<TabState | undefined> {
  const key = `tab:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] as TabState | undefined;
}

function updateTab(tabId: number, change: (existing: TabState | undefined) => TabState): Promise<void> {
  const previous = tabQueues.get(tabId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await chrome.storage.session.set({ [`tab:${tabId}`]: change(await getTab(tabId)) });
    });
  tabQueues.set(tabId, next);
  return next;
}

// --- settings --------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// --- response cache --------------------------------------------------------

interface CacheEntry {
  at: number;
  data: ResolveResponse;
}

/**
 * Keyed on the stable product key, so the same item recognized on a different
 * storefront reuses the answer. Most lookups should never cross the network
 * twice - the 200ms render budget contains a round trip now that the dataset
 * lives in Postgres rather than in the extension.
 */
async function cacheGet(key: string): Promise<ResolveResponse | null> {
  const stored = await chrome.storage.local.get('cache');
  const cache = (stored.cache ?? {}) as Record<string, CacheEntry>;
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.data;
}

async function cachePut(key: string, data: ResolveResponse): Promise<void> {
  const stored = await chrome.storage.local.get('cache');
  const cache = (stored.cache ?? {}) as Record<string, CacheEntry>;
  cache[key] = { at: Date.now(), data };

  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys
      .sort((a, b) => (cache[a]!.at ?? 0) - (cache[b]!.at ?? 0))
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .forEach((stale) => delete cache[stale]);
  }
  await chrome.storage.local.set({ cache });
}

// --- api -------------------------------------------------------------------

async function post<T>(path: string, body: unknown, settings: Settings): Promise<T> {
  const response = await fetch(`${settings.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function resolve(product: ProductRef): Promise<ResolveResponse> {
  const settings = await getSettings();
  const key = productKey(product);

  const cached = await cacheGet(`${CACHE_VERSION}:${key}`);
  if (cached) return cached;

  const response = await post<ResolveResponse>(
    '/v1/product/resolve',
    {
      product,
      weights: settings.weights,
      verifiedOnly: settings.verifiedOnly,
      destinationRegion: settings.province ? `CA-${settings.province}` : null,
      browserCheck: true,
    },
    settings,
  );
  const { data, transientFailure } = await searchStoresInBrowser(response, settings.weights);
  // An AI outage or an unreachable store is not an answer; caching it would
  // keep saying "nothing found" for a day after the problem cleared.
  if (!data.diagnostics.aiError && !transientFailure) await cachePut(`${CACHE_VERSION}:${key}`, data);
  return data;
}

async function searchAlternatives(site: string, query: string): Promise<ResolveResponse> {
  const settings = await getSettings();
  const response = await post<ResolveResponse>(
    '/v1/search',
    { site, query, weights: settings.weights, verifiedOnly: settings.verifiedOnly, browserCheck: true },
    settings,
  );
  return (await searchStoresInBrowser(response, settings.weights)).data;
}

async function analyzeCart(site: string, lines: CartLine[]): Promise<CartAnalysis> {
  const settings = await getSettings();
  return post<CartAnalysis>(
    '/v1/cart/analyze',
    {
      site,
      lines,
      weights: settings.weights,
      verifiedOnly: settings.verifiedOnly,
      destinationRegion: settings.province ? `CA-${settings.province}` : null,
    },
    settings,
  );
}

// --- toolbar state ---------------------------------------------------------

/**
 * Abstention has to be visible without being loud. Silence alone cannot be
 * demonstrated on stage, and a user who sees nothing cannot tell "no Canadian
 * alternative exists" apart from "the extension is broken".
 */
function setBadge(tabId: number, state: 'match' | 'abstain' | 'idle', count = 0): void {
  if (state === 'match') {
    void chrome.action.setBadgeText({ tabId, text: String(count) });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#B5121B' });
    void chrome.action.setTitle({ tabId, title: `${count} Canadian alternative(s) found` });
  } else if (state === 'abstain') {
    void chrome.action.setBadgeText({ tabId, text: '–' });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#6B7280' });
    void chrome.action.setTitle({ tabId, title: 'No Canadian alternative found - click for why' });
  } else {
    void chrome.action.setBadgeText({ tabId, text: '' });
    void chrome.action.setTitle({ tabId, title: 'Canadian Alternatives' });
  }
}

// --- message handling ------------------------------------------------------

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  void (async () => {
    try {
      switch (message.type) {
        case 'report': {
          if (tabId !== undefined) {
            const report = message.report;
            await updateTab(tabId, (existing) => {
              // A new page (in-site navigation) must not inherit the last page's result.
              const samePage = existing?.url === report.url;
              return {
                url: report.url,
                site: report.site,
                kind: report.pageKind,
                resolve: samePage ? existing?.resolve : undefined,
                cart: samePage ? existing?.cart : undefined,
                report,
                updatedAt: Date.now(),
              };
            });
            if (message.report.pageKind === 'none' || message.report.error) {
              setBadge(tabId, 'idle');
            }
          }
          sendResponse({ ok: true, kind: 'tabState', data: null } satisfies Response);
          break;
        }
        case 'resolve': {
          const data = await resolve(message.product);
          if (tabId !== undefined) {
            await updateTab(tabId, (existing) => ({
              ...existing,
              url: existing?.url ?? message.product.url,
              site: message.product.site,
              kind: 'product',
              resolve: data,
              updatedAt: Date.now(),
            }));
            setBadge(tabId, data.abstained ? 'abstain' : 'match', data.candidates.length);
          }
          sendResponse({ ok: true, kind: 'resolve', data } satisfies Response);
          break;
        }
        case 'search': {
          const data = await searchAlternatives(message.site, message.query);
          if (tabId !== undefined) {
            await updateTab(tabId, (existing) => ({
              ...existing,
              url: existing?.url ?? '',
              site: message.site,
              kind: 'search',
              resolve: data,
              updatedAt: Date.now(),
            }));
            setBadge(tabId, data.abstained ? 'abstain' : 'match', data.candidates.length);
          }
          sendResponse({ ok: true, kind: 'search', data } satisfies Response);
          break;
        }
        case 'analyzeCart': {
          const data = await analyzeCart(message.site, message.lines);
          if (tabId !== undefined) {
            await updateTab(tabId, (existing) => ({
              ...existing,
              url: existing?.url ?? '',
              site: message.site,
              kind: 'cart',
              cart: data,
              updatedAt: Date.now(),
            }));
            setBadge(tabId, data.swapCount > 0 ? 'match' : 'abstain', data.swapCount);
          }
          sendResponse({ ok: true, kind: 'cart', data } satisfies Response);
          break;
        }
        case 'getTabState': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const state = tab?.id !== undefined ? ((await getTab(tab.id)) ?? null) : null;
          sendResponse({ ok: true, kind: 'tabState', data: state } satisfies Response);
          break;
        }
        case 'resetSite': {
          // Clears a sticky dismissal and the response cache together. Both
          // produce the same symptom - "it stopped appearing" - so they get
          // one button rather than two.
          const stored = await chrome.storage.local.get(null);
          const keys = Object.keys(stored).filter((k) => k.startsWith('dismissed:'));
          await chrome.storage.local.remove([...keys, 'cache']);
          sendResponse({ ok: true, kind: 'tabState', data: null } satisfies Response);
          break;
        }
        case 'getSettings': {
          sendResponse({ ok: true, kind: 'settings', data: await getSettings() } satisfies Response);
          break;
        }
        case 'setSettings': {
          sendResponse({
            ok: true,
            kind: 'settings',
            data: await setSettings(message.settings),
          } satisfies Response);
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' } satisfies Response);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (tabId !== undefined) {
        setBadge(tabId, 'idle');
        await updateTab(tabId, (existing) =>
          existing?.report
            ? { ...existing, report: { ...existing.report, error: detail } satisfies PageReport }
            : (existing ?? { url: '', site: '', kind: 'none', updatedAt: Date.now() }),
        ).catch(() => undefined);
      }
      sendResponse({ ok: false, error: detail } satisfies Response);
    }
  })();

  return true; // Keep the channel open for the async reply.
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabQueues.delete(tabId);
  void chrome.storage.session.remove(`tab:${tabId}`);
});
