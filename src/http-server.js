import { createServer } from 'node:http';
import { AppError, AuthenticationError, ValidationError } from './errors.js';

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ValidationError('content-type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > maximumBytes) {
    throw new ValidationError('request body is too large');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new ValidationError('request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function authenticate(request, authTokens) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new AuthenticationError();
  if (!authTokens.has(authorization.slice('Bearer '.length))) throw new AuthenticationError();
}

function suggestionQuery(url) {
  const allowed = new Set(['q', 'limit']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError('suggestion query parameters are invalid');
    }
  }
  if (!url.searchParams.has('q')) throw new ValidationError('q is required');
  return { prefix: url.searchParams.get('q'), limit: url.searchParams.get('limit') ?? undefined };
}

export function createHttpServer({
  service,
  authTokens,
  health = async () => true,
  logger = () => {},
  maximumBodyBytes = 1_024,
}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && request.url === '/healthz') {
        await health();
        json(response, 200, { ok: true });
        return;
      }
      authenticate(request, authTokens);
      if (request.method === 'POST' && url.pathname === '/v1/events' && url.search === '') {
        const result = await service.acceptEvent({
          idempotencyKey: request.headers['idempotency-key'],
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'event_intake', created: result.created, sequence: result.event.sequence, evidence: result.evidence });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/suggestions') {
        const result = await service.suggest(suggestionQuery(url));
        logger({
          kind: 'suggestion_response',
          count: result.suggestions.length,
          publicationVersion: result.publicationVersion,
          policyVersion: result.policyVersion,
          evidence: result.evidence,
        });
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('Internal error');
      logger({ kind: 'request_failed', code: safe.code, status: safe.status });
      json(response, safe.status, { error: safe.code });
    }
  });
}
