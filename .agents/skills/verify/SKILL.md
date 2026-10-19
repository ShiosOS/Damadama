---
name: verify
description: Verify Damadama habit creation, saved habits, Today dates, daily entries and session boundaries through its existing browser and API harnesses. Use for user-visible behavior checks and verification-map upkeep.
---

# Verify Damadama

Read the [feature index](features/README.md), then the files for the affected journeys. Run commands from the repository root in an owned checkout. Record the current source and the selected proof mode before starting.

## Launch

Use the integrated browser mode for habit and entry behavior. It mounts the production HabitsPage against the real server and disposable PostgreSQL, with synthetic JWTs and a fixed server clock. It does not run the Clerk sign-in shell.

1. Select this checkout's runtimes from [dev/README.md](../../../dev/README.md) and the current manifests. Keep runtime selection process-local.
2. Run `bun run doctor browser`. Use distinct free `DAMADAMA_BROWSER_PORT` and `DAMADAMA_API_PORT` overrides when the defaults are occupied.
3. Run `bun run test:browser`. This is the canonical preparation and full integrated run. [scripts/developer.ts](../../../scripts/developer.ts) owns locked installation, production and fixture builds, BrowserHost restoration/build and pinned Chromium installation. A completed `bun run check` also prepares these inputs through [scripts/check.ts](../../../scripts/check.ts).
4. After either preparation succeeds, use the Drive command for a complete map pass or a feature file's command for a focused replay. Prepare again when product sources, dependencies or build inputs change.

The session is one canonical Playwright invocation. [playwright.config.ts](../../../tests/Browser/playwright.config.ts) owns BrowserHost and Vite preview, serial driving and teardown. It refuses existing servers. Each invocation gets a fresh PostgreSQL Testcontainer. Keep one invocation active per checkout because build and result paths are shared.

The primary application starts with `bun run start`, as documented in [dev/README.md](../../../dev/README.md). It uses the persistent `damadama-first-slice-postgres` volume and real Clerk configuration. Use it only for an explicitly authorized development session. The integrated recipes do not need it. For actual Clerk session proof, read [session access](features/session-access.md) and follow the existing provider workflow rather than supplying production credentials locally.

## Doctor

`bun run doctor browser` checks prerequisites and free ports before a session. It does not inspect a running app.

The canonical Playwright configuration performs the instance readiness check before driving. Require its API `/health/ready` and Vite preview checks to succeed. Then require the feature's first expected control or authenticated read to succeed before further actions. BrowserHost's real migrations complete before readiness. Its `fixture.json` provides synthetic sessions only.

Bind the run to the checkout by recording `git rev-parse HEAD`, `git rev-parse HEAD^{tree}` and the working diff before preparation. Record the exact command and port overrides. Keep those inputs stable during the invocation. Local readiness does not expose a release SHA, so do not claim a runtime release-manifest attestation from it.

After a failed drive or unexpected UI state, let that invocation exit and finish its owned teardown. Recheck prerequisites and start a fresh invocation before continuing. A healthy HTTP response alone does not recover a wedged browser state.

## Drive

Use the production controls named by the feature map. After canonical preparation, run the complete map in one serial session:

```sh
node node_modules/@playwright/test/cli.js test --config .agents/skills/verify/playwright.config.mjs
```

[The skill config](playwright.config.mjs) reuses canonical startup, readiness, serial driving and browser settings. It selects `habits.spec.ts`, `today.spec.ts`, `entries.spec.ts` and `accessibility.spec.ts`, plus [focused observations](observations.spec.mjs) for cancelled-draft retention with immediate/reloaded values, initial unfiltered saved-list loading/authentication refusal and the actual past-date `Today` button. It adds no application server or fixture account. The creation observation uses the existing `performance` account because the performance spec is excluded from this invocation. The other observations use the empty `other` account without writing rows.

The provider branch of session access needs its separately authorized workflow. Read the selected spec before attributing results. A routed failure response proves the UI's refusal/retry handling; it does not prove a real storage outage. Seeding through the real API establishes a precondition and does not replace driving the feature under test.

## Evidence

Retain the source identities and diff, actual command, stdout/stderr, exit code, selected test names, environment and concrete limitations in a per-run evidence directory outside the cleanup scope. Record the pre-reload result and the independently reloaded view for persistence claims. A screenshot or a successful save status alone is insufficient.

Existing specs write named synthetic screenshots under `.audit/`, browser output under `test-results/`, and the HTML report under `tests/Browser/playwright-report/`. Copy only the run's named non-secret evidence before another invocation can replace it. Record the full source revision separately from any deployed source or controls revision.

The complete-map command writes its HTML report and failure output under `.audit/verification-skill/`. Its observations add `habit-immediate.png`, `habit-reloaded.png`, `saved-list-loading.png`, `saved-list-refused.png`, `calendar-past.png` and `calendar-today.png` there. The saved-list attachment records only whether empty prose was visible alongside loading or refusal. Retain that actual observation before deciding whether a separate product issue exists.

Keep `fixture.json`, `.env` files, JWTs, connection strings, storage state and provider browser captures out of retained proof. Synthetic account controls are never evidence of Clerk sign-in or provider sign-out. [The provider runbook](../../../tests/Provider/README.md) defines its sanitized receipt and email/MFA limits.

## Cleanup

Let Playwright stop the two servers it started and let BrowserHost dispose its Testcontainer. On a failed or interrupted invocation, inspect only the recorded invocation and its children. Finish their teardown before retrying. Use owned process/container identities for any residual cleanup. Preserve the persistent Aspire volume and unrelated sessions.

After owned processes exit, remove this run's generated `tests/Browser/fixture.json` and `.audit/browser-build/fixture.json`. Keep the evidence directory outside those paths. Confirm the run's listeners and processes are gone and the retained evidence files still exist. An interrupted session with unknown ownership is blocked until ownership is reconciled.

## Helpers

The skill's Playwright config and observation spec run through the Drive command. The maintained developer command and canonical Playwright configuration own preparation and server lifecycle. The observation spec covers map gaps without changing product code or shared configuration.

## Maintain

After application changes, use parallel read-only source readers, one per indexed feature. The coordinator consolidates their recipes and owns one serial live pass over every reachable journey. Record an attempted route and its concrete prerequisite for an unreachable branch. Report product regressions separately from map drift. Keep any map correction within this skill tree and re-drive a changed harness. A written map or test listing is not live verification.
