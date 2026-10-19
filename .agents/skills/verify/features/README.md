# Damadama verification map

Use these files as the maintained user-journey index. Read the selected journey and its existing spec before driving. The canonical Playwright invocation is the session owner described in [SKILL.md](../SKILL.md).

| Feature                                       | Integrated recipe                                                                                                                        | Additional boundary                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Session access](session-access.md)           | Expired/signed-out refusal and account data clearing in `habits.spec.ts` and `today.spec.ts`.                                            | Real SignIn and UserButton require the authorized provider workflow. |
| [Create a habit](create-habit.md)             | Creation, cancellation, validation and acknowledged save in `habits.spec.ts`, plus keyboard, mobile and zoom in `accessibility.spec.ts`. | Real Clerk enrollment is separate.                                   |
| [Saved habits](saved-habits.md)               | Full displayed values, reload persistence and owner isolation in `habits.spec.ts`.                                                       | Habit names are headings, not detail links.                          |
| [Today and calendar dates](today-calendar.md) | Scheduling, loading/error/retry, date changes and stale reads in `today.spec.ts`, plus the explicit past-date return journey.            | Device calendar dates differ from UTC edit times.                    |
| [Daily entries](daily-entries.md)             | Five results, commit acknowledgement, reload, retry and retained history in `entries.spec.ts`.                                           | Routed failure fixtures do not prove database failures.              |

The integrated mode uses actual production habit components, actual API endpoints and disposable PostgreSQL. TestApp replaces the Clerk issuer/signing key and server clock. Fixture account buttons and query parameters belong only to this harness.

For the first run use `bun run test:browser`. After its preparation, each feature provides a focused command. Combine overlapping recipes with the consolidated command in SKILL.md to keep one serial server session. Distinct test accounts isolate existing recipes; a fresh invocation resets their database.

Use the source/runtime that is actually under verification. Record any dirty product diff and rebuild before replaying changed inputs. Keep synthetic habit names and fixed dates in integrated evidence. Read [dev/README.md](../../../../dev/README.md) for current runtime, Docker and browser-library prerequisites. Canonical visual compatibility additionally requires Ubuntu 24.04 and its own reviewed baselines.

For every run record which feature IDs and entry points passed, failed or could not be reached. A feature with an unattempted provider branch is not fully verified. Keep the command, source identity, immediate result, persisted result and cleanup/evidence-survival result together. Preserve raw evidence outside generated fixture and build directories.
