# Mediloop for TypeScript and JavaScript

A small client for the Mediloop API. No runtime dependencies: it uses the `fetch` and `crypto` that Node.js already has.

## Use a supported Node.js

This library needs Node.js 22 or later. Run a release that still gets security fixes, keep it patched, and restart your
processes after updating. A webhook endpoint is a public door into your server, so it is the last place to run an old runtime.

## Install

    npm install @zentrixlabs/mediloop

## Use

```ts
import { Client } from '@zentrixlabs/mediloop';

const mediloop = new Client({ apiKey: process.env.MEDILOOP_API_KEY! });

// Act for one facility, in the name of the person doing the work.
const facility = mediloop.forFacility(facilityId).onBehalfOf(clinicianUhid);

const cover = await facility.post('/api/v1/coverage/verify/', {
  patient_uhid: 'UG123456789A',
  benefit_category: 'consultation',
  amount: 50000,
});

for await (const bill of facility.paginate('/api/v1/healthcare-billing/bills/', { open: true })) {
  // ...
}
```

What the client does for you:

- Exchanges your API key for a short-lived token, keeps it, and renews it before it ends (and once more if Mediloop refuses it).
- Sends `X-Facility-ID` and `X-On-Behalf-Of` when you scope the client.
- Gives every write an `Idempotency-Key` and re-sends the same key when it retries, so a retry never writes twice.
  Pass your own key as the last argument to tie a write to a record in your system.
- Retries a network failure, `429` (waiting as long as `Retry-After` says) and `502`, `503`, `504`. It never retries any other refusal.
- Throws `PermissionError`, `NotFoundError`, `ValidationError`, `ConflictError`, `RateLimitError` and the like,
  each carrying Mediloop's reason in `error.errorCode` (for example `route_not_open`).
- Follows paging links only when they point at Mediloop.
- Refuses a base URL that is not https, and never follows a redirect, so a token cannot be sent to another address.

## Webhooks

Pass the body exactly as received, before you parse it. With Express, use `express.raw({ type: 'application/json' })` on that route.

```ts
import { Webhook } from '@zentrixlabs/mediloop';

const event = Webhook.event(req.body, req.header('x-mediloop-signature')!, signingSecret);
```

It checks the signature in constant time and refuses a delivery older than five minutes.

## Sign in with Mediloop

For an app people sign in to. Do the code exchange on your server: it sends your client secret.

```ts
import { Pkce } from '@zentrixlabs/mediloop';

const p = Pkce.start();                       // keep p.verifier and p.state in the person's session
const url = Pkce.authorizeUrl(clientId, redirectUri, p.challenge, p.state);
// send the person to url; on return, check ?state equals p.state, then:
const tokens = await Pkce.exchange(clientId, redirectUri, code, p.verifier, clientSecret);
// later, before the access token ends:
const fresh = await Pkce.refresh(clientId, tokens.refresh_token, clientSecret);
```

The access token is the person's. Send it as a bearer token to call what the person may do in your app, such as
[calls and messages](https://docs.mediloop.co/docs/api/calls).

## Sandbox

To test with made-up data, use a sandbox key (`sk_test_...`) and the sandbox address:

```ts
const mediloop = new Client({ apiKey: process.env.MEDILOOP_SANDBOX_KEY!, baseUrl: 'https://sandbox.api.mediloop.co' });
```

## Tests

    npm test                  # no network
    MEDILOOP_API_KEY=... MEDILOOP_FACILITY=... MEDILOOP_PATIENT=... node dist-test/test/live.js
