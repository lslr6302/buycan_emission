import { NullAiClient, type AiClient } from './ai/client';
import { GeminiClient } from './ai/gemini-client';
import { MockAiClient } from './ai/mock-client';
import { MockRepository } from './data/mock-repository';
import type { Repository } from './data/repository';
import { TigerRepository, type SqlExecutor } from './data/tiger-repository';

/**
 * Backend selection. Both seams are chosen here and nowhere else, so switching
 * from seed data to TigerData, or from the mock AI to Gemini, is an env var.
 *
 *   DATA_BACKEND=mock|tiger     (default: mock)
 *   AI_BACKEND=mock|gemini|none (default: mock)
 */

export interface Config {
  port: number;
  dataBackend: string;
  aiBackend: string;
  sanityVeto: boolean;
  maxCandidates: number;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8787),
    dataBackend: (process.env.DATA_BACKEND ?? 'mock').toLowerCase(),
    aiBackend: (process.env.AI_BACKEND ?? 'mock').toLowerCase(),
    sanityVeto: process.env.SANITY_VETO !== 'false',
    maxCandidates: Number(process.env.MAX_CANDIDATES ?? 3),
  };
}

export async function createRepository(config: Config): Promise<Repository> {
  if (config.dataBackend === 'tiger') {
    const executor = await createTigerExecutor();
    const repo = new TigerRepository(executor);
    await repo.init();
    return repo;
  }
  const repo = new MockRepository();
  await repo.init();
  return repo;
}

/**
 * `pg` is intentionally not a dependency of this repo - the data layer is
 * someone else's to own. Install it when wiring TigerData up for real.
 */
async function createTigerExecutor(): Promise<SqlExecutor> {
  const url = process.env.TIGER_URL;
  if (!url) {
    throw new Error('DATA_BACKEND=tiger requires TIGER_URL (a Postgres connection string).');
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pg = require('pg') as { Pool: new (opts: { connectionString: string }) => SqlExecutor };
    return new pg.Pool({ connectionString: url });
  } catch {
    throw new Error(
      'DATA_BACKEND=tiger needs the pg driver. Run `npm install pg @types/pg`, ' +
        'or run with DATA_BACKEND=mock while the dataset is still being built.',
    );
  }
}

export function createAiClient(config: Config): AiClient {
  switch (config.aiBackend) {
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('AI_BACKEND=gemini requires GEMINI_API_KEY.');
      return new GeminiClient(key, process.env.GEMINI_MODEL);
    }
    case 'none':
      return new NullAiClient();
    default:
      return new MockAiClient();
  }
}
