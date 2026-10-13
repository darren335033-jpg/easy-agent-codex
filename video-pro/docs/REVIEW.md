# Independent implementation review

Reviewed 14 October 2026. This is a local implementation preview, not a released SaaS service, a deployed 1,050-worker system, or a proprietary video model. Named integrations and available MCP tools do not establish that external accounts, server connections, or credentials have been verified.

## Evidence

The Node test suite has 49 cases: 48 passed locally on Linux and one Windows-only ACL inspection awaits native CI. Tests exercise actual local HTTP servers, temporary storage, the real Stripe SDK webhook signature validator, and mocked provider/identity responses. Checks cover origin/Host/CSRF boundaries, private credentials, body limits, owner identity, opaque HttpOnly session cookies, logout during identity outage, persisted paid-submission intent, idempotency, ambiguous submission recovery, provider argument restrictions, media allowlisting, durable webhook deduplication, and entitlement ordering. Module syntax checks passed. Git whitespace validation passed for tracked differences; the implementation is currently untracked, so that command alone does not validate every new file. Browser, live provider, email, payment, MCP, and multi-device deployment verification are separate activities; this review does not certify them.

A source scan found no credential-pattern matches outside test fixtures and dependency directories. This is a limited pattern scan, not proof that all historical files or infrastructure are secret-free. Test credentials are synthetic. Environment files must remain ignored and provider secrets must remain server-side.

## Boundaries

Pricing remains explicitly draft: billingEnabled and unitEconomicsVerified are false, allowances are unfinished, and proposed monthly prices are not available for sale. Checkout must remain disabled until verified provider costs, refunds, taxes, webhook delivery, entitlement limits, and cancellation reconciliation are implemented and reviewed. Signed local test events do not establish that Stripe can deliver webhooks to this localhost service.

The server binds to loopback and restricts accepted Host values. Local mode deliberately trusts the local owner; it is not an Internet authentication scheme. Supabase mode supports a verified-owner allowlist and server-side sessions, not tenant-separated SaaS accounts. Projects are shared between allowlisted owners; per-user ownership and quotas are required before multi-customer service. Supabase cloud database/storage migrations and access policies are not implemented here.

## Deployment requirements

- Establish an approved HTTPS deployment origin, secure production cookies, production identity policy, project ownership and tenant isolation. Replace local Host assumptions with explicit deployment configuration and test it.
- Provide a reachable signed webhook endpoint and verify delivery in a Stripe test environment; add periodic subscription reconciliation and bounded validity so missing updates cannot preserve stale access indefinitely.
- Verify provider model availability, request contracts and media delivery using approved limited spend. Mocked Gen-4.5, Seedance and Veo tests establish adapter behavior only. Complete authenticated media integration for each supported provider.
- Establish measured per-user spend limits, plan allowances and quota accounting. An active subscription alone does not enforce generation budgets or tier entitlements.
- Implement a reviewed recovery procedure for durable submitting/unknown-result jobs. Never blindly retry ambiguous paid submissions. Verify backup, retention, concurrent deployment and restart behavior; local JSON/SQLite storage is a single-host boundary.
- Verify PC and iPhone access through an authenticated deployment or approved private network. Loopback URLs do not establish phone connectivity; responsive CSS does not establish device synchronization.
- Inventory every requested MCP server separately with account ownership, least-privilege access, health-check evidence and current status. Do not describe missing servers as configured.
- Complete uploaded assets, voice/reference rights, storage, editing/export and provider-specific capabilities before advertising them. Keep worldwide campaigns unsent until sender verification, consent, unsubscribe and regional requirements are established.
- Publish measured, blinded model comparisons before making superiority claims. Agent registry entries remain inactive definitions until concrete orchestration, budgets and review ownership exist.

## Remaining risk

No production-readiness finding is issued. The strongest current evidence concerns local safeguards and simulated integrations. Live account connectivity, customer isolation, cloud persistence, paid-provider behavior, subscription reconciliation, operational observability, device synchronization and launch compliance remain deployment gates.

Final local verification: 48 application tests (one Windows-only case skipped) and 11 integration-protocol and scaffold tests passed. Browser checks passed planning, seven-view navigation, disabled checkout, and 390-pixel layout with no JavaScript errors. GitHub CI is prepared for Windows and Linux, but no CI result is claimed before it runs.

Windows portability follow-up: storage now checks actual link components rather than comparing canonical path strings, and applies a protected owner/SYSTEM DACL on Windows. Unix modes are tested on Unix; Windows ACL enforcement fails closed. Native CI verification is recorded in the PR checks.

Storage follow-up: existing job and billing files receive explicit private permissions before use; SQLite journal sidecars are checked for links. Windows ACLs are reapplied and verified, including ownership and both required grants, with no path-verification cache.
