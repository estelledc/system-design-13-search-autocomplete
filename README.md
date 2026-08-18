# Evidence-first Search Autocomplete

A bounded autocomplete practice that turns periodic trie replacement into an executable publication contract.

Synthetic completed-search events enter a commit-ordered PostgreSQL ledger. A builder freezes one committed watermark, computes
deterministic top-5 candidates for every prefix, writes an immutable snapshot, and compare-and-swaps one active pointer. The query
path reads one published snapshot and the current block policy in one statement.

This is a learning repository, not a production search engine, privacy system, or relevance claim.

## What is implemented

- idempotent synthetic event acceptance with one immutable request digest;
- a contiguous committed event watermark created by one locked ledger row;
- explicit `ascii-nfkc-lower-space-v1` phrase and prefix identity;
- minimum-frequency eligibility, deterministic count/term ranking, and top-5 prefix bounds;
- immutable `(snapshot, prefix, rank)` rows—the read contract of cached trie nodes;
- `building → ready → published` lifecycle with artifact count and SHA-256 digest;
- compare-and-swap publication against the build's expected predecessor;
- immediate read-time suppression from a permanent block policy;
- authenticated HTTP event/query routes with `private, no-store` and query-safe structured logs;
- process-death smoke for a ready-but-unpublished build, exact retry, late-event exclusion, and later publication.

The slice deliberately excludes full-text retrieval, fuzzy/semantic search, personalization, trending windows, multilingual
collation, production content policy, differential privacy, distributed caches/streams, sharding, and high availability.

## Architecture in one view

```text
synthetic events               builder                         query request
      |                           |                                  |
      | lock ledger + commit      |                                  |
      |-------------------------->| freeze committed watermark       |
      |                           | aggregate + rank prefixes         |
      |                           | write immutable ready snapshot    |
      |                           | compare-and-swap active pointer   |
      |                           |                                  |
      |                           |                one SQL snapshot   |
      |                           |     active snapshot + block policy|
      |                           |<---------------------------------|
      |                           |---------------- top-5 response -->|
```

The global ledger lock is intentionally not scalable. It is a correctness oracle that prevents a lower allocated event ID from
committing after a supposedly complete watermark. [Architecture](docs/architecture.md) explains the failure windows and the
later scaling boundary.

## Run locally

Requirements: Node.js 22 or newer, npm, and a disposable PostgreSQL 17.6 database.

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/search_autocomplete
export AUTH_TOKENS_JSON='["replace-with-at-least-16-characters"]'
npm run check:ci
```

Start the API:

```bash
npm start
```

Build and publish one snapshot:

```bash
BUILD_KEY=snapshot-build-0001 MIN_COUNT=3 TOP_K=5 node src/main.js build-publish
```

Block a synthetic phrase from future responses:

```bash
BLOCK_TERM='synthetic phrase' node src/main.js block-term
```

Never use production credentials or real query logs. The database tests and smoke reset the configured `public` schema.

## Verification boundary

`npm run check:ci` runs repository policy, 10 pure tests including 120 generated corpora, dependency audit, real PostgreSQL
integration, a true-process `SIGKILL` smoke, and a bounded benchmark. Public CI executes the same gate on Node 22, 24, and 26
with PostgreSQL 17.6.

Passing proves only the tested ingestion, build, publication, filtering, and response invariants. It does not prove the source
chapter's <100 ms / 48,000 QPS figures, balanced sharding, cache coherence, privacy, safety quality, client rendering, suggestion
selection, relevance, user satisfaction, or production acceptance. Exact receipts live in [verification](docs/verification.md).

## Research provenance

The prompt source is chapter 13 of `liquidslr/system-design-notes`, fixed at commit
`9d8388721e7231442763ad37398b8d82224aa68f`. The snapshot has no license file, so this repository follows a clean-room boundary:
the closed-book contract was committed first, and no upstream prose, diagram, image, or code is copied. The later
[research log](docs/research-log.md) compares its cached-trie design against primary specifications and executable failure cases.

## Documents

- [Requirements and invariants](docs/requirements.md)
- [Architecture and publication flow](docs/architecture.md)
- [HTTP and command API](docs/api.md)
- [Threat model](docs/threat-model.md)
- [Operations](docs/operations.md)
- [Verification receipts](docs/verification.md)
- [Closed-book contract](docs/closed-book-contract.md)
- [Research log](docs/research-log.md)
- [ADR 0001](docs/adr/0001-commit-ordered-events-and-atomic-prefix-snapshots.md)
- [Security policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).
