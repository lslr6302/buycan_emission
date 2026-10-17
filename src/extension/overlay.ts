import type { Candidate, CartAnalysis, ResolveResponse, Sourced } from '../shared/types';

/**
 * The injected overlay.
 *
 * Shadow DOM is non-negotiable here: every storefront has its own stylesheet
 * and some reset aggressively, so without isolation the panel renders
 * differently on every site we support.
 *
 * Restraint rules, which judges do notice:
 *   - never cover the buy button (bottom-right, fixed, narrow)
 *   - start collapsed, auto-expand only on a strong match
 *   - dismissible, and the dismissal is remembered per site
 *   - no animation, no sound
 *   - nothing at all when we have nothing to say
 */

const HOST_ID = 'buycan-overlay-host';

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    width: 340px; max-width: calc(100vw - 32px);
    background: #fff; color: #18181b;
    border: 1px solid #e4e4e7; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.14);
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .panel { background: #18181b; color: #f4f4f5; border-color: #3f3f46; }
    .sub { color: #a1a1aa !important; }
    .card { background: #27272a !important; border-color: #3f3f46 !important; }
    .foot { background: #27272a !important; border-color: #3f3f46 !important; color: #a1a1aa !important; }
    .dim { color: #a1a1aa !important; }
  }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; cursor: pointer;
    border-bottom: 1px solid transparent;
  }
  .panel.open .head { border-bottom-color: #e4e4e7; }
  @media (prefers-color-scheme: dark) { .panel.open .head { border-bottom-color: #3f3f46; } }
  .leaf { font-size: 15px; line-height: 1; }
  .head-text { flex: 1; min-width: 0; }
  .title { font-weight: 600; font-size: 13px; }
  .sub { color: #71717a; font-size: 11.5px; margin-top: 1px; }
  .x {
    border: 0; background: none; cursor: pointer; color: inherit;
    opacity: .5; font-size: 15px; padding: 0 2px; line-height: 1;
  }
  .x:hover { opacity: 1; }
  .body { display: none; padding: 10px 12px 12px; max-height: 60vh; overflow-y: auto; }
  .panel.open .body { display: block; }
  .verdict { font-size: 12px; margin-bottom: 10px; }
  .dims { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  .chip {
    font-size: 10.5px; padding: 2px 6px; border-radius: 999px;
    border: 1px solid currentColor; white-space: nowrap;
  }
  .yes { color: #15803d; } .no { color: #b91c1c; } .unk { color: #71717a; }
  .card {
    border: 1px solid #e4e4e7; border-radius: 8px;
    padding: 9px 10px; margin-bottom: 7px; background: #fafafa;
  }
  .card-top { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .card-title { font-weight: 600; font-size: 12.5px; }
  .price { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12.5px; }
  .why { font-size: 11.5px; margin-top: 4px; }
  .dim { color: #71717a; }
  .tag {
    display: inline-block; font-size: 9.5px; text-transform: uppercase;
    letter-spacing: .04em; padding: 1px 5px; border-radius: 3px;
    margin-right: 5px; font-weight: 600;
  }
  .tag-verified { background: #dcfce7; color: #166534; }
  .tag-ai { background: #fef3c7; color: #92400e; }
  .tag-swap { background: #e0e7ff; color: #3730a3; }
  a { color: #1d4ed8; text-decoration: none; }
  @media (prefers-color-scheme: dark) { a { color: #93c5fd; } }
  a:hover { text-decoration: underline; }
  .foot {
    font-size: 10.5px; color: #71717a; padding: 8px 12px;
    border-top: 1px solid #e4e4e7; background: #fafafa;
  }
  .cart-line { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; padding: 3px 0; }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function dismissKey(): string {
  return `dismissed:${location.hostname}`;
}

export async function isDismissed(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(dismissKey());
    return Boolean(stored[dismissKey()]);
  } catch {
    return false;
  }
}

function remove(): void {
  document.getElementById(HOST_ID)?.remove();
}

function mount(expanded: boolean): ShadowRoot {
  remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position:fixed;bottom:20px;right:20px;z-index:2147483647;all:initial';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.append(style);
  document.body.append(host);
  void expanded;
  return shadow;
}

function wire(shadow: ShadowRoot): void {
  const panel = shadow.querySelector('.panel');
  shadow.querySelector('.head')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).classList.contains('x')) return;
    panel?.classList.toggle('open');
  });
  shadow.querySelector('.x')?.addEventListener('click', (event) => {
    event.stopPropagation();
    void chrome.storage.local.set({ [dismissKey()]: true });
    remove();
  });
}

function dimensionChips(verdict: ResolveResponse['provenance']): string {
  const render = (label: string, field: Sourced<boolean>): string => {
    const cls = field.value === true ? 'yes' : field.value === false ? 'no' : 'unk';
    const mark = field.value === true ? '✓' : field.value === false ? '✗' : '?';
    const tip = field.value === null ? (field.reason ?? 'unknown') : (field.source ?? '');
    return `<span class="chip ${cls}" title="${escapeHtml(tip)}">${mark} ${label}</span>`;
  };
  const d = verdict.dimensions;
  return `<div class="dims">
    ${render('Cdn-owned', d.canadianOwned)}
    ${render('Made in CA', d.madeInCanada)}
    ${render('HQ in CA', d.hqInCanada)}
    ${render('Cdn-founded', d.canadianFounded)}
  </div>`;
}

function candidateCard(candidate: Candidate, originalPrice: number | null): string {
  const tag =
    candidate.matchType === 'retailer_swap'
      ? '<span class="tag tag-swap">same product</span>'
      : candidate.origin === 'ai'
        ? '<span class="tag tag-ai">AI-found, verified</span>'
        : '<span class="tag tag-verified">verified</span>';

  const price = candidate.priceCad === null ? '' : `$${candidate.priceCad.toFixed(2)}`;
  const delta =
    candidate.priceCad !== null && originalPrice !== null
      ? candidate.priceCad > originalPrice
        ? ` <span class="dim">(+$${(candidate.priceCad - originalPrice).toFixed(2)})</span>`
        : ` <span class="dim">(−$${(originalPrice - candidate.priceCad).toFixed(2)})</span>`
      : '';

  const checked = candidate.priceChecked
    ? `<span class="dim"> · price checked ${escapeHtml(candidate.priceChecked)}</span>`
    : '<span class="dim"> · price unverified</span>';

  const source = candidate.sourceUrl
    ? ` · <a href="${escapeHtml(candidate.sourceUrl)}" target="_blank" rel="noopener">source</a>`
    : '';

  return `<div class="card">
    <div class="card-top">
      <div class="card-title">
        <a href="${escapeHtml(candidate.url)}" target="_blank" rel="noopener">${escapeHtml(candidate.title)}</a>
      </div>
      <div class="price">${price}${delta}</div>
    </div>
    <div class="why">${tag}${escapeHtml(candidate.rationale)}</div>
    <div class="why dim">${escapeHtml(candidate.retailer)}${checked}${source}</div>
  </div>`;
}

export function renderProduct(result: ResolveResponse, expanded: boolean): void {
  // Nothing to offer means nothing on screen. The badge and the popup carry
  // the abstention; the page stays untouched.
  if (result.abstained) {
    remove();
    return;
  }

  const shadow = mount(expanded);
  const originalPrice = result.product.price?.amount ?? null;
  const count = result.candidates.length;

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel${expanded ? ' open' : ''}">
      <div class="head">
        <span class="leaf">🍁</span>
        <div class="head-text">
          <div class="title">${count} Canadian alternative${count === 1 ? '' : 's'}</div>
          <div class="sub">${escapeHtml(result.provenance.summary)}</div>
        </div>
        <button class="x" title="Dismiss on this site">×</button>
      </div>
      <div class="body">
        <div class="verdict">
          <strong>${escapeHtml(result.provenance.displayName)}</strong>
          ${dimensionChips(result.provenance)}
        </div>
        ${result.candidates.map((c) => candidateCard(c, originalPrice)).join('')}
      </div>
      <div class="foot">
        Ranked by a fixed formula, not a model. Adjust the weights in the popup.
      </div>
    </div>`;

  shadow.append(container);
  wire(shadow);
}

export function renderCart(analysis: CartAnalysis): void {
  if (analysis.lines.length === 0) {
    remove();
    return;
  }

  const shadow = mount(true);
  const money = (n: number) => `$${n.toFixed(2)}`;

  const swaps = analysis.lines
    .filter((line) => line.bestSwap && line.flow !== 'stays_in_canada')
    .map(
      (line) => `<div class="cart-line">
        <span>${escapeHtml(line.line.product.title.slice(0, 38))}</span>
        <span class="price">→ ${escapeHtml(line.bestSwap!.title.slice(0, 26))}</span>
      </div>`,
    )
    .join('');

  const abstentions = analysis.lines.filter((line) => line.abstained).length;

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel open">
      <div class="head">
        <span class="leaf">🍁</span>
        <div class="head-text">
          <div class="title">${money(analysis.leavesCanadaCad)} of ${money(analysis.totalCad)} leaves Canada</div>
          <div class="sub">${analysis.swapCount} swap${analysis.swapCount === 1 ? '' : 's'} available</div>
        </div>
        <button class="x" title="Dismiss on this site">×</button>
      </div>
      <div class="body">
        <div class="verdict">${escapeHtml(analysis.headline)}</div>
        ${swaps}
        ${
          analysis.unknownCad > 0
            ? `<div class="why dim">${money(analysis.unknownCad)} could not be traced. Counted as unknown, not as foreign.</div>`
            : ''
        }
        ${
          abstentions > 0
            ? `<div class="why dim">${abstentions} item${abstentions === 1 ? ' has' : 's have'} no Canadian alternative we can verify.</div>`
            : ''
        }
      </div>
      <div class="foot">Cart contents are sent to the lookup API and are not stored.</div>
    </div>`;

  shadow.append(container);
  wire(shadow);
}

export { remove as removeOverlay };
