import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  ApiError, AuthenticationError, Client, ConnectionError, MediloopError, NotFoundError, PermissionError, Pkce, RateLimitError,
  ValidationError, Webhook, type Transport, type TransportResponse,
} from '../src/index.js';

type Step = { status: number; headers?: Record<string, string>; body?: string } | ConnectionError;
type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

class Fake implements Transport {
  calls: Call[] = [];
  constructor(public script: Step[]) {}
  async send(method: string, url: string, headers: Record<string, string>, body: string | null): Promise<TransportResponse> {
    this.calls.push({ method, url, headers, body });
    const next = this.script.shift();
    if (next === undefined) throw new Error(`Unexpected call: ${method} ${url}`);
    if (next instanceof ConnectionError) throw next;
    return { status: next.status, headers: next.headers ?? {}, body: next.body ?? '' };
  }
}

const tok: Step = { status: 200, body: JSON.stringify({ access_token: 'tok1', expires_in: 600 }) };
const ok: Step = { status: 200, body: '{"results":[1]}' };
let slept: number[] = [];
const make = (t: Fake, extra: Record<string, unknown> = {}) =>
  new Client({ apiKey: 'sk_live_x', transport: t, sleeper: async (s) => void slept.push(s), ...extra });

test('the token is fetched once and reused', async () => {
  const t = new Fake([tok, ok, ok]);
  const c = make(t);
  await c.get('/api/v1/a/');
  await c.get('/api/v1/b/');
  assert.equal(t.calls.length, 3);
  assert.ok(t.calls[0]!.url.endsWith('/api/v1/auth/token/'));
  assert.equal(t.calls[1]!.headers.Authorization, 'Bearer tok1');
  assert.equal(t.calls[1]!.headers['Idempotency-Key'], undefined);
});

test('facility and person headers are sent, and a renewal reaches every copy', async () => {
  const t = new Fake([tok, ok, ok]);
  const base = make(t);
  await base.forFacility('F1').onBehalfOf('UG1').get('/api/v1/x/');
  assert.equal(t.calls[1]!.headers['X-Facility-ID'], 'F1');
  assert.equal(t.calls[1]!.headers['X-On-Behalf-Of'], 'UG1');
  await base.get('/api/v1/y/');
  assert.equal(t.calls.length, 3, 'the copy shared the token with the original');
});

test('a write has a key, and a retry re-sends the same key', async () => {
  const t = new Fake([tok, { status: 503 }, { status: 502 }, { status: 201, body: '{"id":"r1"}' }]);
  const r = await make(t).post('/api/v1/things/', { a: 1 });
  assert.deepEqual(r, { id: 'r1' });
  const keys = new Set(t.calls.slice(1).map((c) => c.headers['Idempotency-Key']));
  assert.equal(keys.size, 1);
  assert.ok([...keys][0]);
});

test('a given key is honoured', async () => {
  const t = new Fake([tok, { status: 201, body: '{}' }]);
  await make(t).post('/x/', {}, 'mine-1');
  assert.equal(t.calls[1]!.headers['Idempotency-Key'], 'mine-1');
});

test('a connection failure is retried, then raised', async () => {
  const t = new Fake([tok, new ConnectionError('down'), new ConnectionError('down'), new ConnectionError('down')]);
  await assert.rejects(make(t).get('/x/'), ConnectionError);
  assert.equal(t.calls.length, 4);
});

test('Retry-After is respected', async () => {
  slept = [];
  const t = new Fake([tok, { status: 429, headers: { 'retry-after': '3' } }, ok]);
  await make(t).get('/x/');
  assert.deepEqual(slept, [3]);
});

test('other refusals are not retried and carry the reason', async () => {
  let t = new Fake([tok, { status: 403, body: '{"error":"This route is not open to outside software.","code":"route_not_open"}' }]);
  await assert.rejects(make(t).get('/x/'), (e: unknown) => e instanceof PermissionError && e.errorCode === 'route_not_open' && e.status === 403);
  assert.equal(t.calls.length, 2);
  t = new Fake([tok, { status: 404, body: '{"detail":"No Claim matches the given query."}' }]);
  await assert.rejects(make(t).get('/x/'), NotFoundError);
  t = new Fake([tok, { status: 400, body: '{"message":"bad"}' }]);
  await assert.rejects(make(t).post('/x/', {}), ValidationError);
  assert.equal(t.calls.length, 2);
  t = new Fake([tok, { status: 429 }, { status: 429 }, { status: 429 }]);
  await assert.rejects(make(t).get('/x/'), RateLimitError);
});

test('a 401 renews the token once, and a second one is raised', async () => {
  let t = new Fake([tok, { status: 401, body: '{"error":"expired"}' }, { status: 200, body: JSON.stringify({ access_token: 'tok2', expires_in: 600 }) }, ok]);
  await make(t).get('/x/');
  assert.equal(t.calls[3]!.headers.Authorization, 'Bearer tok2');
  t = new Fake([tok, { status: 401 }, { status: 200, body: JSON.stringify({ access_token: 'tok2', expires_in: 600 }) }, { status: 401 }]);
  await assert.rejects(make(t).get('/x/'), AuthenticationError);
});

test('paginate follows next, and refuses a link that leaves Mediloop', async () => {
  let t = new Fake([
    tok,
    { status: 200, body: JSON.stringify({ results: [1, 2], next: 'https://api.mediloop.co/api/v1/p/?page=2' }) },
    { status: 200, body: JSON.stringify({ results: [3], next: null }) },
  ]);
  const seen: number[] = [];
  for await (const item of make(t).paginate<number>('/api/v1/p/')) seen.push(item);
  assert.deepEqual(seen, [1, 2, 3]);
  t = new Fake([tok, { status: 200, body: JSON.stringify({ results: [1], next: 'https://evil.example/steal' }) }]);
  await assert.rejects(async () => {
    for await (const _ of make(t).paginate('/api/v1/p/')) void _;
  }, MediloopError);
});

test('settings are checked', () => {
  assert.throws(() => new Client({ apiKey: 'k', baseUrl: 'http://api.mediloop.co' }), MediloopError);
  assert.throws(() => new Client({ apiKey: '' }), MediloopError);
});

const secret = 'whsec_test';
const body = '{"event":"payment.succeeded"}';
const now = 1763366400;
const sig = (b: string, ts: number, s: string) => `t=${ts},v1=${createHmac('sha256', s).update(`${ts}.${b}`).digest('hex')}`;

test('webhooks', () => {
  assert.doesNotThrow(() => Webhook.verify(body, sig(body, now, secret), secret, 300, now));
  assert.throws(() => Webhook.verify(body + ' ', sig(body, now, secret), secret, 300, now), MediloopError);
  assert.throws(() => Webhook.verify(body, sig(body, now, 'other'), secret, 300, now), MediloopError);
  assert.throws(() => Webhook.verify(body, sig(body, now - 1000, secret), secret, 300, now), MediloopError);
  const good = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
  assert.doesNotThrow(() => Webhook.verify(body, `t=${now},v1=bad,v1=${good}`, secret, 300, now));
  assert.throws(() => Webhook.verify(body, 'garbage', secret, 300, now), MediloopError);
  assert.throws(() => Webhook.verify(body, `t=${now},v1=${good.slice(0, 10)}`, secret, 300, now), MediloopError);
  assert.deepEqual(Webhook.event(body, sig(body, Math.floor(Date.now() / 1000), secret), secret), { event: 'payment.succeeded' });
});

test('PKCE', async () => {
  const p = Pkce.start();
  const expected = createHash('sha256').update(p.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(p.challenge, expected);
  const url = Pkce.authorizeUrl('ext-app', 'https://app.example/cb', p.challenge, p.state);
  assert.ok(url.includes('code_challenge_method=S256') && url.includes(`state=${p.state}`));
  const t = new Fake([{ status: 200, body: JSON.stringify({ access_token: 'a', refresh_token: 'r' }) }, { status: 200, body: JSON.stringify({ access_token: 'b' }) }, { status: 400, body: '{}' }]);
  const tokens = await Pkce.exchange('ext-app', 'https://app.example/cb', 'code1', p.verifier, 'secret1', t);
  assert.equal(tokens.access_token, 'a');
  assert.ok(t.calls[0]!.body!.includes('client_secret=secret1') && t.calls[0]!.body!.includes('code_verifier='));
  assert.equal((await Pkce.refresh('ext-app', 'r', 'secret1', t)).access_token, 'b');
  await assert.rejects(Pkce.refresh('ext-app', 'r', 'secret1', t), MediloopError);
});

test('a refusal is an ApiError', async () => {
  const t = new Fake([tok, { status: 418, body: '{}' }]);
  await assert.rejects(make(t).get('/x/'), ApiError);
});
