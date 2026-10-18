import { normalizeBrand } from '../../shared/normalize';
import { siteFor } from '../../shared/retailers';
import { listingMatchesLead } from '../../shared/stores';
import type { BrowserLead, ProductRef, ProductSpec } from '../../shared/types';
import type { AiStore, StoredAlternativeInput } from '../data/ai-store';

/**
 * Remembering what the browser found for an AI lead.
 *
 * The AI fallback's store search runs in the extension (the stores block
 * servers), so the server never sees the verified listing - and the AI store
 * could not remember it. The extension reports its finds back instead.
 *
 * The API is open, so a report is accepted only when it answers a lead this
 * server issued for this product recently, sits on one of that request's
 * allowed stores, and is that lead's brand and product type. Nobody can
 * plant an arbitrary product; the worst a forged report can do is point a
 * lead we issued at a different listing of the same brand on the same store.
 */

const ISSUED_TTL_MS = 30 * 60 * 1000;
const MAX_ISSUED = 2000;

interface Issued {
  product: ProductRef;
  spec: ProductSpec | null;
  leads: BrowserLead[];
  sites: string[];
  aiBackend: string;
  at: number;
}

const issued = new Map<string, Issued>();

export function rememberIssuedLeads(key: string, entry: Omit<Issued, 'at'>): void {
  issued.delete(key); // Re-insert so the map stays in issue order for pruning.
  issued.set(key, { ...entry, at: Date.now() });
  const cutoff = Date.now() - ISSUED_TTL_MS;
  for (const [k, v] of issued) {
    if (v.at >= cutoff && issued.size <= MAX_ISSUED) break;
    issued.delete(k);
  }
}

/** A listing the extension found and verified for one of our leads. */
export interface ReportedFind {
  url: string;
  title: string;
  brand: string | null;
  retailer: string;
  priceCad: number | null;
  gtin: string | null;
  massKg: number | null;
  sourceUrl: string | null;
  claim: string;
}

export async function saveBrowserFinds(
  key: string,
  finds: ReportedFind[],
  aiStore: AiStore,
): Promise<{ saved: number; refused: number }> {
  const entry = issued.get(key);
  if (!entry || Date.now() - entry.at > ISSUED_TTL_MS) return { saved: 0, refused: finds.length };

  const accepted: StoredAlternativeInput[] = [];
  for (const find of finds) {
    if (!siteFor(find.url, entry.sites)) continue;
    const lead = entry.leads.find(
      (l) => l.sourceUrl === find.sourceUrl && listingMatchesLead(`${find.brand ?? ''} ${find.title}`, l),
    );
    if (!lead || !lead.sourceUrl) continue;
    accepted.push({
      productKey: key,
      originalBrandKey: normalizeBrand(entry.product.brand) || null,
      originalTitle: entry.product.title,
      originalSite: entry.product.site,
      category: entry.spec?.category ?? null,
      url: find.url,
      title: find.title,
      brand: find.brand ?? lead.brand,
      retailer: find.retailer,
      priceCad: find.priceCad,
      gtin: find.gtin,
      massKg: find.massKg,
      // The lead's citation, not the report's: only what we issued is trusted.
      sourceUrl: lead.sourceUrl,
      claim: lead.claim,
      aiBackend: entry.aiBackend,
    });
  }

  if (accepted.length > 0) await aiStore.save(accepted);
  return { saved: accepted.length, refused: finds.length - accepted.length };
}
