import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { AutocompleteService } from '../src/autocomplete-service.js';
import { PostgresAutocompleteStore } from '../src/postgres-store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL benchmark');

function letters(number) {
  let value = number;
  let result = '';
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function rate(count, startedAt) {
  return Number((count / ((performance.now() - startedAt) / 1_000)).toFixed(3));
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
const store = new PostgresAutocompleteStore(pool);
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await store.migrate();
  const service = new AutocompleteService({ store });
  const suffix = randomUUID();
  const terms = Array.from({ length: 80 }, (_, index) => `bench${letters(index)}`);
  const events = terms.flatMap((term) => Array.from({ length: 4 }, () => term));

  const acceptanceStarted = performance.now();
  for (let offset = 0; offset < events.length; offset += 20) {
    await Promise.all(events.slice(offset, offset + 20).map((term, index) => service.acceptEvent({
      idempotencyKey: `benchmark-event-${suffix}-${offset + index}`,
      request: { query: term },
    })));
  }
  const eventAcceptancePerSecond = rate(events.length, acceptanceStarted);

  const buildStarted = performance.now();
  const started = await service.startBuild({
    request: { buildKey: `benchmark-build-${suffix}`, minCount: 2, topK: 5 },
  });
  const ready = await service.materializeBuild(started.build.id);
  const published = await service.publishBuild(started.build.id);
  const buildMilliseconds = Number((performance.now() - buildStarted).toFixed(3));
  assert.equal(published.publicationVersion, 1);
  assert.equal(ready.build.eligibleTermCount, terms.length);

  const lookupCount = 1_000;
  const lookupStarted = performance.now();
  for (let index = 0; index < lookupCount; index += 1) {
    const prefix = index % 2 === 0 ? 'b' : `bench${letters(index % terms.length).slice(0, 1)}`;
    const response = await service.suggest({ prefix, limit: 5 });
    assert.ok(response.suggestions.length <= 5);
  }
  const suggestionLookupsPerSecond = rate(lookupCount, lookupStarted);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_autocomplete_benchmark_receipt',
    node: process.versions.node,
    postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
    events: events.length,
    distinctTerms: terms.length,
    eventAcceptancePerSecond,
    materializedRows: ready.build.suggestionCount,
    prefixes: ready.build.prefixCount,
    buildMilliseconds,
    lookups: lookupCount,
    suggestionLookupsPerSecond,
  })}\n`);
} finally {
  await pool.end();
}
