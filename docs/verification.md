# Verification

## Current receipt

The corrected implementation gate passed at commit `846227850dceba04092d7a730513f75891cad858` in GitHub Actions run
[`32171098277`](https://github.com/estelledc/system-design-13-search-autocomplete/actions/runs/32171098277). All Node 22.23.2,
24.19.0, and 26.7.0 jobs used PostgreSQL 17.6 and completed the same full gate.

| Gate | Current result | What it proves |
|---|---|---|
| repository/syntax | 38 files checked in every matrix job | parsing, required artifacts, links, action pins, and portable paths |
| pure tests | 10/10 passing per job, 0 skipped | normalization, ranking, generated properties, service/HTTP/log contracts |
| generated corpora | 120 deterministic trials per job | shuffled aggregate order preserves rows/digest and prefix/rank/top-k invariants |
| dependency audit | 0 known high-severity findings in every job | current npm advisory result, not full supply-chain assurance |
| PostgreSQL integration | 6/6 passing per job, 0 skipped | commit-order ledger, cutoffs, ready visibility, CAS publication, filtering |
| process smoke | passed per job with the same semantic receipt | ready-before-publish crash, exact retry, late event, block policy |
| bounded benchmark | completed per job; raw values below | timing for one small synthetic fixture, not production capacity |

The smoke receipt in all three jobs reported:

```json
{"builderCrashSignal":"SIGKILL","baselinePublicationVersion":1,"oldSnapshotRetainedAfterReadyCrash":true,"retryCreated":false,"retryMaterialized":false,"betaWatermark":8,"lateTermExcludedFromBeta":true,"gammaWatermark":11,"blockPolicyVersion":1,"renderedClaims":0,"selectedClaims":0}
```

Shared-runner benchmark inputs were 320 accepted events across 80 terms, one snapshot containing 115 rows across 85 prefixes,
and 1,000 bounded suggestion lookups:

| Node | event acceptance/s | build ms | suggestion lookups/s |
|---|---:|---:|---:|
| 22.23.2 | 492.433 | 18.730 | 47.092 |
| 24.19.0 | 523.601 | 18.655 | 48.753 |
| 26.7.0 | 180.625 | 11.688 | 88.719 |

These are single observations from separate GitHub-hosted runners and PostgreSQL service containers. They are neither stable
Node-version comparisons nor production-capacity promises.

## Retained red-to-green evidence

The first implementation run
[`32170756550`](https://github.com/estelledc/system-design-13-search-autocomplete/actions/runs/32170756550) at
`4adb403d686d1b07b50e06955e58dd621bd5c231` is intentionally retained. Static policy, 10 pure tests, the audit, and all 6 real
PostgreSQL integration tests passed in every job. The process smoke then failed because it queried prefix `ap` while expecting
`avocado`, which can only match prefix `a`.

Commit `846227850dceba04092d7a730513f75891cad858` corrected the smoke query to `a`. It also serialized queries issued through one
transaction client, removing the `node-postgres` deprecation warning without weakening any assertion. The next matrix run was
green across all three runtimes.

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
