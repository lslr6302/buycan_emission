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
| **Ownership/catalogue data** | **placeholder seed — not demo-ready** |
| **Gemini integration** | **stub — throws NotImplemented** |

The seed data under `src/server/data/seed/` is unverified placeholder and every
catalogue URL is a brand homepage, not a real product link. It exists so the
pipeline runs. It is not safe to show a judge.

---

## Integration: the three seams

Each partner owns exactly one file. Nothing else needs to change.

### 1. Data → TigerData

**File:** `src/server/data/tiger-repository.ts`
**Interface:** `src/server/data/repository.ts`

The queries are already written. The only thing needed is making `COLUMNS` at
the top of the file match the real schema — or adding a Postgres view that
matches it, which is often less work.

```bash
npm install pg @types/pg
DATA_BACKEND=tiger TIGER_URL=postgres://... npm run server
```

Notes for whoever owns the schema:

- **Sources are per-field, not per-record.** A brand can have verified
  ownership and unknown manufacturing, and the UI renders exactly that. If the
  table has one `source_url` per row, say so — it is a real limitation and the
  adapter in `field()` needs to know.
- **Vector search** is pushed into SQL via pgvector (`<=>`). Something upstream
  has to embed the query; the repository takes `query.embedding` and falls back
  to full-text ranking when it is absent.
- `findBrand()` receives raw, messy strings off product pages — `"Klean Kanteen
  Canada"`, `"KLEANKANTEEN"`. Normalize with `normalizeBrand()` from
  `src/shared/normalize.ts` so both sides agree on what a key looks like.

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
