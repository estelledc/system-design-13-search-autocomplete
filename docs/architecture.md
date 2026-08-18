# Architecture

## Why the authority is a snapshot, not a trie object

The chapter's optimized trie caches top suggestions at every prefix node. Its external read contract is therefore simply:

```text
(snapshot ID, normalized prefix) -> bounded ranked phrases
```

PostgreSQL rows keyed by `(snapshot_id, prefix, rank)` implement that contract directly. This avoids three competing versions in
an in-memory tree, serialized object, and cache. A radix tree, object snapshot, or key-value cache can later replace the physical
representation without changing event identity, ranking, publication, or evidence semantics.

## Commit-ordered event intake

PostgreSQL sequences guarantee distinct allocation, not gapless commit order. v0.1 instead executes:

1. begin transaction;
2. lock the singleton `event_ledger` row `FOR UPDATE`;
3. return an exact idempotency replay or conflict on a changed digest;
4. assign `last_committed_sequence + 1`;
5. update the ledger and insert the event;
6. commit, releasing the row for the next new event.

If an event transaction stalls, later new events wait. A build can still read the prior committed ledger version and freeze a
lower cutoff. This is intentionally safe and intentionally not scalable.

## Build lifecycle

```text
create build                 materialize                    publish
    |                            |                             |
    | freeze watermark           | lock build                  | lock active pointer
    | freeze policy version      | aggregate <= watermark      | require state=ready
    | freeze expected active     | block <= policy version     | compare predecessor
    | state=building             | deterministic prefix rows   | pointer + state commit
    |                            | rows + digest -> ready       | state=published
```

Build creation is idempotent by build key. Materialization uses one Repeatable Read transaction and commits either the complete
artifact plus receipt or none of it. Process death after `ready` but before publication leaves the prior active pointer intact.

Publication is compare-and-swap, not “last builder wins.” If B and C both expect A, publishing B changes the pointer; C then
conflicts and cannot overwrite B. Replaying publication while the same snapshot remains active is harmless.

## Late events

Suppose B freezes watermark 8. Event 9 commits while B computes. Every B query uses `sequence <= 8`, so event 9 cannot enter B.
Retrying B by build key reuses watermark 8 and the same artifact. A later C can freeze 9 and include it. Wall-clock completion
order does not redefine snapshot contents.

## Filtering and response consistency

A build excludes terms blocked at its frozen policy version. New emergency blocks must not wait for another build, so serving
also left-joins the current permanent block table and omits matches.

Active pointer, snapshot metadata, current policy version, block exclusion, ordered candidates, and limit are evaluated in one
SQL statement. PostgreSQL Read Committed gives that statement one database snapshot. The response returns both `rank` after
current filtering and `snapshotRank` from the immutable artifact.

This service cannot retract an older response, browser history, external cache, export, log, replica snapshot, or backup.

## Scaling boundary

- The single ledger row is the first write bottleneck. A future partitioned ledger or durable stream must define a complete
  multi-partition watermark; replacing the row with `bigserial` would break the current invariant.
- Materialization groups the frozen event prefix in PostgreSQL and holds one transaction while building rows in memory. Large
  corpora need staged artifacts, checksums, and an atomic manifest, not an unbounded transaction.
- Immutable snapshots duplicate top-k rows. Retention and safe orphan cleanup are not automated.
- Reads query PostgreSQL directly. A cache requires snapshot/policy keys, invalidation, privacy retention, and observed benefit.
- Alphabetic sharding is vulnerable to skew. No shard map or migration/fencing protocol exists.

## Deliberately absent components

There is no Redis, Kafka, Flink, MongoDB, object store, CDN, distributed trie, ML ranker, shard manager, region coordinator, or
failover controller. Their names do not repair a missing watermark or publication protocol.
