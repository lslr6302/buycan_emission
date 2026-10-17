import { normalizeBrand, productKey, round } from '../../shared/normalize';
import {
  DEFAULT_WEIGHTS,
  equivalenceScore,
  priceScore,
  rankPreferringSite,
  totalScore,
} from '../../shared/scoring';
import { allowedSitesFor } from '../../shared/retailers';
import type {
  AbstentionReason,
  AiLead,
  BrowserLead,
  Candidate,
  GateRejection,
  ProductRef,
  ProductSpec,
  ProvenanceVerdict,
  ResolveRequest,
  ResolveResponse,
  Weights,
} from '../../shared/types';
import type { AiClient } from '../ai/client';
import type { CatalogueItem, Repository } from '../data/repository';
import { qualifiesAsCanadian, verdictFor } from './provenance';

/**
 * The runtime pipeline for one product.
 *
 *   spec -> brand -> provenance -> verified retrieval
 *        -> retailer fallback -> score -> abstain?
 *        -> (dataset empty) AI suggestions -> store search in the browser
 *
 * Order matters and is not an accident. The verified dataset always runs
 * first; the AI only sees products the database could not answer for.
 */

export interface PipelineDeps {
  repo: Repository;
  ai: AiClient;
  /** Ceiling on candidates returned to the client. */
  maxCandidates?: number;
  /** Disable the yes/no veto (it costs one AI call per top candidate). */
  sanityVeto?: boolean;
}

const VERIFIED_POOL = 30;

export async function resolveProduct(
  request: ResolveRequest,
  deps: PipelineDeps,
): Promise<ResolveResponse> {
  const started = Date.now();
  const { repo, ai } = deps;
  const maxCandidates = deps.maxCandidates ?? 3;
  const weights = normalizeWeights(request.weights);
  const product = request.product;
  const key = productKey(product);

  const rejections: GateRejection[] = [];
  let aiCandidatesSeen = 0;
  let aiError: string | null = null;
  let browserSearch: ResolveResponse['browserSearch'] = null;

  // 1. Spec. Cached by stable key, so this runs once per product ever.
  const spec = await loadSpec(key, product, repo, ai);

  // 2. Brand linking and the decomposed provenance verdict for what the user
  //    is looking at. This renders even when we have no alternative to offer.
  const brand = product.brand ? await repo.findBrand(product.brand) : null;
  const provenance = verdictFor(brand, product.brand);

  // 3. Verified path.
  const verifiedItems = await findVerified(product, spec, repo);
  let candidates = verifiedItems.map((item) =>
    toCandidate(item, product, spec, 'verified', item.gtin && item.gtin === product.gtin ? 'gtin_exact' : 'equivalent', null),
  );

  // 4. Provenance filter. A candidate that is not actually Canadian is not an
  //    alternative, however well it matches on attributes.
  candidates = await attachProvenance(candidates, repo);
  candidates = candidates.filter((c) => qualifiesAsCanadian(c.provenance));

  // 5. Rank deterministically (shopper's own site first), then veto the top few.
  candidates = rankPreferringSite(candidates, weights, product.site);
  if (deps.sanityVeto !== false && candidates.length > 0) {
    candidates = await applySanityVeto(candidates.slice(0, maxCandidates + 2), product, ai, rejections);
    candidates = rankPreferringSite(candidates, weights, product.site);
  }
  candidates = candidates.slice(0, maxCandidates);

  // 6. Retailer fallback. When there is no Canadian product, the lever moves
  //    from what you buy to where you buy it.
  if (candidates.length === 0) {
    const swaps = await retailerFallback(product, repo, weights);
    candidates = swaps.slice(0, maxCandidates);
  }

  // 7. AI fallback - only when the dataset had nothing at all. The AI names
  //    Canadian products to look for; it never supplies a listing. The four
  //    stores (and usually the shopper's own) block servers, so the actual
  //    store search runs in the extension, which gets the leads back here.
  if (candidates.length === 0 && !request.verifiedOnly) {
    const sites = allowedSitesFor(product.site);
    // A failed call is not "nothing found" - remember it, or a quota error
    // reaches the shopper as "no Canadian alternative exists".
    const leads = await ai.suggestAlternatives({ product, spec, limit: 4, sites }).catch((error: unknown) => {
      aiError = error instanceof Error ? error.message : String(error);
      return [] as AiLead[];
    });
    aiCandidatesSeen = leads.length;

    const kept = await screenLeads(leads, product, repo, rejections);
    if (kept.length > 0 && request.browserCheck) browserSearch = { leads: kept, sites };
  }

  const abstained = candidates.length === 0;
  const abstentionReason = abstained
    ? pickAbstentionReason(spec, rejections, aiCandidatesSeen, aiError)
    : null;

  return {
    key,
    product,
    spec,
    provenance,
    candidates,
    abstained,
    abstentionReason,
    abstentionMessage: abstained
      ? abstentionMessage(abstentionReason!, product, provenance) + stubNote(ai.name, aiCandidatesSeen)
      : null,
    browserSearch,
    diagnostics: {
      extractionTier: product.extraction.tier,
      brandLinked: brand !== null,
      verifiedCandidates: verifiedItems.length,
      aiCandidates: aiCandidatesSeen,
      aiCandidatesRejected: rejections.length,
      rejections,
      elapsedMs: Date.now() - started,
      dataSource: repo.name,
      aiSource: ai.name,
      aiError,
    },
  };
}

// ---------------------------------------------------------------------------

async function loadSpec(
  key: string,
  product: ProductRef,
  repo: Repository,
  ai: AiClient,
): Promise<ProductSpec | null> {
  const cached = await repo.getCachedSpec(key);
  if (cached) return cached;

  const spec = await ai.extractSpec(product).catch(() => null);
  if (spec) await repo.putCachedSpec(key, spec).catch(() => undefined);
  return spec;
}

async function findVerified(
  product: ProductRef,
  spec: ProductSpec | null,
  repo: Repository,
): Promise<CatalogueItem[]> {
  // Exact barcode match first. It is the strongest claim the system can make.
  if (product.gtin) {
    const exact = await repo.findByGtin(product.gtin);
    if (exact.length > 0) return exact;
  }

  return repo.findAlternatives({
    category: spec?.category ?? null,
    hard: spec?.hard ?? {},
    text: product.title,
    limit: VERIFIED_POOL,
  });
}

function toCandidate(
  item: CatalogueItem,
  product: ProductRef,
  spec: ProductSpec | null,
  origin: Candidate['origin'],
  matchType: Candidate['matchType'],
  sourceUrl: string | null,
): Candidate {
  const equivalence = equivalenceScore(
    { gtin: product.gtin, title: product.title, spec },
    { gtin: item.gtin, title: item.title, category: item.category, attrs: item.attrs },
  );

  return {
    id: item.id,
    origin,
    matchType,
    title: item.title,
    brand: item.brand,
    url: item.url,
    retailer: item.retailer,
    retailerCanadianOwned: item.retailerCanadianOwned,
    priceCad: item.priceCad,
    priceChecked: item.priceChecked,
    gtin: item.gtin,
    massKg: item.massKg,
    shipsFrom: item.shipsFrom,
    provenance: placeholderProvenance(item.brand),
    components: {
      equivalence,
      // Provenance is filled in by attachProvenance once the candidate's own
      // brand has been looked up; price is final here.
      canadian: 0.5,
      price: priceScore(product.price?.amount ?? null, item.priceCad),
    },
    score: 0,
    sourceUrl,
    rationale: '',
  };
}

/**
 * Before any store is searched: a lead needs a citation, must not be the
 * brand the shopper is already looking at, and must not be a brand the
 * dataset knows to be foreign. A brand the dataset has never heard of stays -
 * absence of evidence is not evidence of foreign ownership - and is shown as
 * AI-found with its ownership marked unknown.
 */
async function screenLeads(
  leads: AiLead[],
  product: ProductRef,
  repo: Repository,
  rejections: GateRejection[],
): Promise<BrowserLead[]> {
  const ownBrand = normalizeBrand(product.brand);
  const kept: BrowserLead[] = [];
  for (const lead of leads) {
    const where = `lead:${lead.query}`;
    if (!lead.sourceUrl) {
      rejections.push({ gate: 'source_url_required', url: where, detail: `${lead.brand}: no source for the Canadian claim` });
      continue;
    }
    if (ownBrand && normalizeBrand(lead.brand) === ownBrand) {
      rejections.push({ gate: 'same_brand', url: where, detail: `${lead.brand} is the brand already on the page` });
      continue;
    }
    const record = await repo.findBrand(lead.brand);
    const verdict = verdictFor(record, lead.brand);
    if (verdict.canadianScore !== null && !qualifiesAsCanadian(verdict)) {
      rejections.push({ gate: 'brand_not_canadian', url: where, detail: `${lead.brand}: ${verdict.summary}` });
      continue;
    }
    kept.push({ ...lead, provenance: verdict });
  }
  return kept;
}

function placeholderProvenance(brand: string | null): ProvenanceVerdict {
  return verdictFor(null, brand);
}

/** Second pass: look up each candidate's own ownership and rescore. */
async function attachProvenance(candidates: Candidate[], repo: Repository): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    const brand = candidate.brand ? await repo.findBrand(candidate.brand) : null;
    const provenance = verdictFor(brand, candidate.brand);
    out.push({
      ...candidate,
      provenance,
      components: {
        ...candidate.components,
        canadian: provenance.canadianScore ?? 0.5,
      },
      rationale: candidate.rationale || provenance.summary,
    });
  }
  return out;
}

/**
 * One yes/no call per top candidate. A filter, not a ranker - it can remove a
 * candidate but never reorder one, so rankings stay reproducible.
 */
async function applySanityVeto(
  candidates: Candidate[],
  product: ProductRef,
  ai: AiClient,
  rejections: GateRejection[],
): Promise<Candidate[]> {
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    try {
      const verdict = await ai.sanityCheck(product, candidate.title);
      if (verdict.acceptable) {
        kept.push(candidate);
      } else {
        rejections.push({ gate: 'sanity_veto', url: candidate.url, detail: verdict.reason });
      }
    } catch {
      kept.push(candidate); // A failed veto must not silently drop a good match.
    }
  }
  return kept;
}

/**
 * No Canadian product exists in this category - true for essentially all
 * electronics. Offer the same item from a Canadian-owned retailer so the
 * retail margin stays in Canada, and be explicit that nothing else changes.
 */
async function retailerFallback(
  product: ProductRef,
  repo: Repository,
  weights: Weights,
): Promise<Candidate[]> {
  if (!product.gtin) return [];

  const sameProduct = await repo.findByGtin(product.gtin);
  const canadianRetailers = await repo.findCanadianRetailers();
  const canadianDomains = new Set(canadianRetailers.map((r) => r.domain));

  return sameProduct
    .filter((item) => item.retailerCanadianOwned || canadianDomains.has(domainOf(item.url)))
    .map((item) => {
      const components = {
        equivalence: 1, // Same barcode. Proof, not a guess.
        canadian: 0.5,
        price: priceScore(product.price?.amount ?? null, item.priceCad),
      };
      return {
        ...toCandidate(item, product, null, 'verified', 'retailer_swap' as const, null),
        components,
        score: totalScore(components, weights),
        rationale:
          'Identical product (same barcode) from a Canadian-owned retailer. ' +
          'The product itself is unchanged - only where the retail margin goes.',
      };
    });
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pickAbstentionReason(
  spec: ProductSpec | null,
  rejections: GateRejection[],
  aiLeads: number,
  aiError: string | null,
): AbstentionReason {
  if (aiError) return 'ai_unavailable';
  if (aiLeads > 0) {
    return rejections.length >= aiLeads ? 'all_candidates_failed_validation' : 'not_in_allowed_stores';
  }
  if (!spec) return 'insufficient_product_data';
  return 'no_canadian_alternative';
}

/**
 * Shown when the user clicks the toolbar icon on a page where we stayed quiet.
 * Abstention is a feature, but an invisible feature cannot be demonstrated -
 * so it gets a real explanation rather than an empty state.
 */
function abstentionMessage(
  reason: AbstentionReason,
  product: ProductRef,
  provenance: ProvenanceVerdict,
): string {
  const brand = provenance.displayName;
  switch (reason) {
    case 'no_canadian_alternative':
      return (
        `No Canadian alternative found for this ${product.categoryHint ?? 'product'}. ` +
        `That is a real answer, not a loading state - for some categories no Canadian ` +
        `manufacturing exists, and we would rather say so than invent a match.`
      );
    case 'ai_unavailable':
      return (
        `Nothing in our database matched, and the AI search could not run this time ` +
        `(quota or outage), so we cannot say whether a Canadian alternative exists. ` +
        `Try again later.`
      );
    case 'not_in_allowed_stores':
      // The extension replaces this once it has searched the stores.
      return (
        `Nothing in our database matched. The AI suggested Canadian alternatives; ` +
        `the store search for them runs in the browser extension.`
      );
    case 'all_candidates_failed_validation':
      return (
        `The AI suggested possible Canadian alternatives, but none passed our checks ` +
        `(no cited source, or a brand our dataset knows is not Canadian). ` +
        `Unverified suggestions are withheld rather than shown with a caveat.`
      );
    case 'insufficient_product_data':
      return (
        `We could not read enough about this listing to search safely. ` +
        `Guessing from a title alone is how wrong answers get made.`
      );
    case 'category_out_of_scope':
      return (
        `This category is outside the set we cover properly. ` +
        `We cover a few categories deeply rather than all of them badly.`
      );
    default:
      return `No alternative to show for ${brand}.`;
  }
}

/** Says so when suggestions came from the offline mock rather than Gemini. */
function stubNote(aiName: string, aiLeads: number): string {
  if (aiName !== 'mock' || aiLeads === 0) return '';
  return ' (Note: AI suggestions came from the mock backend, not Gemini.)';
}

export function normalizeWeights(weights: Weights | undefined): Weights {
  if (!weights) return DEFAULT_WEIGHTS;
  const safe = (n: unknown, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
  return {
    equivalence: safe(weights.equivalence, DEFAULT_WEIGHTS.equivalence),
    canadian: safe(weights.canadian, DEFAULT_WEIGHTS.canadian),
    price: safe(weights.price, DEFAULT_WEIGHTS.price),
  };
}

export { round };
