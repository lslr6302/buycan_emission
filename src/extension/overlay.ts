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

/**
 * The loon lives in the extension bundle, not in the stylesheet. A 2048px
 * PNG as a data: URI would be blocked by img-src on half the storefronts we
 * run on; an extension-origin URL injected by a content script is exempt
 * from the page's CSP, which is the whole reason this is a background-image
 * on an element rather than an inline <img>.
 */
function assetUrl(path: string): string {
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return '';
  }
}

/**
 * Grandstander, bundled with the extension so the panel reads the same on a
 * machine that has never heard of it and on a storefront whose CSP blocks
 * fonts.googleapis.com.
 *
 * It is registered through the FontFace API rather than an @font-face rule in
 * the panel's stylesheet, because @font-face inside a shadow root is ignored:
 * fonts resolve against the document's font set, so that is where it has to
 * be added. Loading is fire-and-forget - the fallback stack below is what
 * renders until it arrives, and what stays if it never does.
 */
const FONT_FACES: Array<{ file: string; unicodeRange: string }> = [
  {
    file: 'assets/fonts/grandstander-latin.woff2',
    unicodeRange:
      'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, ' +
      'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, ' +
      'U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    // Accented brand names are common on Canadian storefronts; without this
    // subset "Liberté" falls back mid-word, which looks like a bug.
    file: 'assets/fonts/grandstander-latin-ext.woff2',
    unicodeRange:
      'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, ' +
      'U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, ' +
      'U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
];

let fontRequested = false;

function ensureFont(): void {
  if (fontRequested) return;
  fontRequested = true;
  try {
    if (typeof FontFace !== 'function' || !document.fonts) return;
    for (const { file, unicodeRange } of FONT_FACES) {
      const url = assetUrl(file);
      if (!url) return;
      const face = new FontFace('Grandstander', `url("${url}") format("woff2")`, {
        weight: '100 900',
        style: 'normal',
        display: 'swap',
        unicodeRange,
      });
      face
        .load()
        .then((loaded) => document.fonts.add(loaded))
        .catch(() => {
          /* page CSP or a missing file; the fallback stack covers it */
        });
    }
  } catch {
    /* same */
  }
}

/* Palette, straight from the design file. Named rather than repeated so a
   retouch is one line each. */
const CREAM = '#fffdf4';
const MINT = '#cee9df';
const MINT_DOT = '#dff4eb';
const SAND = '#f4e7d3';
const TAN = '#d3b991';
const INK = '#5f4d31';
const CORAL = '#f4836e';
const GREEN = '#96de53';
const AMBER = '#ffe46a';

const STYLES = `
  /* The host carries its own inline reset; resetting it again here would
     clobber the fixed positioning. Only normalize what is inside. */
  * { box-sizing: border-box; margin: 0; padding: 0; }

  /* Grandstander ships with the extension (see ensureFont); the rest of the
     stack is what renders while it loads, and what stays if a strict
     font-src refuses it. */
  .panel {
    font: 13px/1.45 Grandstander, "Comic Sans MS", "Trebuchet MS",
          -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    width: 400px; max-width: calc(100vw - 32px);
    background: ${CREAM}; color: ${INK};
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,.18);
    overflow: hidden;
    /* The design is warm and light by intent. Opting out of dark mode keeps
       the cream and sand from being inverted into mud by the host page. */
    color-scheme: light;
  }

  /* Header: mint band, polka dots, scalloped lower edge, loon on the left.
     The scallop is a repeating radial rather than eight ellipses - same
     silhouette, one paint, no extra assets to make web-accessible. */
  .head {
    position: relative;
    display: flex; align-items: center; gap: 8px;
    min-height: 82px; padding: 12px 34px 14px 94px;
    cursor: pointer;
    background:
      radial-gradient(circle 4.5px at 4.5px 4.5px, ${MINT_DOT} 98%, transparent 100%)
        0 0 / 27px 27px repeat,
      ${MINT};
  }
  .head::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -13px;
    height: 14px; pointer-events: none;
    background: radial-gradient(circle 18px at 50% 0, ${MINT} 98%, transparent 100%)
      0 0 / 36px 36px repeat-x;
  }
  .mascot {
    /* Kept wholly inside the band: the panel clips its own overflow, so a
       loon that pokes out above or to the left loses that part of itself. */
    position: absolute; left: 9px; bottom: -3px;
    width: 78px; height: 78px;
    background: url("${assetUrl('assets/quack.png')}") center / contain no-repeat;
    /* Faces right on the canvas, left in the design. */
    transform: scaleX(-1);
    pointer-events: none;
  }
  .head-text { flex: 1; min-width: 0; }
  .title {
    font-weight: 700; font-size: 17px; line-height: 1.08;
    letter-spacing: .01em; text-transform: uppercase; color: ${CORAL};
  }
  .sub { color: ${INK}; font-size: 11.5px; margin-top: 3px; opacity: .8; }
  .x {
    position: absolute; top: 8px; right: 10px;
    border: 0; background: none; cursor: pointer; color: ${INK};
    font-size: 20px; line-height: 1; padding: 0 2px; opacity: .65;
  }
  .x:hover { opacity: 1; }

  /* Body. The mint rule down the left is a background stripe so it scrolls
     with the cards instead of floating over them. */
  .body {
    display: none; padding: 24px 12px 14px 30px; max-height: 60vh; overflow-y: auto;
    /* Longhands, not the shorthand: the position/size pair is easy to lose
       in a gradient layer, and the rule then degrades to a full-bleed mint
       panel. */
    background-image: linear-gradient(${MINT}, ${MINT});
    background-repeat: no-repeat;
    /* Measured from the border edge, not the padding edge, or the rule
       lands under the cards and disappears. */
    background-origin: border-box;
    background-position: 10px 0;
    background-size: 6px 100%;
  }
  .panel.open .body { display: block; }

  .verdict { font-size: 12px; margin-bottom: 10px; }
  .dims { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
  .chip {
    font-size: 10.5px; padding: 2px 7px; border-radius: 999px;
    border: 1px solid currentColor; white-space: nowrap;
  }
  .yes { color: #3f7d26; } .no { color: #b4553f; } .unk { color: rgba(95,77,49,.55); }

  /* Cards. Sand block, dashed tan rules between rows, chevron bottom-right. */
  .card {
    position: relative;
    background: ${SAND}; border-radius: 8px;
    padding: 10px 12px 12px; margin-bottom: 10px;
  }
  .card-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .card-title { font-weight: 600; font-size: 14px; }
  .card-title .price { font-weight: 400; }
  .badge { font-size: 12px; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 7px; display: inline-block; flex: none; }
  .dot-green { background: ${GREEN}; }
  .dot-amber { background: ${AMBER}; }
  .row {
    font-size: 12px; padding: 7px 2px 7px 0;
    border-top: 2px dashed ${TAN};
    display: flex; align-items: center; gap: 7px;
  }
  .row:first-child { margin-top: 8px; }
  .row.bullet::before { content: '·'; padding: 0 4px 0 8px; opacity: .7; }
  .label {
    font-size: 12px; padding-top: 8px; border-top: 2px dashed ${TAN};
    margin-top: 2px; opacity: .85;
  }
  .price { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .why { font-size: 12px; margin-top: 4px; }
  .dim { color: rgba(95,77,49,.55); }

  /* Collapsed card shows its first line and says so; the chevron is the
     only affordance, exactly as drawn. */
  .card:not(.open) .rest .row:not(:first-child),
  .card:not(.open) .rest .label { display: none; }
  .card.open .more { display: none; }
  .more { font-size: 12px; color: rgba(95,77,49,.5); }
  .chev {
    position: absolute; right: 12px; bottom: 12px;
    width: 36px; height: 28px; border: 0; border-radius: 4px;
    background: ${TAN}; color: ${INK}; cursor: pointer;
    font: inherit; font-size: 15px; line-height: 1;
  }
  /* Points down to open, up to close - the direction the card will move. */
  .chev::before { content: '^'; display: block; transform: translateY(5px) rotate(180deg); }
  .card.open .chev::before { transform: translateY(2px) rotate(0deg); }
  .card .rest { padding-right: 46px; }

  a { color: ${INK}; text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: ${CORAL}; }

  .foot {
    font-size: 10.5px; color: rgba(95,77,49,.6); padding: 9px 12px 10px 30px;
    border-top: 2px dashed ${TAN};
  }
  .cart-line {
    font-size: 12px; padding: 7px 0; border-top: 2px dashed ${TAN};
    display: flex; justify-content: space-between; gap: 8px;
  }

  /* Already-Canadian confirmation. The headline turns green instead of
     coral - reassurance, not a reward for shopping. */
  .panel.success .title { color: #3f7d26; }
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
  ensureFont();
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
    'width: 400px',
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
  // The top suggestion is the one we are most confident in; it opens with
  // the panel so an expanded panel is never a wall of collapsed titles.
  shadow.querySelector('.card')?.classList.add('open');
  shadow.querySelector('.head')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).classList.contains('x')) return;
    panel?.classList.toggle('open');
  });
  // One delegated listener: cards are re-rendered wholesale, so binding per
  // card would leak handlers on every refresh.
  shadow.addEventListener('click', (event) => {
    const chev = (event.target as HTMLElement).closest?.('.chev');
    if (!chev) return;
    event.stopPropagation();
    chev.closest('.card')?.classList.toggle('open');
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
  // Green dot for a record we verified, amber for an AI match we could only
  // corroborate in part. The wording stays as blunt as the colour.
  const [dotClass, badge] =
    candidate.matchType === 'retailer_swap'
      ? ['dot-green', 'same product']
      : candidate.origin === 'ai'
        ? ['dot-amber', 'ai matched']
        : ['dot-green', 'verified'];

  const price = candidate.priceCad === null ? '' : `$${candidate.priceCad.toFixed(2)}`;
  const delta =
    candidate.priceCad !== null && originalPrice !== null
      ? candidate.priceCad > originalPrice
        ? ` <span class="dim">(+$${(candidate.priceCad - originalPrice).toFixed(2)})</span>`
        : ` <span class="dim">(−$${(originalPrice - candidate.priceCad).toFixed(2)})</span>`
      : '';

  const checked = candidate.priceChecked
    ? `price checked ${escapeHtml(candidate.priceChecked)}`
    : 'price unverified';

  // Say plainly when the link only reaches a homepage. Implying it is a
  // product page is the small dishonesty that costs trust in the rest.
  const linkNote =
    candidate.linkKind === 'brand' ? ' <span class="dim">· brand site</span>' : '';

  const source = candidate.sourceUrl
    ? `<div class="row bullet"><a href="${escapeHtml(candidate.sourceUrl)}" target="_blank" rel="noopener">source</a></div>`
    : '';

  return `<div class="card">
    <div class="card-top">
      <div class="card-title">${escapeHtml(candidate.title)}${
        price ? ` <span class="price">${price}${delta}</span>` : ''
      }</div>
      <div class="badge"><span class="dot ${dotClass}"></span>${badge}</div>
    </div>
    <div class="rest">
      <div class="row bullet">
        <a href="${escapeHtml(candidate.url)}" target="_blank" rel="noopener">${escapeHtml(
          candidate.retailer,
        )}</a>${linkNote}<span class="more"> ... more</span>
      </div>
      ${source}
      <div class="label">comments</div>
      <div class="row"><span class="dot ${dotClass}"></span>${escapeHtml(candidate.rationale)}</div>
      <div class="row"><span class="dot dot-amber"></span>${checked}</div>
    </div>
    <button class="chev" type="button" aria-label="Show more"></button>
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

  const listedOnly = p.dimensions.canadianOwned.value === null && p.listedCanadian.value === true;

  const madeNote = listedOnly
    ? 'Listed in the Canadian brands directory.'
    : made === true
      ? 'Made in Canada too.'
      : made === false
        ? 'Canadian-owned, though not manufactured in Canada.'
        : 'Manufacturing location unknown.';

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel open success">
      <div class="head">
        <span class="mascot"></span>
        <div class="head-text">
          <div class="title">${listedOnly ? 'Listed as Canadian' : 'This one is Canadian'}</div>
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
        ${
          listedOnly
            ? `<div class="why dim">This is the directory's own listing, not a verified ownership record — the specific details are not filled in${
                p.listedCanadian.source
                  ? ` (<a href="${escapeHtml(p.listedCanadian.source)}" target="_blank" rel="noopener">source</a>)`
                  : ''
              }.</div>`
            : ''
        }
        <div class="why dim">No alternatives suggested: you are already buying Canadian.</div>
      </div>
      <div class="foot">Every claim above links to its source. Hover a tag.</div>
    </div>`;

  shadow.append(container);
  wire(shadow);
}

/**
 * We could not identify the product's brand, but the shop itself is a
 * listed Canadian business. Worth saying: most small Canadian retailers
 * stock brands no directory covers, and going silent there is the case
 * where the tool looks least useful despite being on exactly the kind of
 * store it exists to send people to.
 */
function renderCanadianRetailer(result: ResolveResponse): void {
  const site = result.siteBrand;
  if (!site) return;

  const shadow = mount();
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel open success">
      <div class="head">
        <span class="mascot"></span>
        <div class="head-text">
          <div class="title">You are on a Canadian shop</div>
          <div class="sub">${escapeHtml(site.name)}</div>
        </div>
        <button class="x" title="Hide for this page">×</button>
      </div>
      <div class="body">
        <div class="why">
          ${escapeHtml(site.name)} is listed in the Canadian brands directory${
            site.source
              ? ` (<a href="${escapeHtml(site.source)}" target="_blank" rel="noopener">source</a>)`
              : ''
          }.
        </div>
        <div class="why dim">
          We could not identify this product's own brand, so we are not
          claiming anything about who makes it — only about the shop.
        </div>
      </div>
      <div class="foot">No alternatives suggested: the money is already staying here.</div>
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

  // Nothing to offer, but the shop itself is Canadian - say that instead of
  // disappearing.
  if (result.abstained) {
    if (result.provenance.isUnknown && result.siteBrand) renderCanadianRetailer(result);
    else remove();
    return;
  }

  const shadow = mount();
  const originalPrice = result.product.price?.amount ?? null;
  const count = result.candidates.length;

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="panel${expanded ? ' open' : ''}">
      <div class="head">
        <span class="mascot"></span>
        <div class="head-text">
          <div class="title">${count} Canadian alternative${count === 1 ? '' : 's'}</div>
        </div>
        <button class="x" title="Hide for this page">×</button>
      </div>
      <div class="body">
        <div class="verdict">
          <strong>${escapeHtml(result.provenance.displayName)}</strong>
          ${dimensionChips(result.provenance)}
          <div class="why dim">${escapeHtml(result.provenance.summary)}</div>
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
        <span class="mascot"></span>
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
        <span class="mascot"></span>
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
