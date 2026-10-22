import email.utils
import hashlib
import ipaddress
import json
import lzma
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


AZURE = {"http://azure.archive.ubuntu.com/ubuntu/", "https://azure.archive.ubuntu.com/ubuntu/"}
FALLBACK = {"https://archive.ubuntu.com/ubuntu/", "http://archive.ubuntu.com/ubuntu/"}
PUBLIC = AZURE | FALLBACK | {"https://security.ubuntu.com/ubuntu/", "http://security.ubuntu.com/ubuntu/"}
MIRRORS = Path("/etc/apt/apt-mirrors.txt")
SOURCES = Path("/etc/apt/sources.list.d/ubuntu.sources")
KEYRING = "/usr/share/keyrings/ubuntu-archive-keyring.gpg"
FORMAT = '{"http_status":"%{http_code}","remote_ip":"%{remote_ip}","connect_seconds":%{time_connect},"first_byte_seconds":%{time_starttransfer},"total_seconds":%{time_total},"curl_download_bytes":%{size_download}}'
receipt = {
    "schema": 1,
    "experiment": "same-worker-signed-libflite1-A-B-B-A",
    "verdict": "inconclusive_preflight",
    "application_fix_proved": False,
    "affected_worker_reproduction": False,
    "attempts": [],
    "metadata": {},
    "limits": {"download_seconds": 20, "download_retries": 0, "package_attempts": 4},
}
started = time.monotonic()


def require(condition, label):
    if not condition:
        raise ValueError(label)


def bounded(command, seconds):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    expired = False
    try:
        output, _ = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        expired = True
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            output, _ = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output, _ = process.communicate(timeout=2)
    return process.returncode, output, expired


def stanzas(text):
    result = []
    for paragraph in re.split(r"\n\s*\n", text):
        fields = {}
        last = None
        for line in paragraph.splitlines():
            if not line or line.startswith("#"):
                continue
            if line[0].isspace():
                require(last is not None, "invalid_metadata_continuation")
                fields[last] += " " + line.strip()
            else:
                require(":" in line, "invalid_metadata_field")
                last, value = line.split(":", 1)
                require(last not in fields, "duplicate_metadata_field")
                fields[last] = value.strip()
        if fields:
            result.append(fields)
    return result


def download(url, target, maximum):
    code, output, expired = bounded([
        "curl", "-q", "--silent", "--fail", "--globoff",
        "--proto", "=http,https", "--connect-timeout", "5", "--max-time", "20",
        "--retry", "0", "--max-redirs", "0", "--max-filesize", str(maximum),
        "--output", str(target), "--write-out", FORMAT, "--url", url,
    ], 23)
    result = {"url": url, "curl_exit": code, "supervisor_timeout": expired}
    try:
        metrics = json.loads(output)
        require(set(metrics) == {"http_status", "remote_ip", "connect_seconds", "first_byte_seconds", "total_seconds", "curl_download_bytes"}, "invalid_curl_metrics")
        require(isinstance(metrics["http_status"], str) and re.fullmatch(r"[0-9]{3}", metrics["http_status"]), "invalid_http_status")
        metrics["http_status"] = int(metrics["http_status"])
        require(metrics["http_status"] <= 599, "invalid_http_status")
        if metrics["remote_ip"]:
            ipaddress.ip_address(metrics["remote_ip"])
        for field in ("connect_seconds", "first_byte_seconds", "total_seconds", "curl_download_bytes"):
            require(type(metrics[field]) in (int, float) and 0 <= metrics[field] < 1000000000, "invalid_curl_number")
        result.update(metrics)
    except (ValueError, TypeError, KeyError):
        result["metrics_valid"] = False
    else:
        result["metrics_valid"] = True
    result["file_bytes"] = target.stat().st_size if target.exists() else 0
    result["transport_complete"] = code == 0 and not expired and result.get("http_status") == 200
    return result


def apt_setting(key, numeric=False):
    code, raw, expired = bounded(["apt-config", "shell", "PROBE", key], 2)
    require(code == 0 and not expired, "apt_config_query_failed")
    if not numeric:
        return {"configured": bool(raw.strip())}
    match = re.fullmatch(rb"PROBE='([0-9]{1,9})'\n?", raw)
    return {"configured": bool(raw.strip()), "integer": int(match[1]) if match else None}


try:
    require(os.name == "posix" and Path("/etc/os-release").exists(), "unsupported_platform")
    os_release = Path("/etc/os-release").read_text()
    require(re.search(r'^ID=ubuntu$', os_release, re.M) and re.search(r'^VERSION_ID="24\.04"$', os_release, re.M), "unsupported_os")
    code, architecture, expired = bounded(["dpkg", "--print-architecture"], 2)
    require(code == 0 and not expired and architecture.strip() == b"amd64", "unsupported_architecture")
    identity = {}
    for key, pattern in {"ImageOS": r"ubuntu24", "ImageVersion": r"[0-9]{8}\.[0-9]+\.[0-9]+", "PROBE_WORKER": r"[123]", "GITHUB_SHA": r"[a-f0-9]{40}", "GITHUB_RUN_ID": r"[0-9]+", "GITHUB_RUN_ATTEMPT": r"[0-9]+"}.items():
        value = os.environ.get(key, "")
        identity[key] = value if re.fullmatch(pattern, value) else None
    receipt["runner"] = identity
    receipt["runner"]["provisioner_and_region_source"] = "ordinary GitHub Actions Set up job log; root must retain its exact allowlisted lines"
    receipt["proxy_presence"] = {
        "environment": {key: bool(os.environ.get(key)) for key in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")},
        "apt": {key: apt_setting(key) for key in ("Acquire::http::Proxy", "Acquire::https::Proxy", "Acquire::http::Proxy::azure.archive.ubuntu.com", "Acquire::http::Proxy::archive.ubuntu.com", "Acquire::https::Proxy::azure.archive.ubuntu.com", "Acquire::https::Proxy::archive.ubuntu.com", "Acquire::http::Proxy-Auto-Detect", "Acquire::https::Proxy-Auto-Detect")},
    }
    receipt["apt_transport_settings"] = {key: apt_setting(key, True) for key in ("Acquire::Retries", "Acquire::http::Timeout", "Acquire::https::Timeout", "Acquire::http::Dl-Limit", "Acquire::https::Dl-Limit")}
    source_stanzas = stanzas(SOURCES.read_text())
    require(source_stanzas, "ubuntu_sources_missing")
    allowed_fields = {"Types", "URIs", "Suites", "Components", "Signed-By", "Architectures", "Enabled"}
    public_sources = []
    endpoints = []
    mirror_entries = []
    for source in source_stanzas:
        require(set(source) <= allowed_fields, "unreviewed_source_option")
        require(source.get("Enabled", "yes") == "yes", "disabled_source")
        require(source.get("Signed-By") == KEYRING, "unexpected_archive_keyring")
        require(set(source.get("Types", "").split()) <= {"deb", "deb-src"}, "unexpected_source_type")
        require(set(source.get("Suites", "").split()) <= {"noble", "noble-updates", "noble-backports", "noble-security"}, "unexpected_suite")
        require(set(source.get("Components", "").split()) <= {"main", "universe", "restricted", "multiverse"}, "unexpected_component")
        require(set(source.get("Architectures", "amd64").split()) == {"amd64"}, "unexpected_source_architecture")
        for uri in source.get("URIs", "").split():
            require(uri in PUBLIC or uri == "mirror+file:/etc/apt/apt-mirrors.txt", "unreviewed_source_uri")
            if uri == "mirror+file:/etc/apt/apt-mirrors.txt":
                for line in MIRRORS.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    require(parts[0] in PUBLIC and all(re.fullmatch(r"priority:[0-9]+", part) for part in parts[1:]), "unreviewed_mirror_entry")
                    endpoints.append(parts[0])
                    mirror_entries.append({"url": parts[0], "priority": int(parts[1].split(":")[1]) if len(parts) == 2 else None})
            else:
                endpoints.append(uri)
        public_sources.append({key: source[key] for key in ("Types", "URIs", "Suites", "Components", "Signed-By") if key in source})
    require(any("noble" in source.get("Suites", "").split() and "universe" in source.get("Components", "").split() and "deb" in source.get("Types", "").split() for source in source_stanzas), "noble_universe_binary_source_missing")
    azure = next((endpoint for endpoint in endpoints if endpoint in AZURE), None)
    fallback = next((endpoint for endpoint in endpoints if endpoint in FALLBACK), None)
    require(azure is not None and fallback is not None, "configured_endpoint_pair_missing")
    receipt["source_configuration"] = {"path": str(SOURCES), "stanzas": public_sources, "mirror_entries": mirror_entries, "configured_source_order": list(dict.fromkeys(endpoints)), "A": azure, "B": fallback}
    receipt["transport_scope"] = "curl uses environment proxy configuration; APT-only proxy and bandwidth settings are observed but not replayed; remote_ip may identify a proxy"
    with tempfile.TemporaryDirectory(prefix="apt-payload-probe-") as work:
        work = Path(work)
        release = work / "InRelease"
        release_download = download(azure + "dists/noble/InRelease", release, 2 * 1024 * 1024)
        receipt["metadata"]["release_download"] = release_download
        require(release_download["transport_complete"], "metadata_release_download_incomplete")
        code, _, expired = bounded(["gpgv", "--keyring", KEYRING, str(release)], 5)
        receipt["metadata"]["signature"] = {"gpgv_exit": code, "supervisor_timeout": expired, "keyring": KEYRING, "verified": code == 0 and not expired}
        require(code == 0 and not expired, "metadata_release_signature_rejected")
        text = release.read_text()
        require("\n\n" in text and "\n-----BEGIN PGP SIGNATURE-----" in text, "metadata_release_format_rejected")
        body = text.split("\n\n", 1)[1].split("\n-----BEGIN PGP SIGNATURE-----", 1)[0]
        require(re.search(r"^Codename: noble$", body, re.M), "metadata_codename_rejected")
        date = re.search(r"^Date: (.+)$", body, re.M)
        require(date is not None, "metadata_date_missing")
        require(email.utils.parsedate_to_datetime(date[1]).timestamp() <= time.time() + 600, "metadata_date_in_future")
        valid_until = re.search(r"^Valid-Until: (.+)$", body, re.M)
        if valid_until:
            require(email.utils.parsedate_to_datetime(valid_until[1]).timestamp() >= time.time(), "metadata_expired")
        receipt["metadata"]["release_sha256"] = hashlib.sha256(release.read_bytes()).hexdigest()
        receipt["metadata"]["valid_until_present"] = valid_until is not None
        require("\nSHA256:\n" in body, "metadata_sha256_section_missing")
        hashes = body.split("\nSHA256:\n", 1)[1].split("\n\n", 1)[0]
        entry = re.search(r"^ ([a-f0-9]{64})\s+([0-9]+)\s+universe/binary-amd64/Packages\.xz$", hashes, re.M)
        require(entry is not None, "metadata_package_index_missing")
        index_hash, index_size = entry[1], int(entry[2])
        require(0 < index_size <= 80 * 1024 * 1024, "metadata_index_size_rejected")
        index = work / "Packages.xz"
        index_download = download(azure + "dists/noble/universe/binary-amd64/Packages.xz", index, index_size)
        receipt["metadata"]["index_download"] = index_download
        require(index_download["transport_complete"] and index.stat().st_size == index_size and hashlib.sha256(index.read_bytes()).hexdigest() == index_hash, "metadata_index_integrity_rejected")
        receipt["metadata"]["index"] = {"path": "universe/binary-amd64/Packages.xz", "size": index_size, "sha256": index_hash, "verified": True}
        package = None
        with lzma.open(index, "rt") as stream:
            paragraph = []
            decoded_bytes = 0
            for line in stream:
                decoded_bytes += len(line)
                require(decoded_bytes <= 512 * 1024 * 1024, "metadata_decompression_limit")
                if line.strip():
                    paragraph.append(line)
                else:
                    fields = stanzas("".join(paragraph))
                    paragraph = []
                    if fields and fields[0].get("Package") == "libflite1" and fields[0].get("Architecture") == "amd64":
                        package = fields[0]
                        break
        require(package is not None, "signed_libflite1_metadata_missing")
        filename = package.get("Filename", "")
        digest = package.get("SHA256", "")
        size_text = package.get("Size", "")
        require(re.fullmatch(r"pool/universe/f/flite/libflite1_[A-Za-z0-9.+~:-]+_amd64\.deb", filename), "package_filename_rejected")
        require(re.fullmatch(r"[a-f0-9]{64}", digest) and re.fullmatch(r"[0-9]+", size_text), "package_integrity_metadata_rejected")
        size = int(size_text)
        require(0 < size <= 20 * 1024 * 1024, "package_size_rejected")
        version = package.get("Version", "")
        require(re.fullmatch(r"[A-Za-z0-9.+~:-]{1,100}", version), "package_version_rejected")
        require(version == "2.2-6build3", "signed_version_differs_from_observed_stall")
        receipt["package"] = {"name": "libflite1", "architecture": "amd64", "suite": "noble", "component": "universe", "version": version, "filename": filename, "size": size, "sha256": digest}
        for number, label in enumerate(("A", "B", "B", "A"), 1):
            target = work / f"attempt-{number}.partial"
            endpoint = azure if label == "A" else fallback
            attempt = download(endpoint + filename, target, size)
            attempt.update({"order": number, "endpoint": label, "complete": False, "sha256": None})
            if attempt["transport_complete"] and attempt["file_bytes"] == size:
                attempt["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
                attempt["complete"] = attempt["sha256"] == digest
            attempt["state"] = "complete_verified" if attempt["complete"] else "partial_or_rejected"
            receipt["attempts"].append(attempt)
            target.unlink(missing_ok=True)
        a = [attempt for attempt in receipt["attempts"] if attempt["endpoint"] == "A"]
        b = [attempt for attempt in receipt["attempts"] if attempt["endpoint"] == "B"]
        if all(attempt["complete"] for attempt in receipt["attempts"]):
            receipt["verdict"] = "inconclusive_all_transfers_complete_no_stall_reproduced"
        elif all(attempt["complete"] for attempt in b) and all(attempt["curl_exit"] == 28 and not attempt["complete"] for attempt in a):
            receipt["verdict"] = "candidate_azure_path_timeout_with_verified_fallback"
        else:
            receipt["verdict"] = "inconclusive_mixed_or_shared_transport_failure"
except (OSError, ValueError, subprocess.SubprocessError, lzma.LZMAError) as error:
    label = str(error)
    receipt["failure"] = label if re.fullmatch(r"[a-z_]{1,100}", label) else "preflight_or_supervisor_failure"
finally:
    receipt["elapsed_seconds"] = round(time.monotonic() - started, 3)
    Path("apt-payload-probe.json").write_text(json.dumps(receipt, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"verdict": receipt["verdict"], "application_fix_proved": False}))

raise SystemExit(0 if receipt["verdict"] == "candidate_azure_path_timeout_with_verified_fallback" else 2)
