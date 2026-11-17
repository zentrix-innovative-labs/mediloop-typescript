import { createHmac, timingSafeEqual } from 'node:crypto';
import { MediloopError } from './errors.js';

/** Checks that a webhook really came from Mediloop and was not changed or replayed. */
export const Webhook = {
  /**
   * @param rawBody the body exactly as received. Do not parse and re-serialise it first.
   * @param signatureHeader the X-MediLoop-Signature header, `t=<seconds>,v1=<hex>`
   * @param toleranceSeconds how old a delivery may be
   * @throws MediloopError when the delivery is not authentic
   */
  verify(rawBody: string | Buffer, signatureHeader: string, secret: string, toleranceSeconds = 300, now: number = Math.floor(Date.now() / 1000)): void {
    let timestamp: string | null = null;
    const signatures: string[] = [];
    for (const part of String(signatureHeader ?? '').split(',')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (name === 't') timestamp = value;
      else if (name === 'v1') signatures.push(value);
    }
    if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) {
      throw new MediloopError('The webhook signature header is not valid.');
    }
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
    let matched = false;
    for (const candidate of signatures) {
      // Compare every candidate in constant time, and do not stop at the first.
      const given = /^[0-9a-fA-F]+$/.test(candidate) && candidate.length === expected.length * 2 ? Buffer.from(candidate, 'hex') : null;
      const same = given !== null && timingSafeEqual(expected, given);
      matched = same || matched;
    }
    if (!matched) {
      throw new MediloopError('The webhook signature does not match.');
    }
    if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
      throw new MediloopError('The webhook is too old. It may be a replay.');
    }
  },

  /** The decoded event, after it has been verified. */
  event(rawBody: string | Buffer, signatureHeader: string, secret: string, toleranceSeconds = 300): Record<string, unknown> {
    Webhook.verify(rawBody, signatureHeader, secret, toleranceSeconds);
    let data: unknown;
    try {
      data = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
    } catch {
      throw new MediloopError('The webhook body is not JSON.');
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new MediloopError('The webhook body is not JSON.');
    }
    return data as Record<string, unknown>;
  },
};
