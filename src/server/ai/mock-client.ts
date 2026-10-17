import { normalizeTitle, parsePrice } from '../../shared/normalize';
import type { ProductRef, ProductSpec } from '../../shared/types';
import type { AiCandidate, AiClient, AlternativeSearchInput, SanityVerdict } from './client';

/**
 * Deterministic stand-in for the Gemini integration. No network, same shapes,
 * reproducible output - which also makes it the right client for the eval
 * harness, where a nondeterministic answer would make the benchmark table
 * meaningless.
 *
 * `searchAlternative` deliberately returns one plausible candidate and one
 * fabricated one, because the fabricated one is the point: it proves the
 * validation gates in pipeline/gates.ts actually fire. Do not "fix" it.
 */
export class MockAiClient implements AiClient {
  readonly name = 'mock';

  async healthy(): Promise<boolean> {
    return true;
  }

  async extractSpec(product: ProductRef): Promise<ProductSpec | null> {
    const category = guessCategory(product);
    if (!category) return null;

    const title = normalizeTitle(product.title);
    const hard: ProductSpec['hard'] = {};
    const soft: ProductSpec['soft'] = {};

    const form = detectForm(title);
    if (form) hard['form'] = form;
    if (/insulated|vacuum|thermal/.test(title)) hard['insulated'] = true;

    const ml = detectMillilitres(title);
    if (ml) soft['volume_ml'] = ml;
    const grams = detectGrams(title);
    if (grams) soft['volume_g'] = grams;
    const material = detectMaterial(title);
    if (material) soft['material'] = material;

    return { category, hard, soft, originRegion: null };
  }

  async searchAlternative(input: AlternativeSearchInput): Promise<AiCandidate[]> {
    const { product } = input;
    return [
      {
        title: `Canadian-made alternative to ${product.title}`,
        brand: 'Rocky Mountain Soap Company',
        url: 'https://www.rockymountainsoap.com/',
        retailer: 'Rocky Mountain Soap Co.',
        priceCad: parsePrice(String(product.price?.amount ?? '')) ?? null,
        sourceUrl: 'https://www.rockymountainsoap.com/pages/our-story',
        claim: 'Manufactured in Canmore, Alberta.',
      },
      {
        // Fabricated on purpose. The gates must reject this before any user
        // sees it; if it ever renders, the validation path is broken.
        title: 'Maple Leaf Authentic Canadian Goods - Premium Edition',
        brand: 'TrueNorth Collective',
        url: 'https://truenorth-collective-canada.example/shop/premium',
        retailer: 'TrueNorth Collective',
        priceCad: 39.99,
        sourceUrl: null,
        claim: 'Proudly Canadian owned and operated.',
      },
    ].slice(0, Math.max(1, input.limit));
  }

  async sanityCheck(original: ProductRef, candidateTitle: string): Promise<SanityVerdict> {
    const a = detectForm(normalizeTitle(original.title));
    const b = detectForm(normalizeTitle(candidateTitle));
    if (a && b && a !== b) {
      return { acceptable: false, reason: `form mismatch: ${a} vs ${b}` };
    }
    return { acceptable: true, reason: 'no disqualifying difference detected' };
  }
}

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/deodorant|antiperspirant/, 'personal_care_deodorant'],
  [/body wash|shower gel|bar soap|soap/, 'personal_care_body_wash'],
  [/shampoo|conditioner/, 'personal_care_hair'],
  [/chips|crisps/, 'snacks_chips'],
  [/coffee|espresso|roast/, 'pantry_coffee'],
  [/ketchup|mustard|condiment|sauce/, 'pantry_condiments'],
  [/tumbler|water bottle|thermos|travel mug|flask/, 'insulated_drinkware'],
  [/t-?shirt|tee|crewneck/, 'apparel_basics_tee'],
  [/vitamin|supplement|softgel/, 'supplements_vitamin_d'],
  [/mouse|keyboard|webcam|headset|monitor/, 'electronics_peripherals'],
];

/**
 * Breadcrumb first, title second. A hand-written map is twenty minutes of work
 * and beats a classifier that has to be trained, evaluated and explained.
 */
export function guessCategory(product: ProductRef): string | null {
  const haystack = `${product.categoryHint ?? ''} ${product.title}`.toLowerCase();
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(haystack)) return category;
  }
  return null;
}

function detectForm(title: string): string | null {
  if (/\bbar\b/.test(title)) return 'bar';
  if (/\bstick\b/.test(title)) return 'stick';
  if (/\bspray\b|aerosol/.test(title)) return 'spray';
  if (/\broll[- ]?on\b/.test(title)) return 'roll_on';
  if (/liquid|wash|gel|lotion/.test(title)) return 'liquid';
  if (/whole bean|beans?\b/.test(title)) return 'whole_bean';
  if (/ground\b/.test(title)) return 'ground';
  if (/softgel|capsule|tablet/.test(title)) return 'softgel';
  return null;
}

function detectMillilitres(title: string): number | null {
  const ml = title.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (ml) return Number(ml[1]);
  const l = title.match(/(\d+(?:\.\d+)?)\s*l\b/);
  if (l) return Number(l[1]) * 1000;
  const oz = title.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\b/);
  if (oz) return Math.round(Number(oz[1]) * 29.574);
  return null;
}

function detectGrams(title: string): number | null {
  const g = title.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (g) return Number(g[1]);
  const kg = title.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  if (kg) return Number(kg[1]) * 1000;
  return null;
}

function detectMaterial(title: string): string | null {
  if (/stainless/.test(title)) return 'stainless_steel';
  if (/\bcotton\b/.test(title)) return 'cotton';
  if (/\bglass\b/.test(title)) return 'glass';
  if (/\bplastic|tritan\b/.test(title)) return 'plastic';
  return null;
}
