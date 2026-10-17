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

  console.log('\nAI store (a discovery is remembered, and reused without the model)');

  // The seed brands, with an empty catalogue so the verified path always
  // comes up empty and the fallback is reached.
  const seed = new MockRepository();
  await seed.init();
  const emptyCatalogue = Object.assign(Object.create(seed) as MockRepository, {
    findAlternatives: async () => [],
    findByGtin: async () => [],
  });

  let searches = 0;
  const fakeAi: AiClient = {
    name: 'fake',
    healthy: async () => true,
    extractSpec: async () => ({ category: 'deodorant', hard: {}, soft: {}, originRegion: null }),
    searchAlternative: async () => {
      searches++;
      return [{
        title: 'Green Beaver Natural Deodorant',
        brand: 'The Green Beaver Company',
        url: 'https://greenbeaver.ca/products/deodorant',
        retailer: 'greenbeaver.ca',
        priceCad: 12.99,
        sourceUrl: 'https://greenbeaver.ca/about',
        claim: 'Canadian-made natural deodorant.',
      }];
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

  const first = await resolveProduct({ product: original('Speed Stick Deodorant 85 g') }, deps);
  check('first lookup asks the model', searches === 1);
  check('first lookup shows the AI find', first.candidates[0]?.origin === 'ai', first.abstentionMessage ?? '');
  check('AI find is stored', (await aiStore.find({ productKey: first.key, brandKey: null, category: null, limit: 5 })).length === 1);

  const second = await resolveProduct({ product: original('Speed Stick Deodorant 85 g') }, deps);
  check('repeat lookup does not ask the model', searches === 1);
  check('repeat lookup reuses the stored find', second.diagnostics.aiStoreHits === 1 && second.candidates.length === 1);
  check('stored find is still labelled ai', second.candidates[0]?.origin === 'ai');

  const sibling = await resolveProduct({ product: original('Speed Stick Deodorant Twin Pack') }, deps);
  check('same brand + category reuses it too', searches === 1 && sibling.diagnostics.aiStoreHits === 1);

  const strict = await resolveProduct({ product: original('Speed Stick Deodorant 85 g'), verifiedOnly: true }, deps);
  check('verifiedOnly ignores the AI store', strict.diagnostics.aiStoreHits === 0 && strict.candidates.length === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
