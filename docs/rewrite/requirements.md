# Damadama rewrite requirements

Status: user-supplied requirements for review. Application implementation is not yet approved. The proposed implementation below is distinct from the product requirements. Unresolved rules stay unresolved until discussed before the affected behavior is implemented.

## Functional requirements

### FR-01. Accounts and ownership

Users can sign in and access only their own habits, schedules, and entries. Authentication provider is not selected yet.

### FR-02. Habits

Users can create a named habit and define what Good, Better, and Best mean for it.

### FR-03. Recurring schedules

Each habit has its own calendar-based repeat schedule. Users can choose days and repeat intervals. Preserve schedule history so later schedule changes do not alter which habits were scheduled on past dates. Missed days do not carry forward.

### FR-04. Daily entries

Users can select Good, Better, Best, or Rest for a scheduled date. Allow at most one entry per habit per date. Users can revisit past scheduled dates and change their selection.

### FR-05. Combined heatmap

Show one GitHub-style heatmap covering the past year across all habits.

- Good = 1, Better = 2, Best = 3, Rest = 0.
- Daily maximum = 3 times the number of habits scheduled that day.
- Opacity = points earned divided by daily maximum.
- Rest remains included in the daily maximum.

### FR-06. Local dates

Today follows the device's current timezone, including during travel. Saved entry dates stay fixed. Record the time of an edit separately from the habit's calendar date.

### FR-07. Offline saves

Persist pending entry changes on the device, visibly mark them as pending, and retry temporary failures automatically. Preserve the original loggedAt timestamp on retries. Reconcile with the server's winning value after a successful response.

### FR-08. Conflict resolution

The change with the newest loggedAt wins. Exact timestamp ties prefer Best > Better > Good > Rest. Identical timestamp/result pairs make no further change. Enforce this comparison atomically in PostgreSQL. Device-clock inaccuracies are an accepted limitation.

### FR-09. Live updates

Other open devices should update automatically, targeting about two seconds under normal conditions. Use best-effort notifications and refetch on reconnect or app focus. Occasional stale screens during failures are acceptable; saved data must remain intact.

## Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-01. Scale | Small initial scale. No requirement to support 1 million daily active users in this version. |
| NFR-02. Responsiveness | Responsive ordinary use. Measure latency; no numeric API latency target is agreed yet. |
| NFR-03. Persistence | Acknowledge a server save only after its database transaction commits. |
| NFR-04. Recovery | Persistent database storage, backups, and a tested restore procedure. |
| NFR-05. Security | HTTPS, server-side ownership checks, input validation, private database access, and no secrets committed to the repository. |
| NFR-06. Hosting | Avoid intentional idle sleeping/cold starts. Brief deployment or failure downtime is acceptable for the initial single-instance setup. |
| NFR-07. Maintainability | One modular backend, with heatmap logic inside it. No separate microservices or query cache initially. |
| NFR-08. Verification | Automated domain tests, real PostgreSQL integration tests, and browser tests for critical flows, including offline recovery. |
| NFR-09. Open source | Documented local startup, example configuration, migrations, and reproducible deployment instructions. |
| NFR-10. Cost | Target roughly $10-15 per month initially and monitor actual usage. This is an estimate, not a guaranteed spending cap. |

## Proposed implementation

ASP.NET Core, Vue with TypeScript, and PostgreSQL. One Railway app service serves the API and built frontend. Store pending browser changes in IndexedDB. Use in-process SSE notifications while there is one app instance. Add cross-instance pub/sub only if replicas are introduced.

This proposal does not authorize paid provisioning or deployment.

## Product decisions to clarify before affected implementation

- Exact recurrence options and representation.
- When schedule edits take effect, including multiple edits on the same day.
- How to display a day with no scheduled habits.
- Authentication provider.
- Habit editing, archiving, and deletion behavior.

Additional questions surfaced during design review are recorded in [design.md](design.md#unresolved-decisions). They are not new requirements or settled rules.

## Working instructions

Explain the relevant design before changing it. Build one small slice at a time, demonstrate it with tests and runtime evidence, and stop for review. Do not invent unresolved product rules or provision paid infrastructure without approval.

The original project at `../Damadama/` remains a read-only reference. Earlier instructions also prohibit modifying that app, deploying, or changing DNS. Reproducible deployment instructions are a documentation requirement, not authorization to deploy.

## Document responsibilities

- This document records the requirements supplied by the user.
- [design.md](design.md) contains a revisable implementation proposal and verification plan.
- [CONTEXT.md](CONTEXT.md) contains domain definitions, without implementation decisions.
- [Project management](README.md) links the GitHub tracker and explains how decisions, proposed slices, and review evidence are recorded.
