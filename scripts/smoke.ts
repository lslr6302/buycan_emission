/**
 * Smoke tests for the parts that are easy to get quietly wrong.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Not a substitute for the eval harness - that measures accuracy against
 * hand-labelled ground truth. This just checks the machinery works.
 */
import { extractFromHtml, isUsable, mergeProducts, pickPrice } from '../src/shared/extract';
import { gtinCheckDigitValid, normalizeGtin, parsePrice, productKey } from '../src/shared/normalize';
import { DEFAULT_WEIGHTS, priceScore, rank, totalScore } from '../src/shared/scoring';
import type { AiClient } from '../src/server/ai/client';
import { MemoryAiStore } from '../src/server/data/ai-store';
import { MockRepository } from '../src/server/data/mock-repository';
import { runGates } from '../src/server/pipeline/gates';
import { type PipelineDeps, resolveProduct } from '../src/server/pipeline/resolve';
import { saveBrowserFinds } from '../src/server/pipeline/ai-finds';
import { MockAiClient } from '../src/server/ai/mock-client';
import { allowedSitesFor, siteFor } from '../src/shared/retailers';
import { listingMatchesLead, parseWalmartSearch, pickListing, searchUrl } from '../src/shared/stores';
import { rankPreferringSite } from '../src/shared/scoring';
import type { Candidate, ProductRef } from '../src/shared/types';

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

// --- merging partial extractions --------------------------------------------

console.log('\nMerging partial reads (Walmart publishes a Product with no price)');

const titleOnly = {
  site: 'walmart.ca', siteId: null, url: 'u',
  title: 'Head & Shoulders Classic Clean Shampoo 613 ml',
  brand: null, gtin: null, price: null, categoryHint: null, imageUrl: null, massKg: null,
  extraction: { tier: 'jsonld' as const, confidence: 'high' as const },
};
const priceOnly = {
  ...titleOnly,
  title: 'Head and Shoulders Shampoo | Walmart Canada',
  brand: 'Head & Shoulders',
  price: { amount: 8.97, currency: 'CAD' },
  extraction: { tier: 'adapter' as const, confidence: 'medium' as const },
};

const merged = mergeProducts([titleOnly, priceOnly]);
check('merged result is usable', isUsable(merged));
check('keeps the higher-tier title', merged.title === titleOnly.title);
check('borrows the missing price', merged.price?.amount === 8.97);
check('borrows the missing brand', merged.brand === 'Head & Shoulders');
check(
  'a complete read is unchanged by merging',
  mergeProducts([priceOnly]).price?.amount === 8.97,
);

// --- visible-price fallback -------------------------------------------------

console.log('\nPicking the real price off a page (Walmart ships no price in JSON-LD)');

// A realistic Walmart-shaped shelf: unit pricing, other sizes, a struck-out
// list price, and the actual current price.
const walmartish = [
  { text: '$4.41/100ml', weight: 30 },
  { text: '$3.97', weight: 30 },
  { text: '$5.97', weight: 30 },
  { text: 'Save 15%', weight: 30 },
  { text: 'was $11.47', weight: 30 },
  { text: '$8.97', weight: 85 },
];
check('prefers the strongest-claiming element', pickPrice(walmartish) === 8.97);
check('ignores per-unit pricing', pickPrice([{ text: '$1.61/100ml', weight: 90 }]) === null);
check('ignores "per ml" phrasing', pickPrice([{ text: '$0.04 per ml', weight: 90 }]) === null);
check('ignores percentage savings', pickPrice([{ text: 'Save 20%', weight: 90 }]) === null);
check('ignores was/list copy', pickPrice([{ text: 'was $11.47', weight: 90 }]) === null);
check('ignores monthly financing', pickPrice([{ text: '\$12.00/mo', weight: 90 }]) === null);
check('rejects implausible values', pickPrice([{ text: '\$250000.00', weight: 90 }]) === null);
check('reads a bare amount', pickPrice([{ text: '8.97', weight: 50 }]) === 8.97);
check('returns null with nothing usable', pickPrice([]) === null);
check(
  'weight beats document order',
  pickPrice([{ text: '\$99.99', weight: 30 }, { text: '\$8.97', weight: 100 }]) === 8.97,
);

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
// Regression: these read as 123 and 250 before the separator rewrite.
check('four digits, no separator', parsePrice('1234.50') === 1234.5);
check('six digits, no separator', parsePrice('$250000.00') === 250000);
check('thousands separator only', parsePrice('$1,234') === 1234);
check('european thousands', parsePrice('1.234.567') === 1234567);

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

  // --- AI store ------------------------------------------------------------

  console.log('\nAI store (a browser find is remembered, and reused without the model)');

  // The seed brands, with an empty catalogue so the verified path always
  // comes up empty and the fallback is reached.
  const seed = new MockRepository();
  await seed.init();
  const emptyCatalogue = Object.assign(Object.create(seed) as MockRepository, {
    findAlternatives: async () => [],
    findByGtin: async () => [],
  });

  let suggestions = 0;
  const greenBeaverLead = {
    brand: 'Green Beaver',
    product: 'natural deodorant',
    query: 'Green Beaver deodorant',
    claim: 'Canadian-made natural deodorant.',
    sourceUrl: 'https://greenbeaver.com/pages/about-us',
  };
  const fakeAi: AiClient = {
    name: 'fake',
    healthy: async () => true,
    extractSpec: async () => ({ category: 'deodorant', hard: {}, soft: {}, originRegion: null }),
    suggestAlternatives: async () => {
      suggestions++;
      return [greenBeaverLead];
    },
    sanityCheck: async () => ({ acceptable: true, reason: 'ok' }),
  };

  const aiStore = new MemoryAiStore();
  const deps: PipelineDeps = { repo: emptyCatalogue, ai: fakeAi, aiStore, fetchImpl: stubFetch };
  const original = (title: string): ProductRef => ({
    site: 'amazon.ca', siteId: null, url: 'https://amazon.ca/x', title, brand: 'Speed Stick',
    gtin: null, price: { amount: 9.99, currency: 'CAD' }, categoryHint: null, imageUrl: null,
    massKg: null, extraction: { tier: 'jsonld', confidence: 'high' },
  });

  const first = await resolveProduct({ product: original('Speed Stick Deodorant 85 g'), browserCheck: true }, deps);
  check('first lookup asks the model', suggestions === 1);
  check('first lookup hands the lead to the browser', first.browserSearch?.leads[0]?.brand === 'Green Beaver');

  // What the extension would report after finding and verifying it on Walmart.
  const walmartFind = {
    url: 'https://www.walmart.ca/en/ip/green-beaver-deodorant/123',
    title: 'Green Beaver Natural Deodorant - Unscented',
    brand: 'Green Beaver',
    retailer: 'Walmart',
    priceCad: 12.97,
    gtin: null,
    massKg: null,
    sourceUrl: greenBeaverLead.sourceUrl,
    claim: greenBeaverLead.claim,
  };
  const saved = await saveBrowserFinds(first.key, [walmartFind], aiStore);
  check('the browser find is stored', saved.saved === 1);

  const forged = await saveBrowserFinds(first.key, [{ ...walmartFind, title: 'Dove Men+Care Deodorant', brand: 'Dove' }], aiStore);
  check('a find for a brand we never suggested is refused', forged.saved === 0);
  const offList = await saveBrowserFinds(first.key, [{ ...walmartFind, url: 'https://example-shop.ca/green-beaver' }], aiStore);
  check('a find off the allowed stores is refused', offList.saved === 0);
  const unknownKey = await saveBrowserFinds('gtin:00000000000000', [walmartFind], aiStore);
  check('a find for a product we issued nothing for is refused', unknownKey.saved === 0);

  const second = await resolveProduct({ product: original('Speed Stick Deodorant 85 g'), browserCheck: true }, deps);
  check('repeat lookup does not ask the model', suggestions === 1);
  check('repeat lookup reuses the stored find', second.diagnostics.aiStoreHits === 1 && second.candidates.length === 1,
    `${second.diagnostics.aiStoreHits} / ${second.candidates.length} / ${second.abstentionMessage}`);
  check('stored find is still labelled ai', second.candidates[0]?.origin === 'ai');

  const sibling = await resolveProduct({ product: original('Speed Stick Deodorant Twin Pack'), browserCheck: true }, deps);
  check('same brand + category reuses it too', suggestions === 1 && sibling.diagnostics.aiStoreHits === 1);

  // Same brand, same (coarse) category, different product: must not inherit
  // the deodorant find - it should go back to the model instead.
  const unrelated = await resolveProduct({ product: original('Speed Stick Gear Body Wash Fresh Rush 532 ml'), browserCheck: true }, deps);
  check('same brand + category but a different product does not reuse it',
    unrelated.diagnostics.aiStoreHits === 0 && suggestions === 2,
    `${unrelated.diagnostics.aiStoreHits} hits / ${suggestions} model calls`);

  const strict = await resolveProduct({ product: original('Speed Stick Deodorant 85 g'), verifiedOnly: true }, deps);
  check('verifiedOnly ignores the AI store', strict.diagnostics.aiStoreHits === 0 && strict.candidates.length === 0);

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

  console.log('\nAlready-Canadian products get no suggestions');

  const seedRepo = new MockRepository();
  await seedRepo.init();
  const seedDeps = { repo: seedRepo, ai: new MockAiClient() };
  const onPage = (title: string, brand: string): ProductRef => ({
    site: 'walmart.ca', siteId: null, url: 'u', title, brand, gtin: null,
    price: { amount: 9.99, currency: 'CAD' }, categoryHint: null, imageUrl: null, massKg: null,
    extraction: { tier: 'jsonld', confidence: 'high' },
  });

  const canadian = await resolveProduct({ product: onPage('Green Beaver Natural Deodorant Stick 50 g', 'The Green Beaver Company'), browserCheck: true }, seedDeps);
  check('stops on a Canadian brand', canadian.alreadyCanadian && canadian.candidates.length === 0,
    `${canadian.ownStatus} / ${canadian.candidates.length}`);
  check('and never asks the AI', canadian.browserSearch === null && canadian.diagnostics.aiCandidates === 0);

  const foreign = await resolveProduct({ product: onPage('Dove Men+Care Antiperspirant Stick 76 g', 'Dove'), browserCheck: true }, seedDeps);
  check('still suggests for a foreign brand', !foreign.alreadyCanadian && foreign.candidates.length > 0,
    `${foreign.abstentionReason} / ${foreign.candidates.length}`);

  const unknownBrand = await resolveProduct({ product: onPage('Some Brand Maple Syrup 500 ml', 'Some Unheard Of Brand'), browserCheck: true }, seedDeps);
  check('an unknown brand is not treated as Canadian', !unknownBrand.alreadyCanadian);

  // Your rule: at least half Canadian counts, even under a foreign parent.
  const kickingHorse = await resolveProduct({ product: onPage('Kicking Horse Coffee Three Sisters 454 g', 'Kicking Horse Coffee'), browserCheck: true }, seedDeps);
  check('a Canadian-made brand under a foreign parent counts as Canadian', kickingHorse.alreadyCanadian);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
