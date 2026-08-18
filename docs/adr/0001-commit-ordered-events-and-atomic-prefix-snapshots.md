# ADR 0001: Commit-ordered events and atomic prefix snapshots

## Status

Accepted for the v0.1 evidence slice.

## Context

Autocomplete reads need a tiny, stable result while accepted search events and policy updates continue. A periodic trie is useful
only if the system defines which committed events it contains, whether every cached node belongs to the same version, and how the
new version becomes visible. PostgreSQL `bigserial` allocation does not establish a gap-free committed prefix, so a naive maximum
ID watermark can change meaning after a lower in-flight transaction commits.

The fixed chapter's strongest executable idea is caching top suggestions at each prefix node. Its weakest boundary is replacing
the old trie: build completeness, double publication, late events, filtering, and cache invalidation are unspecified.

## Decision

Use PostgreSQL 17.6 as the single durable authority and a pure deterministic prefix builder.

1. New event acceptance locks a singleton ledger, checks idempotency, assigns the next integer, inserts the event, and commits.
   This produces a contiguous committed watermark. Exact retry returns the stored event; changed normalized intent conflicts.
2. A build record freezes the current ledger watermark, active-snapshot predecessor, block-policy version, normalizer version,
   minimum count, and top-k. Reusing a build key with changed intent conflicts.
3. Materialization reads events through the watermark and blocks through the policy version in one Repeatable Read transaction.
   The pure builder aggregates eligible terms, expands ASCII prefixes, ranks by count descending then term ascending, and retains
   five rows per prefix.
4. Candidate rows and the build's count/content digest commit together. A `building` or `ready` snapshot is never served.
5. Publication locks the singleton active pointer and compare-and-swaps it against the build's expected predecessor. The pointer
   and `published` state commit together. Exact replay is harmless; a stale competing build conflicts.
6. Serving uses one SQL statement that joins the active pointer to immutable candidates and excludes the current authoritative
   block table. It returns one snapshot ID, one policy version, and up to the requested limit.
7. Event intake and suggestion responses use `Cache-Control: private, no-store`. Logs contain counts, states, durations, digests,
   and reason codes but no raw terms, prefixes, idempotency keys, actor IDs, or result lists.

## Why flat prefix rows instead of a serialized trie

The read contract of a trie with cached top-k at every node is `prefix → bounded ranked candidates`. A table keyed by
`(snapshot_id, prefix, rank)` is that contract directly. It avoids making an in-process tree, cache, and serialized object three
competing versions. A trie/radix encoding can replace the physical artifact later if measured size or lookup cost requires it,
without changing normalization, ranking, snapshot, or publication semantics.

## Alternatives rejected for this slice

- **`bigserial` maximum as cutoff:** sequence allocation is not rolled back and does not follow commit order; the same numeric
  cutoff could gain a late-committing lower event.
- **Read live counts and update trie nodes per event:** couples a high-write path to every prefix and exposes partial rank changes;
  no current freshness requirement justifies it.
- **Build rows in place:** readers can mix old and partially updated nodes, and rollback/publish identity is unclear.
- **Rename/swap a serialized file:** useful on one host, but does not by itself coordinate multiple builders/servers or current
  policy blocks.
- **Redis/MongoDB because the chapter names them:** storage names do not establish a committed watermark or atomic publication.
- **Browser cache immediately:** a typed prefix is potentially sensitive and emergency filtering needs a defined invalidation
  protocol. v0.1 prefers no-store.
- **Full Unicode/multilingual support:** normalization, casing, grapheme boundaries, collation, locale partitioning, and migration
  are separate product contracts. The chapter's lowercase-English slice is enough for the current invariant.

## Consequences

- Event acceptance has one global hot row and cannot approach the scenario ingestion rate. It is a correctness oracle for the
  experiment, not the target scaling architecture. Partitioned commit ledgers or a durable ordered stream need a later ADR.
- Builds duplicate immutable candidate rows until cleanup. Storage is traded for atomic rollback and explainability.
- A ready snapshot can remain orphaned after a crash. It is safe to retry/publish by build key or remove after a retention window;
  cleanup must never delete the active snapshot.
- Current read-time blocks can reduce a response below five candidates. This is preferred to filling from an unbounded subtree or
  serving a blocked term.
- One database can prove the bounded publication semantics. It cannot prove high availability, <100 ms at 48,000 QPS, balanced
  sharding, cache coherence, multilingual quality, relevance, privacy protection, or production suitability.
