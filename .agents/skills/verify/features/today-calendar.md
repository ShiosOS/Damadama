# Today and calendar dates

Today shows habits scheduled for the device calendar date. A user can inspect past dates, return to Today, and distinguish loading, empty and failed reads.

## Sub-features

- `today-schedule` displays eligible scheduled habits and retained unscheduled entries with their original definitions.
- `today-read-state` preserves loading/error/empty distinctions and supports Retry.
- `today-date` changes Calendar date and returns with Today.
- `today-refresh` refreshes after creation, reload and a detected device-date change on travel, local midnight, focus or visible return.
- `today-stale` rejects reads that finish after account/date changes or sign-out.

## How to get to it (user POV)

Open region `Today` on the signed-in habit page. Use the `Calendar date` input for a past date. Its heading and region name become `Entries`. Choose the `Today` button to return to the device date. Use `Retry` when a read fails.

## Driving it with Playwright

Preconditions: [canonical preparation](../SKILL.md). [today.spec.ts](../../../../tests/Browser/today.spec.ts) owns its actual API seed calls, independent fixture accounts and browser clock changes.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts today.spec.ts
```

- Require the scheduled read to succeed and region Today to show Walking and its stored definitions. Seeding establishes the schedule; the UI assertions prove the visible result.
- Hold a real scheduled read to inspect loading, then release it. For the controlled error case require the error and a Retry that performs another server read. A delayed response is not an empty list.
- Exercise eligible/ineligible creation and reload. Require the corresponding Today list immediately and again after reload.
- Run the travel, local-midnight, prior-year, visible-return and stale-read examples. Inspect the displayed date and rows after the action. Keep the stored creation date and Monday anchor unchanged. Same-date focus or visible return does not fetch again.
- Change Calendar date to a past date and require region `Entries`. Click the actual `Today` button, then require region `Today`, the device date and real successful scheduled/entry reads. The [complete map pass](../SKILL.md#drive) includes this skill-owned observation. Existing entry examples return by filling the current date or reloading, so their replay alone does not prove the button journey.

## Gotchas

The harness fixes server time and controls browser time. Calendar dates are device dates, not the UTC date of an edit. Source eligibility remains in [ScheduleEligibility.cs](../../../../server/Habits/ScheduleEligibility.cs). Routed failure responses prove client behavior only. The UI rejects future selections and entry writes validate device/server today. Scheduled reads accept any valid date and apply schedule eligibility without a current-date ceiling. The region also displays retained history described under [daily entries](daily-entries.md).
