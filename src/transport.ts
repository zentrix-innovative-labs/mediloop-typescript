import { ConnectionError } from './errors.js';

export interface TransportResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

/** Sends one HTTP request. Swap it for your own (a proxy-aware client, or a fake in tests). */
export interface Transport {
  send(method: string, url: string, headers: Record<string, string>, body: string | null, timeoutSeconds: number): Promise<TransportResponse>;
}

/** The default transport: the platform `fetch`. It never follows a redirect, so a token cannot travel to another address. */
export class FetchTransport implements Transport {
  async send(method: string, url: string, headers: Record<string, string>, body: string | null, timeoutSeconds: number): Promise<TransportResponse> {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.round(timeoutSeconds * 1000))),
      });
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name.toLowerCase()] = value;
      });
      return { status: response.status, headers: out, body: await response.text() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(`Mediloop could not be reached: ${reason}`);
    }
  }
}
