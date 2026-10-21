# Today and calendar dates

Today shows habits scheduled for the device calendar date. A user can inspect past dates, return to Today, and distinguish loading, empty and failed reads.

## Sub-features

- `today-schedule` displays eligible scheduled habits and retained unscheduled entries with their original definitions.
- `today-read-state` preserves loading/error/empty distinctions and supports Retry.
- `today-date` changes Calendar date and returns with Today.
- `today-refresh` refreshes after creation, committed edits/archive, reload and a detected device-date change on travel, local midnight, focus or visible return.
- `today-pending` preserves active entry commands when a habit change removes or refreshes their rows.
- `today-stale` rejects reads that finish after account/date changes or sign-out.

## How to get to it (user POV)

Open region `Today` on the signed-in habit page. Use the `Calendar date` input for a past date. Its heading and region name become `Entries`. Choose the `Today` button to return to the device date. Use `Retry` when a read fails.

## Driving it with Playwright

Preconditions: [canonical preparation](../SKILL.md). [today.spec.ts](../../../../tests/Browser/today.spec.ts) owns its actual API seed calls, independent fixture accounts and browser clock changes.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts today.spec.ts history.spec.ts
```

- Require the scheduled read to succeed and region Today to show Walking and its stored definitions. Seeding establishes the schedule; the UI assertions prove the visible result.
- Hold a real scheduled read to inspect loading, then release it. For the controlled error case require the error and a Retry that performs another server read. A delayed response is not an empty list.
- Exercise eligible/ineligible creation and reload. Require the corresponding Today list immediately and again after reload.
- Run the [edit/archive recipe](edit-archive-habits.md). After a committed change, require refreshed definitions or schedule inclusion without reloading. Inspect retained entry text, both today's choices and an independently reloaded past date. Keep saved entries distinct from scheduled rows.
- Run the [overlapping entry commands](daily-entries.md) after full habit-change refresh. Require pending rows, unchanged retry and the authoritative stored winner through the real request acknowledgements.
- Include `saved habit reveal` in [habits.spec.ts](../../../../tests/Browser/habits.spec.ts). A post-create refresh must settle before the accepted saved row is revealed, including a delayed real read and a simulated failed refresh. Reopen, account, sign-out and date changes cancel the obsolete reveal without allowing its delayed completion to scroll the replacement view.
- Run the travel, local-midnight, prior-year, visible-return and stale-read examples. Inspect the displayed date and rows after the action. Keep the stored creation date and Monday anchor unchanged. Same-date focus or visible return does not repeat Today's scheduled/entry reads. The separate [yearly view](yearly-activity.md) refreshes on those events even when the date is unchanged.
- Change Calendar date to a past date and require region `Entries`. Click the actual `Today` button, then require region `Today`, the device date and real successful scheduled/entry reads. The [complete map pass](../SKILL.md#drive) includes this skill-owned observation. Existing entry examples return by filling the current date or reloading, so their replay alone does not prove the button journey.

## Gotchas

The harness fixes server time and controls browser time. Calendar dates are device dates, not the UTC date of an edit. Source eligibility remains in [ScheduleEligibility.cs](../../../../server/Habits/ScheduleEligibility.cs). The [Today contracts](../../../../web/src/TodayView.types.ts) distinguish schedule refresh after creation from full refresh after a committed habit change. Pending commands belong to account/date/habit and survive row replacement. Routed failure responses prove client behavior only. The UI rejects future selections and entry writes validate device/server today. Scheduled reads accept any valid date and apply schedule eligibility without a current-date ceiling. The region also displays retained history described under [daily entries](daily-entries.md).

Browser-only travel and midnight examples can disagree with BrowserHost's fixed server date. The narrowly marked heatmap 400 allowance in `today.spec.ts` covers that fixture mismatch only. Those examples prove Today calendar behavior, not successful next-day yearly reads.
