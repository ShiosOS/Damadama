# Edit and archive habits

Change a saved habit's definitions or recurrence, or archive its future recurrence. A committed change updates the saved row and Today. Existing entries retain their recorded definitions.

## Sub-features

- `history-edit` saves accepted names and Good, Better and Best definitions before and after reload.
- `history-schedule` changes weekdays or repeat interval without rewriting earlier dates.
- `history-today-choice` asks Keep today or Remove today when a schedule change or archive affects today's saved entry.
- `history-archive` preserves the saved row and entries while excluding future recurrence.
- `history-retry` replays an unchanged failed command and treats a changed draft as a new command.
- `history-boundaries` preserves invalid drafts, mobile keyboard/focus and account isolation.

## How to get to it (user POV)

In `Saved habits`, choose `Edit <habit name>` to open `Edit habit`. Change the fields and choose `Save changes`. Choose `Archive <habit name>` to open `Archive habit`, then confirm with its `Archive habit` button. A `Today's saved entry` group offers `Keep today` and `Remove today` when required.

After successful archive, the saved article displays `Archived`. Its Archive control disappears and Edit remains. Closing either dialog returns focus to the relevant saved-row control, or Edit when Archive has disappeared.

## Driving it with Playwright

Preconditions are the [canonical fresh session](../SKILL.md) and the dedicated accounts in [history.spec.ts](../../../../tests/Browser/history.spec.ts). Its API seeds establish habits and entries. Drive every change under test through the production controls.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts history.spec.ts
```

- Run `editing definitions updates the committed habit and keeps recorded entry text after reload`. Change the name and Good text. Require the accepted saved-row values, unchanged existing entry text and independent reload. Retain the named immediate/reloaded PNGs and edit recording.
- Run `removing today after a schedule edit retains the entry and the previous scheduled date`. Change the recurrence through Edit. Require the explicit choice before acknowledgement, choose Remove today, and inspect the retained entry and previous date. Reload and require `Retained entry` and `Better is saved.`. This case does not reassert the exact recurrence after reload.
- Run both `archiving with Keep` and `archiving with Remove` examples. Require the choice, committed archived badge, saved history, future scheduled exclusion and reload. Keep today changes schedule inclusion for that date; Remove today retains the saved entry outside the schedule.
- Run `retrying a lost acknowledgement reuses the committed mutation identity`. Require the same mutation UUID on retry and one accepted revision. This case does not compare the complete request payload. Run `changing a failed draft starts a new command instead of replaying its older values`. Edit the failed draft, submit it, and require its corrected text with a new mutation identity.
- Run `a held old-account mutation response cannot restore private habits`. Release the committed response after switching accounts and require the current account's view to remain unchanged. The case does not await the old response's completion and a subsequent render before its final assertion. Keep completed-response account isolation unverified.
- Run `the editor keeps invalid drafts and supports mobile keyboard controls`. Require retained invalid values, usable correction, a clean WCAG scan, no page overflow, and Escape returning focus to Edit. Retain the mobile editor PNG. This case closes the corrected draft without saving it. Run the [pending-entry overlap journeys](daily-entries.md) in the same selection.

## Gotchas

[HabitEditor.vue](../../../../web/src/HabitEditor.vue) captures an immutable command for retry. Fields changed after an error invalidate that retry and produce a new command. A Keep/Remove challenge precedes acceptance; it is separate from a lost acknowledgement after commit.

Saved entries, schedule inclusion and first-save eligibility are separate facts. Archive does not delete history or offer restore. A finite pending first save can finish after a change withdraws its row; it does not grant unrestricted writes on future archived dates. Earlier dates and recorded definitions remain historical. The first-ever inserted entry captures the current locked definitions, even when its request began before the definition edit.

The fixed server instant is `2026-01-05T00:30:00Z`. Default New York examples use January 4; the dated history group uses Tokyo and January 5. Keep the test's timezone and date together. Synthetic account transitions and routed failures retain the limits in [session access](session-access.md) and [daily entries](daily-entries.md).
