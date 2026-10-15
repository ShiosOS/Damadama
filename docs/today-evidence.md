# Scheduled-date read contract and backend evidence

Base revision is `efa288e56512da90675b3e791246c36f664f406c`.

## Evaluator contract

`ScheduleEligibility.IsScheduled(InitialSchedule schedule, DateOnly date)` returns whether the stored initial schedule includes the requested calendar date.
Dates before `CreationDate` are excluded. Weekdays use ISO Monday `1` through Sunday `7`.
Repeat weeks start on `FirstWeekMonday` and run Monday through Sunday.
The creation week is week zero, followed by every `RepeatEveryWeeks` weeks.
The evaluator has no clock, timezone conversion, database access, or entry dependency. Missed dates do not carry forward.

Callers supply a calendar date separately from any UTC edit timestamp.
Reading another date does not change `CreationDate`, `FirstWeekMonday`, or the stored creation timezone.

## HTTP contract

`GET /api/habits/scheduled?date=2026-10-14` requires an authenticated account.
The endpoint accepts exactly one `date` value in invariant `YYYY-MM-DD` format.
Missing, empty, malformed, impossible, timestamp, whitespace-padded, and repeated date values return HTTP `400` with `application/problem+json`.
The validation title is `Check the requested date.` and the `errors.date` message is `Use one valid calendar date in YYYY-MM-DD format.`
Signed-out requests return HTTP `401` before date validation.

HTTP `200` returns an array of the existing `HabitResponse` objects, ordered by `createdAt`, then `id`.
Each object retains `id`, `name`, `good`, `better`, `best`, `createdAt`, and `schedule`.
The schedule retains `habitId`, `weekdays`, `repeatEveryWeeks`, `timeZone`, `creationDate`, and `firstWeekMonday`.
An empty scheduled result is `[]`.
The SQL query filters by the authenticated subject before materialization. The pure evaluator selects scheduled habits after materialization.

## Red evidence

The executable examples are in `tests/Backend/ScheduledDateEligibility.feature`, `ScheduleEligibilityTests.cs`, and `ScheduledHabitsTests.cs`.
The first run used a compiled evaluator returning `false` and an authorized endpoint returning an empty array.

```powershell
dotnet test tests/Backend --artifacts-path .audit/check-build --no-restore --filter "FullyQualifiedName~ScheduleEligibility|FullyQualifiedName~ScheduledHabits|FullyQualifiedName~ScheduledDateEligibility" --logger "console;verbosity=normal"
```

The run produced 39 failed and 13 passed tests. Local output is `.audit/today-backend-red.txt`.
The failures included these observed differences.

```text
Scheduled result on 2026-10-14: Expected: True / But was: False
Owner scheduled read: Expected: 1 / But was: 0
Missing date: Expected: BadRequest / But was: OK
```

The recurrence examples use creation date `2026-10-14`, Monday anchor `2026-10-12`, weekdays `1,3,7`, and repeat interval `2`.
They assert `false, true, false, true, false, false, true` for `2026-10-12`, `10-14`, `10-15`, `10-18`, `10-19`, `10-25`, and `10-26` respectively.
Additional NUnit examples cover all seven ISO weekdays, one-week and three-week intervals, year boundaries, leap day, and missed dates.

## Green evidence

The implementation run finished at `2026-10-15T07:20:23.9946532Z` and passed all 103 backend tests, with no failed or skipped tests.

```powershell
dotnet test tests/Backend --artifacts-path .audit/check-build --no-restore --logger "console;verbosity=minimal" --logger trx --results-directory .audit/TestResults
dotnet restore --locked-mode
dotnet format --no-restore
```

Local output is `.audit/today-backend-green.txt`.
The TRX is `.audit/TestResults/emofo_SHIOS_2026-10-15_03_20_06.trx`.
The API tests use the actual ASP.NET Core application, JWT middleware, and a PostgreSQL Testcontainers database.
They prove owner success before another owner's empty result, signed-out refusal, strict date errors, stable ordering, repeat reads, and unchanged stored schedule dates and response fields.
The restore and formatter exited successfully. No database model or migration files changed.

## Today view and literal browser examples

`TodayView.vue` reads `habitsApi.scheduled(date)` and reuses `HabitDetails`.
Its loading, ready, and error variants each carry the requested local calendar date.
Only a ready empty response displays `Nothing scheduled for today.`
A successful creation increments a revision and asks the server to read Today again, including when that new habit is ineligible.
Generation checks discard old-account and old-date success and error responses. Unmount removes the midnight timer and focus/visibility listeners.
The browser constructs its date from local `getFullYear`, `getMonth`, and `getDate` values. It performs no recurrence calculation.

The browser examples use the real ASP.NET Core application and PostgreSQL Testcontainers through optimized Vite assets.
Their accepted habit is created at the fixture's fixed `2026-01-05T00:30:00Z` instant with the stored New York timezone.
This stores creation date `2026-01-04` and Monday anchor `2025-12-29`.

| Given | When | Then |
| --- | --- | --- |
| A Sunday habit and New York device date `2026-01-04` | Today loads | Walking and its three stored definitions appear. |
| A Monday habit repeated every two weeks | The device is in Los Angeles at `2026-01-12T00:30:00Z` | Today is Sunday `2026-01-11` and empty. |
| The same stored schedule and open Chromium page | The device timezone changes to Tokyo, then receives focus | Today is Monday `2026-01-12` and Walking appears. |
| The same open page | The device timezone returns to Los Angeles, then receives focus | Today returns to `2026-01-11` and is empty. The actual API still returns the unchanged stored habit. |
| A Monday habit and New York local time `2026-01-04 23:59:59` | The clock crosses local midnight without navigation or focus | Today becomes `2026-01-05` and Walking appears. |
| A stored habit created on `2026-01-04` | New York's current date is `2025-12-31`, while UTC is `2026-01-01` | Today displays the local prior-year date and excludes the pre-creation habit. |

### Failing browser evidence and UTC mutation check

Before adding the view, the positive scheduled-habit browser test failed with the actual page against the actual backend.
The run used Node `24.19.0` and is saved in `.audit/today-ui-red.txt`.

```text
Expected: visible
Error: element(s) not found
Locator: getByRole('region', { name: 'Today', exact: true }).getByRole('heading', { name: 'Today', exact: true })
1 failed
```

After writing the local-date implementation and travel test, a separate mutation check temporarily replaced local calendar construction with `now.toISOString().slice(0, 10)`.
This is mutation evidence, not an additional red-first claim. The travel test rejected the mutation in `.audit/today-utc-mutation.txt`.

```text
Locator: getByRole('region', { name: 'Today', exact: true }).locator('time')
Expected: "2026-01-11"
Received: "2026-01-12"
1 failed
```

The correct local-date implementation was restored before the final green build.

### Passing browser evidence

The final focused suite passed all 15 tests, with no failures or skipped tests, in 21.8 seconds.
Output is `.audit/today-ui-green.txt`. Tests cover scheduled/empty, held real responses and loading, explicit HTTP 503 and Retry, eligible/ineligible creation refresh before reload, separate reload persistence, owner success before foreign empty, sign-out and direct 401, delayed old-account and old-date successes/errors, local travel, midnight, prior-year dates, the visible-return event, and pending-read completion after unmount.
The stale-response examples wait for the held HTTP response to finish before asserting the final account/date state.
The unmount example advances 25 hours and focuses the page after sign-out, confirming no further scheduled read.

Commands run from the managed Today worktree:

```powershell
dotnet build tests/BrowserHost --artifacts-path .audit/check-build --no-restore
bun x --no-install vite build --config tests/Browser/vite.config.ts
& 'C:/Users/emofo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts today.spec.ts
bun x --no-install eslint web/src/TodayView.vue web/src/habits.ts web/src/HabitsPage.vue tests/Browser/today.spec.ts tests/Browser/habits.spec.ts tests/Browser/accessibility.spec.ts
bun run --cwd web typecheck
bun run format
bun x --no-install prettier --write dev/Properties/launchSettings.json
```

The production-asset build, focused lint, Vue typecheck, and formatting commands succeeded.
The full repository `bun run check` remains the parent reviewer's handoff gate.
Sanitized local browser evidence is `.audit/today-populated.png`, `.audit/today-mobile.png`, `.audit/today-empty.png`, and `.audit/today-flow.webm`.
The recording uses a dedicated context only for the travel example and closes it explicitly before saving the WebM.
Successful reads and creates use the real backend. Interception holds real responses or returns explicit error responses, never handcrafted successful habit payloads.
Browser page errors and console errors were checked. The three intentional HTTP 503 responses are excluded from the browser's resource-error console check.

### Browser driver observations and limits

The first travel driver used Playwright's configured timezone, so Chromium rejected a second CDP override with `Timezone override is already in effect`.
Removing the manual context's timezone option still inherited the test's New York default. The retained `.audit/timezone-probe.mjs` and `.audit/timezone-probe.txt` directly compare contexts.
With `timezoneId: "America/New_York"`, CDP changes to Los Angeles and Tokyo fail. With `timezoneId: ""`, both changes succeed and the browser reports the requested IANA timezone.
The final travel example explicitly sets `timezoneId: ""`, applies CDP overrides in the same page, and asserts the actual browser timezone and resulting local date after each change.

Headless Chromium kept background tabs' `document.visibilityState` as `visible` when another tab came forward.
The visible-return example therefore dispatches `visibilitychange` on the actual visible document after changing the clock.
It verifies the component's visible-event handling. It does not claim native tab-background lifecycle coverage.
Playwright's clock is installed before page navigation and component timer creation.
These fixtures use ephemeral test JWTs through the ordinary server authentication middleware. They do not prove hosted Clerk sign-in or genuine email delivery.
