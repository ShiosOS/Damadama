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

`GET /api/habits?scheduledOn=2026-10-14` requires an authenticated account.
Omitting `scheduledOn` lists all owned habits. When supplied, the filter accepts exactly one value in invariant `YYYY-MM-DD` format.
Empty, malformed, impossible, timestamp, whitespace-padded, and repeated filter values return HTTP `400` with `application/problem+json`.
The validation title is `Check the requested date.` and the `errors.scheduledOn` message is `Use one valid calendar date in YYYY-MM-DD format.`
Signed-out requests return HTTP `401` before filter validation. The former `/api/habits/scheduled` route returns HTTP `404`.

HTTP `200` returns an array of the existing `HabitResponse` objects, ordered by `createdAt`, then `id`.
Each object retains `id`, `name`, `good`, `better`, `best`, `createdAt`, and `schedule`, and adds `archived` and `revision`.
The schedule retains `habitId`, `weekdays`, `repeatEveryWeeks`, `timeZone`, `creationDate`, and `firstWeekMonday`.
An empty scheduled result is `[]`.
The SQL query filters by the authenticated subject before materialization. The pure evaluator selects scheduled habits after materialization.

## History and mutation contract

`PATCH /api/habits/{id}` atomically edits the name and all three definitions. Required fields are `mutationId`, `deviceToday`, `timeZone`, `name`, `good`, `better`, and `best`.
An optional `schedule` contains `weekdays` and `repeatEveryWeeks`. Omitting it preserves the current recurrence and its Monday anchor.
`POST /api/habits/{id}/archives` stops recurrence from the validated device date. It accepts `mutationId`, `deviceToday`, and `timeZone`.
Both operations return the current `HabitResponse` after commit. They retain the original flat columns and creation schedule.

When a schedule edit or archive observes a saved entry today, including Clear, it returns HTTP `409` with `code` equal to `today_choice_required` until `todayChoice` is `Keep` or `Remove`.
Keep includes that retained entry on this date. Remove retains the entry but excludes it from this date's schedule contribution. Neither choice changes another date.
Definition-only edits and later entry changes preserve that decision. Archiving does not delete history or silently unarchive on later edits.

A mutation UUID is bound to its accepted payload. An identical retry returns the current representation without another journal row, even after midnight. Reusing the UUID for a different payload returns HTTP `409` with `code` equal to `mutation_mismatch`.
Unknown and foreign habit IDs both return `404` before domain validation. Anonymous requests return `401`.

`HabitHistory` takes the owned habit's PostgreSQL row lock before reading mutable definitions, membership, or today's entry. Entry writes use the same lock and preserve existing timestamp and result-priority conflict rules.
The first entry insert snapshots the current locked definitions. Existing entries retain their original definitions when edited.

The immutable journal and `HabitTimeline` determine dated membership in commit order. Recurrence replacements restart on the effective date's Monday week, while strictly earlier dates remain unchanged.
A withdrawn rule grants only finite first-save eligibility through the latest date a valid device timezone could represent at admission. A delayed entry uses that grant without restoring heatmap membership.
`IHistoryReader.ReadOwnedRange` returns one through 365 inclusive dates from one owner-filtered repeatable-read snapshot, with at most three data queries regardless of the number of dates.

## Executable examples

`tests/Backend/ScheduledDateEligibility.feature`, `ScheduleEligibilityTests.cs`, and `ScheduledHabitsTests.cs` cover eligibility and the private read.
`tests/Browser/today.spec.ts` covers Today, travel, local midnight, and request states.
Use [Check a change](../../README.md#check-a-change) to rerun the repository checks.
