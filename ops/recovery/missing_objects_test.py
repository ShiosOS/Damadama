import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from publication_process import BoundedProcess, CommandResult, PublicationError
from publish_completion import AwsConfiguration, AwsObjects

CANARY = "private-error-message-canary"


def configuration(endpoint="http://127.0.0.1:1"):
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("AWS_")
    }
    environment.update(
        BACKUP_ENVIRONMENT="staging",
        S3_BUCKET="synthetic-missing-objects",
        AWS_ENDPOINT_URL=endpoint,
        AWS_ACCESS_KEY_ID="synthetic",
        AWS_SECRET_ACCESS_KEY="synthetic",
        AWS_DEFAULT_REGION="us-east-1",
        NO_PROXY="127.0.0.1",
    )
    return AwsConfiguration.load(environment, "synthetic")


class MissingErrorTests(unittest.TestCase):
    def test_only_matching_missing_code_and_observed_cli_wrappers_mean_absent(self):
        class Process:
            def run(self, *_args, **_options):
                return CommandResult(254, b"", self.error)

        with tempfile.TemporaryDirectory() as directory:
            process = Process()
            objects = AwsObjects(configuration(), process, Path(directory))
            for operation, api in [
                ("get-object", "GetObject"),
                ("head-object", "HeadObject"),
            ]:
                for code in ["404", "NoSuchKey"]:
                    for prefix in ["", "aws: [ERROR]: "]:
                        for retry in ["", " (reached max retries: 0)"]:
                            process.error = (
                                f"\n{prefix}An error occurred ({code}) when calling the "
                                f"{api} operation{retry}: {CANARY}\n"
                            ).encode()
                            with self.subTest(
                                operation=operation,
                                code=code,
                                prefix=bool(prefix),
                                retry=bool(retry),
                            ):
                                self.assertFalse(
                                    objects.call(operation, "synthetic-key")
                                )

                valid = (
                    f"aws: [ERROR]: An error occurred (404) when calling the "
                    f"{api} operation (reached max retries: 0): {CANARY}"
                )
                for error in [
                    valid.replace("(404)", "(401)"),
                    valid.replace("(404)", "(403)"),
                    valid.replace("(404)", "(AccessDenied)"),
                    valid.replace("(404)", "(Unknown)"),
                    valid.replace(api, "PutObject"),
                    valid.replace(
                        api, "GetObject" if api == "HeadObject" else "HeadObject"
                    ),
                    valid.replace("retries: 0", "retries: 1"),
                    valid.replace("[ERROR]", "[WARNING]"),
                    "unrecognized-prefix " + valid,
                    CANARY + "\n" + valid,
                    valid + "\n" + CANARY,
                ]:
                    process.error = error.encode()
                    with (
                        self.subTest(operation=operation),
                        self.assertRaisesRegex(
                            PublicationError, "^storage_refused$"
                        ) as refused,
                    ):
                        objects.call(operation, "synthetic-key")
                    self.assertNotIn(CANARY, str(refused.exception))

            process.error = (
                b"An error occurred (404) when calling the PutObject operation: absent"
            )
            with self.assertRaisesRegex(PublicationError, "^storage_refused$"):
                objects.call("put-object", "synthetic-key")


@unittest.skipUnless(shutil.which("aws"), "Actual AWS CLI boundary runtime unavailable")
class ActualCliMissingTests(unittest.TestCase):
    def test_actual_cli_missing_head_and_get_are_absent_but_access_errors_are_refused(
        self,
    ):
        state = {"status": 404, "code": "NoSuchKey"}
        observed = []

        class Handler(BaseHTTPRequestHandler):
            def respond(self, head):
                observed.append(self.command)
                body = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    f"<Error><Code>{state['code']}</Code><Message>{CANARY}</Message></Error>"
                ).encode()
                self.send_response(state["status"])
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not head:
                    self.wfile.write(body)

            def do_HEAD(self):
                self.respond(True)

            def do_GET(self):
                self.respond(False)

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                objects = AwsObjects(
                    configuration(f"http://127.0.0.1:{server.server_port}"),
                    BoundedProcess(45),
                    Path(directory),
                )
                self.assertFalse(objects.head("synthetic-key"))
                self.assertIsNone(objects.get("synthetic-key", 4096))
                for status in [401, 403]:
                    state.update(status=status, code="AccessDenied")
                    for operation in ["head-object", "get-object"]:
                        with (
                            self.subTest(status=status, operation=operation),
                            self.assertRaisesRegex(
                                PublicationError, "^storage_refused$"
                            ) as refused,
                        ):
                            objects.call(
                                operation,
                                "synthetic-key",
                                [str(Path(directory) / "download")]
                                if operation == "get-object"
                                else [],
                            )
                        self.assertNotIn(CANARY, str(refused.exception))
                self.assertEqual(
                    observed, ["HEAD", "GET", "HEAD", "GET", "HEAD", "GET"]
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
