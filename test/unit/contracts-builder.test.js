import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBuildRequest,
  normalizePhrase,
  normalizePrefix,
} from '../../src/contracts.js';
import { ValidationError } from '../../src/errors.js';
import { buildPrefixArtifact, prefixesOf } from '../../src/prefix-builder.js';

test('v0.1 normalizer collapses compatibility ASCII and preserves a meaningful trailing prefix space', () => {
  assert.equal(normalizePhrase('  ＴＷＩＴＴＥＲ\tSearch  '), 'twitter search');
  assert.equal(normalizePrefix('  New\t'), 'new ');
  assert.throws(() => normalizePhrase('café'), ValidationError);
  assert.throws(() => normalizePhrase('a'.repeat(65)), ValidationError);
  assert.deepEqual(prefixesOf('new york'), ['n', 'ne', 'new', 'new ', 'new y', 'new yo', 'new yor', 'new york']);
});

test('build request freezes normalizer, threshold, and top-k bounds', () => {
  assert.deepEqual(normalizeBuildRequest({ buildKey: 'snapshot-build-0001' }), {
    buildKey: 'snapshot-build-0001',
    minCount: 3,
    topK: 5,
    normalizerVersion: 'ascii-nfkc-lower-space-v1',
  });
  assert.throws(
    () => normalizeBuildRequest({ buildKey: 'snapshot-build-0001', minCount: 1, topK: 5 }),
    ValidationError,
  );
  assert.throws(
    () => normalizeBuildRequest({ buildKey: 'snapshot-build-0001', minCount: 3, topK: 6 }),
    ValidationError,
  );
});

test('artifact applies threshold and blocks before deterministic top-k expansion', () => {
  const artifact = buildPrefixArtifact([
    { term: 'apple', count: 8 },
    { term: 'application', count: 5 },
    { term: 'apricot', count: 5 },
    { term: 'ape', count: 2 },
  ], {
    minCount: 3,
    topK: 2,
    blockedTerms: ['apple'],
  });
  const forAp = artifact.rows.filter((row) => row.prefix === 'ap');
  assert.deepEqual(forAp, [
    { prefix: 'ap', rank: 1, term: 'application', score: 5 },
    { prefix: 'ap', rank: 2, term: 'apricot', score: 5 },
  ]);
  assert.ok(artifact.rows.every((row) => row.term.startsWith(row.prefix)));
  assert.ok(artifact.rows.every((row) => row.term !== 'apple' && row.term !== 'ape'));
  assert.equal(artifact.eligibleTermCount, 2);
  assert.match(artifact.contentDigest, /^[0-9a-f]{64}$/);
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

test('generated corpora preserve prefix, rank, bound, and input-order invariants', () => {
  const random = seededRandom(13_2026);
  const alphabet = 'abcdef';
  for (let trial = 0; trial < 120; trial += 1) {
    const terms = new Set();
    while (terms.size < 24) {
      const length = 1 + Math.floor(random() * 8);
      let term = '';
      for (let index = 0; index < length; index += 1) term += alphabet[Math.floor(random() * alphabet.length)];
      terms.add(term);
    }
    const aggregates = [...terms].map((term) => ({ term, count: 1 + Math.floor(random() * 12) }));
    const first = buildPrefixArtifact(aggregates, { minCount: 3, topK: 5 });
    const second = buildPrefixArtifact(shuffled(aggregates, random), { minCount: 3, topK: 5 });
    assert.equal(second.contentDigest, first.contentDigest);
    assert.deepEqual(second.rows, first.rows);
    const groups = Map.groupBy(first.rows, (row) => row.prefix);
    for (const [prefix, rows] of groups) {
      assert.ok(rows.length <= 5);
      assert.deepEqual(rows.map((row) => row.rank), Array.from({ length: rows.length }, (_, index) => index + 1));
      assert.ok(rows.every((row) => row.term.startsWith(prefix) && row.score >= 3));
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1];
        const current = rows[index];
        assert.ok(previous.score > current.score || (previous.score === current.score && previous.term < current.term));
      }
    }
  }
});
