import cors from 'cors';
import express from 'express';
import { z } from 'zod';

import { DEFAULT_WEIGHTS } from '../shared/scoring';
import { analyzeCart } from './pipeline/cart';
import { type PipelineDeps, resolveProduct } from './pipeline/resolve';
import { createAiClient, createAiStore, createRepository, loadConfig } from './config';

/**
 * The API the extension talks to.
 *
 * This server exists for a reason that is not negotiable: a shipped extension
 * is a zip file anyone can unpack, so database credentials and API keys cannot
 * live in it. Everything secret stays on this side of the wire.
 */

const moneySchema = z.object({ amount: z.number(), currency: z.string() });

const productRefSchema = z.object({
  site: z.string(),
  siteId: z.string().nullable().default(null),
  url: z.string(),
  title: z.string().min(1),
  brand: z.string().nullable().default(null),
  gtin: z.string().nullable().default(null),
  price: moneySchema.nullable().default(null),
  categoryHint: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  massKg: z.number().nullable().default(null),
  extraction: z.object({
    tier: z.enum(['jsonld', 'microdata', 'opengraph', 'adapter', 'llm']),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
});

const weightsSchema = z.object({
  equivalence: z.number().min(0).max(1),
  canadian: z.number().min(0).max(1),
  price: z.number().min(0).max(1),
});

const resolveSchema = z.object({
  product: productRefSchema,
  weights: weightsSchema.optional(),
  verifiedOnly: z.boolean().optional(),
  destinationRegion: z.string().nullable().optional(),
});

const searchSchema = z.object({
  site: z.string(),
  query: z.string().min(2).max(300),
  weights: weightsSchema.optional(),
  verifiedOnly: z.boolean().optional(),
});

const cartSchema = z.object({
  site: z.string(),
  lines: z
    .array(z.object({ product: productRefSchema, qty: z.number().int().min(1).max(999) }))
    .max(100),
  weights: weightsSchema.optional(),
  verifiedOnly: z.boolean().optional(),
  destinationRegion: z.string().nullable().optional(),
});

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = await createRepository(config);
  const ai = createAiClient(config);
  const aiStore = await createAiStore(config);

  const deps: PipelineDeps = {
    repo,
    ai,
    maxCandidates: config.maxCandidates,
    sanityVeto: config.sanityVeto,
    aiStore,
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // The extension's origin is chrome-extension://<id>, which varies per
  // install, so the browser sends Origin: null. Reflecting any origin is
  // acceptable here because the API holds no user data and no session.
  app.use(cors({ origin: true }));

  app.get('/v1/health', async (_req, res) => {
    res.json({
      ok: true,
      dataBackend: repo.name,
      dataHealthy: await repo.healthy(),
      aiBackend: ai.name,
      aiHealthy: await ai.healthy(),
      aiStore: aiStore?.name ?? 'none',
      aiStoreHealthy: aiStore ? await aiStore.healthy() : false,
      defaultWeights: DEFAULT_WEIGHTS,
    });
  });

  app.post('/v1/product/resolve', async (req, res) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    try {
      res.json(await resolveProduct(parsed.data, deps));
    } catch (error) {
      fail(res, error, 'resolve');
    }
  });

  /**
   * Search-results pages. The user typed what they want, which is cleaner
   * input than any listing title, so we synthesise a product from the query
   * and run the ordinary pipeline over it. No separate code path to keep in
   * sync, and the same abstention rules apply.
   */
  app.post('/v1/search', async (req, res) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { site, query, weights, verifiedOnly } = parsed.data;
    try {
      res.json(
        await resolveProduct(
          {
            product: {
              site,
              siteId: null,
              url: '',
              title: query,
              brand: null,
              gtin: null,
              price: null,
              categoryHint: null,
              imageUrl: null,
              massKg: null,
              extraction: { tier: 'adapter', confidence: 'low' },
            },
            weights,
            verifiedOnly,
            fromSearch: true,
          },
          deps,
        ),
      );
    } catch (error) {
      fail(res, error, 'search');
    }
  });

  app.post('/v1/cart/analyze', async (req, res) => {
    const parsed = cartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    try {
      res.json(await analyzeCart(parsed.data, deps));
    } catch (error) {
      fail(res, error, 'cart');
    }
  });

  const server = app.listen(config.port, () => {
    console.log(`buycan api on http://localhost:${config.port}`);
    console.log(
      `  data: ${repo.name}   ai: ${ai.name}   ai store: ${aiStore?.name ?? 'none'}   sanityVeto: ${config.sanityVeto}`,
    );
    if (repo.name.startsWith('mock')) {
      console.log('  NOTE: seed data is placeholder and unverified. Not demo-ready.');
    }
  });

  // Almost always a server left running in another terminal. A stack trace is
  // a bad way to learn that.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${config.port} is already in use — the API is probably running in another terminal.\n` +
          `  Use it:    curl localhost:${config.port}/v1/health\n` +
          `  Replace:   npx kill-port ${config.port}   (or close that terminal)\n` +
          `  Elsewhere: PORT=8788 npm run server\n`,
      );
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });

  const shutdown = async () => {
    server.close();
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function fail(res: express.Response, error: unknown, where: string): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${where}]`, message);
  res.status(500).json({ error: 'pipeline_failed', detail: message });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
