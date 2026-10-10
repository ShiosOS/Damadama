# Damadama rewrite requirements

These are the user's requirements for review. Coding still needs approval. The implementation proposal is separate from the product rules. Resolve each open decision before coding the behavior it affects.

## Functional requirements

### FR-01. Accounts and ownership

Users can sign in and access only their own habits, schedules, and entries. The authentication provider is undecided.

### FR-02. Habits

Users can create a named habit and define what Good, Better, and Best mean for it.

### FR-03. Recurring schedules

Each habit has its own calendar-based repeat schedule. Users can choose days and repeat intervals. Preserve schedule history so later edits do not change which habits were scheduled on past dates. Missed days do not carry forward.

### FR-04. Daily entries

Users can select Good, Better, Best, or Rest for a scheduled date. Allow at most one entry per habit per date. Users can revisit past scheduled dates and change their selection.

### FR-05. Combined heatmap

Show one GitHub-style heatmap for the past year across all habits.

- Good earns 1 point, Better 2, Best 3, and Rest 0.
- The daily maximum is 3 times the number of habits scheduled that day.
- Opacity equals points earned divided by the daily maximum.
- Rest stays in the daily maximum.

### FR-06. Local dates

Today follows the device's current timezone, including during travel. Saved entry dates stay fixed. Record the time of an edit separately from the habit's calendar date.

### FR-07. Offline saves

Store pending entry changes on the device and mark them as pending. Retry temporary failures automatically with the original `loggedAt` timestamp. After a successful response, reconcile with the server's winning value.

### FR-08. Conflict resolution

The change with the newest `loggedAt` wins. Exact timestamp ties prefer Best > Better > Good > Rest. Identical timestamp and result pairs make no further change. Enforce this comparison atomically in PostgreSQL. Device-clock inaccuracies are an accepted limitation.

### FR-09. Live updates

Other open devices update automatically, targeting about two seconds under normal conditions. Use best-effort notifications and refetch on reconnect or app focus. Screens may stay stale during failures, but saved data must remain intact.

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01. Scale | Start at a small scale. This version does not need to support 1 million daily active users. |
| NFR-02. Responsiveness | Keep ordinary use responsive and measure latency. No numeric API latency target is agreed yet. |
| NFR-03. Persistence | Acknowledge a server save only after its database transaction commits. |
| NFR-04. Recovery | Use persistent database storage, backups, and a tested restore procedure. |
| NFR-05. Security | Use HTTPS, server-side ownership checks, input validation, and private database access. Commit no secrets to the repository. |
| NFR-06. Hosting | Avoid intentional idle sleeping and cold starts. Brief downtime during deployments or failures is acceptable for the initial single-instance setup. |
| NFR-07. Maintainability | Keep one modular backend with heatmap logic inside it. Do not add microservices or a query cache initially. |
| NFR-08. Verification | Include automated domain tests, real PostgreSQL integration tests, and browser tests for critical flows, including offline recovery. |
| NFR-09. Open source | Document local startup, example configuration, migrations, and reproducible deployment instructions. |
| NFR-10. Cost | Target roughly $10-15 per month initially and monitor actual usage. This estimate is not a spending cap. |

## Proposed implementation

Use ASP.NET Core, Vue with TypeScript, and PostgreSQL. One Railway app service serves the API and built frontend. Store pending browser changes in IndexedDB. Use in-process SSE notifications for one app instance. Add cross-instance pub/sub only if replicas are introduced.

This proposal does not approve paid provisioning or deployment.

## Open product decisions

- Exact recurrence options and representation.
- When schedule edits take effect, including multiple edits on the same day.
- How to display a day with no scheduled habits.
- The authentication provider.
- Habit editing, archiving, and deletion behavior.

[The design's open questions](design.md#unresolved-decisions) include additional questions from review. Those questions are not new requirements or settled rules.

## Working instructions

Explain the design before changing it. Build one small slice at a time, demonstrate it with tests and runtime evidence, and stop for review. Resolve open product rules before implementation. Do not provision paid infrastructure without approval.

Treat the original project at `../Damadama/` as a read-only reference. Do not modify it, deploy, or change DNS. Writing deployment instructions does not approve deployment.

## Related documents

- [System design](design.md) contains the implementation proposal and test plan.
- [Domain glossary](CONTEXT.md) defines terms without implementation decisions.
- [Project management](README.md) links the tracker and explains how to record decisions, work, and review evidence.
