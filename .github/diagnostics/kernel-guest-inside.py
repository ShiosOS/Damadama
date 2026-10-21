import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path("/opt/damadama")
KERNELS = ("6.17.0-1022-azure", "7.0.0-1017-azure")
ENV = {**os.environ, "PATH": "/opt/node/bin:/opt/bun:/opt/dotnet:" + os.environ["PATH"],
       "DOTNET_ROOT": "/opt/dotnet", "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1",
       "DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "l", "PLAYWRIGHT_BROWSERS_PATH": "/opt/playwright",
       "CI": "true", "TZ": "America/New_York"}
COMMANDS = []


class GuestRefusal(Exception):
    pass


def failure_status(error):
    reason = "unexpected-guest-error"
    if isinstance(error, GuestRefusal):
        reason = str(error)
    return {"outcome": "environment-refusal", "reason": reason, "errorClass": type(error).__name__, "commands": COMMANDS}


def run(argv, seconds=300):
    row = {"argv": argv, "exitCode": None}
    COMMANDS.append(row)
    result = subprocess.run(argv, cwd=ROOT, env=ENV, capture_output=True, timeout=seconds)
    row["exitCode"] = result.returncode
    if result.returncode != 0:
        raise GuestRefusal("guest-command-failed")
    return result.stdout.decode().strip()


def checksum(path, algorithm="sha256"):
    with path.open("rb") as source:
        return hashlib.file_digest(source, algorithm).hexdigest()


def download(url, target, maximum=512 * 1024**2):
    with urllib.request.urlopen(url, timeout=90) as response, target.open("wb") as output:
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > maximum:
                raise GuestRefusal("download-bound")
            output.write(block)
    return target


def metadata(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise GuestRefusal("metadata-bound")
    return json.loads(data)


def require_guest():
    if sys.platform != "linux" or os.geteuid() != 0 or ROOT != Path.cwd():
        raise GuestRefusal("guest-context-required")
    if Path("/sys/class/dmi/id/sys_vendor").read_text().strip() != "Damadama" or Path("/sys/class/dmi/id/product_name").read_text().strip() != "kernel-diagnostic":
        raise GuestRefusal("owned-guest-required")
    serial = Path("/sys/class/dmi/id/product_serial").read_text().strip()
    if not re.fullmatch(r"[a-f0-9-]{36}", serial) or Path("/etc/damadama-kernel-experiment").read_text() != serial:
        raise GuestRefusal("guest-experiment-mismatch")


def prepare():
    require_guest()
    run(["systemctl", "mask", "--now", "apt-daily.timer", "apt-daily-upgrade.timer"])
    run(["apt-get", "update"])
    run(["apt-get", "install", "--yes", "--no-install-recommends", "ca-certificates", "curl", "gnupg", "git", "xz-utils", "unzip", "libicu74", "libssl3t64", "libkrb5-3", "zlib1g", "lsof"])
    run(["apt-get", "install", "--yes", "--no-install-recommends", *map(str, sorted(Path("/opt").glob("linux-*.deb")))])
    modules = Path("/etc/initramfs-tools/modules")
    modules.write_text(modules.read_text() + "\nvirtio_pci\nvirtio_blk\nvirtio_net\next4\n")
    for kernel in KERNELS:
        run(["update-initramfs", "-u", "-k", kernel])
    downloads = Path("/opt/downloads")
    downloads.mkdir()
    node_name = "node-v24.21.0-linux-x64.tar.xz"
    sums = download("https://nodejs.org/dist/v24.21.0/SHASUMS256.txt", downloads / "node-sums", 1024 * 1024).read_text()
    expected = re.findall(r"^([a-f0-9]{64})  " + re.escape(node_name) + "$", sums, re.M)
    node = download("https://nodejs.org/dist/v24.21.0/" + node_name, downloads / node_name)
    if len(expected) != 1 or checksum(node) != expected[0]:
        raise GuestRefusal("node-checksum-mismatch")
    run(["tar", "-xJf", str(node), "-C", "/opt"])
    Path("/opt/node-v24.21.0-linux-x64").rename("/opt/node")
    release = metadata("https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.3")
    assets = [asset for asset in release["assets"] if asset["name"] == "bun-linux-x64.zip"]
    if len(assets) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", assets[0].get("digest", "")):
        raise GuestRefusal("bun-digest-unavailable")
    bun = download(assets[0]["browser_download_url"], downloads / "bun.zip")
    if "sha256:" + checksum(bun) != assets[0]["digest"]:
        raise GuestRefusal("bun-checksum-mismatch")
    with zipfile.ZipFile(bun) as archive:
        executable = archive.read("bun-linux-x64/bun")
    Path("/opt/bun").mkdir()
    Path("/opt/bun/bun").write_bytes(executable)
    Path("/opt/bun/bun").chmod(0o755)
    releases = metadata("https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json")
    sdks = [sdk for release in releases["releases"] for sdk in release.get("sdks", []) if sdk["version"] == "10.0.113"]
    files = [file for sdk in sdks for file in sdk["files"] if file["rid"] == "linux-x64" and file["name"].endswith(".tar.gz")]
    if len(files) != 1 or not re.fullmatch(r"[a-fA-F0-9]{128}", files[0]["hash"]):
        raise GuestRefusal("dotnet-digest-unavailable")
    sdk = download(files[0]["url"], downloads / "dotnet.tar.gz")
    if checksum(sdk, "sha512").lower() != files[0]["hash"].lower():
        raise GuestRefusal("dotnet-checksum-mismatch")
    Path("/opt/dotnet").mkdir()
    run(["tar", "-xzf", str(sdk), "-C", "/opt/dotnet"])
    docker_key = download("https://download.docker.com/linux/ubuntu/gpg", downloads / "docker.asc", 65536)
    run(["gpg", "--batch", "--yes", "--dearmor", "--output", "/usr/share/keyrings/docker.gpg", str(docker_key)])
    Path("/etc/apt/sources.list.d/docker.list").write_text("deb [arch=amd64 signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable\n")
    run(["apt-get", "update"])
    run(["apt-get", "install", "--yes", "--no-install-recommends", "docker-ce=5:28.0.4-1~ubuntu.24.04~noble", "docker-ce-cli=5:28.0.4-1~ubuntu.24.04~noble", "containerd.io"])
    run(["apt-mark", "hold", "docker-ce", "docker-ce-cli", "containerd.io"])
    run(["systemctl", "enable", "--now", "docker"])
    run(["bun", "install", "--frozen-lockfile"])
    run(["dotnet", "restore", "--locked-mode", "--artifacts-path", ".audit/check-build"])
    run(["dotnet", "build", "--no-restore", "--artifacts-path", ".audit/check-build"])
    run(["bun", "x", "--no-install", "vite", "build", "--config", "tests/Browser/compatibility.vite.config.ts"])
    run(["node", "node_modules/@playwright/test/cli.js", "install", "--with-deps", "chromium", "firefox", "webkit"])
    run(["docker", "pull", "postgres:17-alpine"])
    run(["docker", "pull", "testcontainers/ryuk:0.14.0"])
    versions = {"node": run(["node", "--version"]), "bun": run(["bun", "--version"]), "dotnetSdk": run(["dotnet", "--version"]),
                "dotnetRuntimes": run(["dotnet", "--list-runtimes"]).splitlines(), "dockerClient": run(["docker", "version", "--format", "{{.Client.Version}}"]),
                "dockerServer": run(["docker", "version", "--format", "{{.Server.Version}}"]), "playwright": run(["node", "node_modules/@playwright/test/cli.js", "--version"])}
    if versions["node"] != "v24.21.0" or versions["bun"] != "1.4.3" or versions["dotnetSdk"] != "10.0.113" or versions["dockerServer"] != "28.0.4" or versions["dockerClient"] != "28.0.4" or versions["playwright"] != "Version 1.64.1":
        raise GuestRefusal("runtime-version-mismatch")
    if not any(line.startswith("Microsoft.NETCore.App 10.0.13 ") for line in versions["dotnetRuntimes"]):
        raise GuestRefusal("dotnet-runtime-mismatch")
    package_lines = run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"]).splitlines()
    package_manifest = [line.split("\t") for line in package_lines]
    if any(len(row) != 2 or not re.fullmatch(r"[a-zA-Z0-9.+:~_-]+", field) for row in package_manifest for field in row):
        raise GuestRefusal("package-manifest-invalid")
    files = [Path("/opt/node/bin/node"), Path("/opt/bun/bun"), Path("/opt/dotnet/dotnet"), Path("/opt/dotnet/shared/Microsoft.NETCore.App/10.0.13/libcoreclr.so")]
    chromium = sorted(Path("/opt/playwright").glob("chromium-*/chrome-linux*/chrome"))
    if len(chromium) != 1:
        raise GuestRefusal("chromium-executable-unavailable")
    versions["chromium"] = run([str(chromium[0]), "--version"])
    if not re.search(r"\b156\.0\.8078\.4\b", versions["chromium"]) or len(versions["chromium"]) > 256:
        raise GuestRefusal("chromium-version-mismatch")
    files += chromium
    files += sorted(Path("/opt/playwright").glob("chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell"))
    files += sorted(Path("/opt/playwright").glob("firefox-*/firefox/firefox"))
    files += sorted(Path("/opt/playwright").glob("webkit-*/pw_run.sh"))
    if len(files) < 8:
        raise GuestRefusal("browser-executable-inventory-incomplete")
    files += sorted((ROOT / ".audit/check-build/bin/BrowserHost").rglob("*.dll"))
    files += sorted((ROOT / ".audit/browser-build").rglob("*.js"))
    manifest = {
        "schemaVersion": 1, "head": run(["git", "rev-parse", "HEAD"]), "tree": run(["git", "rev-parse", "HEAD^{tree}"]),
        "rootUuid": run(["findmnt", "-no", "UUID", "/"]), "versions": versions,
        "packages": package_manifest, "files": {str(path): checksum(path) for path in files},
        "bootFiles": {prefix + kernel: checksum(Path("/boot", prefix + kernel)) for kernel in KERNELS for prefix in ("vmlinuz-", "initrd.img-")},
        "runtimeDownloads": {"node": checksum(node), "bun": checksum(bun), "dotnetSha512": checksum(sdk, "sha512")},
        "containerImages": [json.loads(line) for line in run(["docker", "image", "inspect", "postgres:17-alpine", "testcontainers/ryuk:0.14.0", "--format", "{{json .RepoDigests}}"]).splitlines()],
        "commands": COMMANDS,
    }
    Path("/opt/kernel-prepared.json").write_text(json.dumps(manifest, indent=2) + "\n")
    run(["apt-get", "clean"])
    shutil.rmtree(downloads)
    for package in Path("/opt").glob("linux-*.deb"):
        package.unlink()
    Path("/etc/cloud/cloud-init.disabled").touch()
    run(["systemctl", "stop", "docker", "containerd"])
    run(["sync"])


def inspect():
    require_guest()
    manifest = json.loads(Path("/opt/kernel-prepared.json").read_text())
    for filename, expected in manifest["files"].items():
        if checksum(Path(filename)) != expected:
            raise GuestRefusal("frozen-file-mismatch")
    packages = [line.split("\t") for line in run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\n"]).splitlines()]
    if packages != manifest["packages"]:
        raise GuestRefusal("frozen-package-mismatch")
    if run(["git", "rev-parse", "HEAD"]) != manifest["head"] or run(["git", "rev-parse", "HEAD^{tree}"]) != manifest["tree"]:
        raise GuestRefusal("frozen-source-mismatch")
    run(["systemctl", "start", "docker"], 60)
    if run(["docker", "version", "--format", "{{.Server.Version}}"]) != "28.0.4":
        raise GuestRefusal("docker-version-mismatch")
    memory = re.search(r"^MemAvailable:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M)
    cpu_flags = re.search(r"^flags\s+: ([a-zA-Z0-9_ ]+)$", Path("/proc/cpuinfo").read_text(), re.M)
    total_memory = re.search(r"^MemTotal:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M)
    return {
        "kernel": run(["uname", "-r"]), "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "cpuCount": os.cpu_count(), "cpuFlags": cpu_flags[1].split(), "totalMemoryBytes": int(total_memory[1]) * 1024, "availableMemoryBytes": int(memory[1]) * 1024,
        "freeDiskBytes": shutil.disk_usage(ROOT).free, "pressure": {kind: Path("/proc/pressure", kind).read_text().strip() for kind in ("cpu", "memory", "io")},
        "frozenFilesMatch": True, "frozenPackagesMatch": True, "frozenSourceMatches": True,
        "dockerVersion": "28.0.4", "unixSeconds": int(time.time()),
    }


if __name__ == "__main__":
    os.chdir(ROOT)
    try:
        if sys.argv[1:] == ["prepare"]:
            prepare()
        elif sys.argv[1:] == ["inspect"]:
            print(json.dumps(inspect()))
        else:
            raise SystemExit(2)
    except Exception as error:
        Path("/opt/kernel-prepare-status.json").write_text(json.dumps(failure_status(error)))
        raise SystemExit(1)
