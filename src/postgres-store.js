import { buildPrefixArtifact } from './prefix-builder.js';
import {
  AppError,
  DependencyError,
  NotFoundError,
  PublicationConflictError,
  RequestConflictError,
  ValidationError,
} from './errors.js';
import { SCHEMA_SQL } from './schema.js';

function dependencyFailure(error) {
  if (error instanceof AppError) return error;
  return new DependencyError('PostgreSQL operation failed', error);
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    sequence: Number(row.sequence),
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    normalizedQuery: row.normalized_query,
    acceptedAtMs: Number(row.accepted_at_ms),
  };
}

function mapBuild(row) {
  if (!row) return null;
  return {
    id: row.id,
    buildKey: row.build_key,
    requestDigest: row.request_digest,
    watermark: Number(row.watermark),
    policyVersion: Number(row.policy_version),
    expectedActiveSnapshotId: row.expected_active_snapshot_id,
    normalizerVersion: row.normalizer_version,
    minCount: row.min_count,
    topK: row.top_k,
    state: row.state,
    suggestionCount: row.suggestion_count,
    prefixCount: row.prefix_count,
    eligibleTermCount: row.eligible_term_count,
    contentDigest: row.content_digest,
    createdAtMs: Number(row.created_at_ms),
    readyAtMs: row.ready_at_ms === null ? null : Number(row.ready_at_ms),
    publishedAtMs: row.published_at_ms === null ? null : Number(row.published_at_ms),
  };
}

export class PostgresAutocompleteStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    try {
      await this.pool.query(SCHEMA_SQL);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async acceptEvent(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const ledger = await client.query(
        'SELECT last_committed_sequence FROM event_ledger WHERE singleton = true FOR UPDATE',
      );
      const existing = await client.query(
        'SELECT * FROM search_events WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const result = this.#classifyEvent(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      const sequence = Number(ledger.rows[0].last_committed_sequence) + 1;
      await client.query(
        'UPDATE event_ledger SET last_committed_sequence = $1 WHERE singleton = true',
        [sequence],
      );
      const inserted = await client.query(
        `INSERT INTO search_events (
           sequence, id, idempotency_key, request_digest, normalized_query, accepted_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          sequence,
          input.id,
          input.idempotencyKey,
          input.requestDigest,
          input.normalizedQuery,
          input.acceptedAtMs,
        ],
      );
      await client.query('COMMIT');
      return { created: true, event: mapEvent(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async blockTerm({ normalizedQuery, blockedAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const policy = await client.query(
        'SELECT last_version FROM block_policy WHERE singleton = true FOR UPDATE',
      );
      const existing = await client.query(
        'SELECT version FROM blocked_terms WHERE normalized_query = $1',
        [normalizedQuery],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { changed: false, policyVersion: Number(policy.rows[0].last_version) };
      }
      const version = Number(policy.rows[0].last_version) + 1;
      await client.query('UPDATE block_policy SET last_version = $1 WHERE singleton = true', [version]);
      await client.query(
        'INSERT INTO blocked_terms (normalized_query, version, blocked_at_ms) VALUES ($1, $2, $3)',
        [normalizedQuery, version, blockedAtMs],
      );
      await client.query('COMMIT');
      return { changed: true, policyVersion: version };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async createBuild(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const existing = await client.query('SELECT * FROM snapshot_builds WHERE build_key = $1', [input.buildKey]);
      if (existing.rows[0]) {
        const result = this.#classifyBuild(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      const ledger = await client.query(
        'SELECT last_committed_sequence FROM event_ledger WHERE singleton = true',
      );
      const policy = await client.query('SELECT last_version FROM block_policy WHERE singleton = true');
      const active = await client.query('SELECT snapshot_id FROM active_snapshot WHERE singleton = true');
      const inserted = await client.query(
        `INSERT INTO snapshot_builds (
           id, build_key, request_digest, watermark, policy_version, expected_active_snapshot_id,
           normalizer_version, min_count, top_k, state, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'building', $10)
         RETURNING *`,
        [
          input.id,
          input.buildKey,
          input.requestDigest,
          ledger.rows[0].last_committed_sequence,
          policy.rows[0].last_version,
          active.rows[0].snapshot_id,
          input.normalizerVersion,
          input.minCount,
          input.topK,
          input.createdAtMs,
        ],
      );
      await client.query('COMMIT');
      return { created: true, build: mapBuild(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505' && error?.constraint === 'snapshot_builds_build_key_key') {
        return this.#buildAfterRace(input);
      }
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async materializeBuild({ buildId, readyAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const selected = await client.query('SELECT * FROM snapshot_builds WHERE id = $1 FOR UPDATE', [buildId]);
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.state !== 'building') {
        await client.query('COMMIT');
        return { changed: false, build: mapBuild(row) };
      }
      const aggregates = await client.query(
        `SELECT normalized_query AS term, count(*)::bigint AS count
         FROM search_events WHERE sequence <= $1
         GROUP BY normalized_query ORDER BY normalized_query`,
        [row.watermark],
      );
      const blocks = await client.query(
        'SELECT normalized_query FROM blocked_terms WHERE version <= $1 ORDER BY normalized_query',
        [row.policy_version],
      );
      const artifact = buildPrefixArtifact(aggregates.rows, {
        minCount: row.min_count,
        topK: row.top_k,
        blockedTerms: blocks.rows.map((block) => block.normalized_query),
      });
      await client.query('DELETE FROM snapshot_suggestions WHERE snapshot_id = $1', [buildId]);
      if (artifact.rows.length > 0) {
        await client.query(
          `INSERT INTO snapshot_suggestions (snapshot_id, prefix, rank, term, score)
           SELECT $1, input.prefix, input.rank, input.term, input.score
           FROM unnest($2::text[], $3::integer[], $4::text[], $5::bigint[])
             AS input(prefix, rank, term, score)`,
          [
            buildId,
            artifact.rows.map((candidate) => candidate.prefix),
            artifact.rows.map((candidate) => candidate.rank),
            artifact.rows.map((candidate) => candidate.term),
            artifact.rows.map((candidate) => candidate.score),
          ],
        );
      }
      const updated = await client.query(
        `UPDATE snapshot_builds SET
           state = 'ready', suggestion_count = $2, prefix_count = $3,
           eligible_term_count = $4, content_digest = $5, ready_at_ms = $6
         WHERE id = $1 RETURNING *`,
        [
          buildId,
          artifact.rows.length,
          artifact.prefixCount,
          artifact.eligibleTermCount,
          artifact.contentDigest,
          readyAtMs,
        ],
      );
      await client.query('COMMIT');
      return { changed: true, build: mapBuild(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async publishBuild({ buildId, publishedAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const active = await client.query(
        'SELECT snapshot_id, publication_version FROM active_snapshot WHERE singleton = true FOR UPDATE',
      );
      const selected = await client.query('SELECT * FROM snapshot_builds WHERE id = $1 FOR UPDATE', [buildId]);
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.state === 'published') {
        if (active.rows[0].snapshot_id !== row.id) throw new PublicationConflictError();
        await client.query('COMMIT');
        return {
          changed: false,
          publicationVersion: Number(active.rows[0].publication_version),
          build: mapBuild(row),
        };
      }
      if (row.state !== 'ready') throw new ValidationError('snapshot must be ready before publication');
      if (active.rows[0].snapshot_id !== row.expected_active_snapshot_id) throw new PublicationConflictError();
      const publicationVersion = Number(active.rows[0].publication_version) + 1;
      await client.query(
        `UPDATE active_snapshot SET snapshot_id = $1, publication_version = $2, updated_at_ms = $3
         WHERE singleton = true`,
        [buildId, publicationVersion, publishedAtMs],
      );
      const updated = await client.query(
        `UPDATE snapshot_builds SET state = 'published', published_at_ms = $2
         WHERE id = $1 RETURNING *`,
        [buildId, publishedAtMs],
      );
      await client.query('COMMIT');
      return { changed: true, publicationVersion, build: mapBuild(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async getSuggestions({ prefix, limit }) {
    try {
      const result = await this.pool.query(
        `SELECT
           build.id AS snapshot_id,
           build.watermark,
           build.content_digest,
           active.publication_version,
           policy.last_version AS policy_version,
           COALESCE((
             SELECT json_agg(json_build_object(
               'term', ranked.term,
               'score', ranked.score,
               'snapshotRank', ranked.rank
             ) ORDER BY ranked.rank)
             FROM (
               SELECT suggestion.term, suggestion.score, suggestion.rank
               FROM snapshot_suggestions AS suggestion
               LEFT JOIN blocked_terms AS blocked ON blocked.normalized_query = suggestion.term
                 AND blocked.version <= policy.last_version
               WHERE suggestion.snapshot_id = build.id
                 AND suggestion.prefix = $1
                 AND blocked.normalized_query IS NULL
               ORDER BY suggestion.rank
               LIMIT $2
             ) AS ranked
           ), '[]'::json) AS suggestions
         FROM active_snapshot AS active
         JOIN snapshot_builds AS build ON build.id = active.snapshot_id AND build.state = 'published'
         CROSS JOIN block_policy AS policy
         WHERE active.singleton = true AND policy.singleton = true`,
        [prefix, limit],
      );
      if (!result.rows[0]) throw new NotFoundError();
      const row = result.rows[0];
      return {
        snapshotId: row.snapshot_id,
        watermark: Number(row.watermark),
        contentDigest: row.content_digest,
        publicationVersion: Number(row.publication_version),
        policyVersion: Number(row.policy_version),
        suggestions: row.suggestions.map((suggestion, index) => ({
          term: suggestion.term,
          score: Number(suggestion.score),
          rank: index + 1,
          snapshotRank: suggestion.snapshotRank,
        })),
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async stats() {
    try {
      const [ledger, events, builds, active, blocks] = await Promise.all([
        this.pool.query('SELECT last_committed_sequence FROM event_ledger WHERE singleton = true'),
        this.pool.query('SELECT count(*)::integer AS count FROM search_events'),
        this.pool.query(`SELECT
          count(*) FILTER (WHERE state = 'building')::integer AS building,
          count(*) FILTER (WHERE state = 'ready')::integer AS ready,
          count(*) FILTER (WHERE state = 'published')::integer AS published
          FROM snapshot_builds`),
        this.pool.query('SELECT snapshot_id, publication_version FROM active_snapshot WHERE singleton = true'),
        this.pool.query('SELECT count(*)::integer AS count FROM blocked_terms'),
      ]);
      return {
        eventWatermark: Number(ledger.rows[0].last_committed_sequence),
        events: events.rows[0].count,
        builds: builds.rows[0],
        activeSnapshot: active.rows[0].snapshot_id !== null,
        publicationVersion: Number(active.rows[0].publication_version),
        blockedTerms: blocks.rows[0].count,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  #classifyEvent(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, event: mapEvent(row) };
  }

  #classifyBuild(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, build: mapBuild(row) };
  }

  async #buildAfterRace(input) {
    try {
      const result = await this.pool.query('SELECT * FROM snapshot_builds WHERE build_key = $1', [input.buildKey]);
      if (!result.rows[0]) throw new DependencyError('Build conflict was not readable');
      return this.#classifyBuild(result.rows[0], input.requestDigest);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}
