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

/**
 * Service worker. Holds every network call, so the content script never talks
 * to the API directly and the page it runs in can never see our traffic.
 *
 * Also owns the toolbar icon state, which is how abstention becomes visible:
 * when we have nothing to say the overlay never appears, but the badge
 * changes and the popup explains why.
 */

/**
 * Stamped at bundle time, so every rebuild starts with a cold cache. The
 * manual version constant this replaces was a standing trap: fix the server,
 * reload the page, and still be served yesterday's answer with no indication
 * why.
 */
declare const __BUILD_ID__: string;
const CACHE_VERSION = __BUILD_ID__;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Abstentions get a much shorter life than answers. "We found nothing" is
 * the response most likely to be invalidated by a data import or a retrieval
 * fix, and the cheapest to recompute - caching it for a day mostly serves to
 * hide progress.
 */
const ABSTENTION_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const tabStates = new Map<number, TabState>();

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
  const ttl = entry.data.abstained ? ABSTENTION_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - entry.at > ttl) return null;
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

  const data = await post<ResolveResponse>(
    '/v1/product/resolve',
    {
      product,
      weights: settings.weights,
      verifiedOnly: settings.verifiedOnly,
      destinationRegion: settings.province ? `CA-${settings.province}` : null,
    },
    settings,
  );
  await cachePut(`${CACHE_VERSION}:${key}`, data);
  return data;
}

async function searchAlternatives(site: string, query: string): Promise<ResolveResponse> {
  const settings = await getSettings();
  return post<ResolveResponse>(
    '/v1/search',
    { site, query, weights: settings.weights, verifiedOnly: settings.verifiedOnly },
    settings,
  );
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
function setBadge(tabId: number, state: 'match' | 'canadian' | 'abstain' | 'idle', count = 0): void {
  if (state === 'canadian') {
    void chrome.action.setBadgeText({ tabId, text: '✓' });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: '#15803D' });
    void chrome.action.setTitle({ tabId, title: 'Already Canadian-owned' });
  } else if (state === 'match') {
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
            const existing = tabStates.get(tabId);

            // Carry the result forward only when this is the SAME page.
            // A tab keeps its id across navigations, so preserving it
            // unconditionally left the previous product's verdict sitting
            // above the new page's diagnostics - the popup would say
            // "Doritos, foreign-owned" while describing a Walmart shampoo
            // page it had just failed to read.
            const samePage = existing?.url === message.report.url;

            tabStates.set(tabId, {
              url: message.report.url,
              site: message.report.site,
              kind: message.report.pageKind,
              resolve: samePage ? existing?.resolve : undefined,
              cart: samePage ? existing?.cart : undefined,
              report: message.report,
              updatedAt: Date.now(),
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
            tabStates.set(tabId, {
              ...tabStates.get(tabId),
              url: message.product.url,
              site: message.product.site,
              kind: 'product',
              resolve: data,
              updatedAt: Date.now(),
            });
            setBadge(
              tabId,
              data.alreadyCanadian ? 'canadian' : data.abstained ? 'abstain' : 'match',
              data.candidates.length,
            );
          }
          sendResponse({ ok: true, kind: 'resolve', data } satisfies Response);
          break;
        }
        case 'search': {
          const data = await searchAlternatives(message.site, message.query);
          if (tabId !== undefined) {
            tabStates.set(tabId, {
              ...tabStates.get(tabId),
              // Keep the page's url, so the follow-up report from the
              // content script is recognised as the same page.
              url: tabStates.get(tabId)?.url ?? '',
              site: message.site,
              kind: 'search',
              resolve: data,
              updatedAt: Date.now(),
            });
            setBadge(tabId, data.abstained ? 'abstain' : 'match', data.candidates.length);
          }
          sendResponse({ ok: true, kind: 'search', data } satisfies Response);
          break;
        }
        case 'analyzeCart': {
          const data = await analyzeCart(message.site, message.lines);
          if (tabId !== undefined) {
            tabStates.set(tabId, {
              ...tabStates.get(tabId),
              url: tabStates.get(tabId)?.url ?? '',
              site: message.site,
              kind: 'cart',
              cart: data,
              updatedAt: Date.now(),
            });
            setBadge(tabId, data.swapCount > 0 ? 'match' : 'abstain', data.swapCount);
          }
          sendResponse({ ok: true, kind: 'cart', data } satisfies Response);
          break;
        }
        case 'getTabState': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const state = tab?.id !== undefined ? (tabStates.get(tab.id) ?? null) : null;
          sendResponse({ ok: true, kind: 'tabState', data: state } satisfies Response);
          break;
        }
        case 'undismiss': {
          // Clear both the normalized and raw-host spellings; older builds
          // wrote the raw hostname.
          await chrome.storage.local.remove([
            `dismissed:${message.site}`,
            `dismissed:www.${message.site}`,
          ]);
          sendResponse({ ok: true, kind: 'tabState', data: null } satisfies Response);
          break;
        }
        case 'resetSite': {
          // Full wipe of everything cached or remembered, keeping only the
          // user's own settings. Dismissals and stale responses produce the
          // same symptom - "it stopped appearing" - so one button clears both.
          const stored = await chrome.storage.local.get(null);
          const doomed = Object.keys(stored).filter((k) => k !== 'settings');
          if (doomed.length > 0) await chrome.storage.local.remove(doomed);
          tabStates.clear();
          console.info(`[buycan] cleared ${doomed.length} stored key(s); settings kept`);
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
        const existing = tabStates.get(tabId);
        if (existing?.report) {
          existing.report = { ...existing.report, error: detail } satisfies PageReport;
        }
      }
      sendResponse({ ok: false, error: detail } satisfies Response);
    }
  })();

  return true; // Keep the channel open for the async reply.
});

chrome.tabs.onRemoved.addListener((tabId) => tabStates.delete(tabId));

/**
 * Drop a tab's state the moment it navigates.
 *
 * The same-page check in the report handler covers the usual case, but a
 * page we never run on sends no report at all - so without this, switching
 * from a product page to anything unsupported would leave the old verdict
 * on screen in the popup, attributed to a page that never produced it.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const existing = tabStates.get(tabId);
  if (existing && existing.url !== changeInfo.url) {
    tabStates.delete(tabId);
    setBadge(tabId, 'idle');
  }
});

/**
 * Drops every cached response left over from a previous build.
 *
 * Without this, old entries linger in storage forever: unreachable, because
 * keys are prefixed with the build id, but still occupying the quota. It
 * also means "reload the extension" is a complete answer to "the cache is
 * serving me something stale", with no button to find.
 */
async function purgeStaleCache(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get('cache');
    const cache = (stored.cache ?? {}) as Record<string, unknown>;
    const keys = Object.keys(cache);
    const fresh = keys.filter((k) => k.startsWith(`${CACHE_VERSION}:`));
    if (fresh.length === keys.length) return;

    const kept: Record<string, unknown> = {};
    for (const key of fresh) kept[key] = cache[key];
    await chrome.storage.local.set({ cache: kept });
    console.info(
      `[buycan] purged ${keys.length - fresh.length} cached response(s) from earlier builds`,
    );
  } catch (error) {
    console.warn('[buycan] cache purge failed', error);
  }
}

chrome.runtime.onInstalled.addListener(() => void purgeStaleCache());
chrome.runtime.onStartup.addListener(() => void purgeStaleCache());
void purgeStaleCache();
