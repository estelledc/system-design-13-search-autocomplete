import { once } from 'node:events';
import { Pool } from 'pg';
import {
  AutocompleteService,
  PostgresAutocompleteStore,
  ValidationError,
  createHttpServer,
} from './index.js';

function parseJsonEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError(`${name} must contain valid JSON`);
  }
}

function parseIntegerEnvironment(name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function authTokenSet() {
  const tokens = parseJsonEnvironment('AUTH_TOKENS_JSON', []);
  if (!Array.isArray(tokens) || tokens.length < 1) throw new ValidationError('AUTH_TOKENS_JSON must be a nonempty array');
  const result = new Set();
  for (const token of tokens) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
      throw new ValidationError('each auth token must contain 16-256 characters');
    }
    result.add(token);
  }
  return result;
}

function logger(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function run() {
  if (!process.env.DATABASE_URL) throw new ValidationError('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
  const store = new PostgresAutocompleteStore(pool);
  const service = new AutocompleteService({ store });
  const command = process.argv[2] ?? 'serve';
  let keepPoolOpen = false;
  try {
    await store.migrate();
    if (command === 'migrate') {
      logger({ kind: 'migration_complete' });
      return;
    }
    if (command === 'stats') {
      logger({ kind: 'autocomplete_stats', ...(await store.stats()) });
      return;
    }
    if (command === 'block-term') {
      if (process.env.BLOCK_TERM === undefined) throw new ValidationError('BLOCK_TERM is required');
      logger({ kind: 'block_term_receipt', ...(await service.blockTerm({ request: { query: process.env.BLOCK_TERM } })) });
      return;
    }
    if (command === 'build-publish') {
      if (!process.env.BUILD_KEY) throw new ValidationError('BUILD_KEY is required');
      const started = await service.startBuild({
        request: {
          buildKey: process.env.BUILD_KEY,
          minCount: parseIntegerEnvironment('MIN_COUNT', 3, { min: 2, max: 1_000_000 }),
          topK: parseIntegerEnvironment('TOP_K', 5, { min: 1, max: 5 }),
        },
      });
      const ready = await service.materializeBuild(started.build.id);
      logger({
        kind: 'snapshot_ready_receipt',
        created: started.created,
        changed: ready.changed,
        watermark: ready.build.watermark,
        suggestionCount: ready.build.suggestionCount,
        prefixCount: ready.build.prefixCount,
        eligibleTermCount: ready.build.eligibleTermCount,
        contentDigest: ready.build.contentDigest,
        evidence: ready.evidence,
      });
      if (process.env.CRASH_AFTER_BUILD_READY === '1') {
        await new Promise((resolve) => process.stdout.write('', resolve));
        process.kill(process.pid, 'SIGKILL');
      }
      const published = await service.publishBuild(started.build.id);
      logger({
        kind: 'snapshot_published_receipt',
        changed: published.changed,
        watermark: published.build.watermark,
        publicationVersion: published.publicationVersion,
        contentDigest: published.build.contentDigest,
        evidence: published.evidence,
      });
      return;
    }
    if (command !== 'serve') {
      throw new ValidationError('command must be migrate, stats, block-term, build-publish, or serve');
    }

    const server = createHttpServer({
      service,
      authTokens: authTokenSet(),
      health: () => store.ping(),
      logger,
    });
    const host = process.env.HOST ?? '127.0.0.1';
    const port = parseIntegerEnvironment('PORT', 3_000, { min: 0, max: 65_535 });
    server.listen(port, host);
    await once(server, 'listening');
    logger({ kind: 'api_listening', port: server.address().port });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close();
      await once(server, 'close');
      await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    keepPoolOpen = true;
  } finally {
    if (!keepPoolOpen) await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    kind: 'fatal',
    name: error?.name ?? 'Error',
    code: error?.code ?? 'internal_error',
  })}\n`);
  process.exitCode = 1;
});
