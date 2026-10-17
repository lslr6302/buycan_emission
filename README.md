# buycan_emission

Browser extension that tells you who really owns a brand on a shopping page,
whether a verified Canadian alternative exists, and what switching costs — and
says **Unknown** when it does not know.

Works on any storefront that publishes schema.org product markup (most of the
web), with hand-written adapters for sites that do not.

---

## Run it

```bash
npm install
npm run server      # API on http://localhost:8787
npm run build:ext   # bundles to dist/extension
npm test            # 38 smoke tests
```

Then: `chrome://extensions` → Developer mode → **Load unpacked** → `dist/extension`.

`npm run watch:ext` rebuilds on change. The extension still needs a manual
reload in `chrome://extensions` after each rebuild.

### Testing against real storefronts
 
The shipped build only injects on six curated sites. To try it anywhere:

```bash
npm run build:ext:dev     # same code, manifest widened to every site
```

Then open any product page and click the toolbar icon. The popup's **"What
this page looked like"** panel reports which adapter claimed the page, which
extraction tier fired, and what it read — so "nothing happened" tells you
*which* thing failed:

| Panel says | Meaning |
|---|---|
| `generic` / `none` | No schema.org Product markup. Needs an adapter. |
| `generic` / `product`, extraction `none` | Claims to be a product page, nothing readable. |
| tier `jsonld`, no candidates | Extraction worked. The dataset has no match. |
| "Cannot reach the lookup API" | `npm run server` is not running. |

Localhost works no matter which site you are on: the fetch happens in the
extension's service worker, not in the page, so there is no mixed-content
problem and the site's own CSP does not apply.

Never ship the dev build — `<all_urls>` at install is the fastest way to lose
a privacy-minded judge.

Check what is actually wired up:

```bash
curl localhost:8787/v1/health
# {"dataBackend":"mock(seed)","aiBackend":"mock",...}
```

---

## Status: runs end to end on placeholder data

| Piece | State |
|---|---|
| Generic extraction (JSON-LD / microdata / OpenGraph) | done, tested |
| Amazon + Shopify adapters | done, untested against live pages |
| Ownership verdict, decomposed with per-field sources | done |
| Deterministic scoring + client-side re-ranking | done, tested |
| AI candidate validation gates | done, tested |
| Cart aggregation | done |
| Overlay + popup | done, needs real-page testing |
| Ownership data (Tiger Cloud) | connected: 1,404 Canadian brands, 1,250 US brands, 2,431 matches |
| **Product catalogue** | **none — alternatives are brand-level, no prices or deep links** |
| **Gemini integration** | **stub — throws NotImplemented** |

The seed data under `src/server/data/seed/` is unverified placeholder and every
catalogue URL is a brand homepage, not a real product link. It exists so the
pipeline runs. It is not safe to show a judge.

**A product in a category with no seed items will abstain.** Covered so far:
hair care, oral care, body wash, deodorant, lotion, laundry, chips, coffee,
tee shirts, drinkware, vitamins. Anything else falls through to the AI
fallback — which is still a stub that rejects its own fixtures by design, so
that abstention says nothing about whether an alternative exists. The popup
and the abstention message both say when that is what happened.

---

## Integration: the three seams

Each partner owns exactly one file. Nothing else needs to change.

### 1. Data → TigerData

**File:** `src/server/data/tiger-repository.ts`
**Interface:** `src/server/data/repository.ts`

**Connected.** `npm run server` uses Tiger Cloud whenever `.env` holds
`TIMESCALE_SERVICE_URL` (or `TIGER_URL`); `DATA_BACKEND=mock` forces the seed
data. The repository reads the live schema as-is, read-only:

| Table | Used for |
|---|---|
| `brands` | Canadian brands; `status_tags` become the four provenance dimensions, `verification` becomes confidence |
| `us_brands` | Brand linking for the product being viewed; listed = sourced "not Canadian-owned" |
| `matches` | The verified alternatives: product brand → US brand → curated Canadian brands |
| `ownership_overrides` | Team-researched ultimate owner; beats the tags |

What the dataset does not have, and what that means:

- **Brand-level, not product-level.** No products, prices, GTINs or retailers,
  so a candidate is a Canadian brand linking to its homepage, price scores
  neutral, and the GTIN and retailer-swap paths return nothing.
- **Sources are per-row, not per-field.** Every tag-derived fact cites the
  row's first source.
- **"HQ in Canada" without "Canadian-owned" stays unknown**, matching the
  dataset's own `swaps` view, rather than being inferred as Canadian-owned.
- **No spec cache table**; specs are cached in process memory.
- Brand linking is exact-or-high-similarity (`pg_trgm` ≥ 0.6) on purpose:
  `"Starbucks Coffee"` misses rather than risking a link to the wrong company.

### 1b. AI discoveries → second database

**Files:** `src/server/data/ai-store.ts` (interface + in-memory),
`src/server/data/tiger-ai-store.ts` (Postgres)

When the curated data has nothing and the AI fallback finds an alternative
that passes every gate, the provenance filter and the sanity veto, it is saved
to `ai_fallback.alternatives`. Later lookups check there **before** calling the
model:

```
curated data  →  stored AI discoveries  →  new AI search (saved if it survives)
```

- A separate schema, created on startup if missing, so the curated tables stay
  read-only. Set `AI_STORE_URL` to put it on a different Tiger service.
- Reused for the exact same product, or the same brand in the same category.
- Stored finds stay `origin: 'ai'` forever and are shown with the AI tag;
  promoting one to the curated data is a human decision.
- Ownership is not stored; it is re-checked against the curated data on every
  lookup, so a correction there applies immediately.
- Entries expire after 30 days (`AI_STORE_TTL_DAYS`), then the model re-runs.
- `AI_STORE=memory` keeps it in-process; `AI_STORE=none` disables it.
  `verifiedOnly` requests skip it entirely.

```sql
select original_title, title, url, hit_count, verified_at
  from ai_fallback.alternatives order by verified_at desc;
```

### 2. AI → Gemini

**File:** `src/server/ai/gemini-client.ts`
**Interface:** `src/server/ai/client.ts`

Three methods, three narrow jobs:

| Method | Job |
|---|---|
| `extractSpec` | messy listing text → structured spec. Cached, runs once per product ever. |
| `searchAlternative` | web-grounded search, **only** when the verified dataset came up empty |
| `sanityCheck` | yes/no veto on a top candidate. A filter, never a ranker. |

```bash
AI_BACKEND=gemini GEMINI_API_KEY=... npm run server
```

Three things the prompts must not do, because they are the project thesis:

1. **Never ask the model who owns a brand.** That is a database lookup. A model
   answers confidently, wrongly, and without a citation.
2. **Never ask the model to rank.** Ranking is arithmetic in
   `src/shared/scoring.ts` so the same cart produces the same order every time —
   nondeterminism in a live demo is fatal, and an unrankable system cannot go in
   the eval harness.
3. **Always demand a resolvable product URL and a source URL**, and tell the
   model that returning nothing is a correct answer.

Everything it returns is treated as hostile input and runs
`src/server/pipeline/gates.ts` before any user sees it. `MockAiClient`
deliberately returns one fabricated candidate so the gates are exercised on
every run — that is a test fixture, not a bug.

### 3. Sites → adapters

**Directory:** `src/extension/adapters/`

```ts
export default {
  id: 'example',
  match: /(^|\.)example\.ca$/,
  pageKind: () => /\/products\//.test(location.pathname) ? 'product' : 'none',
  product: null,        // null = generic extraction handles it
  cart: async () => [], // omit if no cart support yet
};
```

Most adapters are three lines, because the generic extractor already handles
their product pages. Carts are the expensive part and need real DOM work per
site. `shopify.ts` is the exception worth knowing: every Shopify store serves
its cart as JSON at `/cart.js`, so one adapter covers thousands of storefronts.

---

## Layout

```
src/
  shared/        types, extraction ladder, scoring - used by BOTH sides
    extract/     jsonld (tier 1), microdata (2), opengraph (3)
    scoring.ts   deterministic ranking; runs on the server AND in the popup
  server/
    data/        repository interface + mock + TigerData stub   <- SEAM 1
    ai/          client interface + mock + Gemini stub          <- SEAM 2
    pipeline/    resolve, cart, provenance, gates
    index.ts     express API
  extension/
    adapters/    per-site code                                  <- SEAM 3
    content.ts   extract + render
    background.ts  all network calls, caching, badge state
    overlay.ts   shadow-DOM panel
    popup/       sliders, settings, abstention explanation
scripts/         build-extension.mjs, smoke.ts
```

`shared/scoring.ts` running in both places is deliberate: the popup re-ranks
cached candidates locally, so dragging a weight slider reorders instantly with
no round trip.

---

## Why there is a server at all

A shipped extension is a zip file anyone can unpack. Database credentials and
the Gemini key cannot live in it. The API is the only place secrets can exist,
which also means it is the only place that talks to TigerData.

Consequence worth stating out loud in the writeup: **this is not a local-only
extension.** Product data for the page you are on is sent to the API. There is
no logging, no accounts and no analytics, but "nothing leaves your browser" is
not a claim this architecture can make, and claiming it would be the same
overstatement the project exists to call out.

---

## Known gaps

- Seed data is unverified placeholder; catalogue URLs are homepages, not deep
  links. `architecture.md` is right that a judge will click them.
- The Amazon and Shopify adapters have not been run against live pages.
- No adapter has an HTML fixture or a regression test yet. A silently broken
  selector looks exactly like "no alternative found", which is the one output
  that has to mean something.
- The eval harness does not exist. It is what turns "AI integration" from a
  claim into a measurement, and it is the thing most likely to get cut.
- Carbon is **out of scope** — removed deliberately, despite the repo name.
