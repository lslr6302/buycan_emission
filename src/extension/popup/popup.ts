import { rank } from '../../shared/scoring';
import type { Candidate, Weights } from '../../shared/types';
import {
  DEFAULT_SETTINGS,
  type Message,
  type PageReport,
  type Response,
  type Settings,
  type TabState,
} from '../messages';

/**
 * Popup. Two jobs:
 *
 *   1. Explain the abstention. When no alternative exists the overlay never
 *      appears, so this is the only place that answer is visible - and an
 *      invisible feature cannot be demonstrated.
 *   2. Hold the weight sliders. Re-ranking runs locally against the cached
 *      candidates, so dragging a slider reorders instantly and never costs a
 *      round trip. That responsiveness is the point of a deterministic
 *      scoring function, and it is what sells it on stage.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings = DEFAULT_SETTINGS;
let tabState: TabState | null = null;

function send(message: Message): Promise<Response> {
  return chrome.runtime.sendMessage(message) as Promise<Response>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function candidateHtml(candidate: Candidate): string {
  const price = candidate.priceCad === null ? '' : `$${candidate.priceCad.toFixed(2)}`;
  const tag = candidate.origin === 'ai' ? 'AI-found, verified' : 'verified';
  return `<div class="card">
    <div class="card-title">
      <a href="${escapeHtml(candidate.url)}" target="_blank" rel="noopener">${escapeHtml(candidate.title)}</a>
    </div>
    <div class="muted">${price} · ${escapeHtml(candidate.retailer)} · ${tag} · score ${candidate.score.toFixed(2)}</div>
    <div class="muted">${escapeHtml(candidate.rationale)}</div>
  </div>`;
}

/**
 * Diagnostics. The reason this exists: when you point the extension at a new
 * storefront, "nothing happened" has at least four different causes and they
 * need different fixes. This says which one it was.
 */
function renderDiagnostics(): void {
  const host = $('diagnostics');
  const report = tabState?.report;

  if (!report) {
    host.innerHTML = '<div class="muted">No report from this page. The content script did not run here.</div>';
    return;
  }

  const rows: Array<[string, string]> = [
    ['Adapter', report.adapterId],
    ['Page kind', report.pageKind],
    ['Extraction', report.tier ?? 'none'],
  ];
  if (report.title) rows.push(['Title', report.title.slice(0, 70)]);
  if (report.brand) rows.push(['Brand', report.brand]);
  if (report.gtin) rows.push(['GTIN', report.gtin]);
  if (report.priceCad !== null) rows.push(['Price', `$${report.priceCad.toFixed(2)}`]);
  if (report.cartLines !== null) rows.push(['Cart lines', String(report.cartLines)]);

  const table = `<table class="diag">${rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;

  host.innerHTML = table + explain(report);
}

/** Turn the raw report into the one sentence that says what to do next. */
function explain(report: PageReport): string {
  if (report.error) {
    const unreachable = /fetch|network|Failed to fetch|ECONNREFUSED|returned 5/i.test(report.error);
    return `<div class="err" style="margin-top:8px"><strong>${
      unreachable ? 'Cannot reach the lookup API.' : 'Something went wrong.'
    }</strong>${escapeHtml(report.error)}${
      unreachable
        ? '<div class="muted" style="margin-top:4px">Start it with <code>npm run server</code>, or point the API endpoint below at a deployed one.</div>'
        : ''
    }</div>`;
  }

  if (report.pageKind === 'none') {
    return '<div class="muted" style="margin-top:8px">Not recognized as a product or cart page. Generic detection needs schema.org Product markup; this site may need its own adapter.</div>';
  }

  if (report.pageKind === 'cart' && report.cartLines === 0) {
    return '<div class="muted" style="margin-top:8px">Cart page detected but no lines could be read. This site needs a cart adapter.</div>';
  }

  if (!report.tier) {
    return '<div class="muted" style="margin-top:8px">Product page detected but nothing extractable. No JSON-LD, microdata or OpenGraph price found.</div>';
  }

  return `<div class="muted" style="margin-top:8px">Read via <code>${escapeHtml(report.tier)}</code>${
    report.gtin ? ' with a barcode, so cross-store matching is available.' : '. No barcode, so matching falls back to attributes.'
  }</div>`;
}

function render(): void {
  const status = $('status');
  const result = $('result');

  if (!tabState) {
    status.textContent = 'No supported shopping page detected.';
    result.innerHTML =
      '<div class="muted">Open a product or cart page on a supported storefront.</div>';
    return;
  }

  if (tabState.kind === 'cart' && tabState.cart) {
    const cart = tabState.cart;
    status.textContent = `${tabState.site} · cart`;
    result.innerHTML = `<div class="card"><div class="card-title">${escapeHtml(cart.headline)}</div></div>`;
    return;
  }

  const resolved = tabState.resolve;
  if (!resolved) {
    status.textContent = `${tabState.site} · nothing to report`;
    result.innerHTML = '';
    return;
  }

  status.textContent = `${escapeHtml(resolved.provenance.displayName)} · ${escapeHtml(resolved.provenance.summary)}`;

  // The abstention path. This is the whole reason the popup exists.
  if (resolved.abstained) {
    const rejected = resolved.diagnostics.aiCandidatesRejected;
    result.innerHTML = `
      <div class="abstain">
        <strong>No alternative shown.</strong><br />
        ${escapeHtml(resolved.abstentionMessage ?? '')}
        ${
          rejected > 0
            ? `<div class="muted" style="margin-top:7px">${rejected} candidate${rejected === 1 ? ' was' : 's were'} found and discarded for failing verification.</div>`
            : ''
        }
      </div>`;
    return;
  }

  const ranked = rank(resolved.candidates, settings.weights);
  result.innerHTML = ranked.map(candidateHtml).join('');
}

function bindSliders(): void {
  const inputs: Array<[keyof Weights, string, string]> = [
    ['equivalence', 'w-equiv', 'o-equiv'],
    ['canadian', 'w-cdn', 'o-cdn'],
    ['price', 'w-price', 'o-price'],
  ];

  for (const [key, inputId, outputId] of inputs) {
    const input = $<HTMLInputElement>(inputId);
    const output = $<HTMLOutputElement>(outputId);
    input.value = String(settings.weights[key]);
    output.textContent = settings.weights[key].toFixed(2);

    input.addEventListener('input', () => {
      settings.weights = { ...settings.weights, [key]: Number(input.value) };
      output.textContent = Number(input.value).toFixed(2);
      render(); // Local re-rank. No network, no latency.
    });

    input.addEventListener('change', () => {
      void send({ type: 'setSettings', settings: { weights: settings.weights } });
    });
  }
}

function bindSettings(): void {
  const api = $<HTMLInputElement>('api');
  api.value = settings.apiBaseUrl;
  api.addEventListener('change', () => {
    void send({ type: 'setSettings', settings: { apiBaseUrl: api.value.trim() } });
  });

  const province = $<HTMLSelectElement>('province');
  province.value = settings.province ?? '';
  province.addEventListener('change', () => {
    void send({ type: 'setSettings', settings: { province: province.value || null } });
  });

  const verifiedOnly = $<HTMLInputElement>('verified-only');
  verifiedOnly.checked = settings.verifiedOnly;
  verifiedOnly.addEventListener('change', () => {
    void send({ type: 'setSettings', settings: { verifiedOnly: verifiedOnly.checked } });
  });

  const demoMode = $<HTMLInputElement>('demo-mode');
  demoMode.checked = settings.demoMode;
  demoMode.addEventListener('change', () => {
    void send({ type: 'setSettings', settings: { demoMode: demoMode.checked } });
  });
}

async function init(): Promise<void> {
  const [settingsResponse, stateResponse] = await Promise.all([
    send({ type: 'getSettings' }),
    send({ type: 'getTabState' }),
  ]);

  if (settingsResponse.ok && settingsResponse.kind === 'settings') settings = settingsResponse.data;
  if (stateResponse.ok && stateResponse.kind === 'tabState') tabState = stateResponse.data;

  bindSliders();
  bindSettings();
  render();
  renderDiagnostics();
}

void init();
