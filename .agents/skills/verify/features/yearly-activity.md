# Yearly activity

Inspect one year of schedule-aware daily completion ending on the device's current calendar date. A committed entry or habit change refreshes the displayed totals without reloading.

## Sub-features

- `year-range` displays exactly 365 consecutive dates ending today.
- `year-score` counts Good as 1, Better as 2, Best as 3, and Rest, Clear or missing as 0.
- `year-history` uses each date's schedule inclusion while preserving retained entries outside the totals.
- `year-read-state` distinguishes loading, empty dates and refused reads, with Retry.
- `year-calendar` refreshes for travel, midnight, focus and visible return.
- `year-boundaries` discards responses for an obsolete account or device date and clears cells on sign-out.
- `year-accessible` exposes equivalent date detail by pointer, keyboard and touch without page overflow.

## How to get to it (user POV)

Open the signed-in habit page and find region `Yearly activity`, then group `Daily activity`. Select a day for its date, earned and maximum points, percentage and scheduled count. A date with no scheduled habits says `Nothing scheduled.` and has no percentage.

Focus enters one date cell. Up and Down move one date; Left and Right move seven. Home selects the first date and End selects the last. Pointer movement and touch select the same detail. A narrow screen scrolls the grid horizontally without widening the page.

## Driving it with Playwright

Preconditions are the [canonical fresh session](../SKILL.md) and the dedicated accounts in [heatmap.spec.ts](../../../../tests/Browser/heatmap.spec.ts). Keep its fixed instant and New York device timezone aligned for actual reads and writes.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts heatmap.spec.ts
```

- Run `committed Good Better Best and Rest appear as six of twelve points before and after reload`. Seed four scheduled habits, then choose their results through the real Today controls. Require 6 of 12 points, 50% and four scheduled habits before reload. After reload, require `data-completion="0.5"`. This case does not reassert the exact points and scheduled count after reload. Retain its immediate/reloaded PNGs and recording.
- Run `an unacknowledged entry leaves heatmap totals unchanged until the committed response returns`. Hold the real PUT acknowledgement and require unchanged totals. Release it, require the new total, then reload independently.
- Run `committed definition schedule and archive choices refresh real totals and preserve retained entries after reload`. Start with Good, Better and Best for 6 of 9 points. Edit definitions and require unchanged totals. Remove Good from today's schedule for 5 of 6. Archive Better with Keep for 5 of 6, then archive Best with Remove for 2 of 3. Require the schedule and archive totals after each reload and all retained entry groups. The definition-only edit has no separate reload assertion. Inspect the real future scheduled read and retain its screenshots and recording.
- Hold a real read and require loading with zero invented date cells until release. Route a service refusal and require its distinct error and a Retry that obtains a fresh response. A successful empty year still has 365 neutral dates.
- Run the old-account delayed response case. Require neutral totals for the new empty account after release and zero date cells after sign-out.
- Run device travel with actual timezone emulation and inspect the new anchor while rejecting an old-date response. Run local midnight with its explicitly controlled next-day totals. Run focus and visible return after real API writes at the same date and require the newly committed totals.
- Run `neutral dates expose the same detail by hover keyboard and touch without page overflow`. Require actual focus and matching detail after arrow keys and Home. Require pointer movement to select another detail without stealing keyboard focus. Inspect the WCAG scan, 390-pixel layout, touch detail and named keyboard/mobile PNGs.

## Gotchas

[HeatmapScoring.cs](../../../../server/Heatmap/HeatmapScoring.cs) counts each scheduled habit's maximum as 3. Retained entries excluded from that date's schedule contribute neither earned nor maximum points. An empty date has null completion. [The client schema](../../../../web/src/heatmap.schema.ts) checks consecutive dates and internally consistent totals. Entry enum values express conflict precedence and are not score values.

The range contains 365 dates, so it is not always a calendar year. Today's inclusion choices apply to their command date. Ordinary later entry edits do not change those choices. The old-account and travel cases release their held responses without awaiting completion and a subsequent render before their final assertions. The already-current views can satisfy those assertions before the old response arrives. Keep completed-response rejection unverified for those cases. The account case checks sign-out clearing separately; it does not hold a response across sign-out.

The fixed server clock and controlled browser clocks are separate. The midnight example's routed next-day totals prove client refresh, not a real server rollover. Browser-only date mismatches tolerated by Today specs do not prove successful yearly reads. API seeds and writes establish preconditions for calendar-refresh cases; they do not replace the visible entry actions in the main scoring journey.
