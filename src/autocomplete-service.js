import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import {
  normalizeBlockRequest,
  normalizeBuildRequest,
  normalizeEventRequest,
  normalizeIdentifier,
  normalizePrefix,
  normalizeSuggestionLimit,
  normalizeUuid,
  safeInteger,
} from './contracts.js';

function publicEvent(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    acceptedAtMs: event.acceptedAtMs,
  };
}

function publicBuild(build) {
  return {
    id: build.id,
    watermark: build.watermark,
    policyVersion: build.policyVersion,
    expectedActiveSnapshotId: build.expectedActiveSnapshotId,
    normalizerVersion: build.normalizerVersion,
    minCount: build.minCount,
    topK: build.topK,
    state: build.state,
    suggestionCount: build.suggestionCount,
    prefixCount: build.prefixCount,
    eligibleTermCount: build.eligibleTermCount,
    contentDigest: build.contentDigest,
    createdAtMs: build.createdAtMs,
    readyAtMs: build.readyAtMs,
    publishedAtMs: build.publishedAtMs,
  };
}

export class AutocompleteService {
  constructor({ store, clock = Date.now, uuid = randomUUID }) {
    this.store = store;
    this.clock = clock;
    this.uuid = uuid;
  }

  async acceptEvent({ idempotencyKey, request }) {
    const normalizedKey = normalizeIdentifier(idempotencyKey, 'idempotency key');
    const normalized = normalizeEventRequest(request);
    const result = await this.store.acceptEvent({
      id: normalizeUuid(this.uuid(), 'generated event ID'),
      idempotencyKey: normalizedKey,
      requestDigest: sha256(canonicalJson(normalized)),
      normalizedQuery: normalized.query,
      acceptedAtMs: this.#now(),
    });
    return { created: result.created, event: publicEvent(result.event), evidence: 'event_accepted' };
  }

  async blockTerm({ request }) {
    const normalized = normalizeBlockRequest(request);
    const result = await this.store.blockTerm({
      normalizedQuery: normalized.query,
      blockedAtMs: this.#now(),
    });
    return { ...result, evidence: 'block_policy_committed' };
  }

  async startBuild({ request }) {
    const normalized = normalizeBuildRequest(request);
    const result = await this.store.createBuild({
      id: normalizeUuid(this.uuid(), 'generated snapshot ID'),
      ...normalized,
      requestDigest: sha256(canonicalJson(normalized)),
      createdAtMs: this.#now(),
    });
    return { created: result.created, build: publicBuild(result.build) };
  }

  async materializeBuild(buildId) {
    const result = await this.store.materializeBuild({
      buildId: normalizeUuid(buildId, 'build ID'),
      readyAtMs: this.#now(),
    });
    return { changed: result.changed, build: publicBuild(result.build), evidence: 'snapshot_ready' };
  }

  async publishBuild(buildId) {
    const result = await this.store.publishBuild({
      buildId: normalizeUuid(buildId, 'build ID'),
      publishedAtMs: this.#now(),
    });
    return {
      changed: result.changed,
      publicationVersion: result.publicationVersion,
      build: publicBuild(result.build),
      evidence: 'snapshot_published',
    };
  }

  async suggest({ prefix, limit }) {
    const result = await this.store.getSuggestions({
      prefix: normalizePrefix(prefix),
      limit: normalizeSuggestionLimit(limit),
    });
    return { ...result, evidence: 'suggestion_response' };
  }

  #now() {
    return safeInteger(this.clock(), 'clock', { min: 0 });
  }
}
