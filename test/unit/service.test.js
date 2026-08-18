import assert from 'node:assert/strict';
import test from 'node:test';
import { AutocompleteService } from '../../src/autocomplete-service.js';

const firstUuid = '11111111-1111-4111-8111-111111111111';

test('accepted event response strips raw query and idempotency internals', async () => {
  let captured;
  const service = new AutocompleteService({
    store: {
      async acceptEvent(input) {
        captured = input;
        return { created: true, event: { ...input, sequence: 1 } };
      },
    },
    clock: () => 10_000,
    uuid: () => firstUuid,
  });
  const result = await service.acceptEvent({
    idempotencyKey: 'event-idempotency-0001',
    request: { query: '  Apple  ' },
  });
  assert.equal(captured.normalizedQuery, 'apple');
  assert.match(captured.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.evidence, 'event_accepted');
  assert.equal(result.event.normalizedQuery, undefined);
  assert.equal(result.event.idempotencyKey, undefined);
  assert.equal(result.event.requestDigest, undefined);
});

test('build lifecycle keeps ready and published receipts distinct', async () => {
  const build = {
    id: firstUuid,
    watermark: 8,
    policyVersion: 2,
    expectedActiveSnapshotId: null,
    normalizerVersion: 'ascii-nfkc-lower-space-v1',
    minCount: 3,
    topK: 5,
    state: 'building',
    suggestionCount: null,
    prefixCount: null,
    eligibleTermCount: null,
    contentDigest: null,
    createdAtMs: 10,
    readyAtMs: null,
    publishedAtMs: null,
  };
  const service = new AutocompleteService({
    store: {
      async createBuild(input) { return { created: true, build: { ...build, ...input } }; },
      async materializeBuild() {
        return { changed: true, build: { ...build, state: 'ready', suggestionCount: 5, prefixCount: 3 } };
      },
      async publishBuild() {
        return { changed: true, publicationVersion: 1, build: { ...build, state: 'published' } };
      },
    },
    uuid: () => firstUuid,
    clock: () => 10,
  });
  const started = await service.startBuild({ request: { buildKey: 'snapshot-build-0001', minCount: 3, topK: 5 } });
  assert.equal(started.build.buildKey, undefined);
  assert.equal(started.build.requestDigest, undefined);
  assert.equal((await service.materializeBuild(firstUuid)).evidence, 'snapshot_ready');
  assert.equal((await service.publishBuild(firstUuid)).evidence, 'snapshot_published');
});

test('suggestion response preserves the published evidence metadata', async () => {
  const service = new AutocompleteService({
    store: {
      async getSuggestions(input) {
        assert.deepEqual(input, { prefix: 'new ', limit: 3 });
        return {
          snapshotId: firstUuid,
          watermark: 9,
          contentDigest: 'a'.repeat(64),
          publicationVersion: 2,
          policyVersion: 4,
          suggestions: [{ term: 'new york', score: 10, rank: 1 }],
        };
      },
    },
  });
  const result = await service.suggest({ prefix: ' New\t', limit: '3' });
  assert.equal(result.evidence, 'suggestion_response');
  assert.equal(result.suggestions[0].term, 'new york');
});
