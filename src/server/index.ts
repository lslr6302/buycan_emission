import cors from 'cors';
import express from 'express';
import { z } from 'zod';

import { DEFAULT_WEIGHTS } from '../shared/scoring';
import { analyzeCart } from './pipeline/cart';
import { type PipelineDeps, resolveProduct } from './pipeline/resolve';
import { createAiClient, createRepository, loadConfig } from './config';

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

  const deps: PipelineDeps = {
    repo,
    ai,
    maxCandidates: config.maxCandidates,
    sanityVeto: config.sanityVeto,
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
    console.log(`  data: ${repo.name}   ai: ${ai.name}   sanityVeto: ${config.sanityVeto}`);
    if (repo.name.startsWith('mock')) {
      console.log('  NOTE: seed data is placeholder and unverified. Not demo-ready.');
    }
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
