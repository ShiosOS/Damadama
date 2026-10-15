# Back up and restore Damadama

Run one daily backup job per hosting environment. Staging and production have separate databases, volumes, backup buckets,
access keys, and age recipients. Local test backups never use their credentials.
This tooling can land independently of application code, after the release-policy foundation and before gate activation.

## Configure daily backups after approval

1. Publish the trusted recovery image through [first image setup](release-operations.md#publish-images-for-first-setup). Record its immutable `ghcr.io/shiosos/damadama-recovery` reference from the publication receipt.
2. Create a backup service in each Railway environment with that environment's image, credentials, private database address, and backup bucket.
3. Apply `ops/recovery/railway-cron.example.json`. The job runs at 03:00 UTC daily, exits after completion, and does not restart on failure.
4. Generate a different age key pair for each environment. Store the private identity with the recovery operator in an approved secret store.
5. Give the daily job only the public age recipient. Give it bucket credentials confined to its own environment's bucket.
6. Use a dedicated database backup role with read access to all application tables and default read privileges for future tables.
7. Record the latest successful completion and alert if it is older than 24 hours. Review failed cron logs each day until monitoring is established.

Create these variables separately in each backup service:

```text
BACKUP_ENVIRONMENT=staging
PGHOST=postgres.railway.internal
PGPORT=5432
PGDATABASE=damadama_staging
PGUSER=staging_backup
PGPASSWORD=<staging backup role password>
S3_BUCKET=<staging-only bucket>
AWS_ENDPOINT_URL=https://<bucket-provider-endpoint>
AWS_ACCESS_KEY_ID=<staging-only bucket key>
AWS_SECRET_ACCESS_KEY=<staging-only bucket secret>
AWS_DEFAULT_REGION=<provider region>
AGE_RECIPIENT=age1<staging recipient>
```

Create the role during approved setup. Grant schema usage and SELECT on existing tables.
Set default SELECT privileges for tables later created by the application migration role.
Do not grant the backup role application writes or use a production role in staging.
The job validates its environment name and requires all connection, bucket, and encryption settings.

The job writes a PostgreSQL custom-format dump, encrypts it with age, and uploads the encrypted archive and SHA-256 checksum.
It uploads completion JSON only after both objects succeed. Each attempt uses a unique timestamp and nonce; retries cannot overwrite a completed backup.
Restore only objects with completion JSON and a matching checksum. Failed uploads may leave uncommitted objects; they are not successful backups.
The dump covers the whole application database, including future daily-entry tables when those features land.

The retention sweep deletes only recognized backup objects under that environment's prefix whose object modification time is older than seven days.
Unknown keys remain untouched. A retention failure fails the job and needs investigation even if the new archive uploaded.
Railway's native daily snapshot schedule retains six days and is only a supplementary recovery option.

## Restore into an isolated target

Provisioning a restore target and restoring real customer data require explicit approval.
Use an isolated recovery environment, never the shared staging database, to rehearse a production restore.
Do not expose restored production data to staging accounts or public browser origins.

1. Start the restore clock. Select a completed backup no older than the agreed 24-hour loss window.
2. Record its environment, completion time, encrypted object key, checksum, size, and provider access.
3. Create an empty isolated PostgreSQL 17 target. Inspect its host, database, role, and storage before acknowledging the target.
4. Download the encrypted archive and checksum through the provider's HTTPS endpoint. Obtain the matching age identity through the approved secret store.
5. Mount those files read-only in the recovery image. Set target `PGHOST`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` separately from source credentials.
6. Set `RESTORE_TARGET_ACK=isolated-empty-target` and `AGE_IDENTITY_FILE` to the mounted private identity file.
7. Run the restore command:

```text
sh /opt/recovery/restore.sh /recovery/backup.dump.age /recovery/backup.dump.age.sha256
```

8. Start the retained app image against the restored database. Inspect readiness, migration history, representative habits/entries, ownership, definitions, and exact saved calendar dates.
9. Use the appropriate account authority in the private recovery environment to confirm authenticated reads. Do not substitute test authentication in the production image.
10. Record elapsed time through downloads, decryption, restore, app readiness, and data inspection. Compare it with the one-hour target.
11. Obtain a separate recovery/cutover approval before changing production traffic or database references.

The script checks the encrypted checksum before decrypting. It rejects any existing user relations, routines, types, or extra schemas.
It restores without ownership/ACL commands, `--clean`, or EF downgrade and uses one transaction with errors fatal.
An existing target is never cleared automatically. PostgreSQL startup applies only the committed forward migrations.
The first one-hour rehearsal is a local sample; measure the hosted exercise with realistic backup sizes after setup.

## Recover after a spending hard stop

The [approved $20 Compute limit](hosting-cost.md) can stop every workload in the Railway workspace, including both environments and their daily backup jobs.
At the limit, Railway also suspends bucket reads and uploads. Existing bucket data remains billed.
Preserve the database volumes, completed backups, and the hard limit. A spending outage does not authorize data deletion or a restore over the existing database.

1. Record the outage time, current-cycle usage, billing-cycle reset date, service status, and saved $20 limit and $15 alert in the correct workspace.
2. Record each environment's last-known backup completion from available logs or prior records. Mark it unknown if no record is available. Record missed jobs and any gap beyond the agreed 24-hour loss window; verify stored objects after bucket access returns.
3. If the operator keeps the no-overage policy, wait for the next billing-cycle reset. Do not raise or remove the limit to restart services.
4. If earlier recovery needs more spend, obtain explicit operator approval stating the new spending boundary and recovery action before changing anything.
5. After reset, confirm that the $20 limit and $15 alert remain saved and that the new cycle has enough headroom. Inspect every service rather than assuming recovery succeeded.
6. Verify PostgreSQL readiness and the retained volume first. For previously approved app deployments, check the retained image digest, app readiness, real sign-in, and saved-data reads.
7. If automatic recovery fails, redeploy only the previously approved service image after checking remaining headroom. Never deploy an unapproved production app as a recovery shortcut.
8. After bucket access returns, identify the latest completed candidate from the bucket's completion records, even if step 2 recorded unknown. Verify its environment, archive, and checksum before treating it as recoverable. If no valid candidate exists, record that no recoverable backup is verified. Check job state and the next schedule. When budget headroom permits, run the approved backup job and verify its checksum and completion record before declaring backups current.

Railway [tries to restart resources at the next billing cycle](https://docs.railway.com/pricing/cost-control#usage-limits-faq).
Do not assume that a reset, manual redeployment, or unchanged service settings proves a private image pull or a healthy application.
Record what actually restarted and what remains offline. The current setup has no verified hosted app or backup execution to recover.

A missed backup can leave the latest recoverable copy older than 24 hours. A later successful backup does not fill the missing recovery interval.
If a restore is necessary, state the backup time and lost-write window before requesting restore and cutover approval.
The one-hour restore target depends on accessible backups, a usable approved image, a healthy target, and sufficient budget headroom.
Waiting for billing reset can exceed that target. Do not claim a one-hour recovery guarantee under the hard limit or trigger a live hard stop to test this procedure.

## Roll back a release

1. Read the production release's source, digest, previous image, backup, and compatibility evidence.
2. Restore the predeployment backup into an isolated target and apply the new schema there.
3. Run the previous image against that forward schema. Verify readiness, authenticated reads, a transactionally committed save, and preservation of ownership and stored dates.
4. If that exercise passes, obtain explicit rollback approval and redeploy the retained previous digest with production settings.
5. Recheck readiness, real signin, and saved values. Record the rollback deployment and source.

An image rollback does not reverse migrations. Do not run EF `Down`; the initial migration drops habit and schedule tables.
If the prior binary is incompatible, stop. Restore and cut over only after approval that states the backup time and lost-write window.
The initial release has no previous production image and cannot claim an image rollback exercise.

## Repeat the local exercise

With Docker's Linux engine and Node 24, run:

```text
docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-proof .
node ops/recovery/prove.mjs
node ops/recovery/prove.mjs damadama-candidate
```

The first command path uses a schema fixture. The optional image path starts the actual compiled application,
checks migration/readiness, restarts it, encrypts and uploads sample data to an isolated Moto S3 simulator,
restores a separate database, and starts the image against the restored schema.
It compares independently read owner, definition text, UTC instant, weekdays, timezone, and saved dates.
It also checks refusal of corrupt archives and nonempty targets.
Every container/network is created for the exercise and removed by its captured identity. Other local services and Aspire volumes are untouched.
The generated age identity is local test data under `.audit`; it is never committed or uploaded as CI evidence.

The exercise proves local script and application packaging behavior. It does not verify Railway storage, real Clerk authentication,
email delivery, production-sized restoration, or a previously released binary's forward-schema compatibility.
CI runs the fixture variant because the application PR is still unmerged. Failure reports last three days.

## Provider reference

- [Railway backup schedules](https://docs.railway.com/volumes/backups)
- [Railway cron behavior](https://docs.railway.com/cron-jobs)
- [Railway bucket endpoint and access](https://docs.railway.com/storage-buckets)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
- [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
