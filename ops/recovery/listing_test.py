import json
import os
import shutil
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

from publication_process import BoundedProcess, CommandResult
from prove_completion_publication import BUCKET, require_empty_bucket

CANARY = "private-synthetic-object-key-canary"


class ListingBoundaryTests(unittest.TestCase):
    def exercise(self, raw, checks):
        calls = []

        def aws(*args):
            calls.append(args)
            return CommandResult(0, b"" if len(calls) == 1 else raw, b"")

        require_empty_bucket(
            aws,
            lambda code, details=None: checks.append(
                {"check": code, **(details or {})}
            ),
        )

    def test_explicit_complete_zero_key_first_page_accepts_without_inventing_json(self):
        checks = []
        self.exercise(b'{"KeyCount":0,"IsTruncated":false}', checks)
        aggregate = next(
            item for item in checks if item["check"] == "automatic-list-result"
        )
        self.assertEqual(aggregate["stdoutByteLength"], 0)
        self.assertFalse(aggregate["listJsonParsed"])
        self.assertEqual(checks[-1]["check"], "empty-first-page-key-count")

    def test_first_page_guards_refuse_objects_null_contents_truncation_and_wrong_count(
        self,
    ):
        for change, expected in [
            ({"Contents": [{"Key": CANARY}]}, "no-backup-objects-created"),
            ({"Contents": None}, "no-backup-objects-created"),
            ({"IsTruncated": True}, "empty-first-page-complete"),
            ({"IsTruncated": None}, "empty-first-page-complete"),
            ({"IsTruncated": 0}, "empty-first-page-complete"),
            ({"KeyCount": 1}, "empty-first-page-key-count"),
            ({"KeyCount": False}, "empty-first-page-key-count"),
            ({"KeyCount": 0.0}, "empty-first-page-key-count"),
            ({"KeyCount": CANARY}, "empty-first-page-key-count"),
            ({"KeyCount": None}, "empty-first-page-key-count"),
        ]:
            checks = []
            value = {"KeyCount": 0, "IsTruncated": False, **change}
            with self.subTest(check=expected), self.assertRaises(AssertionError):
                self.exercise(json.dumps(value).encode(), checks)
            self.assertEqual(checks[-1]["check"], expected)
            self.assertNotIn(CANARY, json.dumps(checks))

        checks = []
        with self.assertRaisesRegex(AssertionError, "first page must be complete"):
            self.exercise(b"{}", checks)
        self.assertEqual(checks[-1]["check"], "empty-first-page-complete")

    def test_empty_or_malformed_authoritative_stdout_is_still_an_error(self):
        for raw in [b"", CANARY.encode()]:
            checks = []
            with self.assertRaises(json.JSONDecodeError):
                self.exercise(raw, checks)
            self.assertEqual(checks[-1]["check"], "empty-bucket-list-parse")
            self.assertFalse(checks[-1]["listJsonParsed"])
            self.assertEqual(checks[-1]["stdoutByteLength"], len(raw))
            self.assertNotIn(CANARY, json.dumps(checks))


@unittest.skipUnless(shutil.which("aws"), "Actual AWS CLI boundary runtime unavailable")
class ActualCliListingTests(unittest.TestCase):
    def exercise(self, nonempty):
        contents = ""
        if nonempty:
            contents = f"<Contents><Key>{CANARY}</Key><Size>1</Size></Contents>"
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"<Name>{BUCKET}</Name><Prefix></Prefix><KeyCount>{int(nonempty)}</KeyCount>"
            f"<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
        ).encode()
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(parse_qs(urlsplit(self.path).query))
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("AWS_")
        }
        environment.update(
            AWS_ACCESS_KEY_ID="synthetic",
            AWS_SECRET_ACCESS_KEY="synthetic",
            AWS_DEFAULT_REGION="us-east-1",
            AWS_CONFIG_FILE=os.devnull,
            AWS_SHARED_CREDENTIALS_FILE=os.devnull,
            AWS_EC2_METADATA_DISABLED="true",
            AWS_MAX_ATTEMPTS="1",
            AWS_PAGER="",
            AWS_CLI_AUTO_PROMPT="off",
            NO_PROXY="127.0.0.1",
        )
        process = BoundedProcess(30)
        checks = []

        def aws(*args):
            result = process.run(
                [
                    shutil.which("aws"),
                    "--endpoint-url",
                    f"http://127.0.0.1:{server.server_port}",
                    "s3api",
                    *args,
                ],
                env=environment,
            )
            self.assertEqual(
                result.code,
                0,
                "Loopback CLI fixture must succeed before testing the emptiness guard",
            )
            return result

        try:
            if nonempty:
                with self.assertRaises(AssertionError):
                    require_empty_bucket(
                        aws,
                        lambda code, details=None: checks.append(
                            {"check": code, **(details or {})}
                        ),
                    )
                self.assertEqual(checks[-1]["check"], "no-backup-objects-created")
            else:
                require_empty_bucket(
                    aws,
                    lambda code, details=None: checks.append(
                        {"check": code, **(details or {})}
                    ),
                )
                page = next(
                    item
                    for item in checks
                    if item["check"] == "empty-bucket-list-parse"
                )
                self.assertTrue(page["listJsonParsed"])
                self.assertEqual(page["keyCount"], 0)
                self.assertIs(page["isTruncated"], False)
            self.assertEqual(len(requests), 2)
            self.assertEqual(requests[-1]["max-keys"], ["1"])
            self.assertNotIn(CANARY, json.dumps(checks))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_actual_cli_xml_first_page_accepts_empty_bucket(self):
        self.exercise(False)

    def test_actual_cli_xml_first_page_refuses_a_real_returned_object_without_key_logs(
        self,
    ):
        self.exercise(True)
