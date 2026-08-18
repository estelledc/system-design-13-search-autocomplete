# API and commands

## Authentication and errors

HTTP routes require `Authorization: Bearer <configured synthetic token>`. JSON responses always use
`Cache-Control: private, no-store`. Error bodies expose a stable code without request content:

```json
{"error":"invalid_request"}
```

Possible codes are `invalid_request`, `unauthorized`, `not_found`, `idempotency_conflict`, `publication_conflict`, and
`dependency_unavailable`.

## Accept a synthetic completed-search event

`POST /v1/events`

Headers: `Idempotency-Key` with 16–128 safe identifier characters.

```json
{"query":"example phrase"}
```

Response is 201 when created and 200 for an exact retry:

```json
{
  "created": true,
  "event": {
    "id": "11111111-1111-4111-8111-111111111111",
    "sequence": 1,
    "acceptedAtMs": 1700000000000
  },
  "evidence": "event_accepted"
}
```

The normalized query, request digest, and idempotency key are intentionally absent. Acceptance does not update active
suggestions until a later build is published.

## Read suggestions

`GET /v1/suggestions?q=<prefix>&limit=<1..5>`

Only one `q` and optional `limit` are accepted. A meaningful trailing space is preserved by normalization.

```json
{
  "snapshotId": "22222222-2222-4222-8222-222222222222",
  "watermark": 100,
  "contentDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "publicationVersion": 3,
  "policyVersion": 2,
  "suggestions": [
    {"term":"example phrase","score":9,"rank":1,"snapshotRank":2}
  ],
  "evidence": "suggestion_response"
}
```

`snapshotRank` is the immutable build order. `rank` is contiguous after current block filtering. The response is not evidence of
client rendering, selection, relevance, satisfaction, or a completed search.

## Operator commands

All commands require `DATABASE_URL`; they do not require HTTP bearer configuration.

```bash
node src/main.js migrate
node src/main.js stats
BUILD_KEY=snapshot-build-0001 MIN_COUNT=3 TOP_K=5 node src/main.js build-publish
BLOCK_TERM='synthetic phrase' node src/main.js block-term
```

`build-publish` emits a `snapshot_ready_receipt`, then atomically publishes and emits `snapshot_published_receipt`. The smoke-only
environment `CRASH_AFTER_BUILD_READY=1` sends `SIGKILL` after the ready receipt commits and before publication.

`block-term` is permanent in v0.1 and emits only change/version/evidence fields, never the term.

## Health

`GET /healthz` is unauthenticated. A 200 response proves one current PostgreSQL query only; it does not exercise event intake,
build, publication, filtering, or suggestion quality.
