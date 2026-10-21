import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("kernel_guest", Path(__file__).with_name("kernel-guest.py"))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
inside_spec = importlib.util.spec_from_file_location("kernel_guest_inside", Path(__file__).with_name("kernel-guest-inside.py"))
inside = importlib.util.module_from_spec(inside_spec)
inside_spec.loader.exec_module(inside)


class OwnershipAndPrivacy(unittest.TestCase):
    def test_host_cannot_install_guest_kernels(self):
        with patch.object(inside.sys, "platform", "linux"), patch.object(inside.os, "geteuid", return_value=0, create=True), patch.object(inside.Path, "cwd", return_value=inside.ROOT), patch.object(inside.Path, "read_text", return_value="Microsoft Corporation"), patch.object(inside, "run") as command:
            with self.assertRaisesRegex(inside.GuestRefusal, "owned-guest-required"):
                inside.prepare()
            command.assert_not_called()

    def test_raw_guest_error_and_token_never_enter_failure_receipt(self):
        failure = RuntimeError("unexpected secret eyJhbGciOiJSUzI1NiJ9.synthetic.signature")
        result = inside.failure_status(failure)
        self.assertEqual(result["reason"], "unexpected-guest-error")
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("eyJ", json.dumps(result))

    def test_source_export_excludes_generated_credentials_and_traversal(self):
        for name in (".audit/receipt.json", "tests/Browser/fixture.json", ".env.local", ".env.production", ".ssh/id_ed25519", ".auth/state.json", "nested/id_rsa", "../secret", "/secret", "nested\\.env", ".git/config"):
            with self.subTest(name=name):
                self.assertFalse(guest.source_allowed(name))
        for name in (".env.example", "tests/Browser/compatibility.pw.ts", "web/src/habits.ts", ".github/diagnostics/kernel-guest.py"):
            self.assertTrue(guest.source_allowed(name))

    def test_pid_reuse_is_refused_before_any_signal(self):
        owner = {"pid": 42, "startTicks": 100, "bootId": "boot", "commandSha256": "a"}
        replacement = {**owner, "startTicks": 101}
        with patch.object(guest, "process_identity", return_value=replacement), patch.object(guest.os, "pidfd_open", create=True) as opened:
            with self.assertRaisesRegex(guest.Refusal, "cleanup-identity-unknown"):
                guest.signal_owned(owner, signal.SIGTERM)
            opened.assert_not_called()

    def test_identity_change_after_pidfd_open_never_signals(self):
        owner = {"pid": 42, "startTicks": 100, "bootId": "boot", "commandSha256": "a"}
        with patch.object(guest, "process_identity", side_effect=[owner, None]), patch.object(guest.os, "pidfd_open", return_value=10, create=True), patch.object(guest.os, "close") as closed, patch.object(guest.signal, "pidfd_send_signal", create=True) as sent:
            with self.assertRaisesRegex(guest.Refusal, "cleanup-identity-unknown"):
                guest.signal_owned(owner, signal.SIGTERM)
            sent.assert_not_called()
            closed.assert_called_once_with(10)

    def test_proc_parser_uses_start_ticks_after_command_parentheses(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc / "42").mkdir()
            (proc / "sys/kernel/random").mkdir(parents=True)
            (proc / "sys/kernel/random/boot_id").write_text("test-boot\n")
            fields = ["S"] + ["0"] * 18 + ["12345"] + ["0"] * 4
            (proc / "42/stat").write_text("42 (command (with spaces)) " + " ".join(fields))
            (proc / "42/cmdline").write_bytes(b"qemu\0-name\0owned\0")
            self.assertEqual(guest.process_identity(42, proc)["startTicks"], 12345)
            self.assertIsNone(guest.process_identity(43, proc))

    def test_malformed_proc_is_unknown_instead_of_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            (proc / "42").mkdir()
            (proc / "42/stat").write_text("malformed")
            with self.assertRaises(ValueError):
                guest.process_identity(42, proc)

    def test_insufficient_initial_disk_refuses_before_tools_or_guest(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            with patch.object(guest.Path, "read_text", return_value="MemAvailable: 12000000 kB\n"), patch.object(guest.shutil, "disk_usage", return_value=type("Disk", (), {"free": 15 * guest.GIB})()), patch.object(experiment, "save"):
                with self.assertRaisesRegex(guest.Refusal, "disk-budget-exceeded"):
                    experiment.resources(initial=True)

    def test_overallocated_images_refuse_with_disk_still_free(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            with patch.object(guest.Path, "read_text", return_value="MemAvailable: 12000000 kB\n"), patch.object(guest.shutil, "disk_usage", return_value=type("Disk", (), {"free": 40 * guest.GIB})()), patch.object(guest, "allocated", return_value=11 * guest.GIB), patch.object(experiment, "save"):
                with self.assertRaisesRegex(guest.Refusal, "disk-budget-exceeded"):
                    experiment.resources()

    def test_deadline_keeps_export_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            experiment.deadline = guest.time.monotonic() + 119
            experiment.last_sample = guest.time.monotonic()
            with self.assertRaisesRegex(guest.Refusal, "experiment-deadline"):
                experiment.resources()

    def test_deadline_includes_time_before_host_orchestrator(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(guest.os.environ, {"KERNEL_JOB_STARTED": str(int(guest.time.time()) - 300)}):
            experiment = guest.Experiment(Path(directory))
            remaining = experiment.deadline - guest.time.monotonic()
            self.assertLessEqual(remaining, 42 * 60 - 300)
            self.assertGreater(remaining, 42 * 60 - 302)

    def test_cleanup_failure_overrides_prior_success_and_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            experiment.receipt["outcome"] = "boot-supported"
            with patch.object(guest, "Experiment", return_value=experiment), patch.object(experiment, "execute"), patch.object(experiment, "stop", side_effect=guest.Refusal("cleanup-identity-unknown")), patch("builtins.print"):
                self.assertEqual(guest.main(), 1)
            self.assertEqual(experiment.receipt["outcome"], "environment-refusal")
            self.assertEqual(experiment.receipt["reason"], "cleanup-unverified")

    def test_nonhosted_platform_refuses_without_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            with patch.object(guest.platform, "system", return_value="Windows"), patch.object(experiment, "run") as run:
                with self.assertRaisesRegex(guest.Refusal, "disposable-github-runner-required"):
                    experiment.execute()
                run.assert_not_called()

    @unittest.skipUnless(sys.platform == "linux", "actual /proc and pidfd require Linux")
    def test_native_missing_qmp_stops_only_owned_child(self):
        with tempfile.TemporaryDirectory() as directory:
            experiment = guest.Experiment(Path(directory))
            owned = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            with guest.socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                experiment.port = reservation.getsockname()[1]
            experiment.vm = owned
            experiment.vm_identity = guest.process_identity(owned.pid)
            experiment.qmp_path = Path(directory) / "absent-qmp.sock"
            try:
                experiment.stop()
                self.assertIsNotNone(owned.poll())
                self.assertIsNone(unrelated.poll())
                self.assertEqual(experiment.receipt["cleanup"][0]["method"], "pidfd")
                self.assertTrue(experiment.receipt["cleanup"][0]["processAbsent"])
                self.assertTrue(experiment.receipt["cleanup"][0]["listenerAbsent"])
            finally:
                for child in (owned, unrelated):
                    if child.poll() is None:
                        child.terminate()
                    child.wait(timeout=5)

    @unittest.skipUnless(sys.platform == "linux", "actual /proc and pidfd require Linux")
    def test_native_owned_child_signal_preserves_unrelated_child(self):
        owned = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            identity = guest.process_identity(owned.pid)
            guest.signal_owned(identity, signal.SIGTERM)
            owned.wait(timeout=5)
            self.assertIsNone(guest.process_identity(owned.pid))
            self.assertIsNone(unrelated.poll())
        finally:
            for child in (owned, unrelated):
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
