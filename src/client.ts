import { randomUUID } from 'node:crypto';
import {
  ApiError, AuthenticationError, ConflictError, ConnectionError, MediloopError, NotFoundError, PermissionError,
  RateLimitError, ServerError, ValidationError,
} from './errors.js';
import { FetchTransport, type Transport, type TransportResponse } from './transport.js';

export const VERSION = '1.0.0';
export const DEFAULT_BASE_URL = 'https://api.mediloop.co';

export interface ClientOptions {
  /** Your live API key (`sk_live_...`). */
  apiKey: string;
  baseUrl?: string;
  /** Act for one facility (`X-Facility-ID`). */
  facilityId?: string;
  /** The person doing the work (`X-On-Behalf-Of`): a clinician, a cashier, an insurer's officer. */
  onBehalfOf?: string;
  /** Seconds. */
  timeout?: number;
  /** Retries after the first attempt, for a network failure, 429 and 502/503/504. */
  maxRetries?: number;
  transport?: Transport;
  /** Replace the pause between retries (seconds). Mostly for tests. */
  sleeper?: (seconds: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

interface TokenState {
  token: string | null;
  expiresAt: number;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * The Mediloop API client.
 *
 *     const mediloop = new Client({ apiKey: process.env.MEDILOOP_API_KEY! });
 *     const facility = mediloop.forFacility(facilityId).onBehalfOf(clinicianUhid);
 *     const found = await facility.post('/api/v1/uhid/integrations/identify/', { nin: 'CM...' });
 *
 * What it does for you, and nothing more:
 *  - exchanges your API key for a short-lived token, keeps it, and renews it before it ends;
 *  - sends X-Facility-ID and X-On-Behalf-Of when you scope the client;
 *  - gives every write an Idempotency-Key, and re-sends the SAME key on a retry, so a retry can never write twice;
 *  - retries a network failure, 429 and 502/503/504 with a pause, and never retries any other refusal;
 *  - turns a refusal into an error that carries Mediloop's reason code.
 * It has no dependencies.
 */
export class Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly facilityId: string | undefined;
  private readonly person: string | undefined;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly transport: Transport;
  private readonly sleeper: ((seconds: number) => Promise<void>) | undefined;
  /** Shared by the copies made with forFacility and onBehalfOf, so a renewal reaches all of them. */
  private readonly state: TokenState;

  constructor(options: ClientOptions, state?: TokenState) {
    if (!options.apiKey) {
      throw new MediloopError('An API key is required.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('https://') && !this.baseUrl.startsWith('http://localhost')) {
      throw new MediloopError('The base URL must be https.');
    }
    this.facilityId = options.facilityId;
    this.person = options.onBehalfOf;
    this.timeout = options.timeout ?? 30;
    this.maxRetries = options.maxRetries ?? 2;
    this.transport = options.transport ?? new FetchTransport();
    this.sleeper = options.sleeper;
    this.state = state ?? { token: null, expiresAt: 0 };
  }

  /** A copy that acts for one facility (X-Facility-ID). */
  forFacility(facilityId: string): Client {
    return this.copy({ facilityId });
  }

  /** A copy that names the person doing the work (X-On-Behalf-Of). */
  onBehalfOf(uhid: string): Client {
    return this.copy({ onBehalfOf: uhid });
  }

  get<T = any>(path: string, query: RequestOptions['query'] = {}): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T = any>(path: string, json: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, { json, idempotencyKey });
  }

  patch<T = any>(path: string, json: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.request<T>('PATCH', path, { json, idempotencyKey });
  }

  put<T = any>(path: string, json: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.request<T>('PUT', path, { json, idempotencyKey });
  }

  /** Every item of a paged list, following `next` until it ends. */
  async *paginate<T = any>(path: string, query: RequestOptions['query'] = {}): AsyncGenerator<T> {
    let page = await this.get<{ results?: T[]; next?: string | null }>(path, query);
    while (true) {
      for (const item of page.results ?? []) {
        yield item;
      }
      const next = page.next;
      if (typeof next !== 'string' || next === '') {
        return;
      }
      // Follow the link, but only to Mediloop: a link must never take your token elsewhere.
      if (!next.startsWith(this.baseUrl + '/')) {
        throw new MediloopError('A paging link pointed outside Mediloop and was not followed.');
      }
      page = await this.request('GET', next.slice(this.baseUrl.length));
    }
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    let url = this.baseUrl + '/' + path.replace(/^\/+/, '');
    const query = options.query ?? {};
    const pairs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
    if (pairs.length > 0) {
      const search = new URLSearchParams(pairs.map(([k, v]): [string, string] => [k, String(v)])).toString();
      url += (url.includes('?') ? '&' : '?') + search;
    }
    const body = options.json === undefined ? null : JSON.stringify(options.json);
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    // One key for the whole call, retries included: that is what makes a retry safe.
    const key = isWrite ? options.idempotencyKey ?? randomUUID() : null;
    let renewed = false;
    let attempt = 0;
    while (true) {
      const sent: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': `mediloop-typescript/${VERSION}`,
        Authorization: `Bearer ${await this.accessToken()}`,
        ...options.headers,
      };
      if (body !== null) sent['Content-Type'] = 'application/json';
      if (this.facilityId !== undefined) sent['X-Facility-ID'] = this.facilityId;
      if (this.person !== undefined) sent['X-On-Behalf-Of'] = this.person;
      if (key !== null) sent['Idempotency-Key'] = key;
      let response: TransportResponse;
      try {
        response = await this.transport.send(method, url, sent, body, this.timeout);
      } catch (error) {
        if (error instanceof ConnectionError && attempt < this.maxRetries) {
          await this.pause(attempt++, null);
          continue;
        }
        throw error;
      }
      if (response.status === 401 && !renewed) {
        // The token may have been revoked or expired early: get a new one once.
        renewed = true;
        this.state.token = null;
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        await this.pause(attempt++, response.headers['retry-after'] ?? null);
        continue;
      }
      return this.decode<T>(response);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.state.token !== null && Date.now() / 1000 < this.state.expiresAt - 30) {
      return this.state.token;
    }
    const body = JSON.stringify({ api_key: this.apiKey });
    let attempt = 0;
    let response: TransportResponse;
    while (true) {
      try {
        response = await this.transport.send(
          'POST',
          this.baseUrl + '/api/v1/auth/token/',
          { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `mediloop-typescript/${VERSION}` },
          body,
          this.timeout,
        );
      } catch (error) {
        if (error instanceof ConnectionError && attempt < this.maxRetries) {
          await this.pause(attempt++, null);
          continue;
        }
        throw error;
      }
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        await this.pause(attempt++, response.headers['retry-after'] ?? null);
        continue;
      }
      break;
    }
    const data = this.decode<{ access_token?: string; expires_in?: number }>(response);
    if (!data || typeof data !== 'object' || !data.access_token) {
      throw new MediloopError('Mediloop did not return a token.');
    }
    this.state.token = String(data.access_token);
    this.state.expiresAt = Date.now() / 1000 + Number(data.expires_in ?? 300);
    return this.state.token;
  }

  private decode<T>(response: TransportResponse): T {
    const raw = response.body;
    let data: any = null;
    if (raw !== '') {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    const status = response.status;
    if (status >= 200 && status < 300) {
      return data as T;
    }
    const code = data && typeof data === 'object' && typeof data.code === 'string' ? data.code : null;
    const message =
      data && typeof data === 'object' ? String(data.error ?? data.detail ?? data.message ?? 'Mediloop refused the request.') : 'Mediloop refused the request.';
    const retryAfter = response.headers['retry-after'] ?? null;
    const Cls =
      status === 401 ? AuthenticationError
      : status === 403 ? PermissionError
      : status === 404 ? NotFoundError
      : status === 409 ? ConflictError
      : status === 429 ? RateLimitError
      : status === 400 || status === 422 ? ValidationError
      : status >= 500 ? ServerError
      : ApiError;
    throw new Cls(status, code, message, data, retryAfter);
  }

  private async pause(attempt: number, retryAfter: string | null): Promise<void> {
    const numeric = retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(Number(retryAfter));
    const seconds = numeric ? Math.min(30, Number(retryAfter)) : Math.min(8, 0.5 * 2 ** attempt) + Math.random() * 0.25;
    if (this.sleeper) {
      await this.sleeper(seconds);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private copy(change: { facilityId?: string; onBehalfOf?: string }): Client {
    return new Client(
      {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        facilityId: change.facilityId ?? this.facilityId,
        onBehalfOf: change.onBehalfOf ?? this.person,
        timeout: this.timeout,
        maxRetries: this.maxRetries,
        transport: this.transport,
        sleeper: this.sleeper,
      },
      this.state,
    );
  }
}
