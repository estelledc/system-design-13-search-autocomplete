# Research log and source corrections

## Snapshot and clean-room boundary

- Closed-book baseline: commit `ab6449b4344cfa3f46c6ce2595d6959e5af2ce3e`, written before reading the chapter.
- Secondary prompt source: `liquidslr/system-design-notes`, fixed commit
  `9d8388721e7231442763ad37398b8d82224aa68f`, chapter 13 tree
  `a2557b6905b3ae10282a05d66811d11c24440899`, `Readme.md` blob
  `7f067efb98183d4eb0d78b0a23e06f08e296ac07`.
- Public-source fetch and review date: 2026-08-19 (Asia/Shanghai).
- The fixed upstream tree has no license file. This repository copies no upstream prose, code, image, or diagram. The chapter is
  used only to identify the exercise and compare mechanisms.

## Closed-book comparison

| Topic | Closed-book contract | Fixed chapter | Decision after comparison |
|---|---|---|---|
| Result contract | up to 10, deterministic integer score and tie-break | up to 5, popularity/frequency, lowercase English | use top 5 and a total frequency-descending/term-ascending order |
| Input scope | versioned Unicode normalization | lowercase English, later lists Unicode as an advanced feature | v0.1 stores ASCII English after explicit NFKC/lowercase/space normalization; multilingual identity stays out of scope |
| Freshness | immutable snapshot at a committed event watermark | weekly aggregation/build, shorter intervals for fast-changing products | keep configurable manual builds, but make the event cutoff and publication state executable |
| Read structure | unspecified until source review | trie with cached top-k at each node; serialized document or prefix-key/value storage | materialize `(snapshot, prefix, rank)` rows: the flat representation is the cached trie-node read contract without another authority |
| Event update | idempotent append-only accepted events | analytics logs, frequency aggregation; early real-time update is later called impractical | keep append-only events and batch aggregation; one accepted event is not an immediately visible suggestion |
| Publication | complete immutable artifact plus atomic active pointer | new trie periodically replaces old data, but no switch protocol | require ready-state validation and compare-and-swap publication against the expected active snapshot |
| Filtering | minimum count; content policy reserved | filter layer plus asynchronous physical deletion of harmful suggestions | keep a minimum count and add an immediate authoritative block check; physical historical erasure remains unimplemented |
| Browser caching | reserved until privacy/freshness review | recommends browser caching | return `Cache-Control: private, no-store` in v0.1; typed prefixes and emergency blocks outweigh an unmeasured cache benefit |
| Scale | synthetic 50M DAU / 463k peak requests/s | states 10M DAU, 48k peak QPS, 0.4 GB/day, <100 ms | retain both only as dated/scenario inputs; neither source provides an executable capacity derivation |
| Failure semantics | explicit builder crash, race, rollback, late event, mixed snapshot counterexamples | high availability named, but partial build, activation, rollback, and stale cache behavior absent | make those windows the core process smoke rather than claim high availability |

## Problems in the fixed design that need an executable answer

1. It first describes real-time frequency updates, then says updating on every query is impractical and moves to periodic builds.
   The correction is not a flaw by itself, but the handoff lacks an event cutoff and freshness receipt.
2. “Replace the old trie” does not specify whether readers can observe a partially serialized tree, how two builders race, or how
   a failed release rolls back. A named snapshot ID and one active-pointer transaction make the boundary testable.
3. A trie node that caches top-k does not need to traverse and sort its full subtree at query time. The chapter describes both
   paths without saying which is authoritative. v0.1 serves only precomputed ranked rows.
4. Frequency alone does not define ties, normalization, duplicate logical phrases, or input-order stability. A total order and
   artifact digest are required before two builders can be compared.
5. Asynchronous physical deletion does not define when a harmful term stops serving, especially through browser/cache copies.
   v0.1 checks a current block table in the same read statement and accepts that already exported/browser-cached data cannot be
   recalled by this service.
6. Alphabetic range sharding such as `a-m` / `n-z` is not balanced by construction. v0.1 does not add a shard-map service before
   measuring prefix skew or defining migration/fencing.

## Primary-source corrections

### A database sequence is not a committed event watermark

PostgreSQL 17 documents that `nextval` values are not reclaimed when a transaction aborts and sequence state is not rolled back.
A visible high sequence can therefore coexist with a lower allocated but uncommitted event, and the lower event can commit later.
Using `max(bigserial)` as “all events through here are committed” would let the logical contents of the same cutoff change.

The bounded slice instead locks one `event_ledger` row, assigns `last_committed_sequence + 1`, inserts the event, and commits
before another new event can allocate. This creates a contiguous committed prefix at the cost of globally serializing new event
acceptance. The cost is intentional and will be measured rather than hidden.

### Snapshot visibility and pointer publication

PostgreSQL 17 Read Committed gives each statement a snapshot, so two statements in one transaction can see different concurrent
commits. Repeatable Read holds one database view across successive reads, though updating transactions must handle serialization
failure. Materialization therefore reads the frozen event prefix and block version inside one repeatable-read transaction and
writes the entire candidate artifact atomically. Serving joins the active pointer, snapshot metadata, current policy version,
blocks, and candidate rows in one SQL statement so one response cannot mix snapshot IDs.

Publication locks the singleton active-pointer row. It succeeds only if the current pointer still equals the build's recorded
expected predecessor. A slower old builder cannot silently replace a newer published snapshot.

### Normalization is a versioned product rule

Unicode Standard Annex #15 distinguishes canonical normalization from compatibility normalization; NFKC can intentionally map
compatibility forms to a composed equivalent. ECMAScript exposes NFC, NFD, NFKC, and NFKD through `String.prototype.normalize`.
Normalization does not solve language-specific case, tokenization, grapheme, collation, or safety rules.

The fixed chapter's v0.1 requirement is lowercase English. This slice applies NFKC, lowercase, trim, and whitespace collapse,
then accepts only ASCII `a-z` and internal spaces within 64 UTF-8 bytes. The algorithm is named `ascii-nfkc-lower-space-v1`.
Unicode/multilingual support requires a new namespace and migration; it is not switched on by widening a regular expression.

### Browser caching is a policy choice, not a free optimization

RFC 9111 defines `no-store` as instructing caches not to store the request/response, while also warning that it is not a complete
privacy guarantee. Because a prefix can reveal intent and a newly blocked suggestion must stop serving from this origin, v0.1
returns `Cache-Control: private, no-store`. A future cache needs an explicit key, policy-version invalidation, retention/privacy
decision, and measured benefit.

## Source-informed design decisions

- Store idempotent synthetic events in PostgreSQL 17.6 behind one commit-ordered ledger row.
- Build at an explicit watermark and minimum count; rank by count descending and normalized term ascending; retain top 5 per
  prefix. Builder input order cannot change rows or digest.
- Represent cached trie nodes as immutable relational prefix rows. No separate in-memory cache, serialized tree, MongoDB, Redis,
  Kafka, or shard map is introduced in v0.1.
- Make build creation idempotent. Materialization transitions `building → ready` only with an artifact count and SHA-256 digest.
  Publication compare-and-swaps the active pointer; ready but unpublished snapshots are safe after process death.
- Check the latest block policy at read time and return fewer than five suggestions if necessary. Blocking proves only that this
  origin omitted the term after the policy commit; it cannot retract previous responses or external caches.
- Label outputs `event_accepted`, `snapshot_ready`, `snapshot_published`, and `suggestion_response`. None proves rendering,
  selection, relevance, satisfaction, or a human/business outcome.

## Primary sources

- [PostgreSQL 17: Sequence Manipulation Functions](https://www.postgresql.org/docs/17/functions-sequence.html)
- [PostgreSQL 17: Transaction Isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- [PostgreSQL 17: Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [Unicode Standard Annex #15: Unicode Normalization Forms](https://www.unicode.org/reports/tr15/)
- [ECMAScript: `String.prototype.normalize`](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.normalize)

The public bodies above were fetched into temporary evidence bundles and passed the repository fetch verifier. Search snippets
were candidate discovery only. Unicode and ECMAScript are living specifications; implementation claims remain bound to the
explicit v0.1 normalizer and the tested runtime matrix.
