import argparse
import datetime as dt
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit

from publication_process import BoundedProcess, PublicationError

METADATA_KEY = "damadama/staging/monitor/completion.json"
MANIFEST_LIMIT = 4096
ENVELOPE_LIMIT = 16383
STDOUT_LIMIT = 8192
MANIFEST_KEYS = {
    "environment",
    "backup",
    "completedAt",
    "retentionDays",
    "durationSeconds",
}
ENVELOPE_KEYS = {
    "schemaVersion",
    "origin",
    "observedAt",
    "completion",
    "archivePresent",
    "checksumPresent",
    "job",
    "retention",
}
OUTCOMES = {"succeeded", "failed", "unknown"}
KEY = re.compile(r"damadama/staging/(\d{8}T\d{6}Z)-[a-f0-9]{16}\.dump\.age")
INSTANT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z")


def require(condition, code):
    if not condition:
        raise PublicationError(code)


def instant(value):
    require(isinstance(value, str) and INSTANT.fullmatch(value), "invalid_timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise PublicationError("invalid_timestamp") from None
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    expected = value.replace("Z", ".000Z") if len(value) == 20 else value
    require(canonical == expected, "invalid_timestamp")
    return parsed


def decode(raw, limit):
    require(len(raw) <= limit, "json_limit")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise PublicationError("invalid_json") from None


def backup_start(key):
    match = KEY.fullmatch(key) if isinstance(key, str) else None
    require(match is not None, "invalid_backup_key")
    stamp = match[1]
    return instant(
        f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}Z"
    )


def completion(value, now, selected_key=None):
    require(
        isinstance(value, dict) and set(value) == MANIFEST_KEYS,
        "invalid_completion_fields",
    )
    require(value["environment"] == "staging", "wrong_environment")
    started = backup_start(value["backup"])
    finished = instant(value["completedAt"])
    require(started <= finished <= now, "completion_time_order")
    require(
        type(value["retentionDays"]) is int
        and 7 <= value["retentionDays"] <= 9007199254740991,
        "invalid_retention_days",
    )
    require(
        type(value["durationSeconds"]) is int
        and 0 <= value["durationSeconds"] <= 9007199254740991,
        "invalid_duration",
    )
    if selected_key is not None:
        require(selected_key == value["backup"] + ".json", "completion_key_mismatch")
    return value


def validate_selected_key(key):
    require(
        isinstance(key, str) and key.endswith(".json") and KEY.fullmatch(key[:-5]),
        "invalid_completion_key",
    )
    backup_start(key[:-5])


def validate_envelope(value, now):
    require(
        isinstance(value, dict) and set(value) == ENVELOPE_KEYS,
        "invalid_envelope_fields",
    )
    require(
        type(value["schemaVersion"]) is int and value["schemaVersion"] == 1,
        "invalid_schema",
    )
    require(
        isinstance(value["origin"], str) and value["origin"] in {"synthetic", "hosted"},
        "invalid_origin",
    )
    observed = instant(value["observedAt"])
    require(observed <= now, "future_observation")
    require(
        type(value["archivePresent"]) is bool
        and type(value["checksumPresent"]) is bool,
        "invalid_presence",
    )
    require(
        isinstance(value["job"], str)
        and isinstance(value["retention"], str)
        and value["job"] in OUTCOMES
        and value["retention"] in OUTCOMES,
        "invalid_outcome",
    )
    if value["completion"] is not None:
        completion(value["completion"], now)
        require(
            instant(value["completion"]["completedAt"]) <= observed,
            "observation_before_completion",
        )
    return value


@dataclass(frozen=True)
class AwsConfiguration:
    endpoint: str
    bucket: str
    environment: dict

    @classmethod
    def load(cls, environment, origin):
        require(
            environment.get("BACKUP_ENVIRONMENT") == "staging", "production_disabled"
        )
        require(
            environment.get("AWS_ACCESS_KEY_ID")
            and environment.get("AWS_SECRET_ACCESS_KEY"),
            "storage_credentials_missing",
        )
        require(
            re.fullmatch(
                r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", environment.get("S3_BUCKET", "")
            ),
            "invalid_bucket",
        )
        address = urlsplit(environment.get("AWS_ENDPOINT_URL", ""))
        require(
            address.scheme in {"http", "https"}
            and address.hostname
            and not address.username
            and not address.password
            and not address.query
            and not address.fragment,
            "invalid_endpoint",
        )
        require(
            origin != "hosted" or address.scheme == "https", "hosted_requires_https"
        )
        isolated = {
            key: value
            for key, value in environment.items()
            if key
            not in {
                "AWS_PROFILE",
                "AWS_DEFAULT_PROFILE",
                "AWS_REGION",
                "AWS_WEB_IDENTITY_TOKEN_FILE",
                "AWS_ROLE_ARN",
                "AWS_ROLE_SESSION_NAME",
                "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN",
                "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
            }
        }
        return cls(
            environment["AWS_ENDPOINT_URL"],
            environment["S3_BUCKET"],
            {
                **isolated,
                "AWS_DEFAULT_REGION": environment.get("AWS_DEFAULT_REGION") or "auto",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                "AWS_MAX_ATTEMPTS": "1",
                "AWS_RETRY_MODE": "standard",
                "AWS_PAGER": "",
                "AWS_CLI_AUTO_PROMPT": "off",
            },
        )


class AwsObjects:
    def __init__(self, configuration, process, directory):
        self.prefix = [
            "aws",
            "--endpoint-url",
            configuration.endpoint,
            "--cli-connect-timeout",
            "5",
            "--cli-read-timeout",
            "5",
            "--output",
            "json",
            "s3api",
        ]
        self.bucket = configuration.bucket
        self.environment = configuration.environment
        self.process = process
        self.directory = directory

    def call(self, operation, key, extra=(), *, output=None, limit=None):
        result = self.process.run(
            self.prefix
            + [operation, "--bucket", self.bucket, "--key", key]
            + list(extra),
            env=self.environment,
            watched_file=output,
            file_limit=limit,
        )
        if result.code == 0:
            return True
        api_operation = {"get-object": "GetObject", "head-object": "HeadObject"}.get(
            operation
        )
        if api_operation and re.fullmatch(
            rb"\s*(?:aws: \[ERROR\]: )?An error occurred \((?:404|NoSuchKey)\) when calling the "
            + api_operation.encode()
            + rb" operation(?: \(reached max retries: 0\))?:[^\r\n]*\s*",
            result.stderr,
        ):
            return False
        raise PublicationError("storage_refused")

    def get(self, key, limit):
        output = self.directory / "download.json"
        output.unlink(missing_ok=True)
        present = self.call(
            "get-object",
            key,
            ["--range", f"bytes=0-{limit}", str(output)],
            output=output,
            limit=limit,
        )
        if not present:
            return None
        require(output.exists() and output.stat().st_size <= limit, "download_limit")
        return output.read_bytes()

    def head(self, key):
        return self.call("head-object", key)

    def put(self, raw):
        output = self.directory / "publication.json"
        output.write_bytes(raw)
        self.call(
            "put-object",
            METADATA_KEY,
            [
                "--body",
                str(output),
                "--content-type",
                "application/json",
                "--cache-control",
                "no-store",
            ],
        )


def publish(
    objects,
    *,
    origin,
    backup_exit_code,
    stdout,
    selected_key=None,
    retention_failed=False,
    clock=None,
):
    clock = clock or (lambda: dt.datetime.now(dt.timezone.utc))
    now = clock()
    require(
        isinstance(origin, str) and origin in {"synthetic", "hosted"}, "invalid_origin"
    )
    require(
        type(backup_exit_code) is int and 0 <= backup_exit_code <= 255,
        "invalid_backup_exit_code",
    )
    require(len(stdout) <= STDOUT_LIMIT, "stdout_limit")
    require(
        type(retention_failed) is bool
        and not (backup_exit_code == 0 and retention_failed),
        "conflicting_retention_observation",
    )
    expected = None
    if backup_exit_code == 0:
        expected = completion(decode(stdout, STDOUT_LIMIT), now)
        if selected_key is not None:
            require(
                selected_key == expected["backup"] + ".json", "completion_key_mismatch"
            )
        selected_key = expected["backup"] + ".json"
    if selected_key is not None:
        validate_selected_key(selected_key)
    stored = None
    archive_present = False
    checksum_present = False
    if selected_key is not None:
        raw = objects.get(selected_key, MANIFEST_LIMIT)
        if raw is not None:
            stored = completion(decode(raw, MANIFEST_LIMIT), now, selected_key)
            if expected is not None:
                require(stored == expected, "successful_manifest_mismatch")
            archive_present = objects.head(stored["backup"])
            checksum_present = objects.head(stored["backup"] + ".sha256")
    if backup_exit_code == 0:
        require(
            stored is not None and archive_present and checksum_present,
            "successful_triplet_missing",
        )
    observed = clock().isoformat(timespec="milliseconds").replace("+00:00", "Z")
    envelope = validate_envelope(
        {
            "schemaVersion": 1,
            "origin": origin,
            "observedAt": observed,
            "completion": stored,
            "archivePresent": archive_present,
            "checksumPresent": checksum_present,
            "job": "succeeded" if backup_exit_code == 0 else "failed",
            "retention": "succeeded" if backup_exit_code == 0 else "unknown",
        },
        clock(),
    )
    if retention_failed:
        envelope["retention"] = "failed"
    raw = json.dumps(envelope, separators=(",", ":"), ensure_ascii=True).encode()
    require(len(raw) <= ENVELOPE_LIMIT, "envelope_limit")
    objects.put(raw)
    require(objects.get(METADATA_KEY, ENVELOPE_LIMIT) == raw, "readback_mismatch")
    return raw


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise PublicationError("invalid_arguments")


def main(argv=None):
    try:
        parser = SafeParser()
        parser.add_argument("mode", choices=["publish", "supervise"])
        parser.add_argument("--origin", required=True, choices=["synthetic", "hosted"])
        parser.add_argument("--backup-exit-code", type=int)
        parser.add_argument("--stdout-file", type=Path)
        parser.add_argument("--completion-key")
        parser.add_argument("--prior-completion-key")
        parser.add_argument("--retention-failed", action="store_true")
        parser.add_argument("--deadline-seconds", type=int, default=30)
        args = parser.parse_args(argv)
        require(1 <= args.deadline_seconds <= 300, "invalid_deadline")
        configuration = AwsConfiguration.load(os.environ.copy(), args.origin)
        if args.completion_key is not None:
            validate_selected_key(args.completion_key)
        if args.prior_completion_key is not None:
            validate_selected_key(args.prior_completion_key)
        exit_code = args.backup_exit_code
        stdout = b""
        if args.mode == "supervise":
            require(
                exit_code is None
                and args.stdout_file is None
                and args.completion_key is None
                and not args.retention_failed,
                "invalid_arguments",
            )
            require(
                all(
                    os.environ.get(name)
                    for name in [
                        "PGHOST",
                        "PGDATABASE",
                        "PGUSER",
                        "PGPASSWORD",
                        "AWS_ACCESS_KEY_ID",
                        "AWS_SECRET_ACCESS_KEY",
                        "AGE_RECIPIENT",
                    ]
                ),
                "backup_configuration_missing",
            )
            backup_seconds = os.environ.get("BACKUP_MAX_SECONDS", "1800")
            require(
                re.fullmatch(r"[0-9]{1,5}", backup_seconds)
                and 0 < int(backup_seconds) <= 86400,
                "invalid_backup_deadline",
            )
            try:
                result = BoundedProcess(int(backup_seconds) + 10).run(
                    ["sh", str(Path(__file__).with_name("backup.sh"))],
                    env=configuration.environment,
                )
                exit_code, stdout = result.code, result.stdout
                if exit_code < 0:
                    exit_code = 1
            except PublicationError:
                exit_code = 1
            selected_key = args.prior_completion_key if exit_code != 0 else None
        else:
            require(
                exit_code is not None
                and args.stdout_file is not None
                and args.prior_completion_key is None,
                "invalid_arguments",
            )
            selected_key = args.completion_key
            with args.stdout_file.open("rb") as source:
                stdout = source.read(STDOUT_LIMIT + 1)
        with tempfile.TemporaryDirectory(prefix="damadama-publication-") as directory:
            os.chmod(directory, 0o700)
            process = BoundedProcess(args.deadline_seconds)
            objects = AwsObjects(configuration, process, Path(directory))
            raw = publish(
                objects,
                origin=args.origin,
                backup_exit_code=exit_code,
                stdout=stdout,
                selected_key=selected_key,
                retention_failed=args.retention_failed,
            )
        print(raw.decode())
        return exit_code if args.mode == "supervise" else 0
    except PublicationError as error:
        print(
            json.dumps({"outcome": "failed", "failureCode": str(error)}),
            file=sys.stderr,
        )
        return 1
    except Exception:
        print('{"outcome":"failed","failureCode":"publication_error"}', file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
