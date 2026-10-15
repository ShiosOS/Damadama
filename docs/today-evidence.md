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
