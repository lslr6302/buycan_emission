# Running and testing this locally

Getting from a fresh clone to a working extension in your browser. Takes about
five minutes.

The project is two halves that run separately:

| Half | What it is | How it runs |
|---|---|---|
| **API server** | Node/Express, talks to the database | `npm run server`, stays running in a terminal |
| **Extension** | Chrome extension, loaded unpacked | built to `dist/extension`, loaded once |

The extension talks to the server over HTTP. **Both have to be running**, and
the server has to stay running while you browse.

---

## 1. Prerequisites

**Node 20.12 or newer.** Check with `node -v`. The server calls
`process.loadEnvFile()`, which does not exist in older versions — on Node 18
you get a confusing `loadEnvFile is not a function` crash at startup.

**Google Chrome** (or any Chromium browser — Edge, Brave, Arc).

---

## 2. Install dependencies

```bash
npm install
```

That reads `package.json` and downloads everything into `node_modules/`.

Re-run it **any time you pull** — if someone adds a dependency and you skip
this, you get `Cannot find module 'pg'` or similar. That error always means
"run npm install", never anything subtler.

---

## 3. Point it at the database

```bash
cp .env.example .env
```

Then open `.env` and paste in the real `TIMESCALE_SERVICE_URL`. **Ask the team
for it** — `.env` is gitignored, so it is deliberately not in the repo.

You can skip this step. Without a connection string the server falls back to a
small bundled seed dataset, which is enough to see the extension work but is
*not* the real data. Step 5 shows how to tell which one you are on.

---

## 4. Start the server

```bash
npm run server
```

You should see:

```
buycan api on http://localhost:8787
  data: tigerdata   ai: mock   sanityVeto: true
```

Leave this terminal open. The server does not auto-reload — **if you change
anything under `src/server/`, stop it with Ctrl+C and start it again.**

---

## 5. Confirm the server is healthy

In a second terminal:

```bash
curl localhost:8787/v1/health
```

```json
{"ok":true,"dataBackend":"tigerdata","dataHealthy":true,"aiBackend":"mock"}
```

- `dataBackend: tigerdata` → connected to the real database
- `dataBackend: mock(seed)` → running on seed data, so `.env` was not found.
  Make sure you ran `npm run server` from the project root.

`aiBackend: mock` means the offline stand-in. For real AI suggestions, put
`GEMINI_API_KEY` in `.env` and run `npm run server:gemini` instead (free-tier
key is enough).

---

## 6. Build and load the extension

```bash
npm run build:ext:dev
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the **`dist/extension`** folder in this repo

It should appear as **Canadian Alternatives (dev)**.

### dev vs. normal build

| Command | Runs on | Use when |
|---|---|---|
| `build:ext:dev` | every website | testing, trying new storefronts |
| `build:ext` | six listed Canadian sites | the real build; never demo the dev one |

The dev build requests access to all sites, which is fine locally and would be
a bad look in a submission.

**After every rebuild, click the refresh icon on the extension card in
`chrome://extensions`.** Chrome does not pick up changes on its own.

---

## 7. Try it

With the server running, visit these on **amazon.ca**:

| Search or product | Expected |
|---|---|
| Search "shampoo" | Panel opens with Canadian hair-care brands |
| A **Dove** product | Alternatives: Rocky Mountain Soap, Crate 61 Organics |
| A **Tide** product | Alternatives: Eco-Max, Nature Clean, Tru Earth |
| Any **Logitech** product | Nothing on the page. Click the toolbar icon — it explains that no Canadian alternative exists. **This is correct behaviour**, not a bug. |

The panel appears bottom-right and never covers the buy button.

---

## 8. When nothing appears

Nothing appearing is sometimes the right answer, so the extension tells you
which case you are in. **Click the toolbar icon** and read the *"What this
page looked like"* panel:

| It says | Meaning | Fix |
|---|---|---|
| `Page kind: none` | Not recognised as a product/cart/search page | This site needs an adapter |
| `Extraction: none` | Product page, but nothing readable from it | Site publishes no structured data |
| `Overlay: hidden — nothing to show` | Worked fine, genuinely found nothing | Nothing to fix |
| `Overlay: hidden — dismissed` | You clicked × here before | Click **"Show it again now"** |
| `Cannot reach the lookup API` | Server is not running | `npm run server` |

For more detail, open the page console (**F12** → Console, filter for
`buycan`). Every step logs:

```
[buycan] adapter=amazon pageKind=product url=/dp/B0...
[buycan] extracted {tier: "adapter", brand: "Dove", price: 9.47, …}
[buycan] resolved {ownStatus: "foreign", candidates: 2, abstained: false}
[buycan] overlay mounted (340x180 at 1068,520)
```

Whichever line is **last** is where it stopped.

The extension's own background script logs somewhere separate: on
`chrome://extensions`, click the blue **"service worker"** link on the
extension card.

---

## Common problems

**`Cannot find module 'pg'`** (or any module) — run `npm install`. Happens
after pulling changes that added a dependency.

**`Port 8787 is already in use`** — a server is running in another terminal.
That is usually fine: just use it. To replace it, close that terminal or run
`npx kill-port 8787`. To run alongside: `PORT=8788 npm run server`.

**Changed server code and nothing happened** — the server does not hot-reload.
Ctrl+C and `npm run server` again. (`npm run dev` does watch, if you prefer.)

**Changed extension code and nothing happened** — rebuild with
`npm run build:ext:dev`, *then* hit refresh on the extension card.

**Results look out of date** — the extension caches responses. A rebuild
clears it automatically; otherwise use **"Reset dismissals & clear cache"** in
the popup.

**Extension card shows a red "Errors" badge** — click it. Usually a syntax
error in the bundle; rebuild and look at the terminal output.

---

## Checks before you push

```bash
npm run typecheck    # TypeScript, no emit
npm test             # 38 smoke tests, no database needed
npm run build        # all of the above plus the production bundle
```

`npm test` covers extraction, GTIN handling, scoring, and the validation gates
that stop fabricated AI results reaching users. It does not touch the network
or the database, so it is safe and fast to run anywhere.

---

## Where things live

```
src/
  shared/        types, HTML extraction, scoring — used by both halves
  server/
    data/        database access       <- repository.ts is the interface
    ai/          Gemini seam           <- client.ts is the interface
    pipeline/    the resolve logic
  extension/
    adapters/    per-site code (amazon, shopify, generic)
    content.ts   runs on the page: extract, then render
    background.ts  all network calls and caching
    popup/       settings and diagnostics
scripts/         build-extension.mjs, smoke.ts, inspect-db.ts
```

`npx tsx scripts/inspect-db.ts` prints the live database schema with row
counts — useful when a query is not returning what you expect.
