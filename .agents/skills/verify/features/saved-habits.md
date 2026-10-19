# Saved habits

The saved list shows the account's accepted name, Good, Better and Best definitions, weekdays and repeat interval. Reload preserves those displayed values, while switching accounts or signing out clears private data.

## Sub-features

- `list-values` displays each habit and its definitions/schedule once.
- `list-persist` preserves the displayed values after reload.
- `list-empty-error` observes initial loading, empty success and authentication refusal without treating an empty row count as successful authentication.
- `list-owner` removes the previous account's private rows on account change.

## How to get to it (user POV)

Open the signed-in habit page and inspect region `Saved habits`, headed `Your habits`. Create a habit through `Add habit` when no saved row exists. A habit name is a heading and has no opened-detail route.

## Driving it with Playwright

Preconditions: the [canonical fresh session](../SKILL.md) and the dedicated accounts used by [habits.spec.ts](../../../../tests/Browser/habits.spec.ts).

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts habits.spec.ts
```

- Use the existing `reloading preserves every saved value` test. It creates Walking, inspects Good/Better/Best, weekdays and repeat interval, reloads, and checks the same values again.
- Use `saved values appear once with a non-interactive habit name` to require one article/heading and no habit-name button or `Opened habit` region.
- Check the empty list and expired-session cases. Require their own visible result. The current template can show empty prose alongside loading or an authentication alert because those branches are independent. Record the actual combination rather than claiming mutually exclusive states. The expired-session test asserts alerts and zero articles. A held initial unfiltered `GET /api/habits` needs an explicit observation before claiming loading coverage.
- The [complete map pass](../SKILL.md#drive) includes the skill-owned held-read and real authentication-refusal observation. It retains screenshots and the two empty-prose booleans without treating their combination as a product acceptance verdict.
- Use `account change and sign out clear visible account data`. Inspect the owner's saved row first, then the other account's empty view and the signed-out view. Attribute those buttons to the synthetic fixture.
- Use `save acknowledgement cannot reveal the previous accounts habit` for a real committed POST whose response arrives after account switching. Require that response to leave the new account's list unchanged.

## Gotchas

The normal list omits creation instant, timezone, creation date and Monday anchor. Verify the full response and stored schedule through their API/backend tests. A screenshot before reload cannot prove persistence. The fixture's account transition is separate from [provider session proof](session-access.md).
