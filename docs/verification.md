# Verification

## Current receipt

The implementation is complete locally at the pure-test layer. Real PostgreSQL 17.6 execution and public CI receipts are pending
the first implementation push; this file will bind exact commit/run identifiers after that gate executes.

| Gate | Current result | Evidence boundary |
|---|---|---|
| repository/syntax | ready; not yet public | artifact presence, parsing, links, pins, portable paths |
| pure tests | 10 passing, 0 skipped on development runtime | normalization, ranking, generated properties, service/HTTP/log contracts |
| generated corpora | 120 deterministic trials | shuffled aggregate order preserves rows/digest and prefix/rank/top-k invariants |
| dependency audit | 0 known high-severity findings at install time | current npm advisory result, not full supply-chain assurance |
| PostgreSQL integration | pending public PostgreSQL 17.6 run | commit-order ledger, cutoffs, ready visibility, CAS publication, filtering |
| process smoke | pending public PostgreSQL 17.6 run | ready-before-publish crash, exact retry, late event, block policy |
| bounded benchmark | pending public PostgreSQL 17.6 run | raw small-fixture timing only |

## Full gate

```bash
npm ci --ignore-scripts
npm run check:ci
```

The full gate runs static policy, pure/generated tests, high-severity audit, real database integration, true-process smoke, and a
bounded benchmark on a disposable schema.

## Executable counterexamples

- PostgreSQL `nextval` is not used as a committed cutoff; a locked ledger establishes the tested prefix instead.
- An event accepted after B freezes its watermark remains absent from B even when B materializes later; it enters C.
- A ready B followed by builder `SIGKILL` leaves published A serving.
- Retrying B by build key reuses B's watermark/artifact rather than absorbing late events.
- Two ready builds that expect A cannot both publish: the second pointer compare conflicts after the first wins.
- A permanent block suppresses a term immediately from an old active snapshot and before expansion in a new snapshot.
- Shuffling the same aggregate corpus does not change candidate rows or digest.

## What green does not prove

- <100 ms at 48,000 QPS, the closed-book scenario rates, or production capacity;
- multi-host availability, database failover, backup restore, cache invalidation, stream processing, or balanced sharding;
- multilingual normalization/casing/collation, fuzzy/semantic relevance, personalization, or trending freshness;
- content-safety completeness, poisoning resistance, privacy protection, lawful processing, or deletion from external copies;
- client rendering, accessibility announcement, suggestion selection, completed search, relevance, satisfaction, or business
  impact.

The smoke will report both `renderedClaims: 0` and `selectedClaims: 0` deliberately.
