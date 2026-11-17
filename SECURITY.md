# Security

Report a vulnerability in this library by email to security@mediloop.co, or through GitHub's private vulnerability
reporting on this repository. Please do not open a public issue. We acknowledge a report within three working days.

Supported: the latest 1.x release.

## Run a supported Node.js

This library requires Node.js 22 or later. Run a release that still gets security fixes and keep it patched.

## What the library protects against

- A token or API key is never sent to a redirect target or to a paging link that is not on Mediloop.
- A base URL that is not https is refused.
- Webhook signatures are compared in constant time, and old deliveries are refused.
