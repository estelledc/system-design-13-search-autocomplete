# Threat model

## Protected assets

- reusable HTTP bearer values;
- raw accepted phrases, typed prefixes, idempotency keys, and event identities;
- block-policy terms and timing;
- snapshot completeness, digest, predecessor, and active pointer;
- evidence labels that must not be upgraded into client or human outcomes.

Only synthetic data is permitted. Real autocomplete logs can reveal sensitive intent; this repository is not a privacy-safe
analytics pipeline.

## Trust boundaries

1. HTTP callers are untrusted until a configured bearer is present.
2. Event/query bodies and URL parameters are untrusted even after authentication.
3. Local operator commands are trusted to possess database access and environment configuration.
4. PostgreSQL is the durable authority. A process log, in-memory artifact, or command exit alone is not publication evidence.
5. Suggestion clients and users are outside observability. A response cannot prove display, accessibility announcement,
   selection, relevance, satisfaction, or identity of the actor.

## Threats and controls

| Threat | Current control | Residual risk |
|---|---|---|
| bearer disclosure | header-only bearer, no request-header logging | environment/proxy/client storage is outside repository control |
| query/prefix logs | structured event kinds, counts, versions, states, digests only | PostgreSQL, proxy, browser history, and platform logs need separate controls |
| response caching | `Cache-Control: private, no-store` | directives are not erasure or protection from malicious/noncompliant storage |
| oversized/ambiguous input | exact JSON/query fields, 1 KiB body, 64-byte phrase, top-5 bound | no request-rate or connection limit exists |
| compatibility aliases | named NFKC/lower/space normalizer before identity/digest | multilingual casing/collation and confusables are unsupported |
| event replay/change | idempotency uniqueness plus immutable request digest | callers must persist keys correctly |
| incomplete watermark | locked transactional ledger, not `bigserial max` | global lock is a denial-of-service and throughput bottleneck |
| partial build visibility | candidate rows and ready receipt commit together; only active published snapshot serves | transaction/memory size is bounded only by the experiment corpus |
| stale builder overwrite | expected-predecessor compare-and-swap | no automated operator reconciliation/rollback exists |
| harmful term remains visible | current permanent block check in every read | previous responses/exports/caches/backups cannot be recalled |
| low-frequency exposure | configurable minimum count before prefix expansion | threshold is not k-anonymity, differential privacy, or anti-inference protection |
| SQL injection | parameterized values and fixed schema identifiers | database/operator privilege remains broad |
| dependency/action compromise | exact lockfile, disabled install scripts in CI, audit, commit-pinned Actions | audit is not complete supply-chain assurance |

## Fail-closed behavior

- Unsupported characters, fields, duplicate query parameters, sizes, thresholds, and limits return 400.
- Missing/unknown bearer returns 401.
- A changed event/build intent under an existing key returns 409.
- A building/ready snapshot is absent from query service; no active snapshot returns 404.
- A stale publisher returns 409 and does not move the pointer.
- Database errors become 503; no in-memory event or snapshot becomes authoritative.
- Current block policy can only suppress in v0.1; there is no accidental unblock route.

## Not implemented

- TLS/proxy hardening, credential storage/rotation, rate limiting, WAF, tenant roles, operator approval, audit retention;
- differential privacy, privacy budgets, deletion requests, consent, retention limits, encrypted backups, data residency;
- robust content classification, moderation review, legal removal, spam/poisoning/Sybil resistance, editorial controls;
- cache purge, object-snapshot signing, database failover/restore, region isolation, production monitoring or incident response.

Do not deploy this learning slice or feed it real query data.
