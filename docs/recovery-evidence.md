# Recovery evidence

## Hosted staging rehearsal on October 15

The staged habit was recovered from a real Railway bucket into a new local PostgreSQL 17.7 target on 2026-10-15. The exact application archive from [successful main staging run 38696036769](https://github.com/ShiosOS/Damadama/actions/runs/38696036769) read it with ordinary staging Clerk sessions. The [sanitized receipt](evidence/hosted-recovery-2026-10-15.json) records identities, assertions, timestamps, and limits without credentials, account IDs, or raw rows.

The first candidate was the only existing completed backup, from `04:45:28Z`. Its encrypted checksum matched and `restore.sh` decrypted and restored it successfully. Before app startup, PostgreSQL contained zero user relations and no habit, schedule, or migration-history tables. App startup created its schema and returned readiness with zero habits. This candidate did not prove saved-data recovery. The exercise retained that negative result rather than accepting readiness as recovery.

The operator-authorized recovery lane then used **Run now** on the existing approved staging backup deployment. The pre-run listing showed only the fresh original triplet, with no objects eligible for seven-day deletion. That census is a recorded operator observation; the original local listing was later overwritten. The same deployment produced `damadama/staging/20261015T072152Z-4b922f50098353d3.dump.age`, its checksum, and completion JSON. The manifest completed at `07:21:54Z` with `retentionDays: 7`. A later bucket listing preserved both complete triplets. No shared database write, image change, new paid resource, production promotion, or shared rollback occurred.

The 5,511-byte encrypted archive matched SHA-256 `0019a9ff3e07cdac62234db3d175b38657f2e0e837218438f6c4c094e1786b97`. The existing approved staging identity decrypted it. The current main recovery tooling restored it transactionally into an empty target. That local recovery image was built from `efa288e56512da90675b3e791246c36f664f406c`; its `restore.sh` checksum matched the committed file. It was not a claim about the hosted backup image.

Before app startup, the target contained `Habits`, `InitialSchedules`, and `__EFMigrationsHistory`. After startup, independent SQL assertions found exactly one habit and one schedule matching the known staged sample, including the approved owner, all definition text, weekdays `[1, 7]`, a two-week interval, `America/New_York`, creation date `2026-10-15`, and first Monday `2026-10-12`. The receipt labels this assertion timing explicitly.

The retained app archive matched the verified record's archive checksum and embedded source revision. It corresponds to `ghcr.io/shiosos/damadama@sha256:9ea9937c8d328bab8e66bf95f91bf74a0b81931ea6cdb7e78f8222caf7237004`. Its port was bound only to loopback. The database had no published port. Source database credentials were not used for restoration.

Two ordinary Clerk sessions exercised the restored production binary. The owner received 200 for list and detail reads. Its complete restored response equaled the live staged sample, including the creation instant and all saved calendar dates. The second account received 404 for the same detail and could not list the sample. Missing authentication returned 401. The check issued no habit saves, attempted to sign out the exercise sessions, and closed its temporary browser. Session revocation was not independently confirmed. The staging CI key and session tokens stayed out of evidence.

### Recovery targets and timing

The declared simulated failure and final restore clock started at `07:23:08.816Z`, after the fresh backup existed. The object timestamp gives a conservative snapshot bound of `07:21:52Z`. The potential lost-write interval at the simulated failure was at most **76.816 seconds**, within the documented 24-hour RPO. No actual loss or cutover occurred. At authenticated verification, the snapshot bound was **330.374 seconds** old.

One final run measured **253.558 seconds** through authenticated verification at `07:27:22.374Z`, within the one-hour RTO for this staged sample. This included provider downloads, target creation, checksum/decryption/restore, app readiness, private CI-key access, ordinary session setup, and data/ownership inspection. Download through app readiness alone took 15.775 seconds. The restore container process took 1.558 seconds; its whole-second internal timer reported zero and is not a subsecond measurement.

Docker and the exact application archive were available before the final clock started. Initial access investigation, image acquisition/build, and the rejected first backup are outside this final interval. This is one small staged-data run on a shared development machine, not a capacity benchmark, production-volume estimate, or proof of restoration on Railway. Missing backup access, image access, or budget headroom can still exceed the target.

### Compatibility and remaining evidence

The archive migration data and the history after app startup both contained `20261011071109_InitialHabits` and `20261012210223_GroupHabitLevels`. The verified reference app started on that schema and read the saved data. The migration source has not changed between the first habit-slice merge and this reference revision. `GroupHabitLevels.Up` and `Down` are empty. These observations prove this reference binary's compatibility with this backup. No supported previous production image was established, so previous-production rollback compatibility remains unknown. No EF downgrade, production promotion, or shared staging rollback ran.

Railway still configured and executed `ghcr.io/shiosos/damadama-recovery@sha256:6981306ff1a7cc6095620a72af03b867381a2d1342d5f9846877e197c3088c75`, on deployment `a2cacf03-7b4d-436b-b455-3e0b2e20bbed`. The observed manual execution ran from `07:21:51.915Z` through `07:21:57.768Z`. It kept the daily `0 3 * * *` schedule, `sh /opt/recovery/backup.sh` start command, and no-restart policy.

This is the older image, not verification of the newly merged [PR25 deadline](https://github.com/ShiosOS/Damadama/pull/25). The main workflow packages application images; recovery publication remains a separate approved setup process. Deadline publication and hosted rollout remain open in the [backup deadline story](https://app.notion.com/p/3f99c051011881edb3f4cc42302d1450). Local deadline tests below retain their original boundary. No live stalled backup was injected.

The rehearsal preserved seven-day configuration and both completed source backups. It did not test seven days of real-time expiry. Daily entries do not exist in this application slice, so none were recovered or claimed. Real inbox delivery, production recovery, and previous-production rollback remain separate.

## Historical local evidence

The recovery scripts ran locally on 2026-10-12 against real isolated PostgreSQL 17 and a Moto S3 simulator.
An optional proof run used the actual `damadama-candidate` production image built from PR #11's proposed merge `3d1e5784c08ec3ee78944af030e3b1e4cef40c72`.

The proof observed startup migrations and readiness, unauthorized API refusal, and persisted sample rows after an app restart.
The first restart check used an old ephemeral Docker port and failed. Direct port inspection showed Docker changed the host port on restart.
Reobserving the actual port corrected the proof; no application change was required.

The real backup script dumped one habit and one initial schedule, encrypted the archive with age, and uploaded archive/checksum/completion JSON.
The real restore script downloaded ciphertext, checked integrity, decrypted, restored an empty independent target, and started the same production image against it.
Independent SQL reads preserved owner, all definition text, UTC creation instant, weekdays, repeat interval, timezone, `2025-12-31`, and Monday anchor `2025-12-29` exactly.

One completed run measured **4.140 seconds** from backup download through decryption, PostgreSQL restore, and app readiness.
This is a one-row local correctness exercise with a simulated object store. It meets the one-hour target for that sample only.
It does not predict production restore time, include hosted provisioning/access delays, or prove authenticated Clerk reads of restored data.

The proof also observed these refusals:

- A populated target rejects restoration before any data change.
- A target containing only a user view rejects restoration as nonempty.
- An incorrect encrypted checksum rejects decryption/restore.
- An injected checksum-upload failure exits the backup job without a completion manifest or successful result.
- A retry uses a different immutable object key and leaves the prior completed backup intact.

The fixture CI variant does not depend on the application branch. The optional image variant was also run locally.
Seven-day pruning is implemented from object modification times; a seven-day real-time hosted retention exercise has not run.
Hosted cron scheduling, bucket permissions, daily completion monitoring, realistic data-volume restore, actual Clerk signin/email, and previous-production-image compatibility await approved setup.

The proof's generated age identities and encrypted test backups remain under ignored `.audit` directories and are not PR assets.
Only this summary and the repeatable proof script are committed. Failure-report retention is three days.

On 2026-10-14, the local Docker and Moto proof passed with a three-second backup deadline: stalled `pg_dump`, archive upload, and retention commands exited 124, and ordinary termination removed their temporary directories. The review then found that moving completion upload after retention could delete an expired completed backup before a failed replacement manifest upload. On 2026-10-15, a new Docker regression case reproduced the loss of all three old objects with the staged ordering. After restoring completion upload before retention, the full local proof passed. Dump and archive-upload stalls publish no completion marker. A retention stall leaves the new archive, checksum, and completion marker in storage, while the job exits 124 and prints no final success JSON. The new manifest-failure case preserves the expired completed backup. A zero deadline exits 2; normal backup, partial-upload refusal, retry, and restore checks also pass. This is local fixture evidence, not a hosted Railway backup or a measured capacity limit. A process that requires the five-second `KILL` fallback cannot run the shell cleanup trap.
