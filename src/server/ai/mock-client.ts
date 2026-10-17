import { normalizeTitle } from '../../shared/normalize';
import type { AiLead, ProductRef, ProductSpec } from '../../shared/types';
import type { AiClient, AlternativeSearchInput, SanityVerdict } from './client';

/**
 * Deterministic stand-in for the Gemini integration. No network, same shapes,
 * reproducible output - which also makes it the right client for the eval
 * harness, where a nondeterministic answer would make the benchmark table
 * meaningless.
 *
 * `suggestAlternatives` deliberately returns one real lead and one with no
 * citation, because the uncited one is the point: it proves the lead filter
 * drops it before any store is searched. Do not "fix" it.
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

    // Product type is a HARD constraint, not a soft one. Shampoo and
    // conditioner share a form, a volume and most of their title tokens, so
    // without this a conditioner scores well as an alternative to shampoo.
    const type = detectType(title);
    if (type) hard['type'] = type;
    if (/insulated|vacuum|thermal/.test(title)) hard['insulated'] = true;

    const ml = detectMillilitres(title);
    if (ml) soft['volume_ml'] = ml;
    const grams = detectGrams(title);
    if (grams) soft['volume_g'] = grams;
    const material = detectMaterial(title);
    if (material) soft['material'] = material;

    return { category, hard, soft, originRegion: null };
  }

  async suggestAlternatives(input: AlternativeSearchInput): Promise<AiLead[]> {
    return [
      {
        brand: 'Green Beaver',
        product: 'natural aluminum-free antiperspirant',
        query: 'Green Beaver antiperspirant',
        claim: 'Made in Hawkesbury, Ontario.',
        sourceUrl: 'https://greenbeaver.com/pages/about-us',
      },
      {
        // No citation on purpose. The pipeline must drop it before searching
        // any store; if it ever renders, the lead filter is broken.
        brand: 'TrueNorth Collective',
        product: 'premium Canadian goods',
        query: 'TrueNorth Collective',
        claim: 'Proudly Canadian owned and operated.',
        sourceUrl: null,
      },
    ].slice(0, Math.max(1, input.limit));
  }

  async sanityCheck(original: ProductRef, candidateTitle: string): Promise<SanityVerdict> {
    const left = normalizeTitle(original.title);
    const right = normalizeTitle(candidateTitle);

    const typeA = detectType(left);
    const typeB = detectType(right);
    if (typeA && typeB && typeA !== typeB) {
      return { acceptable: false, reason: `product type mismatch: ${typeA} vs ${typeB}` };
    }

    const formA = detectForm(left);
    const formB = detectForm(right);
    if (formA && formB && formA !== formB) {
      return { acceptable: false, reason: `form mismatch: ${formA} vs ${formB}` };
    }

    return { acceptable: true, reason: 'no disqualifying difference detected' };
  }
}

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/deodorant|antiperspirant/, 'personal_care_deodorant'],
  [/body wash|shower gel|bar soap|soap/, 'personal_care_body_wash'],
  [/shampoo|conditioner|hair mask|dry shampoo/, 'personal_care_hair'],
  [/toothpaste|mouthwash|floss|oral care/, 'personal_care_oral'],
  [/body lotion|moisturizer|hand cream|body cream/, 'personal_care_lotion'],
  [/laundry detergent|laundry soap|fabric softener/, 'home_cleaning_laundry'],
  [/chips|crisps/, 'snacks_chips'],
  [/coffee|espresso|roast/, 'pantry_coffee'],
  [/ketchup|mustard|condiment|sauce/, 'pantry_condiments'],
  [/tumbler|water bottle|thermos|travel mug|flask/, 'insulated_drinkware'],
  [/t-?shirt|tee|crewneck/, 'apparel_basics_tee'],
  [/vitamin|supplement|softgel/, 'supplements_vitamin_d'],
  [/mouse|keyboard|webcam|headset|monitor/, 'electronics_peripherals'],
];

/** The category vocabulary the catalogue is labelled with. Other AI clients must answer in it. */
export const KNOWN_CATEGORIES: string[] = [...new Set(CATEGORY_KEYWORDS.map(([, category]) => category))];

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
  if (/toothpaste|\bpaste\b/.test(title)) return 'paste';
  if (/liquid|wash|gel|lotion|shampoo|conditioner/.test(title)) return 'liquid';
  if (/whole bean|beans?\b/.test(title)) return 'whole_bean';
  if (/ground\b/.test(title)) return 'ground';
  if (/softgel|capsule|tablet/.test(title)) return 'softgel';
  return null;
}

/**
 * Narrow product type, emitted only when the title is unambiguous.
 *
 * This is the attribute that keeps a conditioner from being offered as an
 * alternative to shampoo: they share a form, a volume and most of their title
 * tokens, so nothing else in the pipeline separates them.
 */
function detectType(title: string): string | null {
  if (/\bconditioner\b/.test(title)) return 'conditioner';
  if (/\bshampoo\b/.test(title)) return 'shampoo';
  if (/\btoothpaste\b/.test(title)) return 'toothpaste';
  if (/\bmouthwash\b/.test(title)) return 'mouthwash';
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
