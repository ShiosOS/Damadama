# Repository checks

Use [README.md](README.md) for local commands and [Notion](https://app.notion.com/p/3f69c051011881e1bc4ec68e47231420) for planning and system design.
Run `bun run check` before handing off a code change. CI runs the same command.

## Evidence

Commit reusable tests, verification scripts, API contracts, and runbooks.
Store per-run logs, screenshots, recordings, traces, and reports as PR attachments or CI artifacts.
Use the [PR template](.github/pull_request_template.md) to summarize the tested revision, environment, results, limitations, and proof links.
Retain durable release and recovery receipts under their established policy.
The [PR evidence check](.github/workflows/pr-evidence.yml) enforces the current head SHA, required proof, and generated-output locations.
Its [behavior tests](scripts/pr-evidence.test.mjs) run in `bun run check`.

## Domain rules

| Rule                                                                                                                                                    | Enforcement                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use branches for nested conditional logic in JavaScript, TypeScript, and Vue expressions.                                                               | `eslint.config.mjs`, run by `bun run lint` and `bun run check`.                                                                                                                             |
| Create Good, Better, and Best together as nonblank `HabitLevels`, preserve accepted text, and keep public validation keys `good`, `better`, and `best`. | `HabitLevels.Create`, `HabitLevelsTests`, and `ValidationTests`.                                                                                                                            |
| Keep integer ISO weekdays Monday 1 through Sunday 7, distinct sorted selections, the device calendar date, and the Monday repeat anchor.                | Literal examples in `HabitTests.Requires_selected_ISO_weekdays`, `Stores_distinct_sorted_ISO_weekdays_including_Monday_and_Sunday`, and `Preserves_device_calendar_date_and_Monday_anchor`. |
| Keep the EF relational model consistent with migrations and preserve existing flat definition columns and rows.                                         | `MigrationTests.Existing_flat_columns_survive_migration_and_fresh_materialization`, including `HasPendingModelChanges` and an independent SQL read.                                         |
