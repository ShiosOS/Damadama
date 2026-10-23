import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time

INTEGRITY = 'BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ=='
BUNDLE_SHA256 = '829521b67ed7be90c7d6d6098ff39f2241562d47e4ad7ccab13710924a56001d'
receipt = {'schema': 1, 'experiment': 'same-worker-playwright-1.64.1-exact-apt-batch-default-https-default', 'application_fix_proved': False, 'arms': [], 'runner': {k: os.getenv(k) for k in ('ImageOS', 'ImageVersion', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'PROBE_WORKER')}}


def run(command, seconds):
    before = time.monotonic()
    elevated = command[:2] == ['sudo', '-n']
    prefix = ['sudo', '-n'] if elevated else []
    command = command[2:] if elevated else command
    result = subprocess.run(prefix + ['timeout', '--signal=TERM', '--kill-after=2s', str(seconds) + 's'] + command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return result.returncode, result.stdout.decode(errors='replace'), round(time.monotonic() - before, 3)


try:
    assert Path('/etc/os-release').read_text().find('VERSION_ID="24.04"') >= 0
    status = Path('/var/lib/dpkg/status')
    receipt['dpkg_status_before'] = hashlib.sha256(status.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix='apt-batch-probe-') as temporary:
        work = Path(temporary)
        work.chmod(0o777)
        archive = work / 'playwright-core.tgz'
        code, _, _ = run(['curl', '-q', '--silent', '--fail', '--max-time', '15', '--max-filesize', '15000000', '--output', str(archive), 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz'], 18)
        assert code == 0
        import base64
        assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode() == INTEGRITY
        with tarfile.open(archive) as package:
            bundle = package.extractfile('package/lib/coreBundle.js').read()
            assert hashlib.sha256(bundle).hexdigest() == BUNDLE_SHA256
        block = bundle.decode().split('"ubuntu24.04-x64": {', 1)[1].split('lib2package:', 1)[0]
        groups = {g: re.findall(r'"([a-z0-9.+-]+)"', re.search(g + r': \[(.*?)\]', block, re.S)[1]) for g in ('chromium', 'firefox', 'webkit', 'tools')}
        packages = list(dict.fromkeys(sum(groups.values(), [])))
        assert len(packages) == 79
        receipt['playwright'] = {'version': '1.64.1', 'tarball_integrity_verified': True, 'bundle_sha256': BUNDLE_SHA256, 'package_groups': groups, 'unique_packages': packages}
        original = Path('/etc/apt/sources.list.d/ubuntu.sources').read_text()
        assert 'mirror+file:/etc/apt/apt-mirrors.txt' in original
        sources = {'default': original, 'https': original.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://archive.ubuntu.com/ubuntu/')}
        options = {}
        for name, text in sources.items():
            source = work / (name + '.sources')
            source.write_text(text)
            lists = work / (name + '-lists')
            lists.mkdir(mode=0o777)
            options[name] = ['-o', 'Dir::Etc::sourcelist=' + str(source), '-o', 'Dir::Etc::sourceparts=-', '-o', 'Dir::State::lists=' + str(lists)]
            code, output, elapsed = run(['sudo', '-n', 'apt-get'] + options[name] + ['update', '--error-on=any'], 20)
            (work / (name + '-update.log')).write_text(output)
            receipt[name + '_update'] = {'exit': code, 'seconds': elapsed, 'sources_sha256': hashlib.sha256(text.encode()).hexdigest()}
            assert code == 0
        for order, name in enumerate(('default', 'https', 'default'), 1):
            cache = work / ('archives-' + str(order))
            cache.mkdir(mode=0o777)
            code, output, elapsed = run(['sudo', '-n', 'apt-get'] + options[name] + ['-o', 'Dir::Cache::archives=' + str(cache), '--download-only', 'install', '-y', '--no-install-recommends'] + packages, 90)
            downloads = [{'name': p.name, 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in cache.glob('*.deb')]
            partial = [{'name': p.name, 'bytes': p.stat().st_size} for p in (cache / 'partial').glob('*') if p.is_file()]
            receipt['arms'].append({'order': order, 'source': name, 'exit': code, 'seconds': elapsed, 'need_archives': re.findall(r'Need to get [^\n]+', output), 'complete_packages': downloads, 'partial_packages': partial, 'public_get_lines': [line for line in output.splitlines() if line.startswith(('Get:', 'Err:', 'Fetched ', 'Download complete'))]})
            Path('apt-payload-probe.json').write_text(json.dumps(receipt, indent=2) + '\n')
        assert work.resolve().parent == Path(tempfile.gettempdir()).resolve() and work.name.startswith('apt-batch-probe-')
        cleanup_code, _, _ = run(['sudo', '-n', 'chmod', '-R', 'a+rwX', str(work)], 5)
        assert cleanup_code == 0
        receipt['dpkg_status_after'] = hashlib.sha256(status.read_bytes()).hexdigest()
        assert receipt['dpkg_status_before'] == receipt['dpkg_status_after']
        receipt['verdict'] = 'candidate_https_batch_improvement' if [a['exit'] for a in receipt['arms']] == [124, 0, 124] else 'inconclusive_no_red_green_red'
except Exception:
    receipt['verdict'] = 'inconclusive_preflight_or_supervisor_failure'
finally:
    Path('apt-payload-probe.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'verdict': receipt['verdict'], 'arm_exits': [a['exit'] for a in receipt['arms']]}))
