# Release policy evidence

Verified on 2026-10-12. This evidence covers release controls, not a deployed application.

- Baseline GitHub inspection found `main` at `543880fc46ccc7c664d8ae36ae416ed3b58f1e56`, no rulesets, and no environments.
- Initial inspection found PR #11 at `b07d9b4d2b536ce9a7ca56d8c2831ae367ba6357`. It advanced externally to `8d51f1f8e97c42ba539e91d15c0fd4a50b38de99` during this work.
- The initial policy test run had 29 failures against permissive preimplementation functions. Stale-source refusal failed with `Missing expected exception`.
- `node --test release/*.test.mjs` then passed 40 tests, including forged checks, stale source, missing runtime evidence, and weakened approval readback.
- Actionlint v1.7.12 accepted `release-controls.yml`. Prettier 3.9.10 formatted the source and documentation.
- The bootstrap GitHub setup applied successfully twice and read back the same active ruleset and three main-only approval boundaries.
- The live branch-policy response includes `type: branch`; the implementation requires it and fails closed if a future response cannot distinguish branch from tag.
- Bootstrap requires strict `release-controls` and source review with no bypass. The live PR probe shows that required check is missing on PR #11's proposed merge.
- GitHub reports PR #11's merge state as `BLOCKED`. Its new proposed merge is `3d1e5784c08ec3ee78944af030e3b1e4cef40c72`. This demonstrates missing bootstrap CI enforcement, not the pending staging requirement.

The full App-bound staging requirement is prepared but not activated. The verifier App and hosting credentials do not exist in this setup yet.
No infrastructure, staging deployment, actual Clerk login, inbox delivery, or production promotion ran.
Local negative predicates do not establish live missing/stale staging enforcement. Complete the exercise in `release-gate.md` after activation.
