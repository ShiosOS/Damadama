# Local recovery evidence

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
