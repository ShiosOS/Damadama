# Verify a current application backup

Run the synthetic recovery lane from a clean committed checkout with Linux Docker, Buildx 0.13 or later, Node.js 24, Git, tar, and OpenSSL available.

1. Run the focused boundary checks.

   ```sh
   node --test ops/recovery/current-image.test.mjs ops/recovery/image-archives.test.mjs ops/recovery/application-proof.test.mjs
   ```

2. Build the recovery helper and a disposable application image from the exact checkout.

   ```sh
   docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-proof .
   node ops/recovery/current-image.mjs build .audit/current-image.json
   ```

   The builder archives the committed source and uses its `release/Dockerfile`. It creates its own `docker-container` builder with a pinned BuildKit 0.33.1 image, passes that builder explicitly, and removes only that builder at completion. It leaves your active builder selection unchanged. One build writes Docker and OCI tar exports with uncompressed layers. The Docker export is explicitly loaded for execution. The build writes `synthetic-test-build` release metadata without publishing an image.

3. Check the built image and its rejected identity cases, then run the required-image proof.

   ```sh
   node ops/recovery/verify-current-image.mjs .audit/current-image.json
   node ops/recovery/prove.mjs --require-app .audit/current-image.json
   ```

   Require exit code 0 and `outcome: passed` in `.audit/current-image-verification.json` and `.audit/recovery-proof-*/receipt.json`. The image check first accepts the actual built image, then refuses an unrelated manifest digest, wrong SQL hash, stale or foreign embedded source identity, altered Docker archive, and an unrelated real Docker archive with its correct checksum. A failure receipt names a fixed scenario code. The scripts suppress child errors and database rows. Retain only the metadata, verification summary, and proof receipt. Do not upload the surrounding directory, container logs, image archives, age identities, or issuer files.

   API checks emit fixed progress codes and HTTP status numbers, also retained in the receipt's `checks`. A source owner GET must exactly equal the committed POST response before backup begins. On an actual mismatch, a diagnostic can include only validated UTC `postCreatedAt`, `getCreatedAt`, and their signed difference in 100 ns ticks. It never rounds either response or accepts an inconsistent public API as a restore baseline. Other response fields, IDs, tokens, and raw errors stay suppressed. Independent SQL reads establish the saved-row baseline after these source consistency checks pass.

4. Run the legacy fixture separately when changing the shared recovery scripts.

   ```sh
   node ops/recovery/prove.mjs
   ```

   The workflow also passes the verified built image's config ID as the optional image argument. That path checks real startup, saved rows across restart, restored startup, and anonymous refusal. All three forms select a complete source preparation and target verifier before the shared backup and restore sequence.

The required-image lane starts the real Production binary with its committed migrations and an ephemeral HTTPS issuer. It creates synthetic data through the ordinary API, retains an explicit SQL calendar sample, and backs up through `backup.sh`, age, and isolated Moto storage. It restores into a separate empty database with separate credentials. Before startup, it compares migration IDs, columns, constraints, indexes, and independently read saved rows. After startup, it requires unchanged schema and migration history, readiness, equal owner responses, outsider 404 and collection exclusion, and anonymous 401. Invalid signature, issuer, expiry, subject, authorized party, and pending-session tokens must also fail.

The receipt keeps the OCI manifest digest and media type, local config ID, Docker export SHA-256, OCI export SHA-256, migration source tree, generated SQL SHA-256, and controller source separate. The manifest digest identifies the actual uncompressed synthetic OCI export. It can differ from a compressed or published registry manifest digest and does not authenticate a registry promotion.

Both archives remain beside the metadata as `current-image.json.image.tar` and `current-image.json.oci.tar` until proof completes. Verification reads the original OCI manifest bytes, checks descriptor hashes and sizes, and binds config and ordered raw layers to the config's DiffIDs. It checks both manifest selections in the Docker export against that same config and layer sequence, then checks the loaded Linux amd64 image. Bounded JSON reads, streaming layer hashes, allowlisted tar member paths, and duplicate refusal avoid extraction or large layer buffers. Byte fixtures test altered manifest, config, and layer bytes after outer checksums are recomputed. Rebuild after any commit. Identity mismatches cannot fall back to the handwritten fixture.

Recovery failure cases include populated and view-only targets, incorrect checksums, damaged ciphertext with a matching checksum, wrong age identity, partial uploads, completion upload failure, retry, and bounded backup phases. A separate fault archive blocks `pg_restore` during `COPY` with an advisory-lock CHECK function. The proof observes that backend, interrupts it, checks zero user objects, and retries the same ciphertext without clearing the target. It repeats the rollback and retry with the restore's own deadline.

`RESTORE_MAX_SECONDS` defaults to 1800 positive whole seconds and covers checksum, empty-target inspection, decryption, archive inspection, and transactional restore. Empty, zero, negative, fractional, and textual values exit 2 with a configuration error. A blocked restore exits 124. A driver timeout does not substitute for that shell deadline.

The `Current image recovery` workflow proposes daily execution at 03:37 UTC and also runs on pull requests and manual dispatch. Pull requests explicitly test their published head SHA. GitHub activates scheduled workflows only on the default branch and may delay scheduled runs. A draft or unmerged PR has no active schedule. Require a successful recovery run on the exact PR head and the existing full repository `Check` workflow before treating an implementation as verified. The scheduled recovery job runs the restore proof and focused boundary tests. It does not replace the full repository suite.

For hosted rehearsals, use a separately approved staged synthetic account, retained immutable application image, existing recovery image, read access to one completed backup triplet, and its matching age identity. Restore into a new isolated target. Record image acquisition time, restore time, source commit, migration identity, target boundary, and provider checks actually executed. Propose a rehearsal after migration changes and at least quarterly. This synthetic lane neither executes that rehearsal nor proves Clerk sign-in, email delivery, Railway storage, or production recovery. Preserve older hosted receipts and the approved hosted recovery image.

Do not claim previous-production compatibility until an independently identified supported production image is available. Record it as unknown otherwise. The initial baseline has two habit migrations. The lane derives expected history from every migration committed in its tested source, so newer migrations enter the schema comparison. It makes no daily-entry behavior recovery claim.

The relevant platform contracts are Docker's [multiple exporters](https://docs.docker.com/build/exporters/#multiple-exporters) and [OCI and Docker archive options](https://docs.docker.com/build/exporters/oci-docker/), PostgreSQL's [transactional restore](https://www.postgresql.org/docs/17/app-pgrestore.html) and [activity monitoring](https://www.postgresql.org/docs/17/monitoring-stats.html), and GitHub's [schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
