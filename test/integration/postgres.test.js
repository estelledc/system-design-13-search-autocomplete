import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { Pool } from 'pg';
import { AutocompleteService } from '../../src/autocomplete-service.js';
import {
  NotFoundError,
  PublicationConflictError,
  RequestConflictError,
} from '../../src/errors.js';
import { PostgresAutocompleteStore } from '../../src/postgres-store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
const store = new PostgresAutocompleteStore(pool);

beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await store.migrate();
});

after(async () => {
  await pool.end();
});

async function accept(service, term, index) {
  return service.acceptEvent({
    idempotencyKey: `event-key-${String(index).padStart(8, '0')}`,
    request: { query: term },
  });
}

async function acceptCount(service, term, count, offset = 0) {
  return Promise.all(Array.from({ length: count }, (_, index) => accept(service, term, offset + index)));
}

async function readyBuild(service, key, { minCount = 2, topK = 5 } = {}) {
  const started = await service.startBuild({ request: { buildKey: key, minCount, topK } });
  const ready = await service.materializeBuild(started.build.id);
  return { started, ready };
}

async function publishBuild(service, key, options) {
  const result = await readyBuild(service, key, options);
  const published = await service.publishBuild(result.started.build.id);
  return { ...result, published };
}

test('concurrent event acceptance forms one contiguous committed prefix and exact replay', async () => {
  const service = new AutocompleteService({ store });
  const accepted = await Promise.all(Array.from({ length: 32 }, (_, index) => accept(
    service,
    index % 2 === 0 ? 'apple' : 'apricot',
    index,
  )));
  assert.deepEqual(
    accepted.map((result) => result.event.sequence).sort((left, right) => left - right),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  const replay = await accept(service, 'apple', 0);
  assert.equal(replay.created, false);
  assert.equal(replay.event.id, accepted[0].event.id);
  await assert.rejects(accept(service, 'different term', 0), RequestConflictError);
  const state = await pool.query(
    `SELECT (SELECT last_committed_sequence FROM event_ledger) AS watermark,
            count(*)::integer AS count, min(sequence) AS minimum, max(sequence) AS maximum
     FROM search_events`,
  );
  assert.deepEqual({
    watermark: Number(state.rows[0].watermark),
    count: state.rows[0].count,
    minimum: Number(state.rows[0].minimum),
    maximum: Number(state.rows[0].maximum),
  }, { watermark: 32, count: 32, minimum: 1, maximum: 32 });
});

test('a frozen watermark excludes later accepted events until the next snapshot', async () => {
  const service = new AutocompleteService({ store });
  await acceptCount(service, 'apple', 3, 100);
  const started = await service.startBuild({
    request: { buildKey: 'watermark-snapshot-0001', minCount: 2, topK: 5 },
  });
  assert.equal(started.build.watermark, 3);
  await acceptCount(service, 'apricot', 3, 200);
  await service.materializeBuild(started.build.id);
  await service.publishBuild(started.build.id);
  const first = await service.suggest({ prefix: 'ap', limit: 5 });
  assert.deepEqual(first.suggestions.map((candidate) => candidate.term), ['apple']);
  assert.equal(first.watermark, 3);

  const secondBuild = await publishBuild(service, 'watermark-snapshot-0002');
  const second = await service.suggest({ prefix: 'ap', limit: 5 });
  assert.deepEqual(second.suggestions.map((candidate) => candidate.term), ['apple', 'apricot']);
  assert.equal(second.watermark, 6);
  assert.equal(secondBuild.published.publicationVersion, 2);
});

test('ready rows are invisible and stale competing publication cannot overwrite the winner', async () => {
  const service = new AutocompleteService({ store });
  await acceptCount(service, 'alpha', 2, 300);
  const baseline = await publishBuild(service, 'publication-baseline-0001');
  const left = await readyBuild(service, 'publication-racer-left-0001');
  const right = await readyBuild(service, 'publication-racer-right-0001');
  assert.equal(left.started.build.expectedActiveSnapshotId, baseline.started.build.id);
  assert.equal(right.started.build.expectedActiveSnapshotId, baseline.started.build.id);
  await service.publishBuild(left.started.build.id);
  await assert.rejects(service.publishBuild(right.started.build.id), PublicationConflictError);
  const active = await service.suggest({ prefix: 'a', limit: 5 });
  assert.equal(active.snapshotId, left.started.build.id);

  await pool.query('UPDATE active_snapshot SET snapshot_id = NULL, publication_version = 0');
  await assert.rejects(service.suggest({ prefix: 'a', limit: 5 }), NotFoundError);
  const readyCount = await pool.query("SELECT count(*)::integer AS count FROM snapshot_builds WHERE state = 'ready'");
  assert.equal(readyCount.rows[0].count, 1);
});

test('blocking is immediate for reads, idempotent, and applied before future snapshot expansion', async () => {
  const service = new AutocompleteService({ store });
  await acceptCount(service, 'apple', 4, 400);
  await acceptCount(service, 'application', 3, 500);
  await publishBuild(service, 'block-baseline-build-0001');
  const before = await service.suggest({ prefix: 'app', limit: 5 });
  assert.deepEqual(before.suggestions.map((candidate) => candidate.term), ['apple', 'application']);

  const blocked = await service.blockTerm({ request: { query: 'apple' } });
  const replay = await service.blockTerm({ request: { query: '  APPLE ' } });
  assert.deepEqual(blocked, { changed: true, policyVersion: 1, evidence: 'block_policy_committed' });
  assert.deepEqual(replay, { changed: false, policyVersion: 1, evidence: 'block_policy_committed' });
  const after = await service.suggest({ prefix: 'app', limit: 5 });
  assert.deepEqual(after.suggestions, [{
    term: 'application',
    score: 3,
    rank: 1,
    snapshotRank: 2,
  }]);
  assert.equal(after.policyVersion, 1);

  await publishBuild(service, 'block-followup-build-0001');
  const rebuilt = await service.suggest({ prefix: 'app', limit: 5 });
  assert.deepEqual(rebuilt.suggestions, [{
    term: 'application',
    score: 3,
    rank: 1,
    snapshotRank: 1,
  }]);
});

test('build key freezes configuration and ready artifact across exact retries', async () => {
  const service = new AutocompleteService({ store });
  await acceptCount(service, 'search', 3, 600);
  const first = await readyBuild(service, 'idempotent-build-key-0001', { minCount: 2, topK: 4 });
  const replay = await service.startBuild({
    request: { buildKey: 'idempotent-build-key-0001', minCount: 2, topK: 4 },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.build.id, first.started.build.id);
  const readyReplay = await service.materializeBuild(replay.build.id);
  assert.equal(readyReplay.changed, false);
  assert.equal(readyReplay.build.contentDigest, first.ready.build.contentDigest);
  await assert.rejects(
    service.startBuild({ request: { buildKey: 'idempotent-build-key-0001', minCount: 3, topK: 4 } }),
    RequestConflictError,
  );
});

test('snapshot digest and rows are deterministic for an accepted event set', async () => {
  const service = new AutocompleteService({ store });
  await Promise.all([
    ...Array.from({ length: 5 }, (_, index) => accept(service, 'twitter', 700 + index)),
    ...Array.from({ length: 3 }, (_, index) => accept(service, 'twitch', 800 + index)),
    ...Array.from({ length: 3 }, (_, index) => accept(service, 'twilight', 900 + index)),
  ]);
  const left = await readyBuild(service, 'deterministic-build-left-0001');
  const right = await readyBuild(service, 'deterministic-build-right-0001');
  assert.equal(left.ready.build.contentDigest, right.ready.build.contentDigest);
  assert.equal(left.ready.build.suggestionCount, right.ready.build.suggestionCount);
  const rows = await pool.query(
    `SELECT prefix, rank, term, score FROM snapshot_suggestions
     WHERE snapshot_id = $1 ORDER BY prefix, rank`,
    [left.started.build.id],
  );
  const copy = await pool.query(
    `SELECT prefix, rank, term, score FROM snapshot_suggestions
     WHERE snapshot_id = $1 ORDER BY prefix, rank`,
    [right.started.build.id],
  );
  assert.deepEqual(copy.rows, rows.rows);
});
