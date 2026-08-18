import { canonicalJson, sha256 } from './canonical.js';
import { MAX_TOP_K, normalizePhrase, safeInteger } from './contracts.js';
import { ValidationError } from './errors.js';

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function prefixesOf(term) {
  const normalized = normalizePhrase(term);
  return Array.from({ length: normalized.length }, (_, index) => normalized.slice(0, index + 1));
}

export function buildPrefixArtifact(aggregates, { minCount, topK, blockedTerms = [] }) {
  if (!Array.isArray(aggregates)) throw new ValidationError('aggregates must be an array');
  const threshold = safeInteger(minCount, 'minimum count', { min: 2, max: 1_000_000 });
  const candidateLimit = safeInteger(topK, 'top k', { min: 1, max: MAX_TOP_K });
  const blocked = new Set(blockedTerms.map(normalizePhrase));
  const counts = new Map();
  for (const aggregate of aggregates) {
    if (!aggregate || typeof aggregate !== 'object') throw new ValidationError('aggregate must be an object');
    const term = normalizePhrase(aggregate.term);
    const count = safeInteger(Number(aggregate.count), 'aggregate count', { min: 1 });
    const combined = (counts.get(term) ?? 0) + count;
    counts.set(term, safeInteger(combined, 'combined aggregate count', { min: 1 }));
  }
  const eligible = [...counts]
    .filter(([term, count]) => count >= threshold && !blocked.has(term))
    .map(([term, score]) => ({ term, score }))
    .sort((left, right) => right.score - left.score || compareAscii(left.term, right.term));
  const byPrefix = new Map();
  for (const candidate of eligible) {
    for (const prefix of prefixesOf(candidate.term)) {
      const candidates = byPrefix.get(prefix) ?? [];
      candidates.push(candidate);
      byPrefix.set(prefix, candidates);
    }
  }
  const rows = [];
  for (const prefix of [...byPrefix.keys()].sort(compareAscii)) {
    const candidates = byPrefix.get(prefix)
      .sort((left, right) => right.score - left.score || compareAscii(left.term, right.term))
      .slice(0, candidateLimit);
    candidates.forEach((candidate, index) => rows.push({
      prefix,
      rank: index + 1,
      term: candidate.term,
      score: candidate.score,
    }));
  }
  return {
    rows,
    eligibleTermCount: eligible.length,
    prefixCount: byPrefix.size,
    contentDigest: sha256(canonicalJson(rows)),
  };
}
