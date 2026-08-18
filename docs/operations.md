# Operations

## Runtime matrix

- Node.js 22, 24, or 26; `.node-version` selects 22 locally.
- PostgreSQL 17.6 in Compose and CI.
- One API process plus on-demand trusted builder/block commands.

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/search_autocomplete
export AUTH_TOKENS_JSON='["replace-with-at-least-16-characters"]'
```

## Commands and destructive boundaries

| Command | Behavior |
|---|---|
| `node src/main.js migrate` | idempotently create v0.1 schema/indexes |
| `node src/main.js serve` | authenticated event/suggestion API and health |
| `node src/main.js stats` | aggregate counts and versions only |
| `BUILD_KEY=... node src/main.js build-publish` | freeze/reuse, materialize/reuse, and CAS-publish one snapshot |
| `BLOCK_TERM=... node src/main.js block-term` | permanently suppress one normalized phrase |
| `npm run check` | static policy, pure tests, dependency audit |
| `npm run test:postgres` | real database tests; resets configured `public` schema |
| `npm run smoke:postgres` | process-death flow; resets configured `public` schema |
| `npm run benchmark:postgres` | isolated raw timings; resets configured `public` schema |
| `npm run check:ci` | full gate above in sequence |

Database integration, smoke, and benchmark commands are destructive. Point them only at a disposable database.

## Environment

| Variable | Required/default | Boundary |
|---|---|---|
| `DATABASE_URL` | required | never print or commit it |
| `AUTH_TOKENS_JSON` | required for `serve` | JSON array of 16–256 character synthetic bearer values |
| `HOST` | `127.0.0.1` | API bind address |
| `PORT` | `3000` | 0 allowed for assigned test port |
| `BUILD_KEY` | required for build | 16–128 safe identifier characters; do not reuse across different intent |
| `MIN_COUNT` | `3` | 2–1,000,000; not a privacy guarantee |
| `TOP_K` | `5` | 1–5 |
| `BLOCK_TERM` | required for block command | treated as sensitive; omitted from output/logs |
| `CRASH_AFTER_BUILD_READY` | unset | smoke-only `1` sends `SIGKILL` before publication |

## Release flow

1. Run migrations in a controlled step.
2. Keep the current published snapshot active while events enter.
3. Use a new build key and inspect the ready receipt: watermark, counts, digest, normalizer, threshold, and top-k.
4. Publication is part of `build-publish`; a predecessor conflict fails rather than overwrites a newer release.
5. Execute synthetic prefix checks against the returned snapshot/publication/policy versions.
6. Retain the prior snapshot until rollback/retention policy is defined. v0.1 has no rollback command or automatic cleanup.

## Failure playbook

### Event response is ambiguous

Retry identical input with the same idempotency key. 200 returns the committed event; 409 means the key was reused for changed
intent. Never invent a new key merely because the response was lost unless a duplicate count is acceptable.

### Builder dies

- Before ready commit: snapshot remains `building`; rerun the same build key to recompute.
- After ready but before publication: old active remains; rerun the same key to reuse the immutable artifact and publish.
- After publication: exact replay succeeds only while that snapshot remains active; an older/superseded publication conflicts.

### Stale publisher conflict

Do not force the pointer. Inspect which predecessor the failed build froze, which snapshot is active now, and whether its event /
policy cutoffs remain acceptable. Create a new build against the current active snapshot when recomputation is intended.

### Emergency term block

Run the block command and verify the returned policy version. New origin reads suppress the phrase immediately, possibly leaving
fewer than five results. This does not purge past responses, browsers, external caches, logs, exports, replicas, or backups.

### PostgreSQL unavailable

Event/query routes return 503 and build commands fail. There is no in-memory acceptance or stale-cache fallback. Database
restore/failover is outside the tested system.

## Monitoring candidates

- ledger-lock wait time and event acceptance latency;
- latest committed watermark minus active snapshot watermark;
- counts/age of `building` and `ready` snapshots;
- publication conflict/error count;
- active snapshot row count, digest mismatch, and missing pointer;
- block-policy version and filtered-result count;
- suggestion latency and empty-response rate by hashed/bucketed metadata only, never raw prefix.

No production metrics exporter or alert delivery is implemented.
