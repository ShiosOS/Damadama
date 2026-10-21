import errno
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path


def observe_kvm():
    import fcntl

    observation = {
        "uid": os.geteuid(),
        "status": "unsupported",
        "apiVersion": None,
        "vmCreated": False,
        "descriptorsClosed": False,
    }
    device = None
    vm = None
    try:
        device = os.open("/dev/kvm", os.O_RDWR)
        observation["apiVersion"] = fcntl.ioctl(device, 0xAE00, 0)
        if observation["apiVersion"] == 12:
            vm = fcntl.ioctl(device, 0xAE01, 0)
            observation["vmCreated"] = True
            observation["status"] = "available"
    except OSError as error:
        observation["errorCode"] = errno.errorcode.get(error.errno, "UNKNOWN")
        if error.errno in [errno.EACCES, errno.EPERM]:
            observation["status"] = "permission-denied"
    finally:
        for descriptor in [vm, device]:
            if descriptor is not None:
                os.close(descriptor)
        observation["descriptorsClosed"] = True
    return observation


if sys.argv[1:] == ["--kvm-only"]:
    print(json.dumps(observe_kvm()))
    raise SystemExit(0)


class ProbeStop(Exception):
    pass


gib = 1024**3
directory = Path(".audit/compatibility-kernel-prerequisites").resolve()
directory.mkdir(parents=True, exist_ok=True)
receipt = {
    "schemaVersion": 1,
    "outcome": "probe-error",
    "stage": "source",
    "source": {},
    "host": {},
    "kvm": {"unprivileged": None, "privileged": None},
    "resources": {
        "requiredCpuCount": 2,
        "requiredAvailableMemoryBytes": 8 * gib,
        "ownedAllocationLimitBytes": 10 * gib,
        "exportReserveBytes": gib,
        "hostFreeFloorBytes": 4 * gib,
        "packageBudgetBytes": gib,
        "requiredPhysicalHeadroomBytes": 16 * gib,
    },
    "packages": [],
}
targets = [
    ("linux-image-6.17.0-1022-azure", "6.17.0-1022.22"),
    ("linux-modules-6.17.0-1022-azure", "6.17.0-1022.22"),
    ("linux-image-7.0.0-1017-azure", "7.0.0-1017.17~24.04.1"),
    ("linux-modules-7.0.0-1017-azure", "7.0.0-1017.17~24.04.1"),
]

try:
    for field, revision in [("head", "HEAD"), ("tree", "HEAD^{tree}")]:
        result = subprocess.run(
            ["git", "rev-parse", revision], capture_output=True, text=True, timeout=10
        )
        value = result.stdout.strip()
        if result.returncode != 0 or not re.fullmatch(r"[a-f0-9]{40}", value):
            raise ProbeStop("source-unavailable")
        receipt["source"][field] = value

    receipt["stage"] = "host"
    receipt["host"] = {
        "system": platform.system(),
        "architecture": platform.machine(),
        "kernel": platform.release(),
        "imageOS": os.environ.get("ImageOS"),
        "imageVersion": os.environ.get("ImageVersion"),
        "cpuCount": os.cpu_count(),
        "qemuAvailable": shutil.which("qemu-system-x86_64") is not None,
        "qemuImgAvailable": shutil.which("qemu-img") is not None,
    }
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ProbeStop("unsupported-host")
    release = Path("/etc/os-release").read_text()
    if not re.search(r'^ID=ubuntu$', release, re.M) or not re.search(
        r'^VERSION_ID="24\.04"$', release, re.M
    ):
        raise ProbeStop("unsupported-host")
    memory = Path("/proc/meminfo").read_text()
    available = re.search(r"^MemAvailable:\s+(\d+) kB$", memory, re.M)
    if available is None:
        raise ProbeStop("resource-observation-unavailable")
    receipt["host"]["availableMemoryBytes"] = int(available[1]) * 1024
    receipt["host"]["freeDiskBytes"] = shutil.disk_usage(directory).free

    receipt["stage"] = "kvm"
    effective = observe_kvm()
    receipt["kvm"]["unprivileged"] = effective
    if effective["status"] == "permission-denied":
        privileged = subprocess.run(
            ["sudo", "-n", "--", "/usr/bin/python3", "-I", str(Path(__file__).resolve()), "--kvm-only"],
            capture_output=True, text=True, timeout=10,
        )
        if privileged.returncode != 0 or len(privileged.stdout) > 2048:
            receipt["kvm"]["privileged"] = {"status": "unavailable", "exitCode": privileged.returncode}
            raise ProbeStop("kvm-permission-unavailable")
        effective = json.loads(privileged.stdout)
        if not isinstance(effective, dict) or set(effective) - {
            "uid", "status", "apiVersion", "vmCreated", "descriptorsClosed", "errorCode"
        }:
            raise ProbeStop("kvm-observation-invalid")
        receipt["kvm"]["privileged"] = effective
    if effective["status"] != "available":
        raise ProbeStop("unsupported-kvm")

    receipt["stage"] = "resources"
    if (
        (receipt["host"]["cpuCount"] or 0) < 2
        or receipt["host"]["availableMemoryBytes"] < 8 * gib
        or receipt["host"]["freeDiskBytes"] < 16 * gib
    ):
        raise ProbeStop("insufficient-resources")

    receipt["stage"] = "package-metadata"
    state = directory / "apt-state"
    cache = directory / "apt-cache"
    packages = directory / "packages"
    parts = directory / "apt-config-parts"
    logs = directory / "apt-logs"
    for path in [state / "lists/partial", cache / "archives/partial", packages, parts, logs]:
        path.mkdir(parents=True, exist_ok=True)
    main_config = directory / "apt-main.conf"
    main_config.write_text("")
    config = directory / "apt.conf"
    config.write_text(f'Dir::Etc::Parts "{parts}";\nDir::Etc::Main "{main_config}";\n')
    apt_environment = {**os.environ, "APT_CONFIG": str(config)}
    status = state / "status"
    status.write_text("")
    sources = directory / "sources.list"
    sources.write_text(
        "".join(
            "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] "
            f"https://archive.ubuntu.com/ubuntu {suite} main restricted universe multiverse\n"
            for suite in ["noble", "noble-updates", "noble-security"]
        )
    )
    options = [
        "-o", f"Dir::State={state}",
        "-o", f"Dir::State::status={status}",
        "-o", f"Dir::Cache={cache}",
        "-o", f"Dir::Log={logs}",
        "-o", f"Dir::Etc::sourcelist={sources}",
        "-o", "Dir::Etc::sourceparts=-",
        "-o", "Acquire::Retries=0",
        "-o", "Acquire::https::Timeout=30",
        "-o", "APT::Get::List-Cleanup=0",
    ]
    configured = subprocess.run(
        ["apt-config", *options, "dump"],
        env=apt_environment, capture_output=True, text=True, timeout=10,
    )
    if configured.returncode != 0 or re.search(r"::(?:Pre|Post)-Invoke", configured.stdout):
        raise ProbeStop("apt-configuration-not-isolated")
    receipt["hostAptHooksExcluded"] = True
    updated = subprocess.run(
        ["apt-get", *options, "update"],
        env=apt_environment, capture_output=True, text=True, timeout=180,
    )
    receipt["metadataExitCode"] = updated.returncode
    if updated.returncode != 0:
        raise ProbeStop("package-metadata-unavailable")

    total_size = 0
    for name, version in targets:
        row = {"name": name, "version": version, "state": "metadata-unavailable"}
        receipt["packages"].append(row)
        metadata = subprocess.run(
            ["apt-cache", *options, "show", f"{name}={version}"],
            env=apt_environment, capture_output=True, text=True, timeout=30,
        )
        if metadata.returncode != 0:
            row["exitCode"] = metadata.returncode
            raise ProbeStop("package-metadata-unavailable")
        matches = []
        for paragraph in metadata.stdout.strip().split("\n\n"):
            fields = dict(
                line.split(": ", 1)
                for line in paragraph.splitlines()
                if ": " in line and not line.startswith(" ")
            )
            if fields.get("Package") == name and fields.get("Version") == version:
                matches.append(fields)
        if not matches:
            raise ProbeStop("package-metadata-unavailable")
        fields = matches[0]
        expected = fields.get("SHA256", "")
        filename = fields.get("Filename", "")
        if (
            fields.get("Architecture") != "amd64"
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
            or not re.fullmatch(r"pool/[A-Za-z0-9._+~/-]+\.deb", filename)
            or ".." in filename.split("/")
            or not fields.get("Size", "").isdigit()
        ):
            raise ProbeStop("package-metadata-invalid")
        row.update({"sha256": expected, "filename": filename, "size": int(fields["Size"])})
        total_size += row["size"]
        if total_size > gib:
            raise ProbeStop("insufficient-resources")
        receipt["stage"] = "package-bytes"
        downloaded = subprocess.run(
            ["apt-get", *options, "download", f"{name}={version}"],
            env=apt_environment, cwd=packages, capture_output=True, text=True, timeout=90,
        )
        if downloaded.returncode != 0:
            row["state"] = "bytes-unavailable"
            row["exitCode"] = downloaded.returncode
            raise ProbeStop("package-bytes-unavailable")
        archive = packages / Path(filename).name
        with archive.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        row["actualSha256"] = actual
        row["actualSize"] = archive.stat().st_size
        if actual != expected or row["actualSize"] != row["size"]:
            row["state"] = "hash-mismatch"
            raise ProbeStop("package-hash-mismatch")
        row["state"] = "verified"
        receipt["stage"] = "package-metadata"
    receipt["host"]["freeDiskAfterBytes"] = shutil.disk_usage(directory).free
    receipt["outcome"] = "supported"
    receipt["stage"] = "complete"
except ProbeStop as stopped:
    receipt["outcome"] = str(stopped)
except Exception as error:
    receipt["errorClass"] = type(error).__name__

(directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
raise SystemExit(0 if receipt["outcome"] == "supported" else 1)
