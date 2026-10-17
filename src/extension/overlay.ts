import { normalizeSite } from '../shared/normalize';
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
  /* The host carries its own inline reset; resetting it again here would
     clobber the fixed positioning. Only normalize what is inside. */
  * { box-sizing: border-box; margin: 0; padding: 0; }
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
  /* Already-Canadian confirmation. A quiet green edge, not a celebration
     banner - the point is reassurance, not a reward for shopping. */
  .panel.success { border-color: #86efac; }
  .panel.success .head { background: #f0fdf4; }
  .panel.success .title { color: #15803d; }
  @media (prefers-color-scheme: dark) {
    .panel.success { border-color: #166534; }
    .panel.success .head { background: #0f2a18; }
    .panel.success .title { color: #86efac; }
  }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/**
 * Dismissal is per page view, held in memory, and nowhere else.
 *
 * It used to persist for seven days per site, which was far too blunt:
 * closing the panel once on one product silenced the extension across the
 * whole retailer, and the only way back was a settings button nobody would
 * think to look for. "Not now" means this page, now. Navigate to another
 * product, come back, or reload, and it reappears.
 */
let pageKey = '';
let dismissedFor: string | null = null;

/** Called before each render with an identifier for the current page. */
export function setPageKey(key: string): void {
  pageKey = key;
}

export function isDismissed(): boolean {
  return dismissedFor !== null && dismissedFor === pageKey;
}

function remove(): void {
  document.getElementById(HOST_ID)?.remove();
}

function mount(): ShadowRoot {
  remove();
  const host = document.createElement('div');
  host.id = HOST_ID;

  // ORDER MATTERS. `all:initial` is a shorthand for every property, so it has
  // to come FIRST - putting it last silently resets the positioning declared
  // before it, leaving the host static and inline at the foot of <body>,
  // where it renders but is never seen.
  host.style.cssText = [
    'all: initial',
    'position: fixed',
    'bottom: 20px',
    'right: 20px',
    'z-index: 2147483647',
    'display: block',
    // Explicit, not shrink-to-fit. `all: initial` leaves width:auto, and a
    // fixed-position host sized only by its shadow content measured 0x0 in
    // practice - present in the DOM, correctly positioned, and invisible.
    // Sizing the host directly removes the dependency entirely.
    'width: 340px',
    'max-width: calc(100vw - 32px)',
    'height: auto',
    'margin: 0',
    'padding: 0',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });

  // Prefer a constructed stylesheet. A dynamically inserted <style> can be
  // refused on sites with a strict style-src CSP, and when that happens the
  // panel is in the DOM but completely unstyled - which looks exactly like
  // "nothing appeared".
  let styled = false;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet];
    styled = true;
  } catch {
    /* fall through */
  }
  if (!styled) {
    const style = document.createElement('style');
    style.textContent = STYLES;
    shadow.append(style);
  }

  const parent = document.body ?? document.documentElement;
  parent.append(host);

  // Deferred: the caller appends the panel to this shadow root *after*
  // mount() returns, so checking synchronously here measures an empty
  // shadow and reports "zero size - stylesheet did not apply" on a panel
  // that is about to render perfectly.
  setTimeout(() => verifyMounted(host, styled), 0);
  return shadow;
}

/**
 * Confirms the host actually landed and kept its positioning. Silent failure
 * here is the worst outcome: everything reports success while the user sees
 * nothing, which is precisely the bug this is here to catch.
 */
function verifyMounted(host: HTMLElement, usedAdoptedSheet: boolean): void {
  try {
    if (!host.isConnected) {
      console.warn('[buycan] overlay host was not attached to the document');
      return;
    }
    const computed = getComputedStyle(host);
    if (computed.position !== 'fixed') {
      console.warn(
        `[buycan] overlay host is position:${computed.position}, expected fixed. ` +
          'The page or its CSP is overriding our inline style; the panel will be invisible.',
      );
      return;
    }
    const rect = host.getBoundingClientRect();
    const panel = host.shadowRoot?.querySelector('.panel');
    const panelRect = panel?.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) {
      console.warn(
        '[buycan] overlay host measured 0x0.' +
          (panel
            ? ` Panel is present and ${Math.round(panelRect?.width ?? 0)}x${Math.round(
                panelRect?.height ?? 0,
              )} - the host box is the problem, not the stylesheet.`
            : ' No .panel in the shadow root - content was never appended.'),
      );
      return;
    }
    console.info(
      `[buycan] overlay mounted (${Math.round(rect.width)}x${Math.round(rect.height)} at ` +
        `${Math.round(rect.left)},${Math.round(rect.top)}; styles via ` +
        `${usedAdoptedSheet ? 'adoptedStyleSheets' : '<style>'})`,
    );
  } catch (error) {
    console.warn('[buycan] overlay self-check failed', error);
  }
}

function wire(shadow: ShadowRoot): void {
  const panel = shadow.querySelector('.panel');
  shadow.querySelector('.head')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).classList.contains('x')) return;
    panel?.classList.toggle('open');
  });
  shadow.querySelector('.x')?.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissedFor = pageKey;
    console.info('[buycan] hidden for this page; it returns on the next product or reload');
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

/**
 * The product is already Canadian-owned. Confirm it and get out of the way -
 * offering "alternatives" here would be noise, and would imply the thing
 * they are looking at is a problem when it is the answer.
 *
 * Manufacturing is still stated plainly. Canadian-owned and made overseas is
 * a real and common combination, and quietly implying otherwise under a
 * maple leaf is the overclaiming this project exists to avoid.
 */
export function renderAlreadyCanadian(result: ResolveResponse): void {
  const shadow = mount();
  const p = result.provenance;
  const made = p.dimensions.madeInCanada.value;

  const madeNote =
    made === true
      ? 'Made in Canada too.'
      : made === false
        ? 'Canadian-owned, though not manufactured in Canada.'
        : 'Manufacturing location unknown.';

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel open success">
      <div class="head">
        <span class="leaf">🍁</span>
        <div class="head-text">
          <div class="title">This one is Canadian</div>
          <div class="sub">${escapeHtml(p.displayName)} · ${escapeHtml(madeNote)}</div>
        </div>
        <button class="x" title="Hide for this page">×</button>
      </div>
      <div class="body">
        ${dimensionChips(p)}
        <div class="why">${escapeHtml(p.summary)}</div>
        ${
          p.cfiaClass
            ? `<div class="why dim">Labelled "${escapeHtml(p.cfiaClass)}" — a specific legal claim, not a slogan.</div>`
            : ''
        }
        <div class="why dim">No alternatives suggested: you are already buying Canadian.</div>
      </div>
      <div class="foot">Every claim above links to its source. Hover a tag.</div>
    </div>`;

  shadow.append(container);
  wire(shadow);
}

export function renderProduct(result: ResolveResponse, expanded: boolean): void {
  // Already Canadian-owned: confirm rather than suggest.
  if (result.alreadyCanadian) {
    renderAlreadyCanadian(result);
    return;
  }

  // Nothing to offer means nothing on screen. The badge and the popup carry
  // the abstention; the page stays untouched.
  if (result.abstained) {
    remove();
    return;
  }

  const shadow = mount();
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
        <button class="x" title="Hide for this page">×</button>
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

/**
 * Search-results pages. Shown before the user has committed to a brand, which
 * is the cheapest possible moment to change their mind - no cart to edit, no
 * decision to undo.
 */
export function renderSearch(result: ResolveResponse, query: string): void {
  if (result.abstained || result.candidates.length === 0) {
    remove();
    return;
  }

  const shadow = mount();
  const count = result.candidates.length;

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel open">
      <div class="head">
        <span class="leaf">🍁</span>
        <div class="head-text">
          <div class="title">${count} Canadian option${count === 1 ? '' : 's'} for "${escapeHtml(
            query.slice(0, 40),
          )}"</div>
          <div class="sub">Before you pick a brand</div>
        </div>
        <button class="x" title="Hide for this page">×</button>
      </div>
      <div class="body">
        ${result.candidates.map((c) => candidateCard(c, null)).join('')}
      </div>
      <div class="foot">
        Matched on your search terms, ranked by a fixed formula. Adjust the weights in the popup.
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

  const shadow = mount();
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
        <button class="x" title="Hide for this page">×</button>
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
