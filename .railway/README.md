# Railway definitions and isolated previews

This is a preparation PR. It does not enable previews, apply infrastructure, change trusted deployment sources or enable tracing. The three explicit targets are `staging`, `production` and a new empty `preview-base`. Unknown targets fail before producing a definition.

## Validate the definitions

Use Node 24. Install the isolated tooling lock and run its checks from the repository root.

```sh
npm ci --prefix .railway --ignore-scripts --no-audit --no-fund
npm run check --prefix .railway
```

The checks evaluate the real Railway SDK definition and reject missing resources, trusted source ownership, secret replacement, database exposure, removed backup schedules, copied preview data and missing caps. These are offline checks. They do not establish a live no-change plan or a working preview.

The root frozen Bun install supplies the same pinned SDK for `bun run check:railway`. The required `bun run check` runs that suite and includes the authoring file in TypeScript coverage and compilation.

The SDK is pinned to `railway` 3.16.0 in its own lock. Railway CLI 5.70.0 is required separately. Use a private installation of the [official release](https://github.com/railwayapp/cli/releases/tag/v5.70.0), leaving global runtimes unchanged. Verify the archive SHA256 before extraction.

| Archive                                           | SHA256                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `railway-v5.70.0-x86_64-pc-windows-gnu.tar.gz`    | `dfdb77bd230aeeb7611865c873d77b87f64cfeef2af22330baad93916743e3fc` |
| `railway-v5.70.0-x86_64-unknown-linux-gnu.tar.gz` | `9225eb5144e4174d1a88ac47c7bf8caf9d566679414086606322e586d64ee0f5` |

## Verify the existing infrastructure import

The definition was prepared from redacted connected inventory on 2026-10-18. It declares the existing services, volumes, buckets, domain settings, caps, private database mount and daily encrypted backup schedules separately for each environment. Existing variables use `preserve()`. Existing service sources and registry credentials are deliberately omitted. The application release controller must retain exclusive ownership of its image digest. The graph contains no application image digest for IaC to roll back on the next release.

Import fidelity is **not verified** until actual redacted no-change plans succeed for both environments. Connected Railway authentication does not authenticate the CLI. Initial real plan attempts for both targets exited 1 with `Not authenticated`. No credential was extracted from the connector and no offline fixture was counted as a live plan.

Normal CLI login was subsequently authorized and completed. Actual authenticated default-redacted plans now exit 2 with 0 additions, 5 changes and 0 deletions in staging, and 0 additions, 3 changes and 0 deletions in production. CLI 5.70.0 proposes clearing omitted image sources and their registry credentials, contrary to the documented omission expectation. The staging image had advanced independently since the initial inventory; the live plan still proposes removing that current source. This fails the release-controller ownership requirement. No plan was applied. Import and activation remain blocked on source-preserving native plan behavior. The authoring file rejects ordinary trusted `apply`. Saved-plan apply bypasses authoring evaluation, so do not create or apply saved artifacts for this blocked import.

After independent review, use a clean checkout of that exact reviewed commit. Authenticate through legitimate `railway login` or an explicitly supplied environment-scoped project token, then link that private checkout to the existing Damadama project. Do not print, decrypt, inline or copy existing secret values. Never evaluate unreviewed PR-authored IaC with Railway credentials. The new GitHub workflow deliberately receives no Railway credentials and only runs offline checks.

Set `RAILWAY_CLI` to the pinned executable and use process-local Node 24, then run each command with the full reviewed commit SHA. The wrapper adds the private CLI directory to the child PATH because the SDK verifies the CLI by executable name.

```sh
node .railway/plan.mjs staging FULL_REVIEWED_COMMIT_SHA
node .railway/plan.mjs production FULL_REVIEWED_COMMIT_SHA
```

The wrapper checks the exact clean authoring tree and CLI version, runs `config plan --detailed-exit-code`, and prints only its status. Exit 0 means no changes, exit 2 means drift, and exit 1 means an error or missing prerequisite. It never applies. Do not upload raw JSON plans, current graphs, pinned plan artifacts or verbose errors. They can contain secrets even when a terminal diff is redacted. To investigate drift, run a fresh local default-redacted text plan with the same pinned CLI and target. Avoid `--show-values` and `--decrypt-variables`.

Before approving any future apply, compare a normal default-redacted `config pull` in a disposable reviewed checkout against this definition. Reconcile every unknown service setting, volume backup schedule, alert and registry setting without overwriting existing values. Require a no-change plan for staging and production, and verify a newer live application digest still yields no source change. Unavailable authentication keeps this gate closed. `plan.mjs` does not independently establish that its SHA was reviewed; the reviewer supplies that fact.

Do not treat `release/railway-service.example.json` or `ops/recovery/railway-cron.example.json` as native Railway configuration. They are application release/recovery input contracts. This PR introduces no deprecated `railway.json` or `railway.toml`.

## Activate isolated native PR previews after approval

1. Approve the exact resource plan and cost separately from this code PR. Use the existing project. Leave staging and production image-backed. Do not enable GitHub source, Wait for CI or native PR previews against either trusted environment.
2. Create an **empty**, isolated `preview-base` environment. Do not duplicate or sync staging or production. Its entire inventory must contain only `preview-app`, `preview-postgres` and `preview-postgres-volume`. It must have no buckets, backup jobs, trusted credentials or copied data. Never promote or sync a preview back into a trusted environment.
3. Configure only `PREVIEW_CLERK_ISSUER` and `PREVIEW_CLERK_PUBLISHABLE_KEY` as shared preview values, from a dedicated Clerk development instance containing synthetic preview accounts only. Set that instance's generated-domain allowlist and redirect settings. Do not reuse staging or production Clerk settings, accounts or secret keys. Preview code can read every variable made available to it.
4. Plan the reviewed `preview-base` definition with the pinned CLI and inspect it before approval. It declares a digest-pinned PostgreSQL 17 database, matching the existing major version, and an explicitly fresh 1 GB volume with `forkFromBaseEnvironment: false`. The explicit PostgreSQL service uses Railway secret generation for its own database password. Do not seed it from a backup or trusted database. Confirm the resulting database's private address, generated credentials, fresh volume and 0.5 CPU/500 MB cap in readback before enabling previews. No PostgreSQL domain or TCP proxy is permitted.
5. The preview app alone uses the native GitHub source for this repository, the dedicated preview Dockerfile, `/health/ready`, one replica and a 0.5 CPU/500 MB cap. Its database connection references only `preview-postgres` in the same environment. Its authorized party is its generated Railway domain. Configure a Railway-provided domain for the base app before enabling native PR environments so PR domains are generated automatically. Do not add custom domains to the graph.
6. Read back both service configurations and every variable name. The app must have only its four declared application settings plus Railway-provided values. The base's only shared settings must be the two preview Clerk values. Database credentials must come from its disposable database. Reject inherited `AWS_*`, backup metadata, deployment tokens, registry credentials and trusted database URLs. Verify empty database tables before the first test. No resource should have native tracing enabled as part of this activation.
7. Before enabling native PR environments, select `preview-base` as their base in Project Settings > Environments and read back that exact selection. Railway defaults to production. Keep native previews disabled until the selection is verified, including for existing open PRs. Then enable native previews for trusted workspace contributors only. Leave bot previews off initially. Focused PR environments may be enabled after confirming that the app's database reference brings PostgreSQL into each preview. Native Wait for CI is optional preview convenience. It cannot replace the trusted release predicates.
8. Run a synthetic pilot PR. Verify a generated HTTPS domain, preview-only Clerk sign-in, save and reload, and fresh database/volume identity. Confirm no trusted data is reachable. Close the pilot PR and read back automatic deletion of its environment, services and volume. Native cleanup is documented for closed or merged PRs, but pilot cleanup is an activation proof that remains outstanding. Keep a daily stale-preview audit and manually close/remove abandoned previews after 24 hours. Do not enable broad automatic cleanup against trusted environments.

## Cost and rollout limits

Start with at most one open preview during the pilot. After measuring it, propose a limit of three open previews plus the base. Native PR environment settings do not establish a hard concurrency or lifetime cap. The proposed count and daily audit are operator controls that must be arranged before broad enablement.

At each environment's declared maxima, the app and database together have one vCPU, 1 GB RAM and a 1 GB volume. The [current container rates](https://docs.railway.com/pricing/plans) give an estimated resource ceiling of about $0.042 per hour or $1.01 per day per environment. This uses the documented per-minute CPU, memory and volume rates. Four continuously saturated environments are about $4.02 per day before egress at $0.05/GB and any subscription difference. Actual CPU and RAM are billed by use. This is an estimate, not a spending cap or a verified bill. Builds are currently free. Set a separate approved workspace usage limit with its interruption impact understood; it affects the workspace, including existing services. No budget or platform limit has been changed.

Required remaining evidence is two actual trusted no-change plans, a reviewed preview creation plan, dedicated preview auth setup, resource/credential readback, pilot application proof, measured cost, and observed automatic cleanup. None is implied by passing offline CI.

Primary references are [IaC](https://docs.railway.com/infrastructure-as-code), [the current authoring API](https://docs.railway.com/infrastructure-as-code/reference), [native PR environments](https://docs.railway.com/environments), and [deployment teardown](https://docs.railway.com/deployments/deployment-teardown).
