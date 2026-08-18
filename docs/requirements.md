# Requirements and invariants

## Product slice

One authenticated synthetic analytics source can submit completed-search events. One authenticated client can ask for up to five
popular phrases beginning with a normalized prefix. An operator can build/publish snapshots and permanently block a phrase.

The project uses synthetic lowercase-English phrases after explicit compatibility normalization. It is not document search,
personal history, personalization, trending, spell correction, fuzzy/semantic retrieval, or a production safety/privacy system.

## Scenario inputs

The fixed chapter states 10 million daily active users, 48,000 peak query requests/second, 0.4 GB/day of new query data, top 5,
and <100 ms response time. It does not provide enough arithmetic or workload definition to verify those values.

The closed-book exercise independently assumed 50 million daily active users, 4 billion autocomplete requests/day, and about
462,963/second at a declared 10x peak. Both sets are design prompts only. The repository measures a small single-database fixture
and makes no production capacity prediction.

## Normalization contract

`ascii-nfkc-lower-space-v1` performs, in order:

1. require a JavaScript string;
2. apply Unicode NFKC compatibility normalization;
3. lowercase;
4. collapse whitespace to one ASCII space;
5. trim phrase boundaries; for lookup prefixes, preserve one meaningful trailing space;
6. require only ASCII `a-z` words separated by one space;
7. require at most 64 UTF-8 bytes.

Fullwidth Latin compatibility forms can converge to ASCII. Other scripts, accents, punctuation, emoji, malformed, empty, and
oversized input fail closed. Widening this rule requires a new normalizer version and snapshot migration.

## Functional rules

1. An event idempotency key binds one normalized phrase digest. Exact replay returns the original sequence; changed intent
   conflicts.
2. New event transactions serialize on one ledger row. The assigned sequence and event insert commit together, creating a
   contiguous committed prefix `1..watermark`.
3. Creating a build freezes the current event watermark, block-policy version, normalizer, minimum count, top-k, and expected
   active snapshot. Exact build-key replay returns that same identity and cutoff.
4. Materialization counts only events through the frozen watermark. A phrase below `minCount` or blocked at the frozen policy
   version emits no prefix row.
5. Every emitted row's phrase starts with its prefix. Candidates order by count descending then normalized phrase ascending.
   Each prefix contains at most five rows.
6. Candidate rows and their count/prefix-count/eligible-term-count/content-digest receipt commit atomically when state becomes
   `ready`. Ready rows are not queryable.
7. Publication locks one pointer and succeeds only if its current value equals the build's expected predecessor. Pointer and
   `published` state commit together.
8. One suggestion statement pins one published snapshot ID and current block-policy version. A block committed before that
   statement excludes the term immediately; the response can contain fewer than five rows.
9. Event acceptance, snapshot readiness, publication, server response, client rendering, selection, search execution, relevance,
   satisfaction, and business outcome are separate facts.

## Evidence vocabulary

| Label | What it proves | What it does not prove |
|---|---|---|
| `event_accepted` | immutable event and commit-ordered sequence exist | eligibility, publication, or serving |
| `snapshot_ready` | all candidate rows and content digest committed for one frozen input | active visibility |
| `snapshot_published` | active pointer transaction committed | cache/client observation or quality |
| `block_policy_committed` | this origin's later reads will apply a permanent suppression | erasure from old exports, browsers, logs, or backups |
| `suggestion_response` | server returned candidates from one snapshot/policy observation | rendering, selection, relevance, satisfaction, or human outcome |

## Explicit limits

- `minCount`: 2–1,000,000; it is a toy eligibility boundary, not k-anonymity or differential privacy.
- `topK` and request limit: 1–5.
- HTTP JSON body: 1 KiB.
- One active snapshot and one permanent block namespace.
- No unblock, snapshot rollback command, retention scheduler, or automatic builder lease.
- One global event-ledger row and one PostgreSQL database; the throughput ceiling is expected and measured.
