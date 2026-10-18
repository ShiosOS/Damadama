# Verify the staging Clerk session

Run the **Provider session verification** workflow on main to verify the deployed SignIn interface, an ordinary synthetic-account session, and the UserButton **Sign out** action. This adds session checks to the existing release smoke. It does not create habits or repeat ownership tests.

1. Review and merge the provider workflow through the normal repository process. GitHub requires a manually dispatched workflow to [exist on the default branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). An unmerged PR is not active verification.
2. Confirm the existing `staging` environment identifies the dedicated staging Clerk instance and approved synthetic account A. It uses `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`, and `CLERK_TEST_USER_A` variables, plus the `CLERK_SECRET_KEY` secret. The exact allowed origin is `https://staging.damadama.app`. Keep customer accounts and personal inboxes out of this workflow.
3. Read staging's `/release.json`. Dispatch the workflow on main with its full lowercase 40-character source commit as `source_sha`. The runner derives the source tree from Git and requires that commit to be an ancestor of the exact controls checkout. The workflow does not accept a checkout ref or caller-supplied tree.
4. Inspect the job result and the three-day `provider-session-<attempt>` artifact. Only `test-results/provider-smoke.json` is uploaded. A pass records the deployed source commit and tree separately from the controls SHA. It reports the manifest identity, not a fresh running-image digest attestation.

The provider job uses the existing `staging` environment and [staging concurrency group](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency). `queue: max` and `cancel-in-progress: false` preserve queued staging operations. It needs only `contents: read`, and the Clerk secret is available only to the runner step. It uses no Railway credentials or historical-artifact access. It does not create or reactivate `staging-verification`.

The runner refuses missing setup before Git, browser, or network access. It rejects non-main dispatches, other repositories, a different workflow identity, mismatched checkout, development keys, and alternate origins. Before requesting a ticket, it checks readiness, tokenless API 401, the exact runtime public key, and the expected source manifest. It repeats these public checks after the browser flow.

The browser opens the deployed `/` entry and observes the real Clerk SignIn component. It exchanges a [120-second Backend API sign-in ticket](https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token) for a complete ordinary session bound to account A. It checks API 200, signed-in reload, the actual UserButton menu action, and absence of an active session, user, and protected interface after sign-out and reload. The final API request explicitly omits credentials and authorization. This proves tokenless refusal. It makes no claim about immediate revocation of a previously issued JWT.

This ticket bypasses email verification and MFA. Clerk's [server-side test helper documentation](https://clerk.com/docs/guides/development/testing/playwright/test-helpers) explains that boundary. [Testing Tokens](https://clerk.com/docs/guides/development/testing/overview) bypass bot protection and are distinct from sign-in tickets. This runner does not use Testing Tokens. Clerk's fixed email-code test helpers are development-only and do not prove inbox delivery. Real one-time-email delivery still needs an independently authorized controlled synthetic inbox and a separate verification lane. No such inbox is configured here.

Browser state stays in memory. The runner writes no screenshots, traces, HAR, videos, or storage state. These captures can expose [authentication state](https://playwright.dev/docs/auth) and [network or page contents](https://playwright.dev/docs/trace-viewer). Receipts accept only fixed codes, complete boolean proof, public source identities, and documented constants. They exclude account IDs, keys, tokens, API response bodies, and raw provider or Playwright errors. A failed stage emits no partial successful proof. Run only through the trusted workflow when using live credentials.

## Check the helpers locally

Use Node 24 and the root locked dependencies.

```sh
bun install --frozen-lockfile
node --test tests/Provider/*.test.mjs
bun x --no-install eslint tests/Provider
bun x --no-install prettier --check tests/Provider .github/workflows/provider-smoke.yml
```

These deterministic tests prove accepted and rejected configuration, session observations, identity drift, sanitized receipts, and the actual CLI's missing-setup and Git ancestry checks. The CLI tests stop before network access. Controlled responses in helper tests are not live provider evidence. Root `bun run check` remains required before code handoff. The provider helper workflow adds file-scoped formatting because the root formatter currently names `tests/Browser`.

Without provider inputs, `node tests/Provider/run.mjs` exits 1 and writes a `missing-setup` receipt. Configuration failures use `rejected-configuration`. Browser and public-check failures use `failed` with a fixed stage code and useful message. A missing secret, failed setup, helper pass, or historical release result never becomes a new provider pass.

## Existing evidence and separate activation

[Staging run 39091774009](https://github.com/ShiosOS/Damadama/actions/runs/39091774009) verified source `97c1eddece70325433013c3f0bb303cb1265a00d` with actual Clerk ticket sessions, habit creation before reload, persistence, and ownership refusal. Its sign-out observation used the Clerk API and checked protected content disappearance. It explicitly excluded email delivery. Keep that historical evidence separate from this new UserButton and session-absence proof. A new pass requires this workflow to execute successfully against its specified deployed revision.
