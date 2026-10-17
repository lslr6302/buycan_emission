import { round } from '../../shared/normalize';
import type {
  CartAnalysis,
  CartLine,
  CartLineAnalysis,
  CartRequest,
} from '../../shared/types';
import { type PipelineDeps, normalizeWeights, resolveProduct } from './resolve';

/**
 * Cart aggregation - the demo centrepiece.
 *
 * A badge on one product is a curiosity. The same logic over a whole cart
 * produces a dollar figure large enough to feel, which is the difference
 * between a browser extension and a point.
 */

export async function analyzeCart(request: CartRequest, deps: PipelineDeps): Promise<CartAnalysis> {
  const started = Date.now();
  const weights = normalizeWeights(request.weights);

  const lines: CartLineAnalysis[] = [];
  for (const line of request.lines) {
    lines.push(await analyzeLine(line, request, weights, deps));
  }

  let totalCad = 0;
  let staysInCanadaCad = 0;
  let leavesCanadaCad = 0;
  let unknownCad = 0;
  let swapCount = 0;
  let swapPriceDeltaCad = 0;
  let afterSwapStaysInCanadaCad = 0;

  for (const analysis of lines) {
    const value = analysis.lineTotalCad ?? 0;
    totalCad += value;

    if (analysis.flow === 'stays_in_canada') {
      staysInCanadaCad += value;
      afterSwapStaysInCanadaCad += value;
    } else if (analysis.flow === 'leaves_canada') {
      leavesCanadaCad += value;
    } else {
      unknownCad += value;
    }

    const swap = analysis.bestSwap;
    if (swap && analysis.flow !== 'stays_in_canada') {
      swapCount++;
      const qty = analysis.line.qty;
      const swapTotal = swap.priceCad === null ? value : swap.priceCad * qty;
      swapPriceDeltaCad += swapTotal - value;
      afterSwapStaysInCanadaCad += swapTotal;
    }
  }

  const analysis: CartAnalysis = {
    currency: 'CAD',
    totalCad: round(totalCad),
    staysInCanadaCad: round(staysInCanadaCad),
    leavesCanadaCad: round(leavesCanadaCad),
    unknownCad: round(unknownCad),
    swapCount,
    swapPriceDeltaCad: round(swapPriceDeltaCad),
    afterSwapStaysInCanadaCad: round(afterSwapStaysInCanadaCad),
    lines,
    headline: '',
    diagnostics: {
      linesAnalyzed: lines.length,
      abstentions: lines.filter((l) => l.abstained).length,
      elapsedMs: Date.now() - started,
    },
  };

  analysis.headline = headlineFor(analysis);
  return analysis;
}

async function analyzeLine(
  line: CartLine,
  request: CartRequest,
  weights: CartRequest['weights'],
  deps: PipelineDeps,
): Promise<CartLineAnalysis> {
  const resolved = await resolveProduct(
    {
      product: line.product,
      weights,
      verifiedOnly: request.verifiedOnly,
      destinationRegion: request.destinationRegion,
    },
    deps,
  );

  const unitPrice = line.product.price?.amount ?? null;
  const lineTotalCad = unitPrice === null ? null : round(unitPrice * line.qty);

  return {
    line,
    provenance: resolved.provenance,
    lineTotalCad,
    flow: flowFor(resolved.provenance),
    bestSwap: resolved.candidates[0] ?? null,
    abstained: resolved.abstained,
  };
}

/**
 * Where this line's money ends up. Unknown is its own bucket rather than being
 * folded into "leaves Canada" - inflating the headline number with guesses
 * would be the same sin the tool exists to call out.
 */
function flowFor(provenance: CartLineAnalysis['provenance']): CartLineAnalysis['flow'] {
  const owned = provenance.dimensions.canadianOwned.value;
  if (owned === true) return 'stays_in_canada';
  if (owned === false) return 'leaves_canada';
  return 'unknown';
}

function headlineFor(analysis: CartAnalysis): string {
  const money = (n: number) => `$${n.toFixed(2)}`;

  if (analysis.totalCad === 0) {
    return 'No priced items found in this cart.';
  }

  const parts: string[] = [
    `Your ${money(analysis.totalCad)} cart sends ${money(analysis.leavesCanadaCad)} outside Canada.`,
  ];

  if (analysis.unknownCad > 0) {
    parts.push(`${money(analysis.unknownCad)} could not be traced and is counted as unknown, not as foreign.`);
  }

  if (analysis.swapCount > 0) {
    const delta = analysis.swapPriceDeltaCad;
    const cost =
      Math.abs(delta) < 0.01
        ? 'at the same price'
        : delta > 0
          ? `for ${money(delta)} more`
          : `and save ${money(Math.abs(delta))}`;
    parts.push(
      `Swap ${analysis.swapCount} item${analysis.swapCount === 1 ? '' : 's'} ` +
        `and ${money(analysis.afterSwapStaysInCanadaCad)} stays here, ${cost}.`,
    );
  } else {
    parts.push('We found no verified Canadian swap for the foreign-owned items in this cart.');
  }

  return parts.join(' ');
}
