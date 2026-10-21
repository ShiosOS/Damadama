# Saved habits

The saved list shows the account's accepted name, Good, Better and Best definitions, weekdays and repeat interval. Reload preserves those displayed values, while switching accounts or signing out clears private data.

## Sub-features

- `list-values` displays each habit and its definitions/schedule once.
- `list-reveal` brings the newly saved row into view after Today settles without restoring a cancelled reveal.
- `list-persist` preserves the displayed values after reload.
- `list-empty-error` shows empty prose only after a successful empty read and keeps loading, authentication refusal and failed reads distinct, including after the creation panel opens and closes.
- `list-owner` removes the previous account's private rows on account change.
- `list-controls` provides separate Edit and Archive controls and preserves archived rows with an Archived badge.

## How to get to it (user POV)

Open the signed-in habit page and inspect region `Saved habits`, headed `Your habits`. Create a habit through `Add habit` when no saved row exists. A habit name is a heading and has no opened-detail route. Use the separate `Edit <habit name>` or `Archive <habit name>` button for [habit changes](edit-archive-habits.md). An archived row retains Edit and its values, displays `Archived`, and removes Archive.

## Driving it with Playwright

Preconditions: the [canonical fresh session](../SKILL.md) and the dedicated accounts used by [habits.spec.ts](../../../../tests/Browser/habits.spec.ts).

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts habits.spec.ts
```

- Use the existing `reloading preserves every saved value` test. It creates Walking, inspects Good/Better/Best, weekdays and repeat interval, reloads, and checks the same values again.
- Use `saved values appear once with a non-interactive habit name` to require one article/heading, separate Edit/Archive buttons and no habit-name button or `Opened habit` region. The [history recipe](edit-archive-habits.md) verifies the archived badge and accepted changed values immediately and after reload.
- Use the `saved habit reveal` group for the immediate viewport result after creation. Its ten cases cover eligible/ineligible dates, reduced motion, a held real Today response, populated Today, simulated refresh refusal, and cancellation by reopen/account/sign-out/date changes. Require the accepted schedule to enter the viewport without scrolling it in the test; a cancelled reveal must leave the replacement view undisturbed. These checks complement the independent reload recipe.
- Use `the saved list shows empty prose only after its initial read succeeds` to hold the real unfiltered `GET /api/habits` response. Require loading with zero articles and no empty prose, then require the empty message after the 200 response arrives.
- Use `expired authentication explains how to continue` to require real authentication alerts, zero articles and no empty prose. Use `a failed saved-list read shows its error without empty prose` for a simulated 503 response. The simulated response proves UI error handling, not a storage outage.
- The [complete map pass](../SKILL.md#drive) also asserts the held-read and real authentication-refusal states. Its retained screenshots and two empty-prose booleans must show `emptyWhileLoading=false` and `emptyAfterRefusal=false`.
- Use `account change and sign out clear visible account data`. Inspect the owner's saved row first, then the other account's empty view and the signed-out view. Attribute those buttons to the synthetic fixture.
- Use `save acknowledgement cannot reveal the previous accounts habit` for a real committed POST whose response arrives after account switching. Require that response to leave the new account's list unchanged.

## Gotchas

The normal list omits creation instant, timezone, creation date and Monday anchor. Verify the full response and stored schedule through their API/backend tests. A screenshot before reload cannot prove persistence. The fixture's account transition is separate from [provider session proof](session-access.md).
