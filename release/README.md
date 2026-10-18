# Stage main and promote the tested image

Merge reviewed PRs after their real `release-controls` and `check` jobs pass. A main push runs the required security and application checks, builds one image, scans its original evidence, publishes its digest, and signs it in a separate job. Staging requires fresh production verification before provider effects.

The signed integration is private preparation. The shared CI graph composition, exact-head native issuance, registry access, cold timing, and final repository validation remain required before activation.
Production uses `https://prod.damadama.app`. Preserve the existing apex site at `https://damadama.app`.

## Prepare the two hosting environments

Apply infrastructure changes only within the operator-approved scope.
Review [the spending limit and cost response](cost.md) first. No setup script provisions paid resources.

1. Create one Railway project with separate staging and production environments. Do not duplicate database data or environment secrets.
2. Create an empty app service and a PostgreSQL 17 service in each environment. Give each database a separate volume, database name, role, and password.
3. Keep PostgreSQL private. Remove its public TCP proxy. Mount its own volume at the image's PostgreSQL data directory.
4. Create separate backup buckets, bucket access keys, and age encryption recipients. Configure the daily logical-backup job from the recovery tooling.
5. Set the app instance to one replica, no sleeping, `/health/ready`, and a 300-second healthcheck timeout. `release/railway-service.example.json` describes those settings.
6. Use a Docker image source, with GitHub autodeploy and image auto-update disabled. Create a distinct private GHCR pull token for each environment, scoped only to `read:packages`, on Railway Pro.
7. Connect `staging.damadama.app` and `prod.damadama.app` with TLS on port 8080. Preserve the existing `damadama.app` site.
8. Create a separate Clerk application for staging. Activate its production instance for the approved staging domain. Production uses a different Clerk application's production instance.
9. Enable email-code signin. Set staging access mode to Invite-only. Admit only approved people and the two ordinary CI accounts. Disable passwords, email links, and social providers. Keep seven-day sessions.
10. Create two sample accounts only in staging. Record their Clerk IDs for automated runtime checks. Verify fresh code delivery in a designated real inbox separately.

Railway environment networking isolates private services. Environment project tokens are scoped to one environment.
Clerk recommends a separate staging application to isolate account data; its settings do not synchronize with production.
Local Aspire retains its own PostgreSQL volume and development Clerk instance.

Create runtime variables separately on each Railway app. Substitute the approved origin and the private database details:

```text
ConnectionStrings__habits=Host=postgres.railway.internal;Port=5432;Database=damadama_staging;Username=staging_app;Password=<staging-only password>
Clerk__Issuer=https://<staging-clerk-host>
Clerk__PublishableKey=pk_live_<staging-key>
Clerk__AuthorizedParties__0=https://<staging-app-origin>
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_HTTP_PORTS=8080
```

Production substitutes its own database, role, password, issuer, key, and origin. Do not include localhost or staging among production origins.
The app needs no Clerk secret key. It applies committed EF migrations before listening; `/health/ready` verifies the database and schema.

Copy `release/environments.example.json` into repository variable `RELEASE_ENVIRONMENTS` with actual nonsecret resource IDs and origins.
The controller rejects placeholders and shared environment IDs, volumes, buckets, database names/roles, Clerk applications, issuers, public keys, or origins.
It also compares the actual Railway token scope, app settings, private connection, and runtime Clerk origins with that policy.
Inspect each database service and volume during setup; the app check does not inspect PostgreSQL's volume attachment or backup-bucket permissions.

Configure these GitHub values:

| Boundary     | Variables                                                                                                                                             | Secrets                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Repository   | `RELEASE_ENVIRONMENTS`                                                                                                                                | None                                                |
| `staging`    | `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_TEST_USER_A`, `CLERK_TEST_USER_B` | Staging `RAILWAY_TOKEN`, staging `CLERK_SECRET_KEY` |
| `production` | Its own Railway IDs, `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`                                                                                            | Production `RAILWAY_TOKEN`                          |

Store backup credentials only in that environment's backup job. Keep age decryption identities with the recovery operator, outside the daily job.
Use environment-scoped Railway project tokens.

During approved setup, inspect an actual Railway deployment's `meta` and confirm which property contains its full immutable GHCR image reference.
Set `RAILWAY_DEPLOYMENT_IMAGE_PATH` in the staging and production GitHub boundaries to that observed property path.
The path is not established by unauthenticated schema inspection. Do not guess that `imageDigest` is the registry digest.
If the provider cannot report the complete immutable reference, this adapter refuses verification and needs a reviewed provenance alternative.
Service source settings alone never count as running-image evidence. A previously deployed but stopped/crashed production service requires recovery, not an initial-release exception.

## Observe automatic staging

1. Open **Main staging** for the merged main commit.
2. Wait for the security callers, control tests, application checks, build, scan, publication, signer, verifier, and staging jobs.
3. Inspect `verified-record-<attempt>` and the runtime evidence. A successful setup-only run has no verified record and cannot promote.

Staging has no human approval. The job verifies readiness, embedded commit and tree, ordinary Clerk sessions, saved values before reload, separate reload values, an owner's successful detail read before another account's refusal, sign-out, and invite-only signup refusal.
The outsider browser opens Clerk's ordinary signup component without an invitation and must observe **Access restricted** with no session. Public sign-in pages can remain visible. Application data still requires a valid ordinary Clerk JWT on every origin.

The two CI accounts use short-lived Clerk tickets to obtain ordinary sessions. This tests neither inbox delivery nor email-code login. Production approval includes that separate human attestation. No fixture authentication enters the image.
Test habits remain sample data because the current application has no permanent-delete endpoint.

`source` contains `{repository, commit, tree}`. `authority` contains `{sha, runId, attempt}`. Verified records use schema 3 and contain `evidence.supply`, which freezes the capsule artifact, signer job, and manifest hash. Older verified records cannot promote.
The controller checks current main before publication, before each provider mutation, and after runtime observation. The staging queue serializes deployments through final observation and never cancels an active deployment.

The build job has contents-read permission, no environment, and no provider or registry credentials. Only the publisher receives package-write permission. The isolated signer receives package-read, OIDC, and attestation-write permissions. The verifier and deployment jobs receive package-read permission. Every deployment admission reacquires original artifacts, verifies production signatures and registry content, and checks the current vulnerability database. The signer does not build, scan, or acquire a database.
The first provider metadata observation remains a separate approved setup task. The adapter cannot claim success from configured service source alone. Keep already published recovery image digests as historical setup artifacts. `package-recovery.mjs` and the recovery role of `images.mjs` retain the trusted recovery packaging and publication primitives.

## Approve production

1. Select a successful **Main staging** run for current main while its original artifacts remain available and its scan and database remain current.
2. Complete an ordinary email-code login with a real inbox. Review the saved values, migrations, and rollback compatibility.
3. Take a production backup and verify the measured isolated restore and seven-day retention.
4. Dispatch **Promote verified release** with the staging run ID, semantic version, short notes, and recovery evidence.
5. Read the preflight summary and `promotion-plan-1`. Compare the source, image digest, staging attempt, supply identity, record hash, plan hash, migrations, and recovery evidence.
6. Approve the protected `production` environment for that plan.
7. Inspect the deployment receipt, then complete production email login and save/reload checks.

The secretless preflight authenticates the successful main-push workflow, exact attempt jobs, artifact run membership, immutable IDs, and ZIP transport digests. It performs full signed admission and freezes the schema 2 plan before the approval gate.
The protected job rereads the plan and staging artifacts after approval. It repeats native authority checks, full signed admission, and native authority checks at every protected boundary. It compares the canonical plan and record hashes and deploys the same registry digest without rebuilding.
GitHub artifacts have no native attempt field. Attempt names, actual producer jobs, and their creation intervals establish attempt membership. A ZIP digest is not the canonical record hash.
Environment approval authorizes a run and environment. The workflow binds that approval to the frozen plan through the dependency graph and postapproval readback. Rerun promotion attempts refuse because the approval API does not identify attempts. Dispatch a new promotion instead.

Historical staging evidence proves the selected image passed at the recorded time. It does not claim that staging still runs the image. Production needs no staging credentials and independently observes its own deployment.

The first release uses `previousImage: null` and `compatibilityEvidence: "initial-release"`. Later releases supply the current immutable production image and a compatibility evidence URL.
The recovery input has this shape; every example value must be replaced with observed evidence:

```json
{
  "backupId": "observed-backup-object-id",
  "completedAt": "2026-10-12T03:00:00Z",
  "retentionDays": 7,
  "restoreSeconds": 120,
  "restoreEvidence": "https://github.com/ShiosOS/Damadama/issues/REPLACE",
  "previousImage": null,
  "compatibilityEvidence": "initial-release"
}
```

This is operator-supplied recovery evidence, validated for freshness and shape after protected approval. It is not a provider backup discovery API.
Promotion refuses a backup older than 24 hours, a restore over one hour, a mismatched prior image, or a stale main commit.
A previously deployed unhealthy service cannot use the initial-release exception.

If main advances after a provider write, the run fails with an **applied-but-unverified** outcome and the actual deployment ID when available. The GitHub release stays draft. No automatic rollback is claimed.

## Diagnose and recover

Use the workflow summary's deployment ID to open Railway deployment logs. Inspect migration startup failures, schema readiness, and app trace IDs.
The backend emits JSON logs; store neither connection strings nor Clerk tokens in PR evidence.
Public workflow artifacts retain a sanitized deployment summary and synthetic habit screenshots, not raw production logs.
Build originals, scan originals, publication evidence, signed capsules, and runtime reports have three-day retention. Source, migration metadata, verified records, and promotion plans have 90-day retention.
Admission can end sooner when main advances, an artifact is deleted, a scan reaches 24 hours, a database reaches 120 hours, or the current upstream database changes. Every admission downloads the original evidence again.
These retention periods do not promise a 90-day promotion or rollback window. This controller provides no rescan or reissue lifecycle and never silently rebuilds a selected promotion candidate.

App rollback redeploys a previously verified digest after explicit approval and proof that it reads and writes the current schema.
It does not run EF `Down`. The initial migration's `Down` deletes both habit tables.
If compatibility is unknown, stop and use the separately approved restore procedure from the recovery runbook.
Railway's short provider rollback retention is supplementary. The retained immutable registry digest is the rollback source.

## Provider references

- [Railway service API](https://docs.railway.com/integrations/api/manage-services)
- [Railway deployment API](https://docs.railway.com/integrations/api/manage-deployments)
- [Railway environment-scoped tokens](https://docs.railway.com/integrations/api)
- [Railway private networking](https://docs.railway.com/networking/private-networking)
- [Clerk staging isolation](https://clerk.com/docs/guides/development/managing-environments)
- [Clerk signin tickets](https://clerk.com/docs/reference/backend/sign-in-tokens/create-sign-in-token)
- [GitHub queued concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

- [Clerk invite-only access](https://clerk.com/docs/guides/secure/restricting-access)
