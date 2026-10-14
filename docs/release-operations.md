# Deploy and promote a verified candidate

This tooling depends on the release-policy foundation in PR #13. Both PRs target `main` and require review before merge.
Land the foundation, then this tooling and the recovery tooling, then activate the full gate before any application merge.
The runtime-check workflow composes the pinned foundation revision for secretless CI while that dependency is unmerged.
Update this branch against `main` after the foundation lands. Deployment workflows require their definitions on the default branch.

## Prepare the two hosting environments

Infrastructure, domains, and deployment each require explicit operator approval. This guide does not grant that approval.
Review [the cost estimate](hosting-cost.md) first. No setup script provisions paid resources.

1. Create one Railway project with separate staging and production environments. Do not duplicate database data or environment secrets.
2. Create an empty app service and a PostgreSQL 17 service in each environment. Give each database a separate volume, database name, role, and password.
3. Keep PostgreSQL private. Remove its public TCP proxy. Mount its own volume at the image's PostgreSQL data directory.
4. Create separate backup buckets, bucket access keys, and age encryption recipients. Configure the daily logical-backup job from the recovery tooling.
5. Set the app instance to one replica, no sleeping, `/health/ready`, and a 300-second healthcheck timeout. `release/railway-service.example.json` describes those settings.
6. Use a Docker image source, with GitHub autodeploy and image auto-update disabled. Create a distinct private GHCR pull token for each environment, scoped only to `read:packages`, on Railway Pro.
7. After domain approval, connect the separate app origins with TLS and route the app service to port 8080. Use a same-origin UI and API.
8. Create a separate Clerk application for staging. Activate its production instance for the approved staging domain. Production uses a different Clerk application's production instance.
9. Enable email-code signup and signin in both Clerk instances. Disable passwords, email links, and social providers. Keep seven-day sessions.
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

| Boundary               | Variables                                                                                                                                             | Secrets                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Repository             | `RELEASE_ENVIRONMENTS`, `RELEASE_GATE_APP_ID`                                                                                                         | None                                                    |
| `staging`              | `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`, `CLERK_TEST_USER_A`, `CLERK_TEST_USER_B` | Staging `RAILWAY_TOKEN`, staging `CLERK_SECRET_KEY`     |
| `staging-verification` | The same staging Railway IDs                                                                                                                          | Staging `RAILWAY_TOKEN`, `RELEASE_GATE_APP_PRIVATE_KEY` |
| `production`           | Its own Railway IDs, `APP_ORIGIN`, `CLERK_PUBLISHABLE_KEY`                                                                                            | Production `RAILWAY_TOKEN`                              |
| `image-publication`    | None                                                                                                                                                  | None                                                    |

Store backup credentials only in that environment's backup job. Keep age decryption identities with the recovery operator, outside the daily job.
Use environment-scoped Railway project tokens, not account tokens. The verifier App has only Checks write and Metadata read.

During approved setup, inspect an actual Railway deployment's `meta` and confirm which property contains its full immutable GHCR image reference.
Set `RAILWAY_DEPLOYMENT_IMAGE_PATH` in the staging, staging-verification, and production GitHub boundaries to that observed property path.
The path is not established by unauthenticated schema inspection. Do not guess that `imageDigest` is the registry digest.
If the provider cannot report the complete immutable reference, this adapter refuses verification and needs a reviewed provenance alternative.
Service source settings alone never count as running-image evidence. A previously deployed but stopped/crashed production service requires recovery, not an initial-release exception.

## Publish images for first setup

The first setup needs registry images before Railway can report an actual deployment's image metadata.
Use **Publish deployment images** to publish those images without granting deployment access.

1. Merge the reviewed publication tooling through the bootstrap procedure. Refresh the application PR against current `main` and wait for its current CI.
2. Inspect the GitHub configuration plan. Apply and inspect the approved current policy to create `image-publication` with a reviewer, a `main` restriction, and no administrator bypass. Keep this boundary free of secrets.
3. Dispatch **Publish deployment images** from `main` with the application PR number. Review its source and migration artifacts, then approve only `image-publication`.
4. Download `image-publication-<attempt>` and record both immutable references from `publication.json`. Verify both GHCR packages are private and accessible to the approved environment pull tokens.
5. Obtain approval for the first setup deployment. Inspect its actual Railway metadata before configuring `RAILWAY_DEPLOYMENT_IMAGE_PATH` and running normal staging verification.

The app build uses the proposed application source. The recovery build uses the trusted controller commit.
Both builds run without package-write credentials. The fresh publisher executes only pinned controls, with a temporary GitHub token and no Railway, Clerk, or verifier credentials.
It validates both archives before either push and checks current source and CI before each push and before saving the receipt.
A failed second push can leave an unreferenced image. A failed run produces no successful publication receipt.

The receipt has `kind: "image-publication"`. It proves no deployment, Clerk sign-in, backup, restore, or runtime verification.
It cannot issue either verifier check or be promoted as a verified release.
Do not approve **Verify candidate in staging** merely to publish an image while the provider metadata path is missing.
Old queued runs and artifacts belong to their original controller commit. After tooling changes, dispatch a fresh run.

## Stage an application PR

1. Update the PR against current `main`. Require `check` and `release-controls` to succeed on its current head. The controller verifies that head contains current main and that its complete tree equals the proposed merge tree.
2. Dispatch **Verify candidate in staging** on `main` with the PR number. Draft application PRs may be staged.
3. Review the candidate source tuple and `migrations.sql` in its build artifact before approving the `staging` deployment.
4. Confirm the staging backup and forward-schema compatibility decision. Then approve deployment explicitly.
5. Wait for actual runtime checks. They verify readiness, unauthorized API refusal, runtime configuration, source identity, actual Clerk sessions, habit creation/reload, ownership refusal, and sign-out clearing.
6. Open the exact staging deployment while the workflow holds the queue. Complete an ordinary fresh email-code sign-in in a real inbox.
7. Inspect the screenshots/recording, complete saved values, migration result, backup/restore evidence, and rollback compatibility decision.
8. Approve `staging-verification` only after that checklist passes. This approval is a human attestation to email delivery and operational review for this run.

The entire workflow uses `queue: max` and never cancels an active staging verification. Up to 100 runs can wait.
Approval waits allocate no job runner. Cancel a failed or abandoned review explicitly to free the queue.
Any head/base/source change or replacement deployment causes verification to fail. Dispatch the new candidate again.
Dashboard deployment changes cannot inherit this run's success. Treat an interrupted deployment as unknown until provider readback resolves it.

The build job receives contents-read only and no environments, secrets, OIDC, or shared privileged build cache.
Only the trusted Dockerfile executes candidate build code, inside its build containers. Fresh privileged jobs execute pinned main controls.
The image contains one ASP.NET host and fresh Vue assets. It excludes fixture hosts, Aspire, and credentials.
Node 24 runs Vue tooling. Bun handles dependencies. The exact SDK 10.0.112 archive uses Microsoft's published SHA-512 because its Docker tag is unavailable.

Clerk automation creates short-lived signin tickets for the two actual staging accounts and obtains ordinary Clerk sessions in the production UI.
It does not exercise the email-code delivery path. The protected final approval records that path as operator-attested, never as automated mail proof.
No fixture issuer, JWT signing key, Vite fixture entry, or test-host switch enters the hosted image.
Staging test habits remain sample data; this first feature has no permanent-delete endpoint.

Before App success, the final job rechecks CI, source, environment isolation, and active deployment.
The record includes actual successful head CI check IDs and run links. It uploads that immutable record first, then publishes both `ci/verified` and `staging/verified` on the proposed merge SHA.
Full GitHub protection requires both checks from the verifier App. Both use the same record hash, and production authenticates both before promotion.
The record has a source-derived candidate version, archive checksum, registry digest, controller SHA, run/attempt, deployment ID, and distinct evidence categories.

## Promote after merge

1. Obtain an approved PR merge separately. Confirm its resulting tree is current `main`.
2. Identify the successful staging run and its retained verified record. Keep the immutable registry image and artifacts for at least 90 days and all supported rollback versions.
3. Take a completed production backup. Confirm the seven-day retention policy and the measured isolated restore exercise.
4. Check the currently deployed production digest and test its binary against the candidate's forward schema in an isolated restore target.
5. Dispatch **Promote verified release** on `main`, supplying the staging run ID, semantic version, short notes, and recovery evidence JSON.
6. Review the exact digest, main source, recovery evidence, and migration compatibility. Approve the `production` environment explicitly.
7. Inspect readiness and unauthorized/configuration checks. Complete a production email-code sign-in and save/reload check manually after promotion.

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
Promotion refuses a backup older than 24 hours, a restore over one hour, mismatched prior image, missing App record, unmerged source, or a different main tree.
It deploys the verified digest without rebuilding and verifies source and readiness again afterward.
GitHub and Railway do not offer one atomic transaction; a concurrent main advance fails the operation and leaves its GitHub release draft for investigation.
Successful promotion records source, image, version, notes, deployment, recovery, and staging record in GitHub Release assets.

## Diagnose and recover

Use the workflow summary's deployment ID to open Railway deployment logs. Inspect migration startup failures, schema readiness, and app trace IDs.
The backend emits JSON logs; store neither connection strings nor Clerk tokens in PR evidence.
Public workflow artifacts retain a sanitized deployment summary and synthetic habit screenshots, not raw production logs.
Failed browser reports and large image-transfer archives last three days. Source, migration metadata, and verified records last 90 days.
Approve staging within the transfer window; expired archives fail closed. Production uses the same retained registry digest and matching metadata without downloading or rebuilding the image.
Preserve release assets and retained digests beyond 90 days if rollback support requires it.

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
