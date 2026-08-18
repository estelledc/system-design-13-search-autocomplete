import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { RequestConflictError } from '../../src/errors.js';
import { createHttpServer } from '../../src/http-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('event endpoint authenticates, returns no-store, and logs no query identity', async () => {
  const logs = [];
  let captured;
  const server = createHttpServer({
    service: {
      async acceptEvent(input) {
        captured = input;
        return {
          created: true,
          event: { id: 'opaque-event', sequence: 1, acceptedAtMs: 10 },
          evidence: 'event_accepted',
        };
      },
    },
    authTokens: new Set(['synthetic-secret-token']),
    logger: (record) => logs.push(record),
  });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'private phrase' }),
    });
    assert.equal(unauthorized.status, 401);
    const accepted = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-secret-token',
        'content-type': 'application/json',
        'idempotency-key': 'private-event-key-0001',
      },
      body: JSON.stringify({ query: 'private phrase' }),
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.headers.get('cache-control'), 'private, no-store');
    assert.equal(captured.idempotencyKey, 'private-event-key-0001');
    const encodedLogs = JSON.stringify(logs);
    for (const secret of ['synthetic-secret-token', 'private-event-key-0001', 'private phrase', 'opaque-event']) {
      assert.ok(!encodedLogs.includes(secret));
    }
  } finally {
    await close(server);
  }
});

test('suggestion endpoint requires an exact bounded query and labels the response', async () => {
  let captured;
  const server = createHttpServer({
    service: {
      async suggest(input) {
        captured = input;
        return {
          snapshotId: 'snapshot-public',
          publicationVersion: 2,
          policyVersion: 1,
          suggestions: [{ term: 'apple', score: 4, rank: 1 }],
          evidence: 'suggestion_response',
        };
      },
    },
    authTokens: new Set(['synthetic-secret-token']),
  });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/v1/suggestions?q=ap&limit=3`, {
      headers: { authorization: 'Bearer synthetic-secret-token' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).evidence, 'suggestion_response');
    assert.deepEqual(captured, { prefix: 'ap', limit: '3' });
    const duplicate = await fetch(`${baseUrl}/v1/suggestions?q=a&q=b`, {
      headers: { authorization: 'Bearer synthetic-secret-token' },
    });
    assert.equal(duplicate.status, 400);
    const unknown = await fetch(`${baseUrl}/v1/suggestions?q=a&extra=1`, {
      headers: { authorization: 'Bearer synthetic-secret-token' },
    });
    assert.equal(unknown.status, 400);
  } finally {
    await close(server);
  }
});

test('expected conflicts map to stable error codes without messages', async () => {
  const server = createHttpServer({
    service: { async acceptEvent() { throw new RequestConflictError('sensitive detail'); } },
    authTokens: new Set(['synthetic-secret-token']),
  });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-secret-token',
        'content-type': 'application/json',
        'idempotency-key': 'private-event-key-0001',
      },
      body: JSON.stringify({ query: 'private phrase' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'idempotency_conflict' });
  } finally {
    await close(server);
  }
});
