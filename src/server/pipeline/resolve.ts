import { normalizeBrand, productKey, round } from '../../shared/normalize';
import { allowedSitesFor } from '../../shared/retailers';
import {
  DEFAULT_WEIGHTS,
  equivalenceScore,
  priceScore,
  rankPreferringSite,
  totalScore,
} from '../../shared/scoring';
import type {
  AbstentionReason,
  AiLead,
  BrandRecord,
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
import type { AiStore, StoredAlternative } from '../data/ai-store';
import type { CatalogueItem, Repository } from '../data/repository';
import { rememberIssuedLeads } from './ai-finds';
import { findProductLink, priceCeiling, requiredNouns, searchTermsFor } from './storefront';
import { ownStatusFor, qualifiesAsCanadian, verdictFor } from './provenance';

/**
 * The runtime pipeline for one product.
 *
 *   spec -> brand -> provenance -> verified retrieval
 *        -> stored AI discoveries -> retailer fallback -> score -> abstain?
 *        -> (still nothing) AI suggestions -> store search in the browser
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
  /** Second database: remembered AI discoveries. Omit to never store them. */
  aiStore?: AiStore;
  /** Used by the gates to fetch candidate pages. Injected in tests. */
  fetchImpl?: typeof fetch;
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
  // The brand is the single most valuable field: without it the curated
  // brand-to-brand match table is unreachable and the verdict degrades to
  // "unknown". So when the page did not give us one, recover it from the
  // title, which almost always opens with the brand.
  const { brand, brandName } = await linkBrand(product, repo, request.fromSearch === true);
  const provenance = verdictFor(brand, brandName);

  // Who runs this shop? On a small Canadian retailer's own site the product
  // brand is often absent from the directory while the shop itself is in
  // it, and "you are on a Canadian retailer" beats saying nothing at all.
  const siteBrand = await findSiteBrand(product, repo);
  const ownStatus = ownStatusFor(provenance);

  // 3. Already Canadian? Then there is nothing to switch to, and suggesting
  //    a "better" Canadian option would be noise. Stop here and let the UI
  //    confirm what they are already holding. Skipping retrieval also saves a
  //    database round trip and any AI call on this path.
  //    Either test counts: Canadian-owned (or directory-listed), or clearing
  //    the same bar an alternative has to - so a brand made, run and founded
  //    in Canada under a foreign parent is not "replaced" with another one.
  if (ownStatus === 'canadian' || qualifiesAsCanadian(provenance)) {
    return {
      key,
      product,
      spec,
      provenance,
      ownStatus,
      alreadyCanadian: true,
      siteBrand,
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
        aiStoreHits: 0,
        rejections: [],
        elapsedMs: Date.now() - started,
        dataSource: repo.name,
        aiSource: ai.name,
        aiError: null,
      },
      browserSearch: null,
    };
  }

  // 4. Verified path.
  const verifiedItems = await findVerified(product, spec, repo, brandName);
  let candidates = verifiedItems.map((item) =>
    toCandidate(item, product, spec, 'verified', item.gtin && item.gtin === product.gtin ? 'gtin_exact' : 'equivalent', null),
  );

  // 5. Earlier AI discoveries for this product, when the database came up
  //    empty. They stay origin 'ai'. Fresh suggestions come last (step 9).
  const brandKey = normalizeBrand(product.brand) || null;
  let aiStoreHits = 0;

  if (candidates.length === 0 && !request.verifiedOnly && deps.aiStore) {
    const stored = await deps.aiStore
      .find({ productKey: key, brandKey, category: spec?.category ?? null, limit: 4 })
      .catch((error) => {
        console.error('[ai-store] find failed:', error instanceof Error ? error.message : error);
        return [];
      });
    aiStoreHits = stored.length;
    candidates = stored.map((entry) => toCandidateFromStore(entry, product, spec));
  }

  // 6. Provenance filter. A candidate that is not actually Canadian is not an
  //    alternative, however well it matches on attributes.
  //    An AI find whose brand the dataset has never heard of stays, shown as
  //    AI-found with ownership unknown; one the dataset knows is foreign goes.
  candidates = await attachProvenance(candidates, repo);
  candidates = candidates.filter(
    (c) => qualifiesAsCanadian(c.provenance) || (c.origin === 'ai' && c.provenance.canadianScore === null),
  );

  // A brand is not an alternative to itself. On a Canadian brand's own
  // store the retrieval happily matches the brand to its own catalogue and
  // recommends the exact product already on screen, which reads as the tool
  // not knowing where it is. Dropped before the storefront lookups so we do
  // not spend a request confirming it either.
  const pageBrand = normalizeBrand(brandName ?? product.brand ?? '');
  if (pageBrand) {
    candidates = candidates.filter((c) => normalizeBrand(c.brand ?? '') !== pageBrand);
  }

  // 7. Rank deterministically (shopper's own site first), then veto the top few.
  candidates = rankPreferringSite(candidates, weights, product.site);
  if (deps.sanityVeto !== false && candidates.length > 0) {
    candidates = await applySanityVeto(candidates.slice(0, maxCandidates + 2), product, ai, rejections);
    candidates = rankPreferringSite(candidates, weights, product.site);
  }
  candidates = candidates.slice(0, maxCandidates);

  // Only now, on the handful we will actually show, turn each brand
  // homepage into a real product link. Doing this before ranking would mean
  // a network request per candidate across a pool of thirty.
  candidates = await attachProductLinks(candidates, product, spec);

  // Belt and braces: the storefront lookup can land on the very page the
  // shopper is reading, even when the brand names differ.
  candidates = candidates.filter((c) => !sameProductUrl(c.url, product.url));

  // Enforce the ceiling wherever the price came from. A candidate several
  // times the price of what the shopper is holding is a different purchase,
  // not a dearer version of the same one.
  const ceiling = product.price ? priceCeiling(product.price.amount) : null;
  if (ceiling !== null) {
    candidates = candidates.filter((c) => c.priceCad === null || c.priceCad <= ceiling);
  }

  candidates = rankPreferringSite(candidates, weights, product.site);

  // 8. Retailer fallback. When there is no Canadian product, the lever moves
  //    from what you buy to where you buy it.
  if (candidates.length === 0) {
    const swaps = await retailerFallback(product, repo, weights);
    candidates = swaps.slice(0, maxCandidates);
  }

  // 9. AI fallback - only when nothing above found anything. The AI names
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

    const kept = await screenLeads(leads, brandName ?? product.brand, repo, rejections);
    if (kept.length > 0 && request.browserCheck) {
      browserSearch = { leads: kept, sites };
      // So the finds the extension reports back can be checked and stored.
      if (deps.aiStore) rememberIssuedLeads(key, { product, spec, leads: kept, sites, aiBackend: ai.name });
    }
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
    ownStatus,
    alreadyCanadian: false,
    siteBrand,
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
      aiStoreHits,
      rejections,
      elapsedMs: Date.now() - started,
      dataSource: repo.name,
      aiSource: ai.name,
      aiError,
    },
    browserSearch,
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

/** The storefront's own listing in the Canadian brands directory. */
async function findSiteBrand(
  product: ProductRef,
  repo: Repository,
): Promise<{ name: string; source: string | null } | null> {
  if (!product.site) return null;
  try {
    const found = await repo.findBrandByDomain(product.site);
    if (!found || found.listedCanadian.value !== true) return null;
    return { name: found.displayName, source: found.listedCanadian.source };
  } catch {
    return null;
  }
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
    linkKind: 'brand',
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
 * A previous AI discovery. Its facts were re-read from the retailer page when
 * it was stored; provenance is looked up afresh by attachProvenance.
 */
function toCandidateFromStore(
  entry: StoredAlternative,
  product: ProductRef,
  spec: ProductSpec | null,
): Candidate {
  const equivalence = equivalenceScore(
    { gtin: product.gtin, title: product.title, spec },
    { gtin: entry.gtin, title: entry.title, category: null, attrs: {} },
  );

  return {
    id: `ai-store:${entry.id}`,
    origin: 'ai',
    matchType: 'equivalent',
    title: entry.title,
    brand: entry.brand,
    url: entry.url,
    linkKind: 'product',
    retailer: entry.retailer,
    retailerCanadianOwned: null,
    priceCad: entry.priceCad,
    priceChecked: entry.verifiedAt.slice(0, 10),
    gtin: entry.gtin,
    massKg: entry.massKg,
    shipsFrom: null,
    provenance: placeholderProvenance(entry.brand),
    components: {
      equivalence,
      canadian: 0.5,
      price: priceScore(product.price?.amount ?? null, entry.priceCad),
    },
    score: 0,
    sourceUrl: entry.sourceUrl,
    rationale: entry.claim,
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
  pageBrand: string | null,
  repo: Repository,
  rejections: GateRejection[],
): Promise<BrowserLead[]> {
  const ownBrand = normalizeBrand(pageBrand);
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

/**
 * Replaces homepage links with deep links, and backfills the prices the
 * ownership dataset does not carry. Runs candidates in parallel; any that
 * fails keeps its homepage link rather than disappearing.
 */
async function attachProductLinks(
  candidates: Candidate[],
  product: ProductRef,
  spec: ProductSpec | null,
): Promise<Candidate[]> {
  const terms = searchTermsFor(product.title, product.brand, spec?.category ?? null);
  if (!terms.trim()) return candidates;

  const specType = typeof spec?.hard['type'] === 'string' ? (spec.hard['type'] as string) : null;
  const mustBe = requiredNouns(spec?.category ?? null, specType);

  return Promise.all(
    candidates.map(async (candidate) => {
      try {
        const found = await findProductLink(
          candidate.url,
          terms,
          mustBe,
          product.price?.amount ?? null,
        );
        if (!found) return candidate;

        return {
          ...candidate,
          url: found.url,
          title: found.title,
          linkKind: 'product' as const,
          priceCad: found.priceCad ?? candidate.priceCad,
          priceChecked:
            found.priceCad !== null ? new Date().toISOString().slice(0, 10) : candidate.priceChecked,
          retailer: candidate.brand ?? candidate.retailer,
          components: {
            ...candidate.components,
            // A real price makes the price weighting mean something again.
            price: priceScore(product.price?.amount ?? null, found.priceCad),
          },
        };
      } catch {
        return candidate; // A homepage link beats no candidate.
      }
    }),
  );
}

/** Compares URLs ignoring query strings, fragments and a trailing slash. */
function sameProductUrl(a: string, b: string): boolean {
  const normalize = (raw: string): string => {
    try {
      const url = new URL(raw);
      return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  };
  if (!a || !b) return false;
  return normalize(a) === normalize(b);
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
