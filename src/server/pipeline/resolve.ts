import { normalizeBrand, productKey, round } from '../../shared/normalize';
import {
  DEFAULT_WEIGHTS,
  equivalenceScore,
  priceScore,
  rank,
  totalScore,
} from '../../shared/scoring';
import type {
  AbstentionReason,
  BrandRecord,
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
import { runGates } from './gates';
import { ownStatusFor, qualifiesAsCanadian, verdictFor } from './provenance';

/**
 * The runtime pipeline for one product.
 *
 *   spec -> brand -> provenance -> verified retrieval
 *        -> AI fallback (gated) -> retailer fallback -> score -> abstain?
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

  // 1. Spec. Cached by stable key, so this runs once per product ever.
  const spec = await loadSpec(key, product, repo, ai);

  // 2. Brand linking and the decomposed provenance verdict for what the user
  //    is looking at. This renders even when we have no alternative to offer.
  // The brand is the single most valuable field: without it the curated
  // brand-to-brand match table is unreachable and the verdict degrades to
  // "unknown". So when the page did not give us one, recover it from the
  // title, which almost always opens with the brand.
  const { brand, brandName } = await linkBrand(product, repo, request.fromSearch === true);
  const provenance = verdictFor(brand, brandName);
  const ownStatus = ownStatusFor(provenance);

  // 3. Already Canadian-owned? Then there is nothing to switch to, and
  //    suggesting a "better" Canadian option would be noise. Stop here and
  //    let the UI confirm what they are already holding. Skipping retrieval
  //    also saves a database round trip and any AI call on this path.
  if (ownStatus === 'canadian') {
    return {
      key,
      product,
      spec,
      provenance,
      ownStatus,
      alreadyCanadian: true,
      candidates: [],
      abstained: false,
      abstentionReason: null,
      abstentionMessage: null,
      diagnostics: {
        extractionTier: product.extraction.tier,
        brandLinked: brand !== null,
        verifiedCandidates: 0,
        aiCandidates: 0,
        aiCandidatesRejected: 0,
        rejections: [],
        elapsedMs: Date.now() - started,
        dataSource: repo.name,
        aiSource: ai.name,
      },
    };
  }

  // 4. Verified path.
  const verifiedItems = await findVerified(product, spec, repo, brandName);
  let candidates = verifiedItems.map((item) =>
    toCandidate(item, product, spec, 'verified', item.gtin && item.gtin === product.gtin ? 'gtin_exact' : 'equivalent', null),
  );

  // 5. AI fallback - only when the database came up empty.
  if (candidates.length === 0 && !request.verifiedOnly) {
    const proposed = await ai.searchAlternative({ product, spec, limit: 4 }).catch(() => []);
    aiCandidatesSeen = proposed.length;

    for (const proposal of proposed) {
      const result = await runGates(proposal);
      if (!result.passed) {
        if (result.rejection) rejections.push(result.rejection);
        continue;
      }
      candidates.push(
        toCandidateFromAi(proposal, result.verified!, product, spec),
      );
    }
  }

  // 6. Provenance filter. A candidate that is not actually Canadian is not an
  //    alternative, however well it matches on attributes.
  candidates = await attachProvenance(candidates, repo);
  candidates = candidates.filter((c) => qualifiesAsCanadian(c.provenance));

  // 7. Rank deterministically, then veto the top few.
  candidates = rank(candidates, weights);
  if (deps.sanityVeto !== false && candidates.length > 0) {
    candidates = await applySanityVeto(candidates.slice(0, maxCandidates + 2), product, ai, rejections);
    candidates = rank(candidates, weights);
  }
  candidates = candidates.slice(0, maxCandidates);

  // 8. Retailer fallback. When there is no Canadian product, the lever moves
  //    from what you buy to where you buy it.
  if (candidates.length === 0) {
    const swaps = await retailerFallback(product, repo, weights);
    candidates = swaps.slice(0, maxCandidates);
  }

  const abstained = candidates.length === 0;
  const abstentionReason = abstained
    ? pickAbstentionReason(spec, rejections, aiCandidatesSeen)
    : null;

  return {
    key,
    product,
    spec,
    provenance,
    ownStatus,
    alreadyCanadian: false,
    candidates,
    abstained,
    abstentionReason,
    abstentionMessage: abstained
      ? abstentionMessage(abstentionReason!, product, provenance) + stubNote(ai.name, aiCandidatesSeen)
      : null,
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
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Resolves the page's brand, falling back to leading n-grams of the title.
 *
 * Longest first, so "Head & Shoulders" is tried before "Head" - a one-word
 * fragment is exactly the kind of thing that fuzzy-matches the wrong
 * company, and a confidently wrong owner is worse than an honest unknown.
 */
async function linkBrand(
  product: ProductRef,
  repo: Repository,
  fromSearch: boolean,
): Promise<{ brand: BrandRecord | null; brandName: string | null }> {
  if (product.brand) {
    const found = await repo.findBrand(product.brand);
    if (found) return { brand: found, brandName: product.brand };
  }

  // On a search page the "title" is whatever the user typed, so treating it
  // as a brand is actively harmful: "laundry detergent" fuzzy-matched the
  // clothing label "Local Laundry", which is Canadian-owned, and the whole
  // lookup short-circuited to "you are already buying Canadian".
  if (fromSearch) return { brand: null, brandName: null };

  for (const candidate of brandCandidatesFromTitle(product.title)) {
    const found = await repo.findBrand(candidate);
    if (found) return { brand: found, brandName: found.displayName };
  }

  return { brand: null, brandName: product.brand };
}

/** Leading 4-, 3- and 2-word prefixes of the title, longest first. */
export function brandCandidatesFromTitle(title: string): string[] {
  const words = title
    .split(/[\s,|–—]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 4);

  const out: string[] = [];
  for (let n = words.length; n >= 2; n--) out.push(words.slice(0, n).join(' '));

  // A single leading word only when it is substantial enough to identify a
  // brand on its own: "Dove", "Tide", "Colgate" - never "The" or "Pro".
  const first = words[0];
  if (first && first.length >= 4) out.push(first);

  return out;
}

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
  /** The linked brand, which may have been recovered from the title. */
  brandName: string | null,
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
    // The LINKED brand, not the raw page field. A brand recovered from the
    // title is the only way into the curated match table on sites that do
    // not publish one, and passing the raw null here wasted that recovery.
    brand: brandName ?? product.brand,
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
  // A repository that reports its own match quality knows better than we do.
  // Curated "Broad coverage, verified" beats token overlap between a listing
  // title and a different brand's name, which is near zero by construction.
  const equivalence =
    typeof item.similarity === 'number'
      ? item.similarity
      : equivalenceScore(
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

function toCandidateFromAi(
  proposal: { title: string; brand: string | null; retailer: string | null; sourceUrl: string | null; claim: string },
  verified: ProductRef,
  product: ProductRef,
  spec: ProductSpec | null,
): Candidate {
  const equivalence = equivalenceScore(
    { gtin: product.gtin, title: product.title, spec },
    { gtin: verified.gtin, title: verified.title, category: null, attrs: {} },
  );

  return {
    // Facts come from the retailer's own page, not from the model. The model
    // only supplied the lead; everything displayed was re-read from source.
    id: `ai:${verified.site}:${verified.siteId ?? verified.title.slice(0, 40)}`,
    origin: 'ai',
    matchType: 'equivalent',
    title: verified.title,
    brand: verified.brand ?? proposal.brand,
    url: verified.url,
    retailer: proposal.retailer ?? verified.site,
    retailerCanadianOwned: null,
    priceCad: verified.price?.amount ?? null,
    priceChecked: new Date().toISOString().slice(0, 10),
    gtin: verified.gtin,
    massKg: verified.massKg,
    shipsFrom: null,
    provenance: placeholderProvenance(verified.brand ?? proposal.brand),
    components: {
      equivalence,
      canadian: 0.5,
      price: priceScore(product.price?.amount ?? null, verified.price?.amount ?? null),
    },
    score: 0,
    sourceUrl: proposal.sourceUrl,
    rationale: proposal.claim,
  };
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
  aiCandidatesSeen: number,
): AbstentionReason {
  if (!spec) return 'insufficient_product_data';
  if (aiCandidatesSeen > 0 && rejections.length >= aiCandidatesSeen) {
    return 'all_candidates_failed_validation';
  }
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
    case 'all_candidates_failed_validation':
      return (
        `We found possible Canadian alternatives but could not verify any of them - ` +
        `the links did not resolve to a real product page we could read a price from. ` +
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

/**
 * While the AI fallback is a stub it rejects everything by construction, so an
 * abstention there says nothing about whether a Canadian alternative exists.
 * Saying so beats letting someone conclude the matcher is broken.
 */
function stubNote(aiName: string, aiCandidatesSeen: number): string {
  if (aiName !== 'mock' || aiCandidatesSeen === 0) return '';
  return (
    ' (Note: the AI fallback is still a stub - it returns fixtures that fail validation by design, ' +
    'so this abstention reflects the placeholder backend, not a real search.)'
  );
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
