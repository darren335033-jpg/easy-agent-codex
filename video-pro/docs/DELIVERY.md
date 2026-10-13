# Easy Agent Video Pro 3.1 delivery contract

This repository is an implementation preview. Configuration does not constitute deployed agents, connected provider accounts, enabled billing, or a trained proprietary model. No claim of superiority over Seedance 2.0 is established. The agent registry contains 1,050 unique inactive role assignments with zero spending authority and no tools. Its ten pilot roles are a proposed starting team; every slot needs a concrete work item and review owner before execution.

## Feature scope

The target workflow is script planning, storyboard/reference management, provider generation, shot comparison, editing/export, quality review, and campaign asset preparation. Google Veo 3.1 is the requested primary provider; Runway Gen-4.5 and Seedance 2.0 are candidate alternatives. Runway Gen-4 Image, ElevenLabs, optional ComfyUI/Wan 2.2/LTX-Video, FFmpeg and DaVinci Resolve require separately verified availability, licences and integration paths. Naming these tools does not mean they are installed or accessible. Provider adapters must report unavailable capabilities explicitly and must never fabricate completed videos.

Production requirements include authenticated project ownership, durable jobs, cancellation, retries, idempotent billing, uploaded-asset permission checks, accessible controls, observable errors, and clear failed-job charging rules. Export settings must match source quality; UI labels must not imply unsupported resolution or features. Human review is required for final quality and marketing claims. Construction content must be reviewed for safety and technical accuracy; generated scenes must not be represented as real site evidence.

## Launch checklist

- Verify provider accounts, documented model identifiers, supported regions, limits, pricing and data retention.
- Keep credentials server-side; use least-privilege MCP access and verify each server with a real health check. Record unavailable servers as unavailable.
- Establish Supabase project ownership, migrations, row-level access policies and storage permissions; test with separate users.
- Verify generation with approved test spend, queue persistence, timeout recovery, deletion and cancellation.
- Review rights for reference imagery, voices and uploaded assets, and publish actual privacy and retention policies.
- Calculate cost per usable output including failed jobs, audio, storage, egress, support and taxes. Finalize video allowances only after measuring margin.
- Validate Stripe test billing, signed webhooks, replay protection, entitlement reconciliation, refunds and cancellation before enabling live billing.
- Obtain explicit email consent, working unsubscribe and suppression handling, and region-specific review before any campaign sends.
- Confirm localisation, accessible layouts, regional availability and support coverage before claiming worldwide availability.
- Approve quality evidence, deployment rollback, incident ownership and customer support documentation.

## Testing and review requirements

Run meaningful unit and integration tests for provider response validation, job state transitions, retries, ownership boundaries, uploaded-asset constraints and billing events. Run browser checks for responsive navigation, keyboard operation, form validation, disabled/unavailable features, loading states and errors. Distinguish mocked tests from live provider checks in the report. Test two users cannot access each other's projects or storage. Exercise duplicate/out-of-order webhooks, failed and cancelled generation, interrupted workers and timeout recovery. Verify secrets never reach browser bundles, logs or downloadable files. Record commands, environment, results, skipped live checks and known defects; passing configuration validation alone is not a production readiness result.

Each reviewed work item needs acceptance criteria, evidence, a reviewer and a disposition. Release-blocking defects include unauthorized data access, unbounded spend, incorrect entitlements, fabricated provider output and missing recovery for paid jobs.

## Seedance comparison procedure

Create a frozen set of 30 prompt cases before evaluation: five each for human motion, character consistency across shots, camera motion, complex scene/object interactions, prompt detail adherence, and audio/visual alignment where both providers support it. Include construction scenes within the balanced cases, without making them the entire sample. Publish prompts, reference rights, provider/version identifiers, settings, region and evaluation date. Fix random seeds where supported; record unsupported seeds explicitly. Predeclare repeat counts and budgets and give each provider equal attempts per case. Retain all outputs, including failures; do not compare selected best outputs against first attempts.

Use at least three human reviewers, randomised anonymous labels and blinded provider identities. Score prompt adherence, visual quality, temporal coherence, character consistency and motion on a documented 1–5 rubric; score audio alignment only for comparable supported cases. Record reviewer disagreement. Measure end-to-end latency, failure rate, billed cost per attempt and cost per accepted output. Report aggregate scores, per-category outcomes and uncertainty rather than only a single favourable sample. A broader “better than Seedance 2.0” claim requires statistically supported results on the declared evaluation scope and must identify that scope, tested versions and limitations. Until then, describe the product as an unbenchmarked workflow preview.

## Pricing and campaigns

Creator $29, Studio $99 and Business $299 per month are USD proposals. Included video allowances are not finalized, billing is disabled, and availability is draft. No plan promises unlimited generation. Email sequences are unsent drafts requiring consent, working preference links, a verified sender and localisation review. No external accounts, services or campaigns are activated by these configuration files.
