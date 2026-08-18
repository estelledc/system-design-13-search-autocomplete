export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_ledger (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_committed_sequence bigint NOT NULL DEFAULT 0 CHECK (last_committed_sequence >= 0)
);

INSERT INTO event_ledger (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS search_events (
  sequence bigint PRIMARY KEY CHECK (sequence > 0),
  id uuid NOT NULL UNIQUE,
  idempotency_key varchar(128) NOT NULL UNIQUE,
  request_digest char(64) NOT NULL,
  normalized_query varchar(64) NOT NULL CHECK (octet_length(normalized_query) BETWEEN 1 AND 64),
  accepted_at_ms bigint NOT NULL CHECK (accepted_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS search_events_query_watermark_idx
  ON search_events (normalized_query, sequence);

CREATE TABLE IF NOT EXISTS block_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_version bigint NOT NULL DEFAULT 0 CHECK (last_version >= 0)
);

INSERT INTO block_policy (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS blocked_terms (
  normalized_query varchar(64) PRIMARY KEY CHECK (octet_length(normalized_query) BETWEEN 1 AND 64),
  version bigint NOT NULL UNIQUE CHECK (version > 0),
  blocked_at_ms bigint NOT NULL CHECK (blocked_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS snapshot_builds (
  id uuid PRIMARY KEY,
  build_key varchar(128) NOT NULL UNIQUE,
  request_digest char(64) NOT NULL,
  watermark bigint NOT NULL CHECK (watermark >= 0),
  policy_version bigint NOT NULL CHECK (policy_version >= 0),
  expected_active_snapshot_id uuid REFERENCES snapshot_builds(id),
  normalizer_version varchar(64) NOT NULL,
  min_count integer NOT NULL CHECK (min_count >= 2),
  top_k integer NOT NULL CHECK (top_k BETWEEN 1 AND 5),
  state varchar(16) NOT NULL CHECK (state IN ('building', 'ready', 'published')),
  suggestion_count integer CHECK (suggestion_count >= 0),
  prefix_count integer CHECK (prefix_count >= 0),
  eligible_term_count integer CHECK (eligible_term_count >= 0),
  content_digest char(64),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  ready_at_ms bigint,
  published_at_ms bigint,
  CONSTRAINT snapshot_ready_receipt CHECK (
    (state = 'building' AND suggestion_count IS NULL AND prefix_count IS NULL
      AND eligible_term_count IS NULL AND content_digest IS NULL AND ready_at_ms IS NULL)
    OR
    (state IN ('ready', 'published') AND suggestion_count IS NOT NULL AND prefix_count IS NOT NULL
      AND eligible_term_count IS NOT NULL AND content_digest IS NOT NULL AND ready_at_ms IS NOT NULL)
  ),
  CONSTRAINT snapshot_publish_time CHECK (
    (state <> 'published' AND published_at_ms IS NULL)
    OR (state = 'published' AND published_at_ms IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS snapshot_suggestions (
  snapshot_id uuid NOT NULL REFERENCES snapshot_builds(id) ON DELETE CASCADE,
  prefix varchar(64) NOT NULL CHECK (octet_length(prefix) BETWEEN 1 AND 64),
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 5),
  term varchar(64) NOT NULL CHECK (octet_length(term) BETWEEN 1 AND 64),
  score bigint NOT NULL CHECK (score > 0),
  PRIMARY KEY (snapshot_id, prefix, rank),
  UNIQUE (snapshot_id, prefix, term)
);

CREATE INDEX IF NOT EXISTS snapshot_suggestions_lookup_idx
  ON snapshot_suggestions (snapshot_id, prefix, rank);

CREATE TABLE IF NOT EXISTS active_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id uuid REFERENCES snapshot_builds(id),
  publication_version bigint NOT NULL DEFAULT 0 CHECK (publication_version >= 0),
  updated_at_ms bigint NOT NULL DEFAULT 0 CHECK (updated_at_ms >= 0)
);

INSERT INTO active_snapshot (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
`;
