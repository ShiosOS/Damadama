# Publish staging completion metadata

This opt-in publisher adds one staging metadata object beside the existing immutable backup triplets. The helper's default entrypoint remains `backup.sh`. This PR does not install a hosted job, create a signed URL, configure monitor secrets, or activate a schedule. Production publication is disabled before backup execution.

The fixed object key is `damadama/staging/monitor/completion.json`. Its exact eight fields are `schemaVersion`, `origin`, `observedAt`, `completion`, `archivePresent`, `checksumPresent`, `job`, and `retention`. `completion` is null or the unchanged five-key backup manifest. The publisher uses its own UTC observation time. It can truthfully publish a valid older completion; the monitor owns freshness policy.

`origin` describes evidence scope. Isolated Moto evidence always uses `synthetic`, which the live monitor refuses. A hosted observation requires explicit `--origin hosted`. The monitor's approved HTTPS URL origin is a different setting: the exact scheme, hostname, and port of the signed GET capability.

## Verify the implementation

Run these commands with Python 3, Node.js 24, and Linux Docker. Docker integration and full repository checks share the project's check capacity.

```sh
python3 -m unittest discover -s ops/recovery -p '*_test.py' -v
sh -n ops/recovery/backup-with-metadata.sh
docker build --platform linux/amd64 --file ops/recovery/Dockerfile --tag damadama-recovery-metadata-proof .
python3 ops/recovery/prove_completion_publication.py
```

Require exit 0 and `outcome: passed` in `.audit/completion-publication-proof.json`. The proof runs PostgreSQL, Moto, the unchanged backup script, and the packaged publisher in disposable containers. It reads the fixed metadata object back through the packaged AWS CLI. It checks successful and failed backup observations, missing objects, malformed and oversized manifests, access refusal, failed replacement, readback refusal, and unchanged original triplets. All output is synthetic. Presence checks do not establish cryptographic checksum verification or restore success.

Fixed per-assert diagnostics identify the exact failed check. They include only exit codes, allowlisted error categories, expected-failure flags, listing shape/counts, packaged file/import/source-match booleans, and Python major/minor versions. They exclude child output, object names, configuration, and credentials. The production-refusal check still requires its exact failure JSON and an empty bucket; diagnostics do not accept an unexpected result. The producer summary's `publishedEnvelopeSha256` and consumer summary's `inputEnvelopeSha256` bind the same synthetic bytes, and CI requires them to match.

For the empty-bucket check, the proof requests JSON with `--no-paginate --max-keys 1`. It preserves the `Contents == []` requirement and also requires integer `KeyCount: 0` and `IsTruncated: false`. The older AWS CLI 2.9.19 paginator retains only object/prefix collections, and its formatter emits no JSON for an empty aggregate. The proof records safe byte lengths and parsed shapes for both modes, then verifies the explicit first page. It never turns absent or malformed stdout into an empty object. Reusable tests exercise accepted and refused pages through the installed CLI against loopback S3 XML fixtures; those fixtures make no Moto or hosted execution claim. See the versioned [paginator model](https://github.com/aws/aws-cli/blob/2.9.19/awscli/botocore/data/s3/2006-03-01/paginators-1.json#L45-L54), [JSON formatter](https://github.com/aws/aws-cli/blob/2.9.19/awscli/formatter.py#L91-L100), and [first-page option](https://docs.aws.amazon.com/cli/latest/reference/s3api/list-objects-v2.html).

The compatibility verifier loads the actual external ops consumer after checking its SHA-256. It does not keep a consumer implementation in this branch. Retrieve the pinned source without printing credentials, then verify it against the actual synthetic envelope produced above.

```sh
mkdir -p .audit/ops-consumer
gh api 'repos/ShiosOS/Damadama/contents/ops/monitoring/monitor.mjs?ref=bef623aa440feeb9a697f610693122889ffc56e4' --jq .content | base64 --decode > .audit/ops-consumer/monitor.mjs
node ops/recovery/verify-completion-consumer.mjs .audit/ops-consumer/monitor.mjs .audit/metadata-envelope.json .audit/consumer-compatibility.json
```

The pinned file SHA-256 is `f24892510b76ce9abd3cc389d7c7beee83b8bddec4998ce3873d09176a8127eb`. The verifier requires the actual synthetic envelope to fail the live consumer's hosted-evidence check. Separately constructed, labeled hosted-shaped fixtures test accepted, missing, stale, future, refused, wrong-environment, failed-job, failed-retention, and unknown outcomes. These fixtures make no hosted execution claim.

Retain only `.audit/completion-publication-proof.json` and `.audit/consumer-compatibility.json` as evidence. Do not upload the audit directory, captured stdout, temporary keys, archive bytes, credentials, signed URLs, or raw child errors. The new PR/manual workflow uses no secrets or hosted environments and has no schedule.

## Choose one privileged staging publisher

The recovery owner must designate one privileged writer for this fixed object before activation. Do not run overlapping publisher jobs. The helper needs its explicitly configured project credentials for reading completion manifests and matching archive/checksum presence, plus writing and reading back the fixed metadata object. The publisher makes no delete or listing request. The unchanged backup script retains its existing broader backup and retention permissions.

Provide the existing staging backup variables, including `BACKUP_ENVIRONMENT=staging`, `S3_BUCKET`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, PostgreSQL settings, and `AGE_RECIPIENT`. The opt-in path refuses missing project credentials and does not fall back to ambient AWS profiles or instance metadata. `AWS_DEFAULT_REGION` defaults to `auto`, as in `backup.sh`. Hosted mode requires an HTTPS storage endpoint. Keep provider-specific endpoint and addressing requirements from the actual bucket's credentials page.

After deployment, credentials, and the provider boundary are separately approved and verified, opt into the wrapper command in that one staging job.

```sh
sh /opt/recovery/backup-with-metadata.sh --origin hosted
```

To observe a known previous completion if the next backup fails, supply that exact manifest object key with `--prior-completion-key`. The wrapper uses it only after failure. It selects the new stdout manifest after success. It never searches timestamps to associate a completion with a failed job.

An existing trusted supervisor can invoke the adapter directly with its observed exit code and bounded capture file.

```sh
python3 /opt/recovery/publish_completion.py publish --origin hosted --backup-exit-code "$backup_status" --stdout-file "$bounded_capture"
```

For exit 0, the adapter requires exactly one valid stdout manifest, equality with the stored manifest, and both matching objects before publishing `job: succeeded` and `retention: succeeded`. An explicit `--completion-key` must equal that successful manifest's JSON key. Nonzero exit publishes `job: failed` and `retention: unknown`; an optional explicit `--completion-key` selects the separately known older completion. A separately observed retention failure can use `--retention-failed` in direct publish mode. A valid triplet alone never establishes job or retention success.

The wrapper captures bounded child output, runs publication after an attempted backup fails, and returns failure if backup or publication fails. Configuration refusal happens before starting backup. The existing completion-before-retention order is unchanged.

## Handle storage failures

Publication has one monotonic whole deadline, defaulting to 30 seconds. `--deadline-seconds` accepts 1 through 300 whole seconds. A command completes only after the child exits and both captured pipes reach EOF within that same budget. Deadline or capture failures terminate the owned Linux process group even if its leader has exited, with bounded cleanup and a static cleanup-failure code. A real descendant-held-pipes regression checks this Linux behavior in CI. Each child has bounded stdout and stderr, disabled CLI retries, and socket timeouts. Downloaded manifests use a range request and an independent actual-byte bound. A definite `404` or `NoSuchKey` is absence. Permission denial, timeout, unknown CLI errors, malformed values, and oversized downloads abort before replacement. A missing object after a supposedly successful backup also aborts.

The publisher constructs one complete JSON body, sends one PUT, then requires byte-equal GET readback. An explicitly refused PUT leaves the previous object in the isolated proof. An uncertain transport failure or refused readback can occur after replacement, so report failure and inspect the fixed object before retrying. The implementation does not claim unverified Railway atomicity, cross-writer ordering, or rollback of an uncertain PUT. One privileged writer remains an operational requirement. Static failure codes exclude child output, endpoints, and credentials.

## Activate and renew a single-object GET capability

The recovery owner owns publication, capability expiry, renewal, and handoff to the monitoring owner. Before activation, verify the actual provider's signed-GET support, maximum expiry, credential lifetime, URL addressing style, and replacement/readback behavior. Record the tested limits and the renewal owner separately from the eight-key envelope. Railway documents private S3-compatible buckets and presigned URLs, but this implementation has not verified a live Railway expiry limit or hosted URL. Keep activation blocked until those checks are complete.

Use a signed GET for only `damadama/staging/monitor/completion.json`. A bucket credential is a broader capability and must not be called read-only or given to the monitor under that description. After the actual expiry is approved, the owner can generate the single-object capability into a private file rather than terminal output.

```sh
umask 077
aws --endpoint-url "$AWS_ENDPOINT_URL" s3 presign "s3://$S3_BUCKET/damadama/staging/monitor/completion.json" --expires-in "$approved_expiry_seconds" > "$private_capability_file"
```

This procedure is documented but has not been executed. Verify the new URL using the monitor's bounded GET path without logging it, install it as `BACKUP_METADATA_URL_STAGING`, and set the separately approved exact HTTPS origin in `BACKUP_METADATA_ORIGIN_STAGING`. Arrange renewal before the verified URL or signing credentials expire, whichever comes first. Verify a replacement capability before changing the monitor secret, then verify monitor readback. Keep issuance, expiry, owner, and next renewal in the privileged operational record. Missing renewal, monitor execution, and native notification delivery remain activation work.

Relevant primary references are the [AWS CLI ranged GET](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object.html), [HEAD refusal semantics](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-object.html), [presigned URL expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), and [Railway private buckets and URL styles](https://docs.railway.com/storage-buckets).
