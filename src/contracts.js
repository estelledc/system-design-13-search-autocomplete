import { ValidationError } from './errors.js';

export const NORMALIZER_VERSION = 'ascii-nfkc-lower-space-v1';
export const MAX_QUERY_BYTES = 64;
export const MAX_TOP_K = 5;

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const phrasePattern = /^[a-z]+(?: [a-z]+)*$/;
const prefixPattern = /^[a-z]+(?: [a-z]+)* ?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function exactObject(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ValidationError(`${label} contains unsupported fields`);
  return value;
}

export function normalizeIdentifier(value, label, { min = 16, max = 128 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !safeIdentifierPattern.test(value)) {
    throw new ValidationError(`${label} must be ${min}-${max} safe identifier characters`);
  }
  return value;
}

export function normalizeUuid(value, label = 'identifier') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ValidationError(`${label} must be a UUID`);
  return value.toLowerCase();
}

function compatibilityNormalize(value, { preserveTrailingSpace }) {
  if (typeof value !== 'string') throw new ValidationError('query must be a string');
  const hadTrailingWhitespace = /\s$/u.test(value);
  let normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (preserveTrailingSpace && hadTrailingWhitespace && normalized.length > 0) normalized += ' ';
  return normalized;
}

function enforceQueryBounds(value, pattern, label) {
  if (!pattern.test(value)) throw new ValidationError(`${label} must contain lowercase English words and single spaces`);
  if (Buffer.byteLength(value, 'utf8') > MAX_QUERY_BYTES) {
    throw new ValidationError(`${label} exceeds the ${MAX_QUERY_BYTES}-byte limit`);
  }
  return value;
}

export function normalizePhrase(value) {
  return enforceQueryBounds(compatibilityNormalize(value, { preserveTrailingSpace: false }), phrasePattern, 'query');
}

export function normalizePrefix(value) {
  return enforceQueryBounds(compatibilityNormalize(value, { preserveTrailingSpace: true }), prefixPattern, 'prefix');
}

export function normalizeEventRequest(value) {
  exactObject(value, new Set(['query']), 'event request');
  return { query: normalizePhrase(value.query) };
}

export function normalizeBlockRequest(value) {
  exactObject(value, new Set(['query']), 'block request');
  return { query: normalizePhrase(value.query) };
}

export function normalizeBuildRequest(value) {
  exactObject(value, new Set(['buildKey', 'minCount', 'topK']), 'build request');
  return {
    buildKey: normalizeIdentifier(value.buildKey, 'build key'),
    minCount: safeInteger(value.minCount ?? 3, 'minimum count', { min: 2, max: 1_000_000 }),
    topK: safeInteger(value.topK ?? MAX_TOP_K, 'top k', { min: 1, max: MAX_TOP_K }),
    normalizerVersion: NORMALIZER_VERSION,
  };
}

export function normalizeSuggestionLimit(value) {
  if (value === undefined || value === null || value === '') return MAX_TOP_K;
  return safeInteger(Number(value), 'suggestion limit', { min: 1, max: MAX_TOP_K });
}
