# Closed-book contract: Search Autocomplete

## Evidence boundary

- Frozen on 2026-08-19 (Asia/Shanghai) from the title “Search Autocomplete” only.
- Chapter 13 of `liquidslr/system-design-notes` and external autocomplete designs have not been read for this contract.
- Every product rule, number, component, and test below is a repository assumption. It is not a claim about Google Search,
  YouTube, Amazon, Feishu, Doubao, or another product.
- This file will be committed before source comparison. Later research may correct the implementation through a research log or
  ADR, but must not rewrite this baseline to make later evidence look like prior knowledge.

## One executable question

> When a user types a prefix, how can the service return a deterministic, bounded suggestion set from one completely published
> evidence snapshot while ingestion, rebuilding, filtering, retries, and process crashes continue?

The v0.1 slice will accept synthetic search-submission events, build immutable ranked prefix snapshots, atomically activate one
snapshot, and serve suggestions from it. It will separate event acceptance, aggregate eligibility, snapshot publication, server
response, client rendering, and user selection.

## Scenario arithmetic, not a forecast

Assume, only to shape the experiment:

- 50 million daily active users, 10 search sessions per user/day, and 8 autocomplete requests per session: 4 billion suggestion
  requests/day, about 46,296/second average;
- a declared 10x peak: about 462,963 suggestion requests/second;
- 500 million completed-search events/day, about 5,787/second average;
- 10 million eligible normalized phrases, an average 20 indexed prefixes per phrase, and 10 candidates per prefix;
- 40 bytes per phrase reference plus integer score/rank metadata: roughly 80 GB for 200 million candidate references before
  encoding, indexes, replicas, snapshot duplication, caches, and operational overhead;
- a server response limit of 10 candidates and normalized input bounded to 64 UTF-8 bytes.

These inputs reveal that read traffic, event ingestion, offline aggregation, and snapshot distribution scale differently. The
repository will exercise small deterministic fixtures and report bounded raw timing. It will not claim the scenario rates.

## Frozen product behavior

- One synthetic English namespace accepts completed-search events and returns up to 10 normalized phrases for a typed prefix.
- NFKC normalization, one explicit locale-aware lowercase rule, whitespace collapse, and byte bounds define identity. The client
  cannot choose an alternate normalizer.
- An ingestion request supplies a stable idempotency key. Exact replay returns the original event; changed normalized query or
  weight conflicts. Event acceptance alone never makes the phrase suggestible.
- A builder freezes a durable event watermark. Events above the watermark belong to a later snapshot even if they arrive before
  the build finishes.
- A phrase becomes eligible only after a configured minimum aggregate count in the frozen event set. The toy threshold reduces
  accidental one-off exposure but is not a privacy guarantee or differential privacy.
- Every indexed Unicode-code-point prefix receives candidates ordered by integer score descending, then normalized phrase
  ascending as a deterministic tie-breaker. The response is prebounded when the snapshot is built.
- A building snapshot is invisible. Publication changes one active-snapshot pointer atomically after all expected rows and a
  deterministic content digest are stored. A reader uses one snapshot ID for its whole response.
- If a builder dies before publication, readers stay on the prior snapshot. If it dies after publication, the new immutable
  snapshot remains authoritative. Retrying the same build input converges on the same logical content.
- The HTTP response may prove which snapshot and candidate rows the service returned. It cannot prove browser rendering,
  accessibility announcement, user attention, suggestion selection, search execution, relevance, satisfaction, or business
  impact.

## Non-goals

- Full-text search, document retrieval/ranking, spell correction, typo tolerance, fuzzy matching, semantic/vector search,
  personalization, geolocation, trending windows, news freshness, or multilingual collation.
- Query history UI, per-user recent searches, federated search, voice input, images, ads, sponsored suggestions, or zero-result
  handling.
- Production content policy, adult/violent/hateful query classification, legal removal, trademark policy, abuse/spam resistance,
  privacy budgets, differential privacy, k-anonymity guarantees, or deletion-service integration.
- Distributed stream processing, global active-active publication, CDN/cache invalidation, trie sharding, database failover,
  production capacity, SLA, deployment, or external acceptance.

## Planned state and authority

- `search_events`: immutable accepted synthetic phrase, server sequence/watermark, idempotency key, request digest, count weight,
  and acceptance time.
- `snapshot_builds`: build identity, frozen event watermark, normalizer/ranker version, eligibility threshold, expected row count,
  content digest, state, and timestamps.
- `snapshot_suggestions`: immutable `(snapshot, prefix, rank)` rows containing normalized phrase and integer score.
- `active_snapshot`: one row pointing to the completely published snapshot.

PostgreSQL is the initial durable authority. A pure builder produces a deterministic prefix artifact from frozen inputs. Serving
may load one immutable snapshot into memory later, but a cache cannot become the publication authority.

## Required invariants

1. **Stable event identity:** one idempotency key binds one normalized event intent and stored result. Exact replay is harmless;
   changed intent conflicts.
2. **Frozen watermark:** every snapshot includes exactly the accepted events at or below its recorded watermark and none above it.
3. **Deterministic normalization:** ingestion, build, and lookup share one versioned normalizer; byte-identical logical input has
   one identity, and unsupported or empty input fails closed.
4. **Eligibility before expansion:** a phrase must meet the aggregate threshold before any of its prefixes are emitted. Low-count
   raw events cannot leak through a prefix endpoint.
5. **Prefix correctness:** every returned phrase begins with the normalized request prefix by Unicode code point.
6. **Total ranking order:** candidates sort by integer score descending and normalized phrase ascending; input/event order cannot
   change snapshot content.
7. **Bounded result:** each prefix stores and returns at most the configured top `k`; no request can expand unbounded candidates.
8. **Atomic visibility:** an active pointer references only a complete, immutable snapshot whose stored row count and digest match
   the build receipt. Readers never combine two snapshot IDs.
9. **Crash convergence:** pre-publication failure leaves the old snapshot active; post-publication failure leaves the new one
   usable. Orphan building snapshots are identifiable and safe to remove.
10. **Evidence honesty:** `event_accepted`, `snapshot_published`, and `suggestion_response` are separate. None implies client
    render, selection, relevance, satisfaction, or a human outcome.
11. **Query minimization:** application logs contain build versions, counts, durations, bounded reason codes, and hashes—not raw
    event phrases, typed prefixes, idempotency keys, actors, or candidate lists.

## Minimal API and process boundary

Planned commands and routes, subject to source-informed ADR review:

- `POST /v1/events`: accept one idempotent synthetic completed-search event;
- `GET /v1/suggestions?q=<prefix>&limit=<n>`: return one active snapshot's bounded candidates;
- `build-once`: freeze a watermark and materialize one immutable candidate snapshot;
- `publish <build-id>` or an atomic build-finalization step: validate and switch the active pointer;
- `stats`: aggregate counts only;
- separate `serve`, `build-once`, `stats`, and migration paths where process death needs to be observable.

The first implementation choice is Node.js 22/24/26 and PostgreSQL 17.6. A trie, radix tree, Redis, Kafka, object store, CDN,
stream processor, or ML ranker will be added only if a current executable requirement cannot be met without it.

## Failure windows to execute

| Window | Durable evidence | Recovery rule |
|---|---|---|
| before event commit | no accepted event | retry the same idempotency key |
| after commit, before event response | one immutable event exists; client result is ambiguous | exact retry returns it |
| events arrive during build | their sequences may exceed the frozen watermark | include them only in a later build |
| builder dies while writing rows | old active pointer remains; building rows are unreachable | discard or retry the incomplete build |
| validation fails before publish | candidate snapshot remains inactive | fix/rebuild; never switch the pointer |
| builder dies after pointer switch | new immutable snapshot remains active | readers continue; cleanup is separate |
| two builders race | both may build, but publication uses an explicit expected active version or deterministic policy | one pointer transition wins; loser cannot silently overwrite |
| server reloads around publication | a request pins one active snapshot ID | next request may see the newer snapshot; one response never mixes |
| low-count or blocked phrase present | raw event remains outside eligible candidate rows | no prefix response exposes it |
| slow/large prefix request | input and result count are bounded before lookup | reject invalid input; do not scan arbitrary history |

## Acceptance evidence

1. Pure tests for Unicode-aware normalization, prefix generation, total ranking order, thresholding, top-k bounds, deterministic
   digest, and input-order independence.
2. Property tests over generated small corpora that every returned term matches its prefix, ranks are total, no ineligible phrase
   appears, and rerunning shuffled input yields identical artifacts.
3. Real PostgreSQL tests for ingestion retry/conflict, concurrent watermarks, immutable builds, expected-pointer publication race,
   snapshot-isolated reads, and orphan cleanup.
4. A true-process smoke that publishes baseline A, begins B, kills the builder before publication and proves A still serves, then
   retries/publishes B and proves one response contains only B.
5. A counterexample showing an event accepted after B's watermark does not appear in B even if build computation observes wall
   time later; it appears only in C.
6. Structured-log tests proving phrases, request prefixes, actor IDs, and idempotency keys are absent.
7. A bounded build/serve benchmark with corpus size, prefix count, runtime, and exclusions; no production QPS extrapolation.
8. Public CI on Node 22/24/26 with PostgreSQL 17.6, 0 skipped tests, pinned Actions, minimal permissions, lockfile, dependency
   audit, MIT license, clean default branch, exact commit, and run receipts.

## Questions reserved for source comparison

- What functional rules, traffic ratios, latency goals, and freshness expectations does the fixed chapter state, and which are
  dated assumptions rather than current facts?
- Does it model accepted search events, aggregate counts, built data, published snapshots, server responses, and selections as
  different evidence layers?
- Does its ranking use frequency only, time windows, personalization, language, safety, or editorial rules?
- What exact data structure is proposed, and does it define Unicode normalization, prefix cardinality, top-k maintenance, tie
  breaking, and immutable publication?
- How are concurrent updates, partial builds, cache invalidation, snapshot rollback, late events, deletion, and filtering handled?
- Which current primary sources are needed for Unicode normalization, PostgreSQL snapshot/locking semantics, HTTP caching, data
  privacy, and any chosen dependency?

## Stop line

The repository is complete only when one minimal ingestion-to-published-suggestion slice and its crash boundaries are public and
green. A component is not added because a diagram expects it. A successful server response is never upgraded into relevance,
selection, satisfaction, learning, or business-outcome evidence.
