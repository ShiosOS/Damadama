import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass


class PublicationError(Exception):
    pass


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: bytes
    stderr: bytes


class BoundedProcess:
    def __init__(self, seconds, output_limit=8192):
        self.ends_at = time.monotonic() + seconds
        self.output_limit = output_limit

    def _cleanup(self, process, readers):
        cleanup_ends_at = time.monotonic() + 2
        cleaned = True
        try:
            if os.name == "nt":
                if process.poll() is None:
                    process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            cleaned = False
        try:
            process.wait(timeout=max(0, cleanup_ends_at - time.monotonic()))
        except (OSError, subprocess.TimeoutExpired):
            cleaned = False
        for reader in readers:
            if reader.ident is not None:
                reader.join(timeout=max(0, cleanup_ends_at - time.monotonic()))
        return (
            cleaned
            and process.poll() is not None
            and all(not reader.is_alive() for reader in readers)
        )

    def run(self, args, *, env=None, watched_file=None, file_limit=None):
        if time.monotonic() >= self.ends_at:
            raise PublicationError("deadline_exceeded")
        try:
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                start_new_session=os.name != "nt",
            )
        except OSError:
            raise PublicationError("command_unavailable") from None
        overflow = threading.Event()
        read_error = threading.Event()
        buffers = [bytearray(), bytearray()]
        pipe_eof = [threading.Event(), threading.Event()]

        def read_pipe(pipe, destination, eof):
            try:
                while chunk := pipe.read(1024):
                    if len(destination) + len(chunk) > self.output_limit:
                        overflow.set()
                    elif not overflow.is_set():
                        destination.extend(chunk)
                eof.set()
            except Exception:
                read_error.set()
            finally:
                try:
                    pipe.close()
                except Exception:
                    read_error.set()

        readers = [
            threading.Thread(target=read_pipe, args=(pipe, buffer, eof), daemon=True)
            for pipe, buffer, eof in zip(
                (process.stdout, process.stderr), buffers, pipe_eof
            )
        ]

        def violation():
            if overflow.is_set():
                return "command_output_limit"
            if read_error.is_set():
                return "command_io_error"
            if (
                watched_file
                and watched_file.exists()
                and watched_file.stat().st_size > file_limit
            ):
                return "download_limit"
            if time.monotonic() >= self.ends_at:
                return "deadline_exceeded"
            return None

        failure = None
        complete = False
        try:
            for reader in readers:
                reader.start()
            while True:
                failure = violation()
                if failure:
                    break
                complete = (
                    process.poll() is not None
                    and all(eof.is_set() for eof in pipe_eof)
                    and all(not reader.is_alive() for reader in readers)
                )
                if complete:
                    failure = violation()
                    break
                overflow.wait(0.01)
        except Exception:
            failure = "command_io_error"
        finally:
            if failure or not complete:
                try:
                    cleaned = self._cleanup(process, readers)
                except Exception:
                    cleaned = False
                if not cleaned:
                    failure = "command_cleanup_failed"
        if failure:
            raise PublicationError(failure)
        return CommandResult(process.returncode, bytes(buffers[0]), bytes(buffers[1]))
