import { Pool } from 'pg';

import { NullAiClient, type AiClient } from './ai/client';
import { GeminiClient } from './ai/gemini-client';
import { MockAiClient } from './ai/mock-client';
import { type AiStore, MemoryAiStore } from './data/ai-store';
import { MockRepository } from './data/mock-repository';
import type { Repository } from './data/repository';
import { TigerAiStore } from './data/tiger-ai-store';
import { TigerRepository, type SqlExecutor } from './data/tiger-repository';

/**
 * Backend selection. Both seams are chosen here and nowhere else, so switching
 * from seed data to TigerData, or from the mock AI to Gemini, is an env var.
 *
 *   DATA_BACKEND=mock|tiger         (default: tiger when a database URL is set, else mock)
 *   AI_BACKEND=mock|gemini|none     (default: mock)
 *   AI_STORE=tiger|memory|none      (default: tiger when a database URL is set, else memory)
 *   AI_STORE_URL                    (default: the main database URL; schema ai_fallback)
 *
 * The database URL is TIGER_URL, or TIMESCALE_SERVICE_URL as written by the
 * Tiger Cloud console's .env download. Variables already in the environment
 * win over .env.
 */

try {
  process.loadEnvFile();
} catch {
  // No .env in the working directory; rely on the real environment.
}

function databaseUrl(): string | undefined {
  return process.env.TIGER_URL ?? process.env.TIMESCALE_SERVICE_URL;
}

function aiStoreUrl(): string | undefined {
  return process.env.AI_STORE_URL ?? databaseUrl();
}

export interface Config {
  port: number;
  dataBackend: string;
  aiBackend: string;
  sanityVeto: boolean;
  maxCandidates: number;
  aiStore: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8787),
    dataBackend: (process.env.DATA_BACKEND ?? (databaseUrl() ? 'tiger' : 'mock')).toLowerCase(),
    aiBackend: (process.env.AI_BACKEND ?? 'mock').toLowerCase(),
    sanityVeto: process.env.SANITY_VETO !== 'false',
    maxCandidates: Number(process.env.MAX_CANDIDATES ?? 3),
    aiStore: (process.env.AI_STORE ?? (aiStoreUrl() ? 'tiger' : 'memory')).toLowerCase(),
  };
}

export async function createRepository(config: Config): Promise<Repository> {
  if (config.dataBackend === 'tiger') {
    const url = databaseUrl();
    if (!url) {
      throw new Error(
        'DATA_BACKEND=tiger requires TIGER_URL or TIMESCALE_SERVICE_URL (a Postgres connection string).',
      );
    }
    const repo = new TigerRepository(executorFor(url));
    await repo.init();
    return repo;
  }
  const repo = new MockRepository();
  await repo.init();
  return repo;
}

/**
 * sslmode is taken out of the URL and passed as an explicit, verifying TLS
 * config. pg currently treats sslmode=require as verify-full and warns that
 * it will stop doing so; this keeps full verification either way.
 */
function executorFor(url: string): SqlExecutor {
  const existing = pools.get(url);
  if (existing) return existing;

  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');

  const pool = new Pool({
    connectionString: parsed.toString(),
    ssl: sslmode && sslmode !== 'disable' ? { rejectUnauthorized: true } : undefined,
    max: 5,
  });
  // An idle client dropped by the server must not take the API down with it.
  pool.on('error', (error) => console.error('[db]', error.message));
  pools.set(url, pool);
  return pool;
}

/** One pool per URL, so both stores share a connection when they share a service. */
const pools = new Map<string, Pool>();

/**
 * The second database: AI discoveries that passed every gate. Kept out of the
 * curated dataset; see data/ai-store.ts for why.
 */
export async function createAiStore(config: Config): Promise<AiStore | undefined> {
  if (config.aiStore === 'none') return undefined;
  if (config.aiStore === 'tiger') {
    const url = aiStoreUrl();
    if (!url) {
      throw new Error('AI_STORE=tiger requires AI_STORE_URL or a main database URL.');
    }
    const store = new TigerAiStore(executorFor(url));
    await store.init();
    return store;
  }
  return new MemoryAiStore();
}

export function createAiClient(config: Config): AiClient {
  switch (config.aiBackend) {
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('AI_BACKEND=gemini requires GEMINI_API_KEY.');
      return new GeminiClient(
        key,
        process.env.GEMINI_MODEL,
        process.env.GEMINI_FAST_MODEL,
        process.env.GEMINI_SEARCH === 'on',
      );
    }
    case 'none':
      return new NullAiClient();
    default:
      return new MockAiClient();
  }
}
