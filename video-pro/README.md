# Easy Agent Video Pro 3.1

A local video-production workspace, with a planning mode that works without credentials.
This is an application around third-party models, not a proprietary trained video model.

## Run

Node.js 24 or newer is required. From this directory:

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:18806 on the machine running it. Windows users can run
`Start-Video-Pro.cmd`. The existing repository-root coding-app README is retained;
its described implementation was not present in this checkout.

## Implemented

- Responsive studio, job library, comparison workspace with human scores, JSON shot-list export.
- Template shot planning (no LLM used), private durable local job storage, cancellation,
  idempotency and recovery of uncertain paid submissions.
- Veo 3.1, Runway Gen-4.5 and Seedance 2 text-to-video adapters, validated with mocks.
- Server-side video retrieval: restricted media hosts, private provider credentials,
  bounded streams, no automatic redirects. Runway CloudFront media requires its exact
  verified hostname in RUNWAY_MEDIA_HOSTS.
- Optional Supabase verified-owner login, opaque HttpOnly sessions, local sign-out.
- Stripe Checkout adapter, signed webhooks, persistent event deduplication and local
  subscription entitlements. Draft pricing keeps checkout disabled.
- 1,050 inactive role slots generated from agent-blueprint.json, with 10 pilot roles.
- Consent-required unsent campaign drafts and an integration readiness inventory.

## Status and limitations

Live video generation is disabled by default. No production video, payment, email,
account provisioning or benchmark was performed. Do not assume credentials-present
means provider access works. Refer to docs/REVIEW.md and docs/INTEGRATIONS.md.

The app is bound to loopback and uses shared owner-operated local storage. It is
not a public multi-tenant SaaS. Do not expose it through a public tunnel. A hosted
version needs tenant isolation, quotas, managed media persistence, operational
monitoring and subscription reconciliation before charging customers.

Copy `.env.example` to `.env` only when configuring actual services. Never commit
secrets. Partial Supabase configuration fails startup. Sessions last no more than
one hour and are invalidated by restart; refresh is not implemented.

Use the integrations page and the verified sources in the docs to finish account
connections. OmniRoute and Orca are optional separate products, not installed by
this repository. iPhone responsive tests are not physical device pairing tests.
