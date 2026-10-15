# Actual Codex Cloud acceptance

## Revised scripts on current main

The [second fresh cloud task](https://chatgpt.com/local/01a13de0-85b9-7534-9141-5caa97ad30ff) executed the exact checked-in scripts
at `5ee2e42f4509a719cb031bd1dea6eb7cd4810ded`, which contains main `a8a51bdcda588a13ed0381b247253be7c79a52ca`.
It detached its isolated checkout to that requested revision and preserved clean tracked/staged files.
It ran Debian 13.6 x64 with unchanged, read-only `/home/agent`.
The supplied runtime identifier was `ccarenv_b64_Y2NhcmVudl8zZTJmYjQyNzJiNjA4MTkxOTZhMmNmNGE0ZWIyYWFmNw`.

Both setup invocations installed or reused the exact runtime pins and completed locked release npm restoration.
They then failed at the pinned Chromium download. Script exits were `setup1=1`, `setup2=1`, and `verify=1`.
Selected output retained in that task's report was:

```text
node-v24.21.0-linux-x64.tar.xz: OK
Node 24.21.0
Bun 1.3.14
.NET SDK 10.0.112
Error: Download failed: server returned code 403 body 'Domain forbidden'
Docker and disposable PostgreSQL verified.
```

Docker server `28.4.0` ran the checked-in isolated PostgreSQL `17.11` probe and executed `SELECT version()`.
The script removed its container and anonymous volume. A subsequent probe-container query returned no rows.
Verification then failed because the pinned `chromium_headless_shell-1248` executable was absent.
Its release-test step was not reached.

The same release test command ran separately with the command tool's supported scoped network permission.
It exited 0 with 162 executed tests, 162 passed, 0 failed, and 0 skipped.
The initial unscoped invocation exited 1 with file-level totals of 15, 12 passed, and 3 failed.
The passing run preserved the tests and used the supported execution permission.

Playwright `1.64.0` requested Chromium `1248`, version `156.0.8078.4`.
The CDN returned HTTP 307 from `cdn.playwright.dev` to
`storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/chrome-linux64.zip`.
The redirected download received HTTP 403 with `Domain forbidden`. No denial bypass or policy change occurred.
Detailed logs and `result.txt` remain under `/workspace/work/pr21-acceptance/` in that cloud task.

The remaining acceptance gates are the supported network update for `storage.googleapis.com`, successful pinned browser installation/launch,
and publication followed by a fresh-task check. The existing setup panel disables Save/Publish and requests reopening setup where it started.
This successful runtime installation does not establish reusable publication or application/Aspire/Clerk verification.

## Initial cloud observation

Run date 2026-10-15. Existing private environment **Damadama**, repository `ShiosOS/Damadama`.
The [fresh cloud task](https://chatgpt.com/local/01a13dcd-fbd4-7240-86d4-967b1aed90dc) reported the following results.
This record summarizes that task's commands and report. It is separate from local Ubuntu validation.
Raw logs and `result.json` remain in that task's `/workspace/work/cloud-acceptance/` directory.
The task could not expose a downloadable artifact because its designated output mount was read-only.

The supplied runtime environment identifier was
`ccarenv_b64_Y2NhcmVudl83OTg5NjZjOTM1NDg4MTkxOTk4Njc4YzRiOWExNjQ3Yw`.
This runtime identifier does not establish the reusable environment's publication status.

- Debian 13.6, x86_64. Checkout `/workspace/Damadama`, branch `work`.
- Remote `https://github.com/ShiosOS/Damadama.git`.
- HEAD `465b8165c1b4b0f29c4daed33d6f3a13b09a8e14`. Tracked files clean before and after.
- Supplied Node `v24.19.0`. Bun and .NET initially absent. `/home/agent` read-only.
- .NET SDK `10.0.112` and Bun `1.3.14` installed and executed in writable workspace paths.
- `npm ci --prefix release --ignore-scripts` passed twice, exits 0 and 0.
- `node --test release/*.test.mjs` executed 171 tests. Passed 171, failed 0, skipped 0.
- Docker client and daemon `28.4.0`. The command tool's scoped network permission enabled access to the existing local socket.
- PostgreSQL SQL result `17.11|42`. The disposable container had no network or published ports and used a generated password.
- The task checked removal of the container and its anonymous volume.
- Playwright `1.64.0` Chromium installation exited 1. Headless launch exited 1 because its executable was absent.
- The Chromium download redirected from `cdn.playwright.dev` to `storage.googleapis.com`, which returned proxy HTTP 403.
- Application checks and Aspire startup did not apply because this main revision has no application manifests.

The task reviewed PR21 commit `3ee7e5e0757c4eac6657b31b9e15c8c9ffca00f6` without switching branches.
It did not execute that setup because it assumed a writable home and privileged Ubuntu package installation.
Subsequent script changes use writable workspace paths and preprovisioned host libraries.
The second task above establishes actual installation of those runtime pins and the revised setup's honest browser failure.
Successful complete setup, browser launch, publication, and verification after publication remain open.

No deployment, merge, provider administration, recovery tooling, production secrets, or authentication/test changes occurred.
