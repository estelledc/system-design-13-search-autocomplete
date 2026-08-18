import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { Pool } from 'pg';
import { PostgresAutocompleteStore } from '../src/postgres-store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test');

const token = 'autocomplete-smoke-token-0001';
const phrases = ['apple', 'application', 'apricot', 'avocado'];
const buildKeys = ['smoke-snapshot-alpha-0001', 'smoke-snapshot-beta-0001', 'smoke-snapshot-gamma-0001'];
const sensitiveValues = [token, ...phrases, ...buildKeys, 'smoke-event-key'];

function startProcess(command, extraEnvironment = {}) {
  const child = spawn(process.execPath, ['src/main.js', command], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AUTH_TOKENS_JSON: JSON.stringify([token]),
      HOST: '127.0.0.1',
      PORT: '0',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const records = [];
  let stdoutBuffer = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line);
      records.push(record);
      events.emit('record', record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, stderr });
    });
  });
  return { child, events, exit, records, hasExited: () => exited };
}

async function waitForRecord(processHandle, kind, timeoutMs = 5_000) {
  const existing = processHandle.records.find((record) => record.kind === kind);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const onRecord = (record) => {
      if (record.kind !== kind) return;
      cleanup();
      resolve(record);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.events.removeListener('record', onRecord);
    };
    processHandle.events.on('record', onRecord);
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.hasExited()) return processHandle?.exit;
  processHandle.child.kill('SIGTERM');
  const result = await processHandle.exit;
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function runCommand(command, environment = {}) {
  const processHandle = startProcess(command, environment);
  const result = await processHandle.exit;
  return { processHandle, result };
}

async function request(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let eventNumber = 0;
async function ingest(baseUrl, phrase, count) {
  for (let index = 0; index < count; index += 1) {
    eventNumber += 1;
    const response = await request(baseUrl, '/v1/events', {
      method: 'POST',
      headers: { 'idempotency-key': `smoke-event-key-${String(eventNumber).padStart(6, '0')}` },
      body: { query: phrase },
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).evidence, 'event_accepted');
  }
}

async function suggestions(baseUrl) {
  const response = await request(baseUrl, '/v1/suggestions?q=a&limit=5');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return response.json();
}

const setupPool = new Pool({ connectionString: process.env.DATABASE_URL });
await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
await new PostgresAutocompleteStore(setupPool).migrate();
await setupPool.end();

const processes = [];
try {
  const api = startProcess('serve');
  processes.push(api);
  const ready = await waitForRecord(api, 'api_listening');
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  await ingest(baseUrl, 'apple', 3);
  await ingest(baseUrl, 'application', 2);
  const baselineCommand = await runCommand('build-publish', {
    BUILD_KEY: buildKeys[0],
    MIN_COUNT: '2',
    TOP_K: '5',
  });
  processes.push(baselineCommand.processHandle);
  assert.equal(baselineCommand.result.code, 0, baselineCommand.result.stderr);
  const baselinePublish = baselineCommand.processHandle.records.find((record) => record.kind === 'snapshot_published_receipt');
  assert.equal(baselinePublish.publicationVersion, 1);
  const baseline = await suggestions(baseUrl);
  assert.deepEqual(baseline.suggestions.map((candidate) => candidate.term), ['apple', 'application']);

  await ingest(baseUrl, 'apricot', 3);
  const crashingBuild = startProcess('build-publish', {
    BUILD_KEY: buildKeys[1],
    MIN_COUNT: '2',
    TOP_K: '5',
    CRASH_AFTER_BUILD_READY: '1',
  });
  processes.push(crashingBuild);
  const betaReady = await waitForRecord(crashingBuild, 'snapshot_ready_receipt');
  const crashed = await crashingBuild.exit;
  assert.equal(crashed.signal, 'SIGKILL');
  assert.equal(betaReady.watermark, 8);
  const duringCrash = await suggestions(baseUrl);
  assert.equal(duringCrash.snapshotId, baseline.snapshotId);
  assert.deepEqual(duringCrash.suggestions.map((candidate) => candidate.term), ['apple', 'application']);

  await ingest(baseUrl, 'avocado', 3);
  const betaRetry = await runCommand('build-publish', {
    BUILD_KEY: buildKeys[1],
    MIN_COUNT: '2',
    TOP_K: '5',
  });
  processes.push(betaRetry.processHandle);
  assert.equal(betaRetry.result.code, 0, betaRetry.result.stderr);
  const betaReadyReplay = betaRetry.processHandle.records.find((record) => record.kind === 'snapshot_ready_receipt');
  const betaPublished = betaRetry.processHandle.records.find((record) => record.kind === 'snapshot_published_receipt');
  assert.equal(betaReadyReplay.created, false);
  assert.equal(betaReadyReplay.changed, false);
  assert.equal(betaPublished.publicationVersion, 2);
  const beta = await suggestions(baseUrl);
  assert.equal(beta.watermark, 8);
  assert.deepEqual(beta.suggestions.map((candidate) => candidate.term), ['apple', 'apricot', 'application']);
  assert.ok(!beta.suggestions.some((candidate) => candidate.term === 'avocado'));

  const gammaCommand = await runCommand('build-publish', {
    BUILD_KEY: buildKeys[2],
    MIN_COUNT: '2',
    TOP_K: '5',
  });
  processes.push(gammaCommand.processHandle);
  assert.equal(gammaCommand.result.code, 0, gammaCommand.result.stderr);
  const gamma = await suggestions(baseUrl);
  assert.equal(gamma.publicationVersion, 3);
  assert.equal(gamma.watermark, 11);
  assert.deepEqual(
    gamma.suggestions.map((candidate) => candidate.term),
    ['apple', 'apricot', 'avocado', 'application'],
  );

  const blockCommand = await runCommand('block-term', { BLOCK_TERM: 'apple' });
  processes.push(blockCommand.processHandle);
  assert.equal(blockCommand.result.code, 0, blockCommand.result.stderr);
  const filtered = await suggestions(baseUrl);
  assert.deepEqual(
    filtered.suggestions.map((candidate) => candidate.term),
    ['apricot', 'avocado', 'application'],
  );
  assert.deepEqual(filtered.suggestions.map((candidate) => candidate.rank), [1, 2, 3]);
  assert.equal(filtered.policyVersion, 1);

  const allLogs = JSON.stringify(processes.flatMap((processHandle) => processHandle.records));
  for (const secret of sensitiveValues) assert.ok(!allLogs.includes(secret), `structured log leaked: ${secret}`);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_autocomplete_smoke_receipt',
    builderCrashSignal: crashed.signal,
    baselinePublicationVersion: baseline.publicationVersion,
    oldSnapshotRetainedAfterReadyCrash: duringCrash.snapshotId === baseline.snapshotId,
    retryCreated: betaReadyReplay.created,
    retryMaterialized: betaReadyReplay.changed,
    betaWatermark: beta.watermark,
    lateTermExcludedFromBeta: !beta.suggestions.some((candidate) => candidate.term === 'avocado'),
    gammaWatermark: gamma.watermark,
    blockPolicyVersion: filtered.policyVersion,
    renderedClaims: 0,
    selectedClaims: 0,
  })}\n`);
} finally {
  for (const processHandle of [...processes].reverse()) await stopProcess(processHandle);
}
