import { canadianScore, coverageScore } from '../../shared/scoring';
import { unknown } from '../../shared/types';
import type { BrandRecord, ProvenanceVerdict, Sourced } from '../../shared/types';

/**
 * Turns a brand record into the decomposed verdict the UI renders.
 *
 * The decomposition is the product. A single "is it Canadian" boolean is what
 * competitors ship and what gets them wrong: Miss Vickie's is Canadian-founded,
 * American-owned and made in Canada all at once, and a shopper deserves to see
 * which of those they are buying.
 */

export function verdictFor(brand: BrandRecord | null, rawBrandName: string | null): ProvenanceVerdict {
  if (!brand) {
    return unlinkedVerdict(rawBrandName);
  }

  const dimensions = {
    canadianOwned: ownershipDimension(brand),
    canadianFounded: countryIs(brand.foundedIn, 'CA'),
    hqInCanada: countryIs(brand.hqCountry, 'CA'),
    madeInCanada: countryIs(brand.mfgOrigin, 'CA'),
  };

  const verdict: ProvenanceVerdict = {
    brandKey: brand.key,
    displayName: brand.displayName,
    dimensions,
    ultimateParent: brand.parent,
    cfiaClass: brand.cfiaClass,
    canadianScore: null,
    coverage: coverageScore({ dimensions }),
    summary: '',
    isUnknown: false,
  };

  verdict.canadianScore = canadianScore(verdict);
  verdict.isUnknown = verdict.coverage === 0;
  verdict.summary = summarize(verdict, brand);
  return verdict;
}

/**
 * Ownership is derived from the ultimate parent, not the immediate one, and
 * not from the brand's own marketing. A brand with no identified parent is
 * treated as independent only when we have a sourced HQ in Canada to stand on -
 * otherwise it stays unknown.
 */
function ownershipDimension(brand: BrandRecord): Sourced<boolean> {
  const parentHq = brand.parentHq;
  if (parentHq.value) {
    return {
      value: parentHq.value.toUpperCase() === 'CA',
      source: parentHq.source,
      confidence: parentHq.confidence,
    };
  }

  // No parent found. Privately held Canadian SMBs land here constantly - the
  // structured sources simply do not cover them.
  const noParent = brand.parent.value === null;
  if (noParent && brand.inferOwnershipFromHq !== false && brand.hqCountry.value) {
    return {
      value: brand.hqCountry.value.toUpperCase() === 'CA',
      source: brand.hqCountry.source,
      confidence: 'medium',
    };
  }

  return unknown<boolean>(parentHq.reason ?? 'no sourced ownership chain');
}

function countryIs(field: Sourced<string>, country: string): Sourced<boolean> {
  if (field.value === null) {
    return unknown<boolean>(field.reason ?? 'no evidence found');
  }
  return {
    value: field.value.toUpperCase() === country,
    source: field.source,
    confidence: field.confidence,
  };
}

function unlinkedVerdict(rawBrandName: string | null): ProvenanceVerdict {
  const reason = rawBrandName
    ? `brand "${rawBrandName}" not found in the ownership dataset`
    : 'no brand could be read from this page';
  return {
    brandKey: null,
    displayName: rawBrandName ?? 'Unknown brand',
    dimensions: {
      canadianOwned: unknown<boolean>(reason),
      canadianFounded: unknown<boolean>(reason),
      hqInCanada: unknown<boolean>(reason),
      madeInCanada: unknown<boolean>(reason),
    },
    ultimateParent: unknown<string>(reason),
    cfiaClass: null,
    canadianScore: null,
    coverage: 0,
    summary: 'Ownership unknown. We would rather say so than guess.',
    isUnknown: true,
  };
}

/**
 * One honest sentence. Where the dimensions disagree, the disagreement is the
 * headline rather than something to be averaged away.
 */
function summarize(verdict: ProvenanceVerdict, brand: BrandRecord): string {
  const d = verdict.dimensions;
  const owned = d.canadianOwned.value;
  const made = d.madeInCanada.value;
  const founded = d.canadianFounded.value;
  const parent = brand.parent.value;

  if (owned === false && founded === true) {
    const where = parent ? `${parent}` : 'a foreign parent';
    return made === true
      ? `Canadian-founded and still made in Canada, but owned by ${where}.`
      : `Canadian-founded, now owned by ${where}.`;
  }
  if (owned === true && made === false) {
    return 'Canadian-owned, but manufactured overseas - the ownership is Canadian, the making is not.';
  }
  if (owned === true && made === true) {
    return 'Canadian-owned and made in Canada.';
  }
  if (owned === true) {
    return 'Canadian-owned. Manufacturing origin unknown.';
  }
  if (owned === false) {
    return parent ? `Foreign-owned, ultimate parent ${parent}.` : 'Foreign-owned.';
  }
  if (made === true) {
    return 'Made in Canada, but ownership could not be established.';
  }
  return 'Not enough sourced evidence to say. Treated as unknown.';
}

/** Does this verdict justify calling the product a Canadian alternative? */
export function qualifiesAsCanadian(verdict: ProvenanceVerdict): boolean {
  const score = verdict.canadianScore;
  return score !== null && score >= 0.5;
}
