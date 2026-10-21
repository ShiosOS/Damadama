import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path, PurePosixPath


GIB = 1024**3
KERNELS = ("6.17.0-1022-azure", "7.0.0-1017-azure")
IMAGE_URL = "https://cloud-images.ubuntu.com/releases/noble/release-20261017/"
IMAGE_NAME = "ubuntu-24.04-server-cloudimg-amd64.img"
IMAGE_SIGNER = "D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81"
PACKAGES = (
    ("pool/main/l/linux-signed-azure-6.17/linux-image-6.17.0-1022-azure_6.17.0-1022.22_amd64.deb", "909e771d8abc1aecb5df5aa699650a1488ea65fb526f8b648ee6925d71805e60"),
    ("pool/main/l/linux-azure-6.17/linux-modules-6.17.0-1022-azure_6.17.0-1022.22_amd64.deb", "499f3c4e76a19b51e399aa9dede097eabc0ca001471c27b34f5a1d1d54b7c44c"),
    ("pool/main/l/linux-signed-azure-7.0/linux-image-7.0.0-1017-azure_7.0.0-1017.17~24.04.1_amd64.deb", "1e4472d644ee9f2322a8a24527e4d63239f7a86f711695d5397b79c4e4cb2b4a"),
    ("pool/main/l/linux-azure-7.0/linux-modules-7.0.0-1017-azure_7.0.0-1017.17~24.04.1_amd64.deb", "19ad1d32c0138b6ef90257f211e80490d3aaf322ba5c3c2910fdfbfb1f20da6d"),
)


class Refusal(Exception):
    pass


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def process_identity(pid, proc=Path("/proc")):
    try:
        stat = (proc / str(pid) / "stat").read_text()
        fields = stat[stat.rindex(")") + 2:].split()
        return {
            "pid": pid,
            "startTicks": int(fields[19]),
            "bootId": (proc / "sys/kernel/random/boot_id").read_text().strip(),
            "commandSha256": hashlib.sha256((proc / str(pid) / "cmdline").read_bytes()).hexdigest(),
        }
    except (FileNotFoundError, ProcessLookupError):
        return None


def signal_owned(identity, sig):
    if process_identity(identity["pid"]) != identity:
        raise Refusal("cleanup-identity-unknown")
    descriptor = os.pidfd_open(identity["pid"])
    try:
        if process_identity(identity["pid"]) != identity:
            raise Refusal("cleanup-identity-unknown")
        signal.pidfd_send_signal(descriptor, sig)
    finally:
        os.close(descriptor)


def allocated(paths):
    return sum(path.stat().st_blocks * 512 for path in paths if path.exists())


def source_allowed(name):
    parts = PurePosixPath(name).parts
    return not (
        "\\" in name or PurePosixPath(name).is_absolute()
        or any(part in ("..", ".audit", ".ssh", ".auth", "node_modules") for part in parts)
        or PurePosixPath(name).name in ("fixture.json", ".env", ".env.local", "id_ed25519", "id_rsa")
        or (PurePosixPath(name).name.startswith(".env.") and PurePosixPath(name).name != ".env.example")
        or name.startswith(".git/")
    )


class Experiment:
    def __init__(self, root):
        self.root = root.resolve()
        self.id = str(uuid.uuid4())
        self.private = self.root / ".audit" / ("kernel-private-" + self.id)
        self.private.mkdir(parents=True, mode=0o700)
        self.proof = self.root / ".audit/kernel-guest-proof"
        self.proof.mkdir(exist_ok=False)
        self.job_started = int(os.environ.get("KERNEL_JOB_STARTED", str(int(time.time()))))
        self.deadline = time.monotonic() + 42 * 60 - max(0, time.time() - self.job_started)
        self.images = []
        self.vm = None
        self.vm_identity = None
        self.port = None
        self.samples = []
        self.last_sample = 0
        self.receipt = {
            "schemaVersion": 1, "experimentId": self.id,
            "outcome": "environment-refusal", "stage": "preflight",
            "reason": "incomplete", "source": {}, "commands": [], "arms": [],
            "hardwareMismatch": {"historicalCpu": 4, "historicalMemoryGiB": 16, "guestCpu": 2, "guestMemoryGiB": 6},
            "limits": {"jobSeconds": 2700, "scriptSeconds": 2520, "exportReserveSeconds": 120, "bootSeconds": 180, "preparationSeconds": 1200, "allocatedImageBytes": 10 * GIB, "packageBytes": GIB, "exportBytes": GIB, "freeFloorBytes": 4 * GIB},
            "cleanup": [], "resources": self.samples,
            "interpretation": "Controlled nested-guest comparison. Passing is nonreproduction. Different arms require fresh crossed confirmation and a concrete mechanism before repair.",
        }

    def save(self):
        (self.proof / "receipt.json").write_text(json.dumps(self.receipt, indent=2) + "\n")

    def resources(self, initial=False):
        if not initial and time.monotonic() - self.last_sample < 4:
            if time.monotonic() >= self.deadline - 120:
                raise Refusal("experiment-deadline")
            return
        self.last_sample = time.monotonic()
        memory = re.search(r"^MemAvailable:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M)
        if memory is None:
            raise Refusal("resources-unknown")
        row = {"elapsedSeconds": round(2520 - (self.deadline - time.monotonic())), "freeBytes": shutil.disk_usage(self.private).free,
               "availableMemoryBytes": int(memory[1]) * 1024, "imageAllocatedBytes": allocated(self.images)}
        for kind in ("cpu", "memory", "io"):
            row[kind + "Pressure"] = Path("/proc/pressure", kind).read_text().strip()
        self.samples.append(row)
        if len(self.samples) > 600:
            raise Refusal("resource-sample-bound")
        self.save()
        if row["freeBytes"] < (16 * GIB if initial else 4 * GIB) or row["imageAllocatedBytes"] > 10 * GIB:
            raise Refusal("disk-budget-exceeded")
        if initial and (row["availableMemoryBytes"] < 8 * GIB or (os.cpu_count() or 0) < 2):
            raise Refusal("memory-or-cpu-unavailable")
        if time.monotonic() >= self.deadline - 120:
            raise Refusal("experiment-deadline")

    def run(self, label, argv, seconds=60, data=None, check=True, output_limit=16 * 1024 * 1024):
        self.resources()
        end = min(time.monotonic() + seconds, self.deadline - 120)
        with tempfile.TemporaryFile(dir=self.private) as output, tempfile.TemporaryFile(dir=self.private) as stdin:
            if data is not None:
                stdin.write(data)
                stdin.seek(0)
            child = subprocess.Popen(argv, cwd=self.root, stdin=stdin, stdout=output, stderr=subprocess.DEVNULL,
                                     env={**os.environ, "DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l"})
            identity = process_identity(child.pid)
            try:
                while child.poll() is None:
                    if time.monotonic() >= end:
                        raise Refusal("command-timeout")
                    try:
                        child.wait(timeout=min(1, max(0.01, end - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        pass
                    self.resources()
            finally:
                if child.poll() is None:
                    if identity is None:
                        raise Refusal("command-ownership-unknown")
                    signal_owned(identity, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        signal_owned(identity, signal.SIGKILL)
                        child.wait(timeout=5)
            self.receipt["commands"].append({"stage": label, "exitCode": child.returncode})
            self.save()
            output.seek(0)
            result = output.read(output_limit + 1)
            if len(result) > output_limit:
                raise Refusal("command-output-bound")
            if check and child.returncode != 0:
                raise Refusal(label + "-failed")
            return child.returncode, result

    def download(self, url, target, limit):
        self.run("download", ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-time", "180", "--max-filesize", str(limit), "--output", str(target), url], 190)

    def qmp(self, command):
        if process_identity(self.vm.pid) != self.vm_identity:
            raise Refusal("qmp-owner-unknown")
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5)
            connection.connect(str(self.qmp_path))
            stream = connection.makefile("rwb")
            greeting = json.loads(stream.readline(65536))
            if "QMP" not in greeting:
                raise Refusal("qmp-greeting-invalid")
            def execute(name):
                stream.write(json.dumps({"execute": name}).encode() + b"\n")
                stream.flush()
                for _ in range(20):
                    value = json.loads(stream.readline(65536))
                    if "return" in value:
                        return value["return"]
                    if "error" in value:
                        raise Refusal("qmp-command-refused")
                raise Refusal("qmp-response-bound")
            execute("qmp_capabilities")
            if execute("query-name") != {"name": self.vm_name} or execute("query-uuid") != {"UUID": self.vm_uuid}:
                raise Refusal("qmp-identity-mismatch")
            return execute(command)

    def ssh_args(self):
        return ["ssh", "-i", str(self.private / "ssh"), "-p", str(self.port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(self.private / "known_hosts"), "ubuntu@127.0.0.1"]

    def ssh(self, label, command, seconds=60, data=None, check=True, output_limit=16 * 1024 * 1024):
        return self.run(label, self.ssh_args() + [command], seconds, data, check, output_limit)

    def guest_command(self, mode, seconds):
        command = "sudo timeout --kill-after=10s " + str(seconds) + "s python3 /opt/damadama/.github/diagnostics/kernel-guest-inside.py " + mode
        code, contents = self.ssh("guest-" + mode, command, seconds + 15, check=False)
        if code != 0:
            status, content = self.ssh("guest-refusal-status", "sudo cat /opt/kernel-prepare-status.json", check=False)
            if status == 0:
                self.receipt.setdefault("guestRefusals", []).append(json.loads(content))
            raise Refusal("guest-" + mode + "-failed")
        return contents

    def boot(self, name, disk, kernel=None, root_uuid=None):
        if self.vm is not None:
            raise Refusal("concurrent-guest-refused")
        self.vm_name = "damadama-" + name + "-" + self.id
        self.vm_uuid = str(uuid.uuid4())
        self.qmp_path = self.private / "qmp.sock"
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        host_public = (self.private / "guest-host.pub").read_text().strip()
        (self.private / "known_hosts").write_text("[127.0.0.1]:" + str(self.port) + " " + host_public + "\n")
        argv = ["qemu-system-x86_64", "-name", self.vm_name, "-uuid", self.vm_uuid,
                "-smbios", "type=1,manufacturer=Damadama,product=kernel-diagnostic,serial=" + self.id,
                "-machine", "q35,accel=kvm", "-cpu", "host", "-smp", "2", "-m", "6144",
                "-display", "none", "-serial", "none", "-monitor", "none", "-no-reboot",
                "-qmp", "unix:" + str(self.qmp_path) + ",server=on,wait=off",
                "-drive", "file=" + str(disk) + ",format=qcow2,if=virtio,discard=unmap",
                "-drive", "file=" + str(self.private / "seed.img") + ",format=raw,if=virtio,readonly=on",
                "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:" + str(self.port) + "-:22",
                "-device", "virtio-net-pci,netdev=net0"]
        if kernel is not None:
            argv += ["-kernel", str(self.private / ("vmlinuz-" + kernel)), "-initrd", str(self.private / ("initrd.img-" + kernel)), "-append", "root=UUID=" + root_uuid + " ro console=ttyS0"]
        self.vm = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.vm_identity = process_identity(self.vm.pid)
        end = time.monotonic() + 180
        while not self.qmp_path.exists() and self.vm.poll() is None and time.monotonic() < end:
            self.resources()
            time.sleep(0.2)
        if self.vm_identity is None or not self.qmp_path.exists():
            raise Refusal("guest-boot-unavailable")
        kvm = self.qmp("query-kvm")
        if kvm != {"enabled": True, "present": True}:
            raise Refusal("actual-kvm-not-proved")
        row = {"name": name, "qemu": self.vm_identity, "uuid": self.vm_uuid, "kvm": kvm, "sshPort": self.port, "kernelRequested": kernel}
        self.receipt.setdefault("boots", []).append(row)
        while time.monotonic() < end and self.vm.poll() is None:
            code, output = self.ssh("boot-poll", "cat /proc/sys/kernel/random/boot_id; uname -r", 10, check=False)
            if code == 0:
                values = output.decode().strip().splitlines()
                if len(values) != 2 or not re.fullmatch(r"[a-f0-9-]{36}", values[0]) or not re.fullmatch(r"[A-Za-z0-9.+-]+", values[1]):
                    raise Refusal("guest-identity-invalid")
                if kernel is not None and values[1] != kernel:
                    raise Refusal("guest-kernel-mismatch")
                row.update({"bootId": values[0], "actualKernel": values[1]})
                self.save()
                return
        raise Refusal("guest-boot-timeout")

    def stop(self):
        if self.vm is None:
            return
        row = {"qemu": self.vm_identity, "processAbsent": False, "listenerAbsent": False}
        self.receipt["cleanup"].append(row)
        if self.vm.poll() is None:
            if self.vm_identity is None:
                raise Refusal("cleanup-identity-unknown")
            try:
                self.qmp("quit")
                row["method"] = "qmp"
            except (OSError, ValueError, Refusal) as error:
                row["qmpErrorClass"] = type(error).__name__
                signal_owned(self.vm_identity, signal.SIGTERM)
                row["method"] = "pidfd"
            try:
                self.vm.wait(timeout=20)
            except subprocess.TimeoutExpired:
                signal_owned(self.vm_identity, signal.SIGKILL)
                self.vm.wait(timeout=10)
        row["processAbsent"] = process_identity(self.vm.pid) is None
        with socket.socket() as probe:
            probe.settimeout(1)
            row["listenerAbsent"] = probe.connect_ex(("127.0.0.1", self.port)) == 111
        if not row["processAbsent"] or not row["listenerAbsent"]:
            raise Refusal("cleanup-absence-unproved")
        self.vm = None
        self.vm_identity = None
        self.qmp_path.unlink(missing_ok=True)
        self.save()

    def prepare_inputs(self):
        for field, ref in (("head", "HEAD"), ("tree", "HEAD^{tree}"), ("canonicalTestBlob", "HEAD:tests/Browser/compatibility.pw.ts")):
            _, value = self.run("source-identity", ["git", "rev-parse", ref])
            self.receipt["source"][field] = value.decode().strip()
        if self.receipt["source"]["head"] != os.environ.get("GITHUB_SHA"):
            raise Refusal("workflow-source-mismatch")
        _, dirty = self.run("source-clean", ["git", "status", "--porcelain=v1", "--untracked-files=normal"])
        if dirty:
            raise Refusal("source-dirty")
        self.run("host-tool-metadata", ["apt-get", "update"], 120)
        self.run("host-tools", ["apt-get", "install", "--yes", "--no-install-recommends", "qemu-system-x86", "qemu-utils", "cloud-image-utils"], 180)
        self.run("ssh-key", ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.private / "ssh")])
        self.run("guest-host-key", ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.private / "guest-host")])
        public = (self.private / "ssh.pub").read_text().strip()
        host_private = (self.private / "guest-host").read_text()
        host_public = (self.private / "guest-host.pub").read_text().strip()
        cloud = {"users": [{"name": "ubuntu", "sudo": "ALL=(ALL) NOPASSWD:ALL", "shell": "/bin/bash", "ssh_authorized_keys": [public]}], "ssh_pwauth": False, "ssh_keys": {"ed25519_private": host_private, "ed25519_public": host_public}, "package_update": False, "package_upgrade": False,
                 "write_files": [{"path": "/etc/damadama-kernel-experiment", "content": self.id, "permissions": "0400"}]}
        (self.private / "user-data").write_text("#cloud-config\n" + json.dumps(cloud))
        (self.private / "meta-data").write_text(json.dumps({"instance-id": self.id, "local-hostname": "damadama-kernel"}))
        self.run("cloud-seed", ["cloud-localds", str(self.private / "seed.img"), str(self.private / "user-data"), str(self.private / "meta-data")])
        gpg = self.private / "gpg"
        gpg.mkdir(mode=0o700)
        self.download("https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x" + IMAGE_SIGNER, self.private / "image-key.asc", 65536)
        self.run("image-key-import", ["gpg", "--homedir", str(gpg), "--batch", "--import", str(self.private / "image-key.asc")])
        for name in ("SHA256SUMS", "SHA256SUMS.gpg"):
            self.download(IMAGE_URL + name, self.private / name, 1024 * 1024)
        _, status = self.run("image-signature", ["gpg", "--homedir", str(gpg), "--batch", "--status-fd", "1", "--verify", str(self.private / "SHA256SUMS.gpg"), str(self.private / "SHA256SUMS")])
        if not re.search(rb"\[GNUPG:\] VALIDSIG " + IMAGE_SIGNER.encode() + rb" ", status):
            raise Refusal("image-signer-mismatch")
        matches = re.findall(r"^([a-f0-9]{64}) [ *]" + re.escape(IMAGE_NAME) + r"$", (self.private / "SHA256SUMS").read_text(), re.M)
        if len(matches) != 1:
            raise Refusal("image-checksum-unknown")
        self.base = self.private / "base.qcow2"
        self.images.append(self.base)
        self.download(IMAGE_URL + IMAGE_NAME, self.base, 2 * GIB)
        if digest(self.base) != matches[0]:
            raise Refusal("image-checksum-mismatch")
        self.receipt["image"] = {"url": IMAGE_URL + IMAGE_NAME, "sha256": matches[0], "signer": IMAGE_SIGNER}
        self.run("image-resize", ["qemu-img", "resize", str(self.base), "24G"])
        _, qemu_version = self.run("qemu-version", ["qemu-system-x86_64", "--version"])
        self.receipt["host"]["qemuVersion"] = qemu_version.decode().splitlines()[0]
        packages = self.private / "packages"
        packages.mkdir()
        for filename, expected in PACKAGES:
            path = packages / Path(filename).name
            self.download("https://archive.ubuntu.com/ubuntu/" + filename, path, GIB)
            if digest(path) != expected or sum(item.stat().st_size for item in packages.iterdir()) > GIB:
                raise Refusal("kernel-package-mismatch")
        self.receipt["kernelPackages"] = [{"filename": filename, "sha256": sha} for filename, sha in PACKAGES]
        staged = self.private / "source"
        self.run("source-clone", ["git", "clone", "--no-local", "--depth=1", self.root.as_uri(), str(staged)])
        for field, ref in (("head", "HEAD"), ("tree", "HEAD^{tree}")):
            _, value = self.run("staged-source-identity", ["git", "-C", str(staged), "rev-parse", ref])
            if value.decode().strip() != self.receipt["source"][field]:
                raise Refusal("staged-source-mismatch")
        (staged / ".git/config").write_text("[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\n")
        for name in ("hooks", "logs"):
            shutil.rmtree(staged / ".git" / name, ignore_errors=True)
        _, names = self.run("source-members", ["git", "ls-tree", "-rz", "--name-only", "HEAD"])
        if any(not source_allowed(name) for name in names.decode().split("\0") if name):
            raise Refusal("source-export-refused")
        with tarfile.open(self.private / "source.tar.gz", "w:gz") as archive:
            archive.add(staged, arcname="damadama")
        self.receipt["source"]["bundleSha256"] = digest(self.private / "source.tar.gz")
        shutil.rmtree(staged)

    def execute(self):
        if platform.system() != "Linux" or os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
            raise Refusal("disposable-github-runner-required")
        if not os.environ.get("KERNEL_JOB_STARTED", "").isdigit() or self.job_started > time.time() + 5:
            raise Refusal("job-start-identity-unavailable")
        self.resources(initial=True)
        import fcntl
        descriptor = os.open("/dev/kvm", os.O_RDWR)
        try:
            if fcntl.ioctl(descriptor, 0xAE00, 0) != 12:
                raise Refusal("kvm-api-unavailable")
            vm = fcntl.ioctl(descriptor, 0xAE01, 0)
            os.close(vm)
        finally:
            os.close(descriptor)
        self.receipt["host"] = {"kernel": platform.release(), "cpuCount": os.cpu_count(), "imageOS": os.environ.get("ImageOS"), "imageVersion": os.environ.get("ImageVersion")}
        self.receipt["workflow"] = {field: os.environ.get(name) for field, name in (("name", "GITHUB_WORKFLOW"), ("job", "GITHUB_JOB"), ("runId", "GITHUB_RUN_ID"), ("attempt", "GITHUB_RUN_ATTEMPT"), ("sha", "GITHUB_SHA"))}
        self.receipt["workflow"]["firstStepUnixSeconds"] = self.job_started
        self.prepare_inputs()
        self.receipt["stage"] = "guest-preparation"
        self.boot("preparation", self.base)
        self.ssh("cloud-init", "sudo cloud-init status --wait", 120)
        self.ssh("source-transfer", "sudo tar -xzf - -C /opt", 90, (self.private / "source.tar.gz").read_bytes())
        for path in (self.private / "packages").iterdir():
            self.ssh("package-transfer", "sudo tee /opt/" + path.name + " >/dev/null", 60, path.read_bytes())
        self.guest_command("prepare", 1200)
        _, prepared = self.ssh("prepared-manifest", "sudo cat /opt/kernel-prepared.json")
        manifest = json.loads(prepared)
        if manifest["head"] != self.receipt["source"]["head"] or manifest["tree"] != self.receipt["source"]["tree"]:
            raise Refusal("guest-source-mismatch")
        self.receipt["prepared"] = manifest
        root_uuid = manifest["rootUuid"]
        if not re.fullmatch(r"[a-f0-9-]{36}", root_uuid):
            raise Refusal("root-uuid-invalid")
        for kernel in KERNELS:
            for prefix in ("vmlinuz-", "initrd.img-"):
                _, contents = self.ssh("boot-file-transfer", "sudo cat /boot/" + prefix + kernel, output_limit=256 * 1024 * 1024)
                target = self.private / (prefix + kernel)
                target.write_bytes(contents)
                if digest(target) != manifest["bootFiles"][prefix + kernel]:
                    raise Refusal("boot-file-mismatch")
        self.ssh("guest-shutdown", "sudo shutdown -h now", 10, check=False)
        try:
            self.vm.wait(timeout=30)
        except subprocess.TimeoutExpired:
            raise Refusal("prepared-shutdown-unproved")
        self.stop()
        self.receipt["preparedBaseSha256"] = digest(self.base)
        self.base.chmod(0o400)
        self.receipt["stage"] = "bounded-boot-milestone"
        for index, kernel in enumerate(KERNELS):
            overlay = self.private / ("boot-" + str(index) + ".qcow2")
            self.images.append(overlay)
            self.run("overlay-create", ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(self.base), str(overlay)])
            self.boot("boot-" + str(index), overlay, kernel, root_uuid)
            inspection = self.guest_command("inspect", 120)
            self.receipt["arms"].append({"kernel": kernel, "scope": "boot-only", "inspection": json.loads(inspection)})
            self.ssh("guest-shutdown", "sudo shutdown -h now", 10, check=False)
            try:
                self.vm.wait(timeout=30)
            except subprocess.TimeoutExpired:
                raise Refusal("arm-shutdown-unproved")
            self.stop()
            if digest(self.base) != self.receipt["preparedBaseSha256"]:
                raise Refusal("immutable-base-changed")
            overlay.unlink()
        self.receipt["outcome"] = "boot-supported"
        self.receipt["reason"] = "exact-kernels-kvm-and-cleanup-proved"
        self.save()


def main():
    experiment = Experiment(Path.cwd())
    try:
        experiment.execute()
    except Refusal as error:
        experiment.receipt["reason"] = str(error)
    except Exception as error:
        experiment.receipt["reason"] = "unexpected-environment-error"
        experiment.receipt["errorClass"] = type(error).__name__
    finally:
        try:
            experiment.stop()
        except Exception as error:
            experiment.receipt["cleanupErrorClass"] = type(error).__name__
            experiment.receipt["reason"] = "cleanup-unverified"
            experiment.receipt["outcome"] = "environment-refusal"
        experiment.save()
    print(json.dumps({"outcome": experiment.receipt["outcome"], "stage": experiment.receipt["stage"], "reason": experiment.receipt["reason"]}))
    return 0 if experiment.receipt["outcome"] == "boot-supported" else 1


if __name__ == "__main__":
    raise SystemExit(main())
