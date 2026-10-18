# Scheduled-date read contract

## Evaluator contract

`ScheduleEligibility.IsScheduled(InitialSchedule schedule, DateOnly date)` returns whether the stored initial schedule includes the requested calendar date.
Dates before `CreationDate` are excluded. Weekdays use ISO Monday `1` through Sunday `7`.
Repeat weeks start on `FirstWeekMonday` and run Monday through Sunday.
The creation week is week zero, followed by every `RepeatEveryWeeks` weeks.
The evaluator has no clock, timezone conversion, database access, or entry dependency. Missed dates do not carry forward.

The browser supplies its current device calendar date in `YYYY-MM-DD` format separately from UTC edit timestamps.
Today follows the device's local date, including after travel and local midnight.
Reading another date does not change `CreationDate`, `FirstWeekMonday`, or the stored creation timezone.
The browser performs no recurrence calculation.

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

## Executable examples

`tests/Backend/ScheduledDateEligibility.feature`, `ScheduleEligibilityTests.cs`, and `ScheduledHabitsTests.cs` cover eligibility and the private read.
`tests/Browser/today.spec.ts` covers Today, travel, local midnight, and request states.
Use [Check a change](../../README.md#check-a-change) to rerun the repository checks.
