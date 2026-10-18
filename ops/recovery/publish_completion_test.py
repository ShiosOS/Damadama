import copy
import datetime as dt
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from publication_process import BoundedProcess, CommandResult, PublicationError
from prove_completion_publication import (
    exception_category,
    failure_details,
    listing_details,
    packaged_details,
)
from publish_completion import (
    AwsConfiguration,
    AwsObjects,
    ENVELOPE_KEYS,
    MANIFEST_LIMIT,
    METADATA_KEY,
    STDOUT_LIMIT,
    completion,
    decode,
    main,
    publish,
    validate_envelope,
)

NOW = dt.datetime(2026, 10, 18, 10, tzinfo=dt.timezone.utc)
CANARY = "private-credential-url-habit-canary"


def manifest():
    return {
        "environment": "staging",
        "backup": "damadama/staging/20261018T095900Z-aaaaaaaaaaaaaaaa.dump.age",
        "completedAt": "2026-10-18T09:59:01Z",
        "retentionDays": 7,
        "durationSeconds": 0,
    }


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


class Objects:
    def __init__(self, value=None):
        value = value or manifest()
        self.data = {
            value["backup"] + ".json": encoded(value),
            value["backup"]: b"corrupt archive is still present",
            value["backup"] + ".sha256": b"not cryptographically verified",
            METADATA_KEY: b"previous metadata",
        }
        self.calls = []
        self.fail = None
        self.bad_readback = False

    def get(self, key, limit):
        self.calls.append(("get", key))
        if self.fail == "get":
            raise PublicationError("storage_refused")
        if key == METADATA_KEY and self.bad_readback:
            return b"different body"
        return self.data.get(key)

    def head(self, key):
        self.calls.append(("head", key))
        if self.fail == "head":
            raise PublicationError("storage_refused")
        return key in self.data

    def put(self, raw):
        self.calls.append(("put", METADATA_KEY))
        if self.fail == "put":
            raise PublicationError("storage_refused")
        self.data[METADATA_KEY] = raw


class PublicationTests(unittest.TestCase):
    def publish(self, objects, **changes):
        arguments = {
            "origin": "synthetic",
            "backup_exit_code": 0,
            "stdout": encoded(manifest()),
            "clock": lambda: NOW,
        }
        arguments.update(changes)
        return json.loads(publish(objects, **arguments))

    def test_success_preserves_exact_five_keys_and_reads_back_fixed_object(self):
        objects = Objects()
        before = copy.deepcopy(objects.data)
        result = self.publish(objects)
        self.assertEqual(set(result), ENVELOPE_KEYS)
        self.assertEqual(result["completion"], manifest())
        self.assertEqual(result["job"], "succeeded")
        self.assertEqual(result["retention"], "succeeded")
        self.assertTrue(result["archivePresent"])
        self.assertTrue(result["checksumPresent"])
        self.assertEqual(result["origin"], "synthetic")
        self.assertEqual(result["observedAt"], "2026-10-18T10:00:00.000Z")
        self.assertLess(len(objects.data[METADATA_KEY]), 16384)
        self.assertEqual(
            objects.calls[-2:], [("put", METADATA_KEY), ("get", METADATA_KEY)]
        )
        for key, raw in before.items():
            if key != METADATA_KEY:
                self.assertEqual(objects.data[key], raw)
        self.assertFalse(
            any(op == "get" and key.endswith(".dump.age") for op, key in objects.calls)
        )

    def test_failed_job_can_observe_explicit_older_completion_without_invented_success(
        self,
    ):
        value = manifest()
        value["backup"] = value["backup"].replace("20261018", "20251018")
        value["completedAt"] = "2025-10-18T09:59:01Z"
        objects = Objects(value)
        result = self.publish(
            objects,
            backup_exit_code=42,
            stdout=CANARY.encode(),
            selected_key=value["backup"] + ".json",
        )
        self.assertEqual(result["completion"], value)
        self.assertEqual((result["job"], result["retention"]), ("failed", "unknown"))
        result = self.publish(
            objects,
            backup_exit_code=42,
            selected_key=value["backup"] + ".json",
            retention_failed=True,
        )
        self.assertEqual(result["retention"], "failed")

    def test_failed_job_without_selected_completion_does_not_guess_from_stdout(self):
        objects = Objects()
        result = self.publish(objects, backup_exit_code=1)
        self.assertIsNone(result["completion"])
        self.assertFalse(result["archivePresent"])
        self.assertFalse(result["checksumPresent"])
        self.assertEqual(objects.calls, [("put", METADATA_KEY), ("get", METADATA_KEY)])

    def test_definite_missing_parts_publish_honest_failure_presence_but_refuse_success(
        self,
    ):
        for suffix, field in [
            (".json", "completion"),
            ("", "archivePresent"),
            (".sha256", "checksumPresent"),
        ]:
            with self.subTest(suffix=suffix):
                objects = Objects()
                del objects.data[manifest()["backup"] + suffix]
                with self.assertRaisesRegex(
                    PublicationError, "successful_triplet_missing"
                ):
                    self.publish(objects)
                self.assertNotIn(("put", METADATA_KEY), objects.calls)
                result = self.publish(
                    objects,
                    backup_exit_code=1,
                    selected_key=manifest()["backup"] + ".json",
                )
                if field == "completion":
                    self.assertIsNone(result[field])
                else:
                    self.assertFalse(result[field])

    def test_bad_reads_never_put_and_definite_failed_put_retains_previous_object(self):
        for operation in ["get", "head", "put"]:
            with self.subTest(operation=operation):
                objects = Objects()
                objects.fail = operation
                with self.assertRaisesRegex(PublicationError, "storage_refused"):
                    self.publish(objects)
                self.assertEqual(objects.data[METADATA_KEY], b"previous metadata")
                if operation != "put":
                    self.assertNotIn(("put", METADATA_KEY), objects.calls)

    def test_readback_failure_is_not_reported_as_publication_success(self):
        objects = Objects()
        objects.bad_readback = True
        with self.assertRaisesRegex(PublicationError, "readback_mismatch"):
            self.publish(objects)
        self.assertNotEqual(objects.data[METADATA_KEY], b"previous metadata")

    def test_stored_completion_must_equal_successful_stdout(self):
        objects = Objects()
        changed = manifest()
        changed["durationSeconds"] = 1
        objects.data[changed["backup"] + ".json"] = encoded(changed)
        with self.assertRaisesRegex(PublicationError, "successful_manifest_mismatch"):
            self.publish(objects)
        self.assertNotIn(("put", METADATA_KEY), objects.calls)

    def test_input_failures_have_useful_codes_and_never_put(self):
        for arguments, code in [
            ({"origin": "unknown"}, "invalid_origin"),
            ({"backup_exit_code": True}, "invalid_backup_exit_code"),
            ({"backup_exit_code": -1}, "invalid_backup_exit_code"),
            ({"backup_exit_code": 256}, "invalid_backup_exit_code"),
            ({"stdout": b"x" * (STDOUT_LIMIT + 1)}, "stdout_limit"),
            ({"stdout": b"not JSON"}, "invalid_json"),
            ({"stdout": encoded(manifest()) + encoded(manifest())}, "invalid_json"),
            (
                {
                    "selected_key": manifest()["backup"].replace("aaaaaaaa", "bbbbbbbb")
                    + ".json"
                },
                "completion_key_mismatch",
            ),
            (
                {"backup_exit_code": 1, "selected_key": "../private.json"},
                "invalid_completion_key",
            ),
            (
                {
                    "backup_exit_code": 1,
                    "selected_key": manifest()["backup"].replace("20261018", "20260230")
                    + ".json",
                },
                "invalid_timestamp",
            ),
            ({"retention_failed": True}, "conflicting_retention_observation"),
        ]:
            with self.subTest(code=code, arguments=list(arguments)):
                objects = Objects()
                with self.assertRaisesRegex(PublicationError, code):
                    self.publish(objects, **arguments)
                self.assertNotIn(("put", METADATA_KEY), objects.calls)

    def test_malformed_oversized_and_future_stored_values_abort_without_put(self):
        future = manifest()
        future["completedAt"] = "2026-10-18T10:00:01Z"
        for raw, code in [
            (b"{", "invalid_json"),
            (b" " * (MANIFEST_LIMIT + 1), "json_limit"),
            (encoded(future), "completion_time_order"),
        ]:
            objects = Objects()
            objects.data[manifest()["backup"] + ".json"] = raw
            with self.assertRaisesRegex(PublicationError, code):
                self.publish(objects)
            self.assertNotIn(("put", METADATA_KEY), objects.calls)


class BoundaryTests(unittest.TestCase):
    def test_manifest_accepts_canonical_seconds_milliseconds_and_integer_boundaries(
        self,
    ):
        value = manifest()
        self.assertIs(completion(value, NOW), value)
        value["completedAt"] = "2026-10-18T09:59:01.001Z"
        self.assertIs(completion(value, NOW, value["backup"] + ".json"), value)

    def test_manifest_refuses_each_invalid_boundary(self):
        for field, value, code in [
            ("extra", CANARY, "invalid_completion_fields"),
            ("environment", "production", "wrong_environment"),
            (
                "backup",
                "damadama/staging/20260230T095900Z-aaaaaaaaaaaaaaaa.dump.age",
                "invalid_timestamp",
            ),
            (
                "backup",
                "damadama/staging/20261018T100001Z-aaaaaaaaaaaaaaaa.dump.age",
                "completion_time_order",
            ),
            ("backup", "../archive", "invalid_backup_key"),
            ("completedAt", "2026-02-30T09:59:01Z", "invalid_timestamp"),
            ("completedAt", "2026-10-18T09:59:01+00:00", "invalid_timestamp"),
            ("completedAt", "2026-10-18T09:59:01.000001Z", "invalid_timestamp"),
            ("completedAt", "2026-10-18T10:00:01Z", "completion_time_order"),
            ("retentionDays", 6, "invalid_retention_days"),
            ("retentionDays", True, "invalid_retention_days"),
            ("retentionDays", 7.0, "invalid_retention_days"),
            ("durationSeconds", -1, "invalid_duration"),
            ("durationSeconds", False, "invalid_duration"),
            ("durationSeconds", 0.1, "invalid_duration"),
            ("durationSeconds", 9007199254740992, "invalid_duration"),
        ]:
            with self.subTest(field=field, code=code):
                changed = manifest()
                changed[field] = value
                with self.assertRaisesRegex(PublicationError, code):
                    completion(changed, NOW)

    def test_json_refuses_duplicate_keys_invalid_utf8_and_extra_values(self):
        for raw, code in [
            (b'{"key":1,"key":2}', "duplicate_json_key"),
            (b'"\xff"', "invalid_json"),
            (b"{}{}", "invalid_json"),
        ]:
            with self.assertRaisesRegex(PublicationError, code):
                decode(raw, MANIFEST_LIMIT)

    def test_exact_envelope_boundaries(self):
        value = json.loads(
            publish(
                Objects(),
                origin="synthetic",
                backup_exit_code=0,
                stdout=encoded(manifest()),
                clock=lambda: NOW,
            )
        )
        for field, invalid, code in [
            ("extra", 1, "invalid_envelope_fields"),
            ("schemaVersion", True, "invalid_schema"),
            ("origin", "unknown", "invalid_origin"),
            ("observedAt", "2026-10-18T10:00:01Z", "future_observation"),
            ("observedAt", "2026-10-18T09:59:00Z", "observation_before_completion"),
            ("archivePresent", 1, "invalid_presence"),
            ("checksumPresent", "true", "invalid_presence"),
            ("job", "okay", "invalid_outcome"),
            ("retention", {}, "invalid_outcome"),
        ]:
            changed = copy.deepcopy(value)
            changed[field] = invalid
            with self.assertRaisesRegex(PublicationError, code):
                validate_envelope(changed, NOW)


class DiagnosticTests(unittest.TestCase):
    def test_failure_diagnostic_accepts_only_expected_fixed_code(self):
        accepted = CommandResult(
            1, b"", encoded({"outcome": "failed", "failureCode": "production_disabled"})
        )
        details = failure_details(accepted, "production_disabled")
        self.assertTrue(details["expectedFailure"])
        self.assertTrue(details["stderrKeysExact"])
        self.assertEqual(details["failureCode"], "production_disabled")
        for raw, category in [
            (
                encoded({"outcome": "failed", "failureCode": CANARY, "extra": CANARY}),
                "other",
            ),
            (b"ModuleNotFoundError: " + CANARY.encode(), "module-missing"),
            (CANARY.encode(), "other"),
        ]:
            details = failure_details(CommandResult(1, b"", raw), "production_disabled")
            self.assertFalse(details["expectedFailure"])
            self.assertEqual(details["errorCategory"], category)
            self.assertNotIn(CANARY, json.dumps(details))

    def test_listing_diagnostics_distinguish_absent_null_and_nonempty_without_keys(
        self,
    ):
        for value, expected in [
            (
                {},
                {
                    "listTopLevelType": "object",
                    "contentsKeyPresent": False,
                    "contentsType": "absent",
                },
            ),
            (
                {"Contents": None, "KeyCount": 0},
                {
                    "listTopLevelType": "object",
                    "contentsKeyPresent": True,
                    "contentsType": "null",
                    "keyCount": 0,
                },
            ),
            (
                {"Contents": [], "KeyCount": 0},
                {
                    "listTopLevelType": "object",
                    "contentsKeyPresent": True,
                    "contentsType": "list",
                    "contentsCount": 0,
                    "keyCount": 0,
                },
            ),
            (
                {"Contents": [{"Key": CANARY}], "KeyCount": 1},
                {
                    "listTopLevelType": "object",
                    "contentsKeyPresent": True,
                    "contentsType": "list",
                    "contentsCount": 1,
                    "keyCount": 1,
                },
            ),
            ([CANARY], {"listTopLevelType": "array"}),
            (None, {"listTopLevelType": "null"}),
        ]:
            details = listing_details(value)
            self.assertEqual(details, expected)
            self.assertNotIn(CANARY, json.dumps(details))
        for count in [True, 2**53, CANARY]:
            self.assertNotIn("keyCount", listing_details({"KeyCount": count}))

    def test_packaged_diagnostics_accept_only_named_boolean_version_and_error_fields(
        self,
    ):
        facts = {
            "publisherPresent": True,
            "publisherImport": True,
            "publisherImportCategory": "ok",
            "runtimeMajor": 3,
            "runtimeMinor": 11,
        }
        details = packaged_details(CommandResult(0, encoded(facts), b""))
        self.assertTrue(details["publisherPresent"])
        self.assertTrue(details["publisherImport"])
        self.assertEqual(details["publisherImportCategory"], "ok")
        self.assertEqual(details["runtimeMajor"], 3)
        refused = {
            **facts,
            "publisherPresent": CANARY,
            "publisherImportCategory": CANARY,
            "runtimeMajor": CANARY,
            "raw": CANARY,
        }
        details = packaged_details(CommandResult(1, encoded(refused), CANARY.encode()))
        self.assertFalse(details["publisherPresent"])
        self.assertEqual(details["publisherImportCategory"], "other")
        self.assertNotIn("runtimeMajor", details)
        self.assertNotIn(CANARY, json.dumps(details))
        self.assertFalse(
            packaged_details(CommandResult(1, CANARY.encode(), b""))["probeJsonObject"]
        )

    def test_exception_diagnostics_never_echo_unrecognized_error_messages(self):
        self.assertEqual(exception_category(AssertionError(CANARY)), "assertion")
        self.assertEqual(
            exception_category(PublicationError("deadline_exceeded")),
            "deadline_exceeded",
        )
        self.assertEqual(
            exception_category(PublicationError(CANARY)), "publication-error"
        )
        self.assertEqual(exception_category(RuntimeError(CANARY)), "other")


class ProcessTests(unittest.TestCase):
    def test_descendant_pipe_capture_cannot_succeed_after_the_deadline(self):
        child = "import time;time.sleep(0.6);print('late-output')"
        parent = (
            "import subprocess,sys;"
            f"subprocess.Popen([sys.executable,'-c',{child!r}]);"
            "print('parent-exited')"
        )
        with self.assertRaisesRegex(PublicationError, "deadline_exceeded"):
            BoundedProcess(0.25).run([sys.executable, "-c", parent])

    @unittest.skipUnless(sys.platform == "linux", "Linux process-group cleanup")
    def test_deadline_terminates_descendant_group_after_leader_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "descendant.pid"
            child = (
                "from pathlib import Path;import os,sys,time;"
                "Path(sys.argv[1]).write_text(str(os.getpid()));"
                "print('descendant-holds-pipes',flush=True);time.sleep(30)"
            )
            parent = (
                "import subprocess,sys;"
                f"subprocess.Popen([sys.executable,'-c',{child!r},sys.argv[1]]);"
                "print('leader-exits',flush=True)"
            )
            descendant = None
            start_process = subprocess.Popen
            leaders = []

            def start(*args, **options):
                leader = start_process(*args, **options)
                leaders.append(leader)
                return leader

            try:
                with patch("publication_process.subprocess.Popen", side_effect=start):
                    with self.assertRaisesRegex(PublicationError, "deadline_exceeded"):
                        BoundedProcess(1).run(
                            [sys.executable, "-c", parent, str(marker)]
                        )
                self.assertEqual(
                    leaders[0].returncode, 0, "Leader must exit before deadline cleanup"
                )
                self.assertTrue(marker.exists(), "The descendant must actually start")
                descendant = int(marker.read_text())
                status = Path(f"/proc/{descendant}/stat")
                deadline = time.monotonic() + 1
                while True:
                    try:
                        if status.read_text().split()[2] == "Z":
                            break
                    except FileNotFoundError:
                        break
                    self.assertLess(
                        time.monotonic(),
                        deadline,
                        "Owned descendant survived group cleanup",
                    )
                    time.sleep(0.01)
            finally:
                if marker.exists():
                    descendant = int(marker.read_text())
                if descendant is not None:
                    try:
                        os.kill(descendant, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_unavailable_command_and_pipe_failure_are_sanitized(self):
        with self.assertRaisesRegex(PublicationError, "command_unavailable"):
            BoundedProcess(1).run(["damadama-publication-command-does-not-exist"])

        class BrokenPipe(io.BytesIO):
            def read(self, count):
                raise OSError(CANARY)

        class Process:
            returncode = 0
            pid = 12345

            def __init__(self):
                self.stdout, self.stderr = BrokenPipe(), io.BytesIO()

            def poll(self):
                return 0

            def wait(self, timeout):
                return 0

        with (
            patch("publication_process.subprocess.Popen", return_value=Process()),
            patch("publication_process.os.killpg", create=True),
            redirect_stderr(io.StringIO()) as error,
        ):
            with self.assertRaisesRegex(PublicationError, "command_io_error"):
                BoundedProcess(1).run(["unused"])
        self.assertNotIn(CANARY, error.getvalue())
        with (
            patch("publication_process.subprocess.Popen", return_value=Process()),
            patch.object(BoundedProcess, "_cleanup", side_effect=OSError(CANARY)),
            redirect_stderr(io.StringIO()) as error,
        ):
            with self.assertRaisesRegex(
                PublicationError, "command_cleanup_failed"
            ) as failure:
                BoundedProcess(1).run(["unused"])
        self.assertNotIn(CANARY, str(failure.exception) + error.getvalue())

    def test_manifest_download_size_does_not_trust_cli_content_length(self):
        class Process:
            raw = encoded(manifest())

            def run(self, args, **options):
                self.args = args
                Path(args[-1]).write_bytes(self.raw)
                return CommandResult(0, b'{"ContentLength":1}', b"")

        with tempfile.TemporaryDirectory() as directory:
            configuration = AwsConfiguration.load(
                {
                    "BACKUP_ENVIRONMENT": "staging",
                    "S3_BUCKET": "fixture-bucket",
                    "AWS_ENDPOINT_URL": "http://object-store:5000",
                    "AWS_ACCESS_KEY_ID": "synthetic",
                    "AWS_SECRET_ACCESS_KEY": "synthetic",
                    "AWS_PROFILE": CANARY,
                },
                "synthetic",
            )
            self.assertNotIn("AWS_PROFILE", configuration.environment)
            self.assertEqual(configuration.environment["AWS_DEFAULT_REGION"], "auto")
            self.assertEqual(
                configuration.environment["AWS_SHARED_CREDENTIALS_FILE"], os.devnull
            )
            process = Process()
            objects = AwsObjects(configuration, process, Path(directory))
            self.assertEqual(
                objects.get(manifest()["backup"] + ".json", MANIFEST_LIMIT),
                encoded(manifest()),
            )
            self.assertIn("bytes=0-4096", process.args)
            process.raw = b"x" * (MANIFEST_LIMIT + 1)
            with self.assertRaisesRegex(PublicationError, "download_limit"):
                objects.get(manifest()["backup"] + ".json", MANIFEST_LIMIT)

    def test_subprocess_accepts_bounded_bytes_and_refuses_timeout_or_overflow(self):
        result = BoundedProcess(2).run([sys.executable, "-c", "print('accepted')"])
        self.assertEqual(
            result.stdout, b"accepted\r\n" if os.name == "nt" else b"accepted\n"
        )
        for script, seconds, code in [
            ("import time;time.sleep(3)", 0.1, "deadline_exceeded"),
            (f"print('{CANARY}'*1000)", 2, "command_output_limit"),
            (
                f"import sys;sys.stderr.write('{CANARY}'*1000)",
                2,
                "command_output_limit",
            ),
        ]:
            with self.assertRaisesRegex(PublicationError, code) as failure:
                BoundedProcess(seconds).run([sys.executable, "-c", script])
            self.assertNotIn(CANARY, str(failure.exception))

    def test_one_monotonic_budget_covers_multiple_commands_and_download_size(self):
        process = BoundedProcess(0.5)
        process.run([sys.executable, "-c", "import time;time.sleep(0.25)"])
        with self.assertRaisesRegex(PublicationError, "deadline_exceeded"):
            process.run([sys.executable, "-c", "import time;time.sleep(0.4)"])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "large.json"
            with self.assertRaisesRegex(PublicationError, "download_limit"):
                BoundedProcess(2).run(
                    [
                        sys.executable,
                        "-c",
                        "from pathlib import Path;import sys;Path(sys.argv[1]).write_bytes(b'x'*4097)",
                        str(target),
                    ],
                    watched_file=target,
                    file_limit=4096,
                )

    def test_cli_failures_never_echo_sensitive_arguments_or_file_content(self):
        for arguments in [
            ["publish", "--origin", CANARY],
            ["publish", "--unknown", CANARY],
            [
                "publish",
                "--origin",
                "synthetic",
                "--backup-exit-code",
                "0",
                "--stdout-file",
                CANARY,
            ],
        ]:
            error = io.StringIO()
            with (
                patch.dict(os.environ, {"BACKUP_ENVIRONMENT": "staging"}),
                redirect_stderr(error),
            ):
                self.assertEqual(main(arguments), 1)
            self.assertNotIn(CANARY, error.getvalue())
            self.assertEqual(
                set(json.loads(error.getvalue())), {"outcome", "failureCode"}
            )

    def test_packaged_cli_classifier_only_accepts_definite_matching_missing_errors(
        self,
    ):
        class Process:
            result = CommandResult(0, b"{}", b"")

            def run(self, args, **options):
                self.args, self.options = args, options
                return self.result

        with tempfile.TemporaryDirectory() as directory:
            process = Process()
            objects = AwsObjects(
                AwsConfiguration.load(
                    {
                        **os.environ,
                        "BACKUP_ENVIRONMENT": "staging",
                        "S3_BUCKET": "fixture-bucket",
                        "AWS_ENDPOINT_URL": "http://object-store:5000",
                        "AWS_ACCESS_KEY_ID": "synthetic-key",
                        "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
                    },
                    "synthetic",
                ),
                process,
                Path(directory),
            )
            self.assertTrue(objects.head(manifest()["backup"]))
            self.assertEqual(process.options["env"]["AWS_MAX_ATTEMPTS"], "1")
            self.assertEqual(
                process.options["env"]["AWS_DEFAULT_REGION"],
                os.environ.get("AWS_DEFAULT_REGION") or "auto",
            )
            self.assertEqual(
                process.options["env"]["AWS_EC2_METADATA_DISABLED"], "true"
            )
            for error, missing in [
                (
                    b"\nAn error occurred (404) when calling the HeadObject operation: Not Found\n",
                    True,
                ),
                (
                    b"An error occurred (NoSuchKey) when calling the HeadObject operation: missing",
                    True,
                ),
                (
                    b"An error occurred (AccessDenied) when calling the HeadObject operation: "
                    + CANARY.encode(),
                    False,
                ),
                (
                    b"An error occurred (404) when calling the GetObject operation: Not Found",
                    False,
                ),
                (b"unknown " + CANARY.encode(), False),
                (
                    b"prefix An error occurred (404) when calling the HeadObject operation: Not Found",
                    False,
                ),
            ]:
                process.result = CommandResult(1, b"", error)
                if missing:
                    self.assertFalse(objects.head(manifest()["backup"]))
                else:
                    with self.assertRaisesRegex(PublicationError, "storage_refused"):
                        objects.head(manifest()["backup"])

    def test_storage_configuration_refuses_production_bad_endpoint_and_bucket(self):
        base = {
            **os.environ,
            "BACKUP_ENVIRONMENT": "staging",
            "S3_BUCKET": "fixture-bucket",
            "AWS_ENDPOINT_URL": "http://object-store:5000",
            "AWS_ACCESS_KEY_ID": "synthetic-key",
            "AWS_SECRET_ACCESS_KEY": "synthetic-secret",
        }
        for changes, origin, code in [
            ({"AWS_ACCESS_KEY_ID": ""}, "synthetic", "storage_credentials_missing"),
            ({"AWS_SECRET_ACCESS_KEY": ""}, "synthetic", "storage_credentials_missing"),
            ({"BACKUP_ENVIRONMENT": "production"}, "synthetic", "production_disabled"),
            ({"S3_BUCKET": "--bad"}, "synthetic", "invalid_bucket"),
            (
                {"AWS_ENDPOINT_URL": "https://user:secret@example.test"},
                "synthetic",
                "invalid_endpoint",
            ),
            (
                {"AWS_ENDPOINT_URL": "https://example.test?secret=" + CANARY},
                "synthetic",
                "invalid_endpoint",
            ),
            ({}, "hosted", "hosted_requires_https"),
        ]:
            with self.assertRaisesRegex(PublicationError, code):
                AwsConfiguration.load({**base, **changes}, origin)

    def test_launcher_refuses_all_configuration_before_invoking_backup(self):
        base = {
            "BACKUP_ENVIRONMENT": "staging",
            "S3_BUCKET": "fixture-bucket",
            "AWS_ENDPOINT_URL": "http://object-store:5000",
            "PGHOST": "source-db",
            "PGDATABASE": "habits",
            "PGUSER": "postgres",
            "PGPASSWORD": "synthetic",
            "AWS_ACCESS_KEY_ID": "synthetic",
            "AWS_SECRET_ACCESS_KEY": "synthetic",
            "AGE_RECIPIENT": "synthetic",
        }
        for changes, extra, code in [
            ({"AWS_ACCESS_KEY_ID": ""}, [], "storage_credentials_missing"),
            ({"AWS_SECRET_ACCESS_KEY": ""}, [], "storage_credentials_missing"),
            ({"BACKUP_ENVIRONMENT": "production"}, [], "production_disabled"),
            ({"S3_BUCKET": "--bad"}, [], "invalid_bucket"),
            (
                {"AWS_ENDPOINT_URL": "https://example.test?secret=" + CANARY},
                [],
                "invalid_endpoint",
            ),
            ({"PGPASSWORD": ""}, [], "backup_configuration_missing"),
            ({}, ["--completion-key", "../private.json"], "invalid_completion_key"),
            ({}, ["--retention-failed"], "invalid_arguments"),
            ({"BACKUP_MAX_SECONDS": "0"}, [], "invalid_backup_deadline"),
            ({}, ["--deadline-seconds", "0"], "invalid_deadline"),
        ]:
            with (
                patch.dict(os.environ, {**base, **changes}, clear=True),
                patch("publish_completion.BoundedProcess.run") as child,
                redirect_stderr(io.StringIO()) as error,
            ):
                self.assertEqual(
                    main(["supervise", "--origin", "synthetic", *extra]), 1
                )
                child.assert_not_called()
                self.assertEqual(json.loads(error.getvalue())["failureCode"], code)
                self.assertNotIn(CANARY, error.getvalue())

    def test_launcher_publishes_after_backup_failure_and_preserves_failure(self):
        environment = {
            "BACKUP_ENVIRONMENT": "staging",
            "S3_BUCKET": "fixture-bucket",
            "AWS_ENDPOINT_URL": "http://object-store:5000",
            "PGHOST": "source-db",
            "PGDATABASE": "habits",
            "PGUSER": "postgres",
            "PGPASSWORD": "synthetic",
            "AWS_ACCESS_KEY_ID": "synthetic",
            "AWS_SECRET_ACCESS_KEY": "synthetic",
            "AGE_RECIPIENT": "synthetic",
        }
        objects = Objects()
        output, errors = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, environment, clear=True),
            patch(
                "publish_completion.BoundedProcess.run",
                return_value=CommandResult(42, CANARY.encode(), CANARY.encode()),
            ),
            patch("publish_completion.AwsObjects", return_value=objects),
            patch("sys.stdout", output),
            redirect_stderr(errors),
        ):
            self.assertEqual(main(["supervise", "--origin", "synthetic"]), 42)
        value = json.loads(output.getvalue())
        self.assertEqual((value["job"], value["retention"]), ("failed", "unknown"))
        self.assertIn(("put", METADATA_KEY), objects.calls)
        self.assertNotIn(CANARY, output.getvalue() + errors.getvalue())
        with (
            patch.dict(os.environ, environment, clear=True),
            patch(
                "publish_completion.BoundedProcess.run",
                return_value=CommandResult(0, b"{}", b""),
            ),
            patch(
                "publish_completion.publish",
                side_effect=PublicationError("storage_refused"),
            ),
            redirect_stderr(io.StringIO()) as error,
        ):
            self.assertEqual(main(["supervise", "--origin", "synthetic"]), 1)
            self.assertEqual(
                json.loads(error.getvalue())["failureCode"], "storage_refused"
            )


if __name__ == "__main__":
    unittest.main()
