import datetime as dt
import hashlib
import json
from pathlib import Path
import secrets
import sys
import tempfile
import time
import uuid

from publication_process import BoundedProcess, PublicationError
from publish_completion import METADATA_KEY

POSTGRES = "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df"
MOTO = "motoserver/moto@sha256:66672d842bf19618966890c574d85198abe92800f4b3b2b5f791015fa1b58831"
HELPER = "damadama-recovery-metadata-proof"
BUCKET = "damadama-metadata-proof"


def error_category(raw):
    for marker, category in [
        (b"ModuleNotFoundError", "module-missing"),
        (b"ImportError", "import-error"),
        (b"SyntaxError", "syntax-error"),
        (b"python3: not found", "interpreter-missing"),
        (b"No such file or directory", "file-missing"),
    ]:
        if marker in raw:
            return category
    return "other" if raw else "empty"


def failure_details(result, expected):
    try:
        value = json.loads(result.stderr)
        parsed = True
    except (ValueError, UnicodeError):
        value, parsed = None, False
    exact = isinstance(value, dict) and set(value) == {"outcome", "failureCode"}
    expected_failure = value == {"outcome": "failed", "failureCode": expected}
    return {
        "exitCode": result.code,
        "stderrJsonParsed": parsed,
        "stderrKeysExact": exact,
        "failureCode": expected
        if expected_failure
        else ("other" if parsed else "unparseable"),
        "expectedFailure": result.code != 0 and expected_failure,
        "errorCategory": error_category(result.stderr),
    }


def listing_details(value):
    kind = {
        dict: "object",
        list: "array",
        type(None): "null",
        str: "string",
        int: "integer",
        bool: "boolean",
    }.get(type(value), "other")
    details = {"listTopLevelType": kind}
    if not isinstance(value, dict):
        return details
    present = "Contents" in value
    contents = value.get("Contents")
    kind = "other"
    if not present:
        kind = "absent"
    elif contents is None:
        kind = "null"
    elif isinstance(contents, list):
        kind = "list"
    details.update({"contentsKeyPresent": present, "contentsType": kind})
    if isinstance(contents, list):
        details["contentsCount"] = len(contents)
    count = value.get("KeyCount")
    if type(count) is int and 0 <= count <= 2**53 - 1:
        details["keyCount"] = count
    if type(value.get("IsTruncated")) is bool:
        details["isTruncated"] = value["IsTruncated"]
    return details


def listing_result_details(result):
    details = {"listExitCode": result.code, "stdoutByteLength": len(result.stdout)}
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        return {**details, "listJsonParsed": False, "listTopLevelType": "unparseable"}
    return {**details, "listJsonParsed": True, **listing_details(value)}


def require_empty_bucket(aws, check):
    check("automatic-list-call")
    automatic = aws("list-objects-v2", "--bucket", BUCKET, "--output", "json")
    check("automatic-list-result", listing_result_details(automatic))
    check("empty-bucket-first-page-call")
    listing = aws(
        "list-objects-v2",
        "--bucket",
        BUCKET,
        "--output",
        "json",
        "--no-paginate",
        "--max-keys",
        "1",
    )
    check("empty-bucket-list-parse", listing_result_details(listing))
    listed = json.loads(listing.stdout)
    check("no-backup-objects-created", listing_details(listed))
    assert listed.get("Contents", []) == []
    check("empty-first-page-complete")
    assert listed.get("IsTruncated") is False, (
        "Empty bucket first page must be complete"
    )
    check("empty-first-page-key-count")
    assert type(listed.get("KeyCount")) is int and listed["KeyCount"] == 0, (
        "Empty bucket first page must report zero keys"
    )


def packaged_details(result):
    details = {"exitCode": result.code, "errorCategory": error_category(result.stderr)}
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        value = None
    details["probeJsonObject"] = isinstance(value, dict)
    if not isinstance(value, dict):
        return details
    for tag in ["launcher", "publisher", "process"]:
        for suffix in ["Present", "Readable", "SourceMatch"]:
            details[tag + suffix] = value.get(tag + suffix) is True
    for tag in ["publisher", "process"]:
        details[tag + "Import"] = value.get(tag + "Import") is True
        category = value.get(tag + "ImportCategory")
        details[tag + "ImportCategory"] = (
            category
            if category
            in ["ok", "module-missing", "import-error", "syntax-error", "io-error"]
            else "other"
        )
    for key in ["runtimeMajor", "runtimeMinor"]:
        if type(value.get(key)) is int and 0 <= value[key] <= 100:
            details[key] = value[key]
    return details


def exception_category(error):
    if isinstance(error, PublicationError):
        code = str(error)
        if code in {
            "deadline_exceeded",
            "command_unavailable",
            "command_io_error",
            "command_output_limit",
            "command_cleanup_failed",
            "download_limit",
            "proof_command_failed",
            "proof_readiness",
        }:
            return code
        return "publication-error"
    return {
        AssertionError: "assertion",
        json.JSONDecodeError: "invalid-json",
        UnicodeDecodeError: "invalid-encoding",
        KeyError: "missing-field",
        TypeError: "unexpected-shape",
        OSError: "io-error",
    }.get(type(error), "other")


def prove():
    audit = Path(".audit").resolve()
    audit.mkdir(exist_ok=True)
    summary_path = audit / "completion-publication-proof.json"
    process = BoundedProcess(600, output_limit=16383)
    containers, checks, diagnostics = [], [], []
    network = None
    temporary = None
    scenario = "docker-preflight"
    phase = "docker-preflight:start"
    outcome = "failed"
    failure_category = None
    published_envelope_sha256 = None

    def check(code, details=None):
        nonlocal phase
        phase = f"{scenario}:{code}"
        event = {"check": phase}
        if details:
            event.update(details)
        diagnostics.append(event)
        print(json.dumps(event), file=sys.stderr)

    def stage(code):
        nonlocal scenario
        scenario = code
        check("start")

    def docker(*args, refused=False):
        result = process.run(["docker", *args])
        if not refused and result.code != 0:
            check(
                "command-exit",
                {
                    "exitCode": result.code,
                    "errorCategory": error_category(result.stderr),
                },
            )
            raise PublicationError("proof_command_failed")
        return result

    try:
        check("engine-info")
        docker("info", "--format", "{{.ServerVersion}}")
        check("default-entrypoint-read")
        entrypoint = json.loads(
            docker(
                "image", "inspect", "--format", "{{json .Config.Entrypoint}}", HELPER
            ).stdout
        )
        check("default-entrypoint-preserved")
        assert entrypoint == ["sh", "/opt/recovery/backup.sh"]
        check("isolated-network-create")
        network = (
            docker("network", "create", f"metadata-proof-{uuid.uuid4()}")
            .stdout.decode()
            .strip()
        )
        temporary = tempfile.TemporaryDirectory(prefix="metadata-proof-", dir=audit)
        directory = Path(temporary.name)
        check("temporary-directory-contained")
        assert directory.parent == audit
        password = secrets.token_hex(20)

        def run(*args):
            identity = (
                docker("run", "-d", "--network", network, *args).stdout.decode().strip()
            )
            containers.append(identity)
            return identity

        source = run(
            "--network-alias",
            "source-db",
            "-e",
            f"POSTGRES_PASSWORD={password}",
            "-e",
            "POSTGRES_DB=habits",
            POSTGRES,
        )
        run("--network-alias", "object-store", MOTO)
        helper = run(
            "--entrypoint",
            "sh",
            "--mount",
            f"type=bind,source={directory},target=/proof",
            "-e",
            "AWS_ACCESS_KEY_ID=synthetic-key",
            "-e",
            "AWS_SECRET_ACCESS_KEY=synthetic-secret",
            "-e",
            "AWS_DEFAULT_REGION=us-east-1",
            "-e",
            "AWS_MAX_ATTEMPTS=1",
            "-e",
            "AWS_ENDPOINT_URL=http://object-store:5000",
            "-e",
            f"S3_BUCKET={BUCKET}",
            "-e",
            "BACKUP_ENVIRONMENT=staging",
            "-e",
            "BACKUP_MAX_SECONDS=20",
            "-e",
            "PGHOST=source-db",
            "-e",
            "PGDATABASE=habits",
            "-e",
            "PGUSER=postgres",
            "-e",
            f"PGPASSWORD={password}",
            HELPER,
            "-c",
            "sleep 900",
        )

        def execute(*args, refused=False):
            return docker("exec", helper, *args, refused=refused)

        def aws(*args):
            return execute(
                "aws", "--endpoint-url", "http://object-store:5000", "s3api", *args
            )

        def wait_ready(args):
            end = time.monotonic() + 60
            while time.monotonic() < end:
                if docker(*args, refused=True).code == 0:
                    return
                time.sleep(1)
            raise PublicationError("proof_readiness")

        stage("isolated-resources")
        wait_ready(["exec", source, "pg_isready", "-U", "postgres", "-d", "habits"])
        wait_ready(
            [
                "exec",
                helper,
                "aws",
                "--endpoint-url",
                "http://object-store:5000",
                "s3api",
                "list-buckets",
            ]
        )
        docker(
            "exec",
            source,
            "psql",
            "-U",
            "postgres",
            "-d",
            "habits",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "CREATE TABLE recovery_sample(owner text, value text); INSERT INTO recovery_sample VALUES ('synthetic-owner','synthetic-backup-row');",
        )
        aws("create-bucket", "--bucket", BUCKET)
        execute("age-keygen", "-o", "/proof/identity")
        recipient = (
            execute("age-keygen", "-y", "/proof/identity").stdout.decode().strip()
        )

        def get(key):
            aws("get-object", "--bucket", BUCKET, "--key", key, "/proof/object.bin")
            return (directory / "object.bin").read_bytes()

        def put(key, body):
            (directory / "input.bin").write_bytes(body)
            aws(
                "put-object",
                "--bucket",
                BUCKET,
                "--key",
                key,
                "--body",
                "/proof/input.bin",
            )

        def policy(action=None, key=None):
            statements = []
            if action:
                statements = [
                    {
                        "Effect": "Deny",
                        "Principal": "*",
                        "Action": action,
                        "Resource": f"arn:aws:s3:::{BUCKET}/{key}",
                    }
                ]
            (directory / "policy.json").write_text(
                json.dumps({"Version": "2012-10-17", "Statement": statements})
            )
            aws(
                "put-bucket-policy",
                "--bucket",
                BUCKET,
                "--policy",
                "file:///proof/policy.json",
            )

        def adapter(code, value=None, key=None, retention_failed=False):
            (directory / "stdout.json").write_bytes(
                b"" if value is None else json.dumps(value).encode()
            )
            args = [
                "python3",
                "/opt/recovery/publish_completion.py",
                "publish",
                "--origin",
                "synthetic",
                "--backup-exit-code",
                str(code),
                "--stdout-file",
                "/proof/stdout.json",
            ]
            if key:
                args += ["--completion-key", key]
            if retention_failed:
                args += ["--retention-failed"]
            return execute(*args, refused=True)

        def failure(result, code):
            check("refused-command-exit", {"exitCode": result.code})
            assert result.code != 0
            check("exact-failure-response", failure_details(result, code))
            assert json.loads(result.stderr) == {
                "outcome": "failed",
                "failureCode": code,
            }

        def inspect_package():
            expected = {
                "launcher": (
                    "backup-with-metadata.sh",
                    hashlib.sha256(
                        Path(__file__).with_name("backup-with-metadata.sh").read_bytes()
                    ).hexdigest(),
                ),
                "publisher": (
                    "publish_completion.py",
                    hashlib.sha256(
                        Path(__file__).with_name("publish_completion.py").read_bytes()
                    ).hexdigest(),
                ),
                "process": (
                    "publication_process.py",
                    hashlib.sha256(
                        Path(__file__).with_name("publication_process.py").read_bytes()
                    ).hexdigest(),
                ),
            }
            script = f"""import hashlib,importlib,json,os,pathlib,sys
sys.path.insert(0,'/opt/recovery')
expected={expected!r}
result={{'runtimeMajor':sys.version_info.major,'runtimeMinor':sys.version_info.minor}}
for tag,(name,digest) in expected.items():
    path=pathlib.Path('/opt/recovery')/name
    try:
        result[tag+'Present']=path.is_file()
        result[tag+'Readable']=os.access(path,os.R_OK)
        result[tag+'SourceMatch']=hashlib.sha256(path.read_bytes()).hexdigest()==digest
    except OSError:
        result[tag+'SourceMatch']=False
for tag,name in [('publisher','publish_completion'),('process','publication_process')]:
    try:
        importlib.import_module(name)
        result[tag+'Import']=True
        result[tag+'ImportCategory']='ok'
    except Exception as error:
        result[tag+'Import']=False
        result[tag+'ImportCategory']={{ModuleNotFoundError:'module-missing',ImportError:'import-error',SyntaxError:'syntax-error',OSError:'io-error'}}.get(type(error),'other')
print(json.dumps(result))
"""
            result = execute("python3", "-c", script, refused=True)
            check("packaged-runtime-facts", packaged_details(result))

        stage("packaged-launcher-production-refusal")
        inspect_package()
        check("production-launcher-call")
        refused = docker(
            "exec",
            "-e",
            "BACKUP_ENVIRONMENT=production",
            "-e",
            f"AGE_RECIPIENT={recipient}",
            helper,
            "sh",
            "/opt/recovery/backup-with-metadata.sh",
            "--origin",
            "synthetic",
            refused=True,
        )
        failure(refused, "production_disabled")
        require_empty_bucket(aws, check)
        checks.append(scenario)

        stage("actual-backup-and-publication")
        result = docker(
            "exec",
            "-e",
            f"AGE_RECIPIENT={recipient}",
            helper,
            "sh",
            "/opt/recovery/backup-with-metadata.sh",
            "--origin",
            "synthetic",
        )
        check("successful-launcher-response-parse", {"exitCode": result.code})
        successful = json.loads(result.stdout)
        check("published-metadata-readback")
        actual = get(METADATA_KEY)
        check("published-metadata-equals-stdout")
        assert json.loads(actual) == successful
        check("origin-remains-synthetic")
        assert successful["origin"] == "synthetic"
        check("successful-job-and-retention")
        assert (successful["job"], successful["retention"]) == (
            "succeeded",
            "succeeded",
        )
        completed = successful["completion"]
        key = completed["backup"] + ".json"
        check("stored-manifest-equals-completion")
        assert json.loads(get(key)) == completed
        check("immutable-triplet-baseline")
        immutable = {
            suffix: hashlib.sha256(get(completed["backup"] + suffix)).hexdigest()
            for suffix in ["", ".sha256", ".json"]
        }
        (audit / "metadata-envelope.json").write_bytes(actual)
        published_envelope_sha256 = hashlib.sha256(actual).hexdigest()
        checks.append(scenario)

        stage("actual-failed-backup-with-explicit-completion")
        failed = docker(
            "exec",
            "-e",
            f"AGE_RECIPIENT={recipient}",
            "-e",
            "PGHOST=unavailable-source",
            helper,
            "sh",
            "/opt/recovery/backup-with-metadata.sh",
            "--origin",
            "synthetic",
            "--prior-completion-key",
            key,
            refused=True,
        )
        check(
            "backup-failure-exit",
            {"exitCode": failed.code, "errorCategory": error_category(failed.stderr)},
        )
        assert failed.code != 0
        check("failed-job-metadata-readback")
        value = json.loads(get(METADATA_KEY))
        check("failed-job-stdout-equals-readback")
        assert json.loads(failed.stdout) == value
        check("explicit-prior-completion-preserved")
        assert value["completion"] == completed
        check("failed-job-never-implies-retention-success")
        assert (value["job"], value["retention"]) == ("failed", "unknown")
        checks.append(scenario)

        stage("explicit-observed-retention-failure")
        check("observed-retention-adapter-call")
        observed_retention = adapter(42, key=key, retention_failed=True)
        check(
            "observed-retention-adapter-exit",
            {
                "exitCode": observed_retention.code,
                "errorCategory": error_category(observed_retention.stderr),
            },
        )
        assert observed_retention.code == 0
        check("observed-retention-failure-readback")
        assert json.loads(get(METADATA_KEY))["retention"] == "failed"
        checks.append(scenario)

        def fixture():
            started = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
            stamp = started.strftime("%Y%m%dT%H%M%SZ")
            return {
                "environment": "staging",
                "backup": f"damadama/staging/{stamp}-{secrets.token_hex(8)}.dump.age",
                "completedAt": started.isoformat(timespec="seconds").replace(
                    "+00:00", "Z"
                ),
                "retentionDays": 7,
                "durationSeconds": 0,
            }

        for name, parts in [
            ("missing-manifest", []),
            ("missing-archive", [".json", ".sha256"]),
            ("missing-checksum", [".json", ""]),
            ("corrupt-archive-presence-only-fixture", [".json", ".sha256", ""]),
        ]:
            stage(name)
            value = fixture()
            selected = value["backup"] + ".json"
            for suffix in parts:
                body = (
                    json.dumps(value).encode()
                    if suffix == ".json"
                    else b"deliberately invalid bytes; presence only"
                )
                put(value["backup"] + suffix, body)
            before = get(METADATA_KEY)
            if name != "corrupt-archive-presence-only-fixture":
                failure(adapter(0, value=value), "successful_triplet_missing")
                check("missing-successful-triplet-retains-previous-object")
                assert get(METADATA_KEY) == before
            check("failed-job-observation-call")
            failed_observation = adapter(42, key=selected)
            check(
                "failed-job-observation-exit",
                {
                    "exitCode": failed_observation.code,
                    "errorCategory": error_category(failed_observation.stderr),
                },
            )
            assert failed_observation.code == 0
            check("failed-job-observation-readback")
            observed = json.loads(get(METADATA_KEY))
            check("fixture-origin-remains-synthetic")
            assert observed["origin"] == "synthetic"
            check("archive-presence-is-exact")
            assert observed["archivePresent"] == ("" in parts)
            check("checksum-presence-is-exact")
            assert observed["checksumPresent"] == (".sha256" in parts)
            check("presence-cannot-imply-job-or-retention-success")
            assert observed["job"] == "failed" and observed["retention"] == "unknown"
            checks.append(scenario)

        for name, raw, code in [
            ("malformed-manifest", b"{", "invalid_json"),
            ("oversized-manifest", b"x" * 5000, "download_limit"),
            (
                "wrong-environment",
                json.dumps({**completed, "environment": "production"}).encode(),
                "wrong_environment",
            ),
            (
                "future-completion",
                json.dumps(
                    {**completed, "completedAt": "2099-01-01T00:00:00Z"}
                ).encode(),
                "completion_time_order",
            ),
        ]:
            stage(name)
            value = fixture()
            selected = value["backup"] + ".json"
            put(selected, raw)
            before = get(METADATA_KEY)
            failure(adapter(42, key=selected), code)
            check("invalid-manifest-retains-previous-object")
            assert get(METADATA_KEY) == before
            checks.append(scenario)

        stage("mismatched-successful-stdout")
        before = get(METADATA_KEY)
        failure(
            adapter(
                0,
                value={
                    **completed,
                    "durationSeconds": completed["durationSeconds"] + 1,
                },
            ),
            "successful_manifest_mismatch",
        )
        check("mismatched-stdout-retains-previous-object")
        assert get(METADATA_KEY) == before
        checks.append(scenario)

        stage("actual-packaged-cli-access-refusal")
        policy("s3:GetObject", key)
        failure(adapter(42, key=key), "storage_refused")
        check("refused-manifest-read-retains-previous-object")
        assert get(METADATA_KEY) == before
        checks.append(scenario)

        stage("definite-put-refusal-preserves-previous-object")
        policy("s3:PutObject", METADATA_KEY)
        failure(adapter(0, value=completed), "storage_refused")
        check("definite-put-refusal-retains-previous-object")
        assert get(METADATA_KEY) == before
        checks.append(scenario)

        stage("actual-readback-refusal")
        policy("s3:GetObject", METADATA_KEY)
        failure(adapter(0, value=completed), "storage_refused")
        check("remove-readback-refusal-policy")
        policy()
        check("readback-refusal-can-follow-replacement")
        assert get(METADATA_KEY) != before
        checks.append(scenario)

        stage("immutable-triplets-preserved")
        for suffix, expected in immutable.items():
            check(
                {
                    "": "archive-unchanged",
                    ".sha256": "checksum-unchanged",
                    ".json": "manifest-unchanged",
                }[suffix]
            )
            assert (
                hashlib.sha256(get(completed["backup"] + suffix)).hexdigest()
                == expected
            )
        checks.append(scenario)
        outcome = "passed"
    except Exception as error:
        failure_category = exception_category(error)
    finally:
        cleanup = BoundedProcess(60)
        results = []
        for identity in reversed(containers):
            try:
                results.append(cleanup.run(["docker", "rm", "-f", identity]).code == 0)
            except Exception:
                results.append(False)
        if network:
            try:
                results.append(
                    cleanup.run(["docker", "network", "rm", network]).code == 0
                )
            except Exception:
                results.append(False)
        if temporary is not None:
            try:
                temporary.cleanup()
            except Exception:
                results.append(False)
        if not all(results):
            phase, outcome = "cleanup", "failed"
            failure_category = "cleanup"
        summary = {
            "schema": 1,
            "scope": "isolated-Moto-PostgreSQL",
            "origin": "synthetic",
            "outcome": outcome,
            "checks": checks,
            "diagnostics": diagnostics,
            "hostedExecution": "not-executed",
            "cleanup": "passed" if all(results) else "failed",
        }
        if outcome != "passed":
            summary["failureCode"] = phase
            summary["failureCategory"] = failure_category or "cleanup"
        if published_envelope_sha256 is not None:
            summary["publishedEnvelopeSha256"] = published_envelope_sha256
        summary_path.write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary))
    return 0 if outcome == "passed" else 1


if __name__ == "__main__":
    sys.exit(prove())
