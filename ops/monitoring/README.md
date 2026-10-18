# Operational monitor contract

This independent observer checks staging liveness, readiness, release identity, and recovery metadata through HTTPS GET requests when explicitly enabled. The workflow runs outside Railway. Its pull request tests need no credentials or activation. Production is explicitly `disabled` and makes no requests.

Implementation, verification, and activation are separate. These files do not establish a metadata producer, signed URL, native scheduled execution, or delivered notification. The declared schedule can attempt runs while observation remains inactive.

## Observation

`observe(target, { now, fetch })` returns an `Observation`. `formatObservation(observation)` formats that trusted result as bounded lines. Parsing, provider transport, and freshness policy stay private to `monitor.mjs`. `now` is an epoch millisecond value, and `fetch` has the native Fetch interface. Both are injectable for tests.

The target contains `environment`, optional `enabled`, `metadataUrl`, `metadataOrigin`, `monitorRevision`, and `runReference`. Staging uses the fixed origin `https://staging.damadama.app`. Every response must have status 200. Redirects fail. The only app routes are `/health/live`, `/health/ready`, and `/release.json`.

An observation contains the trusted environment, observation time, monitor revision, GitHub run reference, observed app commit and tree, an overall verdict, and independent liveness, readiness, identity, completion, job, and retention checks. Each check has a verdict, a fixed reason, an HTTP status or null, and an optional validated server trace or `unavailable`.

The verdicts are `healthy`, `missing`, `stale`, `refused`, `invalid`, `unavailable`, `disabled`, and `unknown`. Overall `healthy` requires every enabled check to be healthy. Unknown job or retention evidence remains `unknown` and fails the CLI. A disabled production target is visible, never healthy, and does not change the enabled staging exit code.

Release identity must match the existing artifact shape `{ "source": { "repository": "ShiosOS/Damadama", "commit": "<40 lowercase hex>", "tree": "<40 lowercase hex>" }, "version": "main-<first 12 commit characters>" }`. The observed app revision is separate from `GITHUB_SHA`, which identifies the monitor checkout. Valid shape does not prove that the app runs the latest desired release.

## Recovery producer boundary

The monitor accepts this exact version 1 envelope. [The bounded healthy fixture](fixtures/healthy.json) is executable contract evidence.

```json
{
  "schemaVersion": 1,
  "origin": "hosted",
  "observedAt": "2026-10-18T12:00:00.000Z",
  "completion": {
    "environment": "staging",
    "backup": "damadama/staging/20261018T025900Z-0123456789abcdef.dump.age",
    "completedAt": "2026-10-18T03:00:00.000Z",
    "retentionDays": 7,
    "durationSeconds": 60
  },
  "archivePresent": true,
  "checksumPresent": true,
  "job": "succeeded",
  "retention": "succeeded"
}
```

`origin` identifies the source of the evidence. `hosted` means the recovery producer read the configured hosted environment's real provider objects. `synthetic` identifies an isolated recovery proof or fixture. The live consumer requires `hosted` and rejects synthetic, absent, or unknown origin values. An origin label is a trusted producer assertion, not independent provenance verification. The healthy test fixture emulates a hosted receipt without establishing live provider evidence.

`completion` is null or the unchanged immutable manifest with exactly the five existing keys. `job` and `retention` independently accept `succeeded`, `failed`, and `unknown`. Each boolean describes producer readback of the matching archive and checksum. `checksumPresent` proves presence asserted by the producer, not checksum verification. A null completion, an orphan object, or either false boolean never proves a completed backup.

The completion environment must exactly match the target. Its key must match `damadama/<environment>/YYYYMMDDTHHMMSSZ-<16 lowercase hex>.dump.age`. The embedded UTC date must exist and precede or equal `completedAt`. The producer checks the corresponding `<backup>.sha256` and `<backup>.json` objects. A manifest naming a different environment, suffix, or future snapshot start is invalid. `retentionDays` is a safe integer of at least 7. `durationSeconds` is a nonnegative safe integer. Zero preserves the existing producer's whole-second timing for a fast completion.

`completedAt` and `observedAt` use real UTC calendar timestamps with either whole seconds or exactly three fractional digits. Neither can be in the future. `observedAt` must be at or after `completedAt`. Both ages must be at most 86,400,000 milliseconds. Exactly 24 hours passes. One millisecond beyond fails. A fresh producer observation cannot refresh an old completion. Daily scheduler delay and backup runtime can cross this strict limit. There is no grace period.

A fresh valid triplet remains completion `healthy` when the job or retention later fails. The overall monitor still fails. Unknown outcomes do not imply success. A stale or invalid envelope cannot establish current job or retention outcomes.

The recovery owner must supply a separate publication adapter without changing the existing immutable manifest or relying on the final stdout success line. The following producer contract remains pending live verification.

- Select one fixed metadata object key for each environment. Publish a replacement atomically so a reader receives one complete envelope.
- Read back the immutable completion object and both matching sibling objects before publishing completed evidence. Preserve prior completion evidence when later retention fails, and report the final job and retention outcomes honestly. Use `unknown` when the outcome cannot be established.
- Set `observedAt` to the actual evidence readback time. Preserve the original `completedAt`. Do not publish a heartbeat as a completed backup.
- Set `origin` to `hosted` only for actual hosted evidence. Keep synthetic proof receipts separate and label them `synthetic`. They cannot satisfy this consumer's freshness checks.
- Issue a narrowly scoped presigned HTTPS GET for that one fixed metadata object. Document expiry, renewal ownership, rotation, and configuration readback before expiry. An expired capability returns `refused` and requires renewal. A 404 is `missing`.
- Verify atomic publication, triplet association, partial upload, failure after completion, renewal, and the metadata-only read restriction against the real provider before activation.

The monitor never receives Railway credentials or bucket credentials. Pulling one metadata object avoids a signed push channel that would require a GitHub write credential in Railway. It cannot validate the producer's honesty or independently restore a backup. TLS and the approved provider origin establish receiver trust. A replay within the 24-hour window cannot be detected without durable monotonic state. Completion time is not a recovery point or restore proof.

## Configuration and output

`OPS_MONITOR_ENABLED_STAGING` is an Actions variable forwarded unchanged to the CLI. The same process environment variable controls local execution. The CLI interprets its raw value once, without trimming or coercion.

| Raw value       | Staging state      | Requests            | Exit                             |
| --------------- | ------------------ | ------------------- | -------------------------------- |
| Unset or empty  | Disabled           | Zero                | 0                                |
| Exact `false`   | Disabled           | Zero                | 0                                |
| Exact `true`    | Enabled            | Bounded observation | 0 only when healthy, otherwise 1 |
| Any other value | Invalid activation | Zero                | 1                                |

Disabled activation returns before metadata validation or fetch. It writes this fixed status to stdout and the Actions step summary, with a notice annotation.

> Staging monitoring inactive; zero requests. This successful run reports disabled state and does not establish live health or alert delivery.

Invalid activation writes a fixed refusal and error annotation without echoing the setting. Enabled activation fails for missing or invalid metadata configuration, stale evidence, refused requests, unhealthy probes, unknown outcomes, or an unexpected disabled observation. The production observation remains disabled in every state.

`BACKUP_METADATA_URL_STAGING` is a secret read capability. `BACKUP_METADATA_ORIGIN_STAGING` is a reviewed repository variable containing the exact provider origin, such as `https://<approved-provider-host>`. It has no credentials, path beyond `/`, query, or fragment. The actual provider origin remains to be selected with recovery. The URL must use that exact HTTPS origin and contain no user information or fragment. Its signed query stays secret. This configuration grants no release environment privileges.

To configure observation, follow this sequence.

1. Verify the producer's hosted publication and metadata-only read capability against the producer contract above.
2. Configure the secret capability and reviewed origin through the applicable Actions settings.
3. Establish the effective activation classification and scope, including any inherited organization variable. This job has no environment declaration. Repository absence alone does not establish inactivity when organization inheritance applies.
4. Set the applicable `OPS_MONITOR_ENABLED_STAGING` variable to exact `true` only when observation is authorized.
5. Read back the tested revision, native job and step conclusions, safe summary, and actual enabled observation. Record only the activation classification, scope, revision, and time. Keep raw private values out of evidence.

To establish inactivity, read back the effective unset, empty, or exact `false` state and its provenance. A registered cron attempt and a successful inactive report do not establish live health. Capability renewal, native schedule operation, and notification delivery each need their own evidence.

Every attempt has a 10-second deadline including body reads. JSON is limited to 16 KiB, even without `Content-Length`. Network failures, timeouts, 429, 500, and 503 receive at most one retry. Refusals and redirects receive no retry. The monitor never follows a redirect or reads a backup archive.

Output contains registered route names, fixed reasons, statuses, validated timestamps and revisions, validated trace references, and the expected repository's GitHub Actions run URL. Stdout and the actual Actions step summary contain the same safe report. They exclude raw activation settings, approved-origin values, capability URLs, queries, response bodies, raw exceptions, account information, and habit values. Failure trace evidence comes from `problem.traceId` or the approved `X-Trace-Id` header. Accepted trace formats are 32 lowercase hexadecimal characters, an ASP.NET request identifier with 13 uppercase alphanumeric characters and 8 uppercase hexadecimal characters, or a W3C `00` traceparent with flags `00` or `01`. All other traces become `unavailable`. The GitHub run reference remains available when the server supplies no safe trace. The failure annotation includes the complete bounded observation with revision, environment, route, status, and trace. Annotation data escapes percent signs and newlines.

## Verification and execution

Use Node.js 24 to run the secret-free tests.

```sh
node --test ops/monitoring/monitor.test.mjs
```

The suite invokes the real CLI under a test-only fetch preload and checks activation, actual summary files, fetch counts, accepted and rejected output, exit codes, partial evidence, independent outcomes, time boundaries, transport limits, and privacy sentinels. The preload is never imported by the live entry point. This controlled failure needs no provider access and exits 1 with a missing-metadata observation.

```sh
OPS_MONITOR_ENABLED_STAGING=true MONITOR_TEST_CASE=missing BACKUP_METADATA_URL_STAGING='https://metadata.example.test/fixed/latest.json' BACKUP_METADATA_ORIGIN_STAGING='https://metadata.example.test' node --import ./ops/monitoring/fixtures/fetch.mjs ops/monitoring/run.mjs
```

The ordinary command reports inactivity with zero requests unless the process environment contains exact `OPS_MONITOR_ENABLED_STAGING=true`. An enabled command performs anonymous staging app probes and reads only the configured metadata object. A missing capability then fails visibly.

```sh
node ops/monitoring/run.mjs
```

The workflow declares `2-57/5 * * * *` and manual runs on main, with minimal `contents: read` permission and no protected release environment. Checkout v7.0.1 and setup-node v7.1.0 use verified immutable commits and Node.js 24 Action runtimes. The monitor installs Node.js 24 and disables unused automatic package caching. PR tests apply to every base branch when monitor files change. Every admitted main schedule or manual job runs the CLI after successful fixtures, including disabled and invalid activation. A pull request or non-main manual run executes fixtures and skips staging. There is no workflow activation gate, dispatch override, or credential-presence inference. Production needs a separate approved target and capability before implementation enables it.

The Bun workflow-lint self-test parses the actual YAML and evaluates only its supported admission expressions and dependencies. It executes the parsed fixture and CLI commands with controlled transport, reads actual summaries, and rejects relevant parsed workflow mutations. The receiver checks also enforce its declared schedule, manual trigger, and exact PR and push path scopes. These checks prove configuration behavior and controlled CLI execution. They do not execute GitHub's native scheduler.

GitHub schedules run from the default branch and can be delayed, dropped, or disabled after inactivity. The proposed cadence is not a detection guarantee. A workflow failure depends on the user's GitHub notification settings and scheduled actor. A failed run does not prove inbox delivery. No email, chat integration, arbitrary user-request error alert, or independent missing-scheduler detector is included. Activation requires a real scheduled run, configured producer evidence, and separate notification delivery evidence.
