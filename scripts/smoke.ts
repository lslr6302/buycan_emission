/**
 * Smoke tests for the parts that are easy to get quietly wrong.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Not a substitute for the eval harness - that measures accuracy against
 * hand-labelled ground truth. This just checks the machinery works.
 */
import { extractFromHtml } from '../src/shared/extract';
import { gtinCheckDigitValid, normalizeGtin, parsePrice, productKey } from '../src/shared/normalize';
import { DEFAULT_WEIGHTS, priceScore, rank, totalScore } from '../src/shared/scoring';
import { runGates } from '../src/server/pipeline/gates';
import { allowedSitesFor, siteFor } from '../src/shared/retailers';
import { listingMatchesLead, parseWalmartSearch, pickListing, searchUrl } from '../src/shared/stores';
import { rankPreferringSite } from '../src/shared/scoring';
import type { Candidate } from '../src/shared/types';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

// --- generic extraction ----------------------------------------------------

console.log('\nJSON-LD extraction (the claim that we are not Amazon-only)');

const shopifyHtml = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"Product",
 "name":"Green Beaver Natural Deodorant Stick, Unscented, 50 g",
 "sku":"GB-DEO-50","gtin13":"0628451123453",
 "brand":{"@type":"Brand","name":"The Green Beaver Company"},
 "category":"Personal Care > Deodorant",
 "weight":{"@type":"QuantitativeValue","value":70,"unitCode":"GRM"},
 "offers":{"@type":"Offer","price":"12.99","priceCurrency":"CAD",
           "availability":"https://schema.org/InStock"}}
</script></head><body></body></html>`;

const extracted = extractFromHtml(shopifyHtml, { site: 'greenbeaver.com', url: 'https://greenbeaver.com/x' });
check('extracts a product', extracted !== null);
check('reads title', extracted?.title.startsWith('Green Beaver') ?? false);
check('reads nested brand object', extracted?.brand === 'The Green Beaver Company');
check('reads price', extracted?.price?.amount === 12.99);
check('reads currency', extracted?.price?.currency === 'CAD');
check('converts grams to kg', extracted?.massKg === 0.07, String(extracted?.massKg));
check('tier is jsonld', extracted?.extraction.tier === 'jsonld');

const graphHtml = `<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","name":"Home"},{"@type":"ListItem","name":"Chips"}]},
 {"@type":"Product","name":"Covered Bridge Kettle Chips","offers":{"@type":"Offer","price":"4.49","priceCurrency":"CAD"}}]}
</script>`;
const fromGraph = extractFromHtml(graphHtml, { site: 'x.ca', url: 'https://x.ca/p' });
check('unwraps @graph', fromGraph?.title === 'Covered Bridge Kettle Chips');
check('falls back to breadcrumb for category', fromGraph?.categoryHint === 'Home > Chips');

const aggregateHtml = `<script type="application/ld+json">
{"@type":"Product","name":"Thing","offers":{"@type":"AggregateOffer","lowPrice":"19.99","priceCurrency":"CAD"}}
</script>`;
check('handles AggregateOffer', extractFromHtml(aggregateHtml, { site: 'x.ca', url: 'u' })?.price?.amount === 19.99);

const productGroupHtml = `<script type="application/ld+json">
{"@context":"http://schema.org/","@type":"ProductGroup","name":"Antiperspirant - Unscented",
 "brand":{"@type":"Brand","name":"Green Beaver"},"productGroupID":"8812",
 "hasVariant":[{"@type":"Product","sku":"GB-AP-UNS","gtin":"0628451123453",
   "offers":{"@type":"Offer","price":"12.99","priceCurrency":"CAD"}}]}
</script>`;
const fromGroup = extractFromHtml(productGroupHtml, { site: 'greenbeaver.com', url: 'u' });
check('reads price off a ProductGroup variant (current Shopify themes)', fromGroup?.price?.amount === 12.99);
check('reads sku and barcode off the variant', fromGroup?.siteId === 'GB-AP-UNS' && fromGroup?.gtin === '00628451123453',
  `${fromGroup?.siteId} ${fromGroup?.gtin}`);

check(
  'refuses a page with no price',
  extractFromHtml('<script type="application/ld+json">{"@type":"Product","name":"No price"}</script>', {
    site: 'x.ca',
    url: 'u',
  }) === null,
);
check('survives malformed JSON-LD', extractFromHtml('<script type="application/ld+json">{nope}</script>', { site: 'x', url: 'u' }) === null);

// --- GTIN ------------------------------------------------------------------

console.log('\nGTIN normalization (the only key that crosses storefronts)');

check('pads UPC-12 to 14', normalizeGtin('036000291452') === '00036000291452');
check('accepts valid EAN-13', normalizeGtin('4006381333931') === '04006381333931');
check('rejects a bad check digit', normalizeGtin('4006381333932') === null);
check('rejects a wrong length', normalizeGtin('12345') === null);
check('strips separators', normalizeGtin('0-36000-29145-2') === '00036000291452');
check('check digit validator', gtinCheckDigitValid('00036000291452'));

check(
  'same barcode on two sites yields one key',
  productKey({ gtin: '00036000291452', site: 'amazon.ca', siteId: 'B01', brand: 'x', title: 'y' }) ===
    productKey({ gtin: '00036000291452', site: 'well.ca', siteId: 'W99', brand: 'x', title: 'y' }),
);

// --- price parsing ---------------------------------------------------------

console.log('\nPrice parsing');
check('plain', parsePrice('$54.99') === 54.99);
check('with currency suffix', parsePrice('CA$1,234.50 CAD') === 1234.5);
check('european decimal comma', parsePrice('54,99 $') === 54.99);
check('null on junk', parsePrice('Currently unavailable') === null);

// --- scoring ---------------------------------------------------------------

console.log('\nDeterministic scoring');
check('cheaper scores full marks', priceScore(20, 15) === 1);
check('50% premium scores zero', priceScore(10, 15) === 0);
check('unknown price is neutral, not punished', priceScore(null, 15) === 0.5);

const components = { equivalence: 0.8, canadian: 1, price: 0.5 };
check('weighted total is in range', Math.abs(totalScore(components, DEFAULT_WEIGHTS) - 0.81) < 0.02);
check('zero weights do not divide by zero', totalScore(components, { equivalence: 0, canadian: 0, price: 0 }) === 0);

const fake = (id: string, eq: number, cdn: number, price: number): Candidate =>
  ({ id, title: id, components: { equivalence: eq, canadian: cdn, price }, score: 0 }) as Candidate;

const pool = [fake('a', 0.5, 1, 0.2), fake('b', 0.9, 0.5, 1), fake('c', 0.7, 0.8, 0.6)];
const byCanadian = rank(pool, { equivalence: 0.1, canadian: 0.8, price: 0.1 });
const byPrice = rank(pool, { equivalence: 0.1, canadian: 0.1, price: 0.8 });
check('weights actually reorder', byCanadian[0]!.id === 'a' && byPrice[0]!.id === 'b',
  `${byCanadian[0]!.id} / ${byPrice[0]!.id}`);
check('ranking is reproducible', JSON.stringify(rank(pool, DEFAULT_WEIGHTS)) === JSON.stringify(rank(pool, DEFAULT_WEIGHTS)));

// --- gates -----------------------------------------------------------------

console.log('\nAI candidate gates (the hallucination firewall)');

const base = { title: 'T', brand: 'B', retailer: 'R', priceCad: 1, claim: 'c' };

(async () => {
  const noSource = await runGates({ ...base, url: 'https://real.ca/products/x', sourceUrl: null });
  check('rejects a candidate with no source_url', !noSource.passed && noSource.rejection?.gate === 'source_url_required');

  const fakeDomain = await runGates({ ...base, url: 'https://totally-real-store.example/shop/p', sourceUrl: 'https://x.ca' });
  check('rejects an obviously fabricated domain', !fakeDomain.passed && fakeDomain.rejection?.gate === 'not_a_storefront');

  const searchPage = await runGates({ ...base, url: 'https://well.ca/search?q=deodorant', sourceUrl: 'https://well.ca' });
  check('rejects a search page', !searchPage.passed && searchPage.rejection?.gate === 'not_a_product_page');

  const insecure = await runGates({ ...base, url: 'http://well.ca/products/x', sourceUrl: 'https://well.ca' });
  check('rejects non-https', !insecure.passed && insecure.rejection?.gate === 'url_not_https');

  const malformed = await runGates({ ...base, url: 'not a url', sourceUrl: 'https://x.ca' });
  check('rejects a malformed url', !malformed.passed && malformed.rejection?.gate === 'url_malformed');

  // A reachable page that parses as a product, served from memory.
  const stubFetch = (async () =>
    new globalThis.Response(shopifyHtml, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const good = await runGates(
    { ...base, url: 'https://greenbeaver.ca/products/deodorant', sourceUrl: 'https://greenbeaver.ca/about' },
    { fetchImpl: stubFetch },
  );
  check('accepts a verifiable product page', good.passed, good.rejection?.detail);
  check('re-reads facts from the retailer page', good.verified?.price?.amount === 12.99);

  const dead = (async () => new globalThis.Response('', { status: 404 })) as typeof fetch;
  const unreachable = await runGates(
    { ...base, url: 'https://greenbeaver.ca/products/gone', sourceUrl: 'https://greenbeaver.ca' },
    { fetchImpl: dead },
  );
  check('rejects a dead link', !unreachable.passed && unreachable.rejection?.gate === 'url_unreachable');

  console.log('\nAllowed sites (shopper\'s site first, then the four retailers)');

  const indigoSites = allowedSitesFor('www.indigo.ca');
  check('current site comes first', indigoSites[0] === 'indigo.ca' && indigoSites.length === 5, indigoSites.join(','));
  check('no duplicate when already on a listed retailer', allowedSitesFor('www.amazon.ca').join(',') === 'amazon.ca,walmart.ca,foodbasics.ca,sobeys.com');
  check('subdomains match their site', siteFor('https://www.sobeys.com/en/p/x', indigoSites) === 'sobeys.com');
  check('lookalike domains do not', siteFor('https://notamazon.ca/dp/B000000000', indigoSites) === null);

  const located = (id: string, url: string, score: number): Candidate =>
    ({ id, title: id, url, components: { equivalence: score, canadian: score, price: score }, score: 0 }) as Candidate;
  const mixed = [located('walmart-best', 'https://www.walmart.ca/en/ip/a/1', 0.9), located('indigo-ok', 'https://www.indigo.ca/p/2', 0.4)];
  check('shopper\'s own site ranks first even with a lower score',
    rankPreferringSite(mixed, DEFAULT_WEIGHTS, 'indigo.ca')[0]!.id === 'indigo-ok');

  console.log('\nStore search for AI leads (brand and product type must both match)');

  const lead = { brand: 'Green Beaver', query: 'Green Beaver antiperspirant' };
  check('accepts the suggested brand and type', listingMatchesLead('Green Beaver 100% natural Antiperspirant - Fresh Verve', lead));
  check('rejects the foreign brand the store ranked first', !listingMatchesLead('Dove Men+Care Antiperspirant Stick 72H, 76 g', lead));
  check('rejects the right brand in the wrong product', !listingMatchesLead('Green Beaver Natural Toothpaste Spearmint', lead));
  check('matches a brand written without spaces', listingMatchesLead('GreenBeaver Antiperspirant Unscented', lead));

  const results = [
    { title: 'AXE 48H Protection Antiperspirant Stick, 76 g', url: 'https://www.walmart.ca/en/ip/axe/1', priceCad: 6.97 },
    { title: 'Green Beaver 100% natural Antiperspirant - Fresh Verve', url: 'https://www.walmart.ca/en/ip/gb/2', priceCad: 12.97 },
  ];
  check('picks the first listing that is really the lead', pickListing(results, lead)?.url === 'https://www.walmart.ca/en/ip/gb/2');

  const walmartHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [
      { name: 'Green Beaver 100% natural Deodorant - Citrus', canonicalUrl: '/en/ip/Green-Beaver/6000202015029?classType=REGULAR', price: 12.97 },
    ] }] } } } },
  })}</script>`;
  const walmartListings = parseWalmartSearch(walmartHtml);
  check('reads Walmart search results', walmartListings[0]?.url === 'https://www.walmart.ca/en/ip/Green-Beaver/6000202015029' && walmartListings[0]?.priceCad === 12.97,
    JSON.stringify(walmartListings[0]));
  check('builds store search URLs', searchUrl('amazon.ca', 'maple syrup') === 'https://www.amazon.ca/s?k=maple%20syrup');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
