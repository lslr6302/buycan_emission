import type { AiLead, ProductRef, ProductSpec } from '../../shared/types';
import type { AiClient, AlternativeSearchInput, SanityVerdict } from './client';
import { KNOWN_CATEGORIES } from './mock-client';

/**
 * Gemini implementation, over the Interactions REST API with plain fetch - no
 * SDK dependency.
 *
 * Activate with AI_BACKEND=gemini and GEMINI_API_KEY (GEMINI_MODEL optional).
 * The key is read here, on the server, and never reaches the extension - a
 * shipped extension is a zip anyone can open, so it is not a place secrets
 * can live.
 *
 * Prompting rules that are not negotiable, because they are the project thesis:
 *
 *   - Never ask the model who owns a brand. That is a database lookup.
 *     A model will answer confidently and wrongly, and cannot cite.
 *   - Never ask the model to rank or order candidates. Ranking is arithmetic
 *     in shared/scoring.ts so it is reproducible on stage and testable in the
 *     eval harness.
 *   - Never ask the model for product URLs. It names what to look for; the
 *     pipeline finds it in the allowed stores' own search, so a listing can
 *     never be invented.
 *   - Always demand a source URL for the Canadian claim, and tell the model
 *     that returning nothing is a correct answer.
 *
 * Runs on the free tier by default. Google Search grounding is a paid-tier
 * feature; GEMINI_SEARCH=on adds it, so the model can check its claims and
 * cite real pages, once the key's project has billing.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
/**
 * Suggestions: worth the stronger model. Not 3.8 Flash, which is newer but
 * timed out or returned 503 on every call during testing (2026-10-17); set
 * GEMINI_MODEL=gemini-3.8-flash to try it again.
 */
const DEFAULT_MODEL = 'gemini-3.6-flash';
/** Spec parse and yes/no veto: simple, latency-sensitive, and the fallback when the main model is overloaded. */
const DEFAULT_FAST_MODEL = 'gemini-3.5-flash-lite';

/** Suggestions (especially grounded) are slower; spec and veto calls should be quick. */
const SEARCH_TIMEOUT_MS = 45_000;
const FAST_TIMEOUT_MS = 15_000;

/** Overload, rate limit and timeouts are worth another model; a bad request is not. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

type JsonSchema = Record<string, unknown>;

interface CallOptions {
  /** Tried in order; the next one only runs after a retryable failure. */
  models: string[];
  system: string;
  input: string;
  schema: JsonSchema;
  search?: boolean;
  timeoutMs: number;
}

class RetryableError extends Error {}

export class GeminiClient implements AiClient {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly model = DEFAULT_MODEL,
    private readonly fastModel = DEFAULT_FAST_MODEL,
    /** Google Search grounding. Paid tier only - off unless GEMINI_SEARCH=on. */
    private readonly useSearch = false,
  ) {}

  async healthy(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  /** TIER 5 extraction. Cached by productKey, so this runs once per product ever. */
  async extractSpec(product: ProductRef): Promise<ProductSpec | null> {
    const json = await this.call({
      models: [this.fastModel],
      system: SPEC_SYSTEM,
      input: describeProduct(product),
      schema: SPEC_SCHEMA,
      timeoutMs: FAST_TIMEOUT_MS,
    });
    return toSpec(json);
  }

  /** Only called when the verified dataset returned nothing. */
  async suggestAlternatives(input: AlternativeSearchInput): Promise<AiLead[]> {
    const json = await this.call({
      models: [this.model, this.fastModel],
      system: this.useSearch ? SUGGEST_SYSTEM_GROUNDED : SUGGEST_SYSTEM,
      input:
        `${describeProduct(input.product)}\n` +
        (input.spec ? `Parsed spec: ${JSON.stringify(input.spec)}\n` : '') +
        `Stores that will be searched: ${input.sites.join(', ')}\n` +
        `Return at most ${input.limit} suggestions.`,
      schema: SUGGEST_SCHEMA,
      search: this.useSearch,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });

    const raw = isRecord(json) && Array.isArray(json['suggestions']) ? json['suggestions'] : [];
    return raw
      .filter(isRecord)
      .map(toLead)
      .filter((lead): lead is AiLead => lead !== null)
      .slice(0, input.limit);
  }

  /** Yes/no veto on a top candidate. A filter, never a ranker. */
  async sanityCheck(original: ProductRef, candidateTitle: string): Promise<SanityVerdict> {
    const json = await this.call({
      models: [this.fastModel],
      system: SANITY_SYSTEM,
      input: `Shopper is buying: ${original.title}\nProposed alternative: ${candidateTitle}`,
      schema: SANITY_SCHEMA,
      timeoutMs: FAST_TIMEOUT_MS,
    });
    if (!isRecord(json) || typeof json['acceptable'] !== 'boolean') {
      throw new Error('sanityCheck: malformed verdict');
    }
    return { acceptable: json['acceptable'], reason: str(json['reason']) ?? '' };
  }

  // --- transport -----------------------------------------------------------

  private async call(options: CallOptions): Promise<unknown> {
    const models = [...new Set(options.models)];
    let lastError: unknown;
    for (const model of models) {
      try {
        return await this.callModel(model, options);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableError)) throw error;
        console.warn(`[gemini] ${model}: ${error.message}`);
      }
    }
    throw lastError;
  }

  private async callModel(model: string, options: CallOptions): Promise<unknown> {
    const body = {
      model,
      system_instruction: options.system,
      input: options.input,
      // Nothing about a shopper's page needs to outlive the request.
      store: false,
      generation_config: { thinking_level: options.search ? 'medium' : 'low' },
      tools: options.search ? [{ type: 'google_search' }] : undefined,
      response_format: { type: 'text', mime_type: 'application/json', schema: options.schema },
    };

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      throw new RetryableError(error instanceof Error ? error.message : 'fetch failed');
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      if (RETRYABLE_STATUS.has(response.status)) {
        throw new RetryableError(`HTTP ${response.status}: ${detail}`);
      }
      // The pipeline swallows AI errors so a failure abstains instead of
      // crashing; log here or a broken key looks exactly like "no match".
      console.warn(`[gemini] ${model} HTTP ${response.status}: ${detail}`);
      throw new Error(`Gemini returned HTTP ${response.status}`);
    }

    const interaction = (await response.json()) as Record<string, unknown>;
    if (interaction['status'] && interaction['status'] !== 'completed') {
      console.warn(`[gemini] interaction status ${String(interaction['status'])}`);
      throw new Error(`Gemini interaction ${String(interaction['status'])}`);
    }

    const text = readOutput(interaction);
    try {
      return parseJson(text);
    } catch {
      console.warn(`[gemini] unparseable output: ${text.slice(0, 300)}`);
      throw new Error('Gemini returned non-JSON output');
    }
  }
}

// ---------------------------------------------------------------------------
// Prompts and schemas
// ---------------------------------------------------------------------------

const FORMS = ['bar', 'stick', 'spray', 'roll_on', 'paste', 'liquid', 'whole_bean', 'ground', 'softgel'];
const TYPES = ['shampoo', 'conditioner', 'toothpaste', 'mouthwash'];
const MATERIALS = ['stainless_steel', 'cotton', 'glass', 'plastic'];

const SPEC_SYSTEM = `You turn a messy retail product listing into a structured spec used to find equivalent products.

- category: use one of these labels when the product fits: ${KNOWN_CATEGORIES.join(', ')}. Otherwise give a short snake_case label of the same style.
- Only fill an attribute when the listing states it. Omit anything you would have to guess.
- form must be one of: ${FORMS.join(', ')}. type must be one of: ${TYPES.join(', ')}. material must be one of: ${MATERIALS.join(', ')}.
- volume_ml for liquids (convert fl oz and litres to ml), volume_g for solids (convert kg/oz to grams).
- Do not say anything about who makes or owns the brand.`;

const SPEC_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    form: { type: 'string', enum: FORMS },
    type: { type: 'string', enum: TYPES },
    insulated: { type: 'boolean' },
    volume_ml: { type: 'number' },
    volume_g: { type: 'number' },
    material: { type: 'string', enum: MATERIALS },
  },
  required: ['category'],
};

const suggestSystem = (sourceRule: string) => `A Canadian shopper is looking at the product below. Suggest Canadian-owned or Canadian-made products that could replace it. We will search Canadian stores (Amazon.ca, Walmart.ca, Food Basics, Sobeys, and the store they are on) for each suggestion ourselves.

Rules:
- Only real brands you know to be Canadian-owned or made in Canada. Prefer brands widely stocked by Canadian grocery and big-box stores, including Canadian store brands (e.g. President's Choice, Compliments, Our Finest) when nothing else fits.
- Best match first: the same kind of product (same use, same form). If no Canadian brand makes exactly that, suggest the closest Canadian product a shopper could use for the same purpose instead - a different form, size or style is fine. A conditioner is still not a shampoo alternative: it must do the same job.
- "brand": the brand name exactly as printed on the package.
- "product": what the product is, e.g. "natural aluminum-free antiperspirant stick".
- "query": 2-4 words to type into a store search box: the brand plus the product type, e.g. "Green Beaver antiperspirant". No sizes or scents.
- "claim": one short factual sentence on why it is Canadian, e.g. "Made in Hawkesbury, Ontario."
- ${sourceRule}
- Do not include the shopper's current brand, and do not rank the suggestions.
- Return an empty list only when no Canadian brand makes anything for this purpose. A brand that is not really Canadian is far worse than no suggestion.`;

const SUGGEST_SYSTEM = suggestSystem(
  '"sourceUrl": the brand\'s official website page that supports the claim (an about page, or the homepage). Never a store or product listing.',
);
const SUGGEST_SYSTEM_GROUNDED = suggestSystem(
  '"sourceUrl": use Google Search to confirm the claim, and give the page that states it (brand about page, news article, registry). Copy it exactly as found.',
);

const SUGGEST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          brand: { type: 'string' },
          product: { type: 'string' },
          query: { type: 'string' },
          claim: { type: 'string' },
          sourceUrl: { type: 'string' },
        },
        required: ['brand', 'product', 'query', 'claim', 'sourceUrl'],
      },
    },
  },
  required: ['suggestions'],
};

const SANITY_SYSTEM = `You are a strict filter. Answer whether a shopper buying the first product would reasonably accept the second as a substitute: same purpose, same form, comparable size. Different brand is fine. Different product type (e.g. conditioner for shampoo, mouthwash for toothpaste) is not. Give a one-sentence reason.`;

const SANITY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    acceptable: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['acceptable', 'reason'],
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function describeProduct(product: ProductRef): string {
  const lines = [`Title: ${product.title}`];
  if (product.brand) lines.push(`Brand: ${product.brand}`);
  if (product.categoryHint) lines.push(`Category on the page: ${product.categoryHint}`);
  if (product.price) lines.push(`Price: ${product.price.amount} ${product.price.currency}`);
  if (product.url) lines.push(`Page: ${product.url}`);
  return lines.join('\n');
}

/** Concatenates the text blocks of every model_output step. */
function readOutput(interaction: Record<string, unknown>): string {
  const texts: string[] = [];

  const steps = Array.isArray(interaction['steps']) ? interaction['steps'] : [];
  for (const step of steps) {
    if (!isRecord(step) || step['type'] !== 'model_output') continue;
    const content = Array.isArray(step['content']) ? step['content'] : [];
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'text') continue;
      if (typeof block['text'] === 'string') texts.push(block['text']);
    }
  }

  // Older response shapes expose the final text directly.
  if (texts.length === 0 && typeof interaction['output_text'] === 'string') {
    texts.push(interaction['output_text']);
  }
  return texts.join('').trim();
}

/** Tolerates a fenced block or prose around the object, which grounded calls sometimes add. */
function parseJson(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object');
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

/** Same hard/soft split as MockAiClient.extractSpec, so both backends feed retrieval identically. */
function toSpec(json: unknown): ProductSpec | null {
  if (!isRecord(json)) return null;
  const category = str(json['category']);
  if (!category) return null;

  const hard: ProductSpec['hard'] = {};
  const soft: ProductSpec['soft'] = {};

  const form = str(json['form']);
  if (form && FORMS.includes(form)) hard['form'] = form;
  const type = str(json['type']);
  if (type && TYPES.includes(type)) hard['type'] = type;
  if (json['insulated'] === true) hard['insulated'] = true;

  const ml = num(json['volume_ml']);
  if (ml) soft['volume_ml'] = ml;
  const grams = num(json['volume_g']);
  if (grams) soft['volume_g'] = grams;
  const material = str(json['material']);
  if (material && MATERIALS.includes(material)) soft['material'] = material;

  return { category: category.toLowerCase(), hard, soft, originRegion: null };
}

/** A missing sourceUrl stays null - the pipeline drops the lead rather than us inventing one. */
function toLead(raw: Record<string, unknown>): AiLead | null {
  const brand = str(raw['brand']);
  const query = str(raw['query']);
  if (!brand || !query) return null;
  return {
    brand,
    product: str(raw['product']) ?? query,
    query,
    claim: str(raw['claim']) ?? '',
    sourceUrl: str(raw['sourceUrl']),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
