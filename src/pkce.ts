import { createHash, randomBytes } from 'node:crypto';
import { MediloopError } from './errors.js';
import { FetchTransport, type Transport } from './transport.js';

export const ISSUER = 'https://auth.mediloop.co/realms/mediloop-healthcare';

function b64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What `start` returns. Keep the verifier and the state in the person's session. */
export interface PkceStart {
  verifier: string;
  challenge: string;
  state: string;
}

/** "Sign in with Mediloop" for an app people sign in to: authorization code with PKCE. */
export const Pkce = {
  start(): PkceStart {
    const verifier = b64url(randomBytes(48));
    return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(24)) };
  },

  authorizeUrl(clientId: string, redirectUri: string, challenge: string, state: string, scope = 'openid'): string {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${ISSUER}/protocol/openid-connect/auth?${query.toString()}`;
  },

  /**
   * Swap the code Mediloop sent back for the person's tokens. Check that the state you got back equals the one you kept.
   * Do this on your server: it sends your client secret.
   */
  async exchange(
    clientId: string, redirectUri: string, code: string, verifier: string, clientSecret?: string, transport: Transport = new FetchTransport(),
  ): Promise<Record<string, any>> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier,
    };
    if (clientSecret) form.client_secret = clientSecret;
    return tokenRequest(form, transport, 'Mediloop did not accept the sign-in code.');
  },

  /** Get a new access token with the refresh token. Do this on your server: it sends your client secret. */
  async refresh(clientId: string, refreshToken: string, clientSecret?: string, transport: Transport = new FetchTransport()): Promise<Record<string, any>> {
    const form: Record<string, string> = { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken };
    if (clientSecret) form.client_secret = clientSecret;
    return tokenRequest(form, transport, 'Mediloop did not accept the refresh token. The person may have stopped your app.');
  },
};

async function tokenRequest(form: Record<string, string>, transport: Transport, failure: string): Promise<Record<string, any>> {
  const response = await transport.send(
    'POST',
    `${ISSUER}/protocol/openid-connect/token`,
    { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    new URLSearchParams(form).toString(),
    30,
  );
  let data: any = null;
  try {
    data = JSON.parse(response.body);
  } catch {
    data = null;
  }
  if (response.status !== 200 || !data || !data.access_token) {
    throw new MediloopError(failure);
  }
  return data;
}
