# Session access

Private habit data requires a valid account session. The real application uses Clerk SignIn and UserButton; the integration fixture supplies synthetic JWT sessions for API and UI boundary checks.

## Sub-features

- `session-refusal` rejects expired and tokenless access without private rows.
- `session-transition` clears previous-account data and drafts on account change/sign-out.
- `session-provider-in` uses the real SignIn component and survives reload.
- `session-provider-out` uses the actual UserButton Sign out action and removes the active session.

## How to get to it (user POV)

Open `/` in the real application to reach Clerk SignIn. After sign-in, open UserButton for Sign out. Fixture buttons named `Fixture owning account`, `Fixture other account` and `Fixture sign out` exist only in the integrated browser entry.

## Driving it with Playwright and the provider workflow

Preconditions: choose integrated or provider mode explicitly. [SKILL.md](../SKILL.md) owns the integrated fresh-session contract. Provider mode requires explicit authorization, the approved staging synthetic account and the trusted workflow configuration in [tests/Provider/README.md](../../../../tests/Provider/README.md).

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts habits.spec.ts today.spec.ts
```

- Integrated refusal uses `expired authentication explains how to continue` and the owner/foreign/sign-out Today example. Require the owner success before the foreign refusal, visible private-data removal and the actual tokenless API refusal. Read each spec's request assertions before describing the result.
- Integrated transitions use the draft clearing and account-data tests in `habits.spec.ts`. The fixture buttons change synthetic accounts; label that evidence accordingly.
- For provider mode follow the existing provider-session workflow on trusted main. Obtain the deployed source from staging's release manifest as the runbook requires. Let that workflow own the browser/session and secret use. Read its actual sanitized `provider-smoke.json` result and deployed source/tree separately from the workflow controls revision.
- Require the real SignIn observation, complete ordinary session, signed-in reload, actual UserButton action, absent session/user/protected UI after sign-out/reload, and final tokenless refusal. If the authorized provider route cannot run, record the attempted route and exact unmet prerequisite. Keep it unverified when it was not attempted.

## Gotchas

TestApp replaces issuer/signing key and clock while retaining normal server JWT validation. Fixture buttons cannot prove Clerk sign-in or sign-out. The provider ticket flow bypasses email verification and MFA and does not prove inbox delivery or immediate revocation of a previously issued JWT. Its browser state stays in memory; retain only its allowlisted receipt. The skill grants no provider credentials, workflow dispatch or persistent Aspire-volume authority.
