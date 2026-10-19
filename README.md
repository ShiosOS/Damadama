# Damadama

Create and list private habits with Good, Better, and Best definitions and a weekday schedule.
Planning and the system design live in the [Damadama Notion home](https://app.notion.com/p/3f69c0510118817188ebdee8acecaef5).

Use the [Codex Cloud setup guide](.codex/cloud/README.md) for cloud development.
Use the [local setup and contribution guide](dev/README.md) for Windows and Linux prerequisites, doctor, focused checks, formatting, and PR evidence.

## Start locally

Install .NET SDK 10.0.112, Bun 1.4.3, Node.js 24 LTS, and Docker with a running Linux container engine.
Node.js runs Playwright. Bun manages the frontend dependencies and scripts.
Trust your .NET development certificate with `dotnet dev-certs https --trust` if you use the HTTPS Aspire dashboard.

1. Copy `.env.example` to `.env.local` at the repository root.
2. Set your Clerk development publishable key and issuer. Keep the listed local browser origins or change them to match your browser URL.
3. Set a PostgreSQL password once. Keep that password when you restart because the local database uses the `damadama-first-slice-postgres` Docker volume.
4. Run `bun run start` from the repository root.

Open [Damadama](http://localhost:5173). The backend is at `http://localhost:5050` and also serves the built frontend.
Aspire starts PostgreSQL, waits for it, starts the backend, applies EF Core migrations, and waits for readiness before starting Vite.
Press Ctrl+C to stop. The database volume remains.

In the Clerk development dashboard, enable email sign-up and verification with an email code, and enable sign-in with an email code.
Disable email links, passwords, and social providers for this flow. Set the maximum session duration to seven days.
The application needs no Clerk secret key. Use the instance's issuer from its OpenID discovery document.
Clerk's built-in Vue sign-in component follows these instance settings.

## Check a change

Run `bun run check`. The first run downloads Chromium, which subsequent runs reuse.
The command checks locked dependencies, TypeScript and Vue types, typed lint, builds, formatting, domain rules, Reqnroll API examples, PostgreSQL integration, and browser flows.
The API uses ordinary JSON and resource URLs. Native ASP.NET endpoint metadata generates OpenAPI 3.1 at `/openapi/v1.json` in Development and Testing. `server/ApiContract.cs` and `server/redocly.yaml` own the schema conventions and lint policy. Backend tests export a fresh document and observed HTTP responses to `.audit/api-contract`; the check validates them with pinned Redocly and Ajv, and CI retains them as artifacts. The database-free generator smoke test writes only to `.audit/api-contract-smoke`.
Run `bun run check:types` for the TypeScript gate without Docker. It covers the web app, Vite configs, browser fixture and tests, and Bun scripts. The gate inventories every maintained `.ts`, `.tsx`, `.mts`, `.cts`, and `.vue` file and rejects files outside a checked project, Vue scripts without `lang="ts"`, and type or lint suppressions. Compiler and lint rejection probes run against the same configs.
Keep Vue props, emits, state unions, and view-only types next to their component. Derive wire types from the Zod schemas in ordinary TypeScript modules; parse external data at the request boundary. Explicitly type function inputs and returns and state contracts, while letting local values with clear initializers infer their types.
An unavailable Docker engine fails the command. Testcontainers databases are separate from your persistent local database.
Pull request checks cache dependencies, cancel superseded runs, and retain verification artifacts from successful and failed runs for seven days.
The [browser performance checks](tests/Browser/performance.md) document fixed production-asset, layout, and request budgets, the baseline, and fixture limits.
The [browser accessibility checks](tests/Browser/accessibility.md) cover WCAG scans, keyboard creation, API refusal, mobile layout, and CSS zoom, with explicit provider limits.
Browser tests use optimized assets and exclude authentication tokens from reports.

Acceptance examples use ephemeral RSA-signed tokens through the ordinary JWT middleware configured by the test host.
Playwright mounts the actual habit page through a separate entry in `tests/Browser`, backed by the actual API and PostgreSQL.
These tests prove habit behavior and authentication refusal. They do not prove Clerk sign-in or email delivery.
To verify Clerk, sign in through the running app using an email code, save a habit, inspect the complete saved row before reloading, then reload and check that every value remains visible.

## Configuration and database changes

Local settings and test reports are ignored by Git. Set these values through the environment when running the backend independently:

- `ConnectionStrings__habits` is the PostgreSQL connection string.
- `Clerk__Issuer` identifies the Clerk instance whose signatures the server accepts.
- `Clerk__AuthorizedParties__0` and subsequent indexes list permitted browser origins for the token's `azp` claim.
- `Clerk__PublishableKey` is returned by `/api/config` so the same frontend build can run with different environment settings.

Only the publishable key is returned as public configuration. Issuer, expiry, signature, subject, and authorized origin are checked on the server.
`/health/live` reports process liveness. `/health/ready` checks the database, migrations, and habit schema.

Run `dotnet tool restore` before using EF tools. Add a migration with `dotnet ef migrations add Name --project server` and review it.
The backend applies committed migrations before accepting requests. Creation saves the habit and initial schedule in one transaction and returns success only after commit.
It derives the calendar date from the server's UTC creation instant in the device's IANA timezone, and stores that date and its Monday anchor separately from the instant.

## Release

Release setup starts with the [PR checks and release environment setup](release/setup.md). Use the [release runbook](release/README.md), [cost response](release/cost.md), and [recovery procedure](ops/recovery/README.md) for operations. The [release design](https://app.notion.com/p/3f69c05101188143930adb65df71cec0) describes source identity and deployment trust.
