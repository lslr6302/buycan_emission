/**
 * Ask Gemini which Canadian products could replace one product, without the
 * server, the extension or the dataset in the way.
 *
 *   npm run try:gemini -- "Dove Men+Care Antiperspirant Stick 76 g" --brand Dove --price 7.97
 *
 * --site is the store the shopper is on (default walmart.ca). Prints each
 * suggestion and the store searches the extension will run for it, in order.
 * The searches themselves only run in the extension: the stores block servers.
 *
 * Makes two real API calls (spec parse, suggestions), both free-tier.
 */
import { GeminiClient } from '../src/server/ai/gemini-client';
import { allowedSitesFor } from '../src/shared/retailers';
import { searchUrl } from '../src/shared/stores';
import type { ProductRef } from '../src/shared/types';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const VALUE_FLAGS = ['--brand', '--price', '--category', '--site'];
const title = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.includes(all[i - 1] ?? ''));
if (!title) {
  console.error('usage: npm run try:gemini -- "<product title>" [--brand X] [--price 9.99] [--category "Beauty > Deodorant"] [--site indigo.ca]');
  process.exit(1);
}

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('GEMINI_API_KEY is not set (put it in .env).');
  process.exit(1);
}

const price = arg('price');
const product: ProductRef = {
  site: arg('site') ?? 'walmart.ca',
  siteId: null,
  url: '',
  title,
  brand: arg('brand'),
  gtin: null,
  price: price ? { amount: Number(price), currency: 'CAD' } : null,
  categoryHint: arg('category'),
  imageUrl: null,
  massKg: null,
  extraction: { tier: 'adapter', confidence: 'medium' },
};

const sites = allowedSitesFor(product.site);
const ai = new GeminiClient(
  key,
  process.env.GEMINI_MODEL,
  process.env.GEMINI_FAST_MODEL,
  process.env.GEMINI_SEARCH === 'on',
);

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await work();
  console.log(`  (${label}: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return result;
}

(async () => {
  console.log(`\nProduct: ${title}${product.brand ? ` [${product.brand}]` : ''}${price ? ` $${price}` : ''}`);
  console.log(`Stores, in order: ${sites.join(', ')}`);

  console.log('\n1. Spec');
  const spec = await timed('spec', () => ai.extractSpec(product));
  console.log(`  ${JSON.stringify(spec)}`);

  console.log('\n2. Gemini suggestions');
  const leads = await timed('suggest', () => ai.suggestAlternatives({ product, spec, limit: 4, sites }));
  if (leads.length === 0) {
    console.log('  Gemini suggested nothing.');
    return;
  }

  for (const [i, lead] of leads.entries()) {
    console.log(`\n  #${i + 1} ${lead.brand} - ${lead.product}`);
    console.log(`     claim:  ${lead.claim}`);
    console.log(`     source: ${lead.sourceUrl ?? '(none - this lead would be dropped)'}`);
    console.log(`     search: "${lead.query}"`);
    for (const site of sites) console.log(`             ${searchUrl(site, lead.query)}`);
  }
  console.log('\nOpen any search link above to see what the extension will look through.\n');
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\nFAILED:', message);
  if (/429/.test(message)) console.error('\nQuota or rate limit hit. Check https://ai.dev/rate-limit.');
  process.exit(1);
});
