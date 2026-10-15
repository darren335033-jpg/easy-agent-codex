# Easy Agent AI contribution guidance

Use the Easy Agent AI identity and supplied media in `assets/`; `assets/manifest.json` records their provenance. Keep the EA mark, charcoal, warm orange, cream, Manrope headings, and DM Sans body consistent with the existing interface. Use Darren M. Smith for formal founder credits and Dazza for personal workspace copy. Preserve faces, logos, media proportions, and accessible HTML copy.

The user-confirmed Easy Agent AI business address is Stirling Walk, Redwood Park SA 5097, Australia. Use it consistently in business details; do not invent a street number or change provider billing profiles from this information alone.

This is an independent coding workspace. Describe only implemented and verified behavior. OpenAI API access and billing are separate from ChatGPT or Codex subscriptions. The 50 specialist roles are configurable model prompts, not separately trained models. A configured provider is not proof that inference worked.

Keep credentials on the server. Never commit `.env`, service-account files, tokens, companion secrets, `.forge` state, private datasets, dependency folders, or build output. Source downloads use the positive allowlist in `scripts/source-files.mjs`; preserve its exclusions.

Repository edits require explicit review. Keep stale-content checks, selected-file Git commits, fixed CLI profiles, signed companion routes, and request-origin guards. Generated project code runs only through the disposable Docker + gVisor runner; never add a host-execution fallback. Missing infrastructure must fail closed.

Preserve the deployment project ID in `.openai/hosting.json` when updating the existing Sites project. It is nonsecret provenance; do not reuse that identity for an unrelated site. Do not publish or widen the hosted site's audience as a side effect of repository work.

Validate relevant changes with `npm test`, `npm run build`, and, for developer-kit changes, `python3 -m unittest discover -s devkit/tests -p 'test_*.py'`. Provider and runner fixtures are not live integration evidence. Real model access and sandbox execution require their separately configured infrastructure. Run lint only when requested.
