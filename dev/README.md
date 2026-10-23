# Set up and contribute to Damadama

Use these steps from the repository root on Windows PowerShell or Linux.
Use the [Codex Cloud guide](../.codex/cloud/README.md) for the existing cloud runtime helpers.
Use the [README](../README.md) for application behavior, configuration, and migration rules.

## Prepare a checkout

Install Git, Bun **1.4.3**, Node.js **24**, the .NET SDK selected by `global.json`, and Docker with a Linux container engine.
The .NET pin is **10.0.112** with `latestPatch`, which also accepts **10.0.113** but not **10.0.200**.
Keep runtime selection scoped to this project. Do not replace another project's global Node installation.
For managed runtimes, prepend the chosen runtime directories to the current process's `PATH`.

Clone with LF line endings so format checks match Linux CI, including when your global Git setting uses CRLF.
The `-c` option applies to this clone operation. The local setting keeps later branch switches on LF without changing global Git settings or other repositories.
Run the same commands in either shell:

```sh
git -c core.autocrlf=false clone https://github.com/ShiosOS/Damadama.git
cd Damadama
git config --local core.autocrlf false
```

If you are contributing to an unmerged feature, fetch and switch to its reviewed published base before creating your branch.
Confirm the intended base in the PR. Do not assume that `main` contains another open PR.

From that base, create your branch and check prerequisites:

```sh
git switch -c codex/describe-the-change
bun run doctor backend
bun install --frozen-lockfile
```

Doctor exits with **0** when its prerequisites pass, **1** for failed prerequisites, and **2** for invalid arguments.
It reports all independent failures with check IDs and remedies. It prints configuration names without their values.
It neither installs runtimes nor starts Docker, changes configuration, or stops port owners.
If Bun itself is missing, install the `packageManager` version before invoking doctor.
If `package.json` contains invalid JSON, Bun may print its own loader diagnostic before the script can control output. Restore that tracked manifest before retrying.

Start Docker Desktop's Linux engine on Windows, or a Linux Docker daemon on Linux, before integration tests.
Doctor uses `docker version --format '{{.Server.Os}}'` to require a successful response from the configured Linux daemon.
It reads the server OS and avoids `info`'s client plugin metadata discovery. This check preserves your Docker context.
It does not prove image downloads or PostgreSQL startup. The focused suites prove those behaviors.
On Linux, install Playwright's [native browser dependencies](https://playwright.dev/docs/browsers#install-system-dependencies) through your system's approved package process.
The browser command downloads its pinned Chromium, but does not install operating system packages.

VS Code can suggest the extensions in `.vscode/extensions.json`. Accept the recommendations that fit your editor.
`.editorconfig` defines UTF-8, LF, final newlines, two-space frontend indentation, and four-space C# indentation.
Existing EF migration files retain their UTF-8 byte order marks.
Markdown trailing whitespace remains available for hard line breaks.

## Start the application

Copy the configuration template in your shell.

Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Linux:

```bash
cp .env.example .env.local
```

Replace the placeholders in `.env.local`. Set `Clerk__Issuer`, `Clerk__PublishableKey`, and `Parameters__postgresPassword`.
Keep the indexed `Clerk__AuthorizedParties__0` and subsequent origin entries aligned with the browser URLs you use.
Keep the PostgreSQL password stable across restarts of the persistent local database.
Never paste configuration values, connection strings, or tokens into PR evidence.
Follow the [README's Clerk instance setup](../README.md#start-locally) before testing real sign-in.

```sh
bun run doctor
bun run start
```

Doctor defaults to `start`. This target checks Node 24, the startup configuration, and loopback TCP ports **5050**, **5173**, **17100**, **17101**, **17201**, and **17301**.
It probes IPv4 and IPv6 where available and closes its listeners. A passing probe is a snapshot, not a reservation.
Aspire allocates PostgreSQL's host endpoint, so doctor does not require port 5432.
Open [Damadama](http://localhost:5173). Press Ctrl+C to stop the application. The database volume remains.

If you use the HTTPS Aspire dashboard, run `dotnet dev-certs https --trust` through your normal certificate approval flow.
Standalone server configuration additionally needs `ConnectionStrings__habits`, as described in the [README](../README.md#configuration-and-database-changes).

## Check a change

Run focused checks while editing, then run the authoritative full check before submitting:

```sh
bun run check:types
bun test scripts/doctor.test.ts scripts/developer.test.ts
bun run format:check
bun run test:backend
bun run test:browser
bun run check
```

| Browser compatibility command                                                | Required preparation and platform                                                                                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`bun run browser:compatibility:capture`](../tests/Browser/compatibility.md) | Ubuntu 24.04, locked Bun and NuGet dependencies, a built backend and compatibility Vite entry, installed Playwright browsers, and Linux Docker. |
| [`bun run browser:compatibility:verify`](../tests/Browser/compatibility.md)  | The same Ubuntu 24.04 setup, plus reviewed PNGs and `manifest.json` in `tests/Browser/baselines/`.                                              |

`format:check` verifies C# with `dotnet format` and frontend, scripts, selected docs, and configuration with Prettier.
`bun run format` writes the same scope. Both commands install locked Bun dependencies and run `dotnet restore --locked-mode` before formatting.
No Docker daemon is needed for formatting or type checks. Review the resulting diff before committing.
No pre-commit hook runs Docker or the full suites. CI remains authoritative.
The [DX workflow](../.github/workflows/developer-experience.yml) checks doctor behavior, types, and formatting on Windows and Linux at the PR head.
Separate Linux jobs run each focused suite from a fresh checkout. Real Linux Docker readiness is checked separately from fixtures.
The workflow does not establish Linux-container capability on a Windows host.

The [Docker probe regression](../scripts/doctor-docker.test.ts) runs with `bun --no-env-file test scripts/doctor-docker.test.ts`.
It builds a finite native .NET plugin and uses the installed Docker CLI against an isolated loopback Engine.
It requires the CLI and selected .NET SDK, but no running daemon.
Windows CI runs the original doctor and developer test files before this regression compiles or invokes the client.
The controlled Windows-server response proves refusal policy, not a real Windows engine.
Doctor retires ordinary descendants in a Windows x64 Job Object or an isolated Linux process group before returning a capture.
The same-Bun helper establishes membership before launching the command, without npm packages, PowerShell, a compiler, or cgroup setup.
Linux descendants that change groups or sessions and work launched through external services are outside this boundary.
Doctor reports `process.cleanup` and exits unsuccessfully if it cannot verify retirement within its separate two-second cleanup budget.
Do not remove an uncertain capture's working directory until its processes are inspected.
The original hosted Windows directory holder remains unidentified.
The contributor formatter and full check also format this fixture's C# folder, which is outside the application solution.

`test:backend` checks Bun, Node 24, the selected .NET SDK, and Linux Docker.
It installs locked Bun dependencies and builds the production frontend because the API contract tests request the application shell.
It restores and builds the backend test project with locked NuGet dependencies.
It runs the existing backend tests and writes TRX results to `.audit/TestResults`.
It does not require Clerk settings, a running app, or the development ports.

`test:browser` additionally requires free fixture ports. It installs locked Bun dependencies and builds the production frontend before restoring and building BrowserHost.
It also builds optimized browser fixtures, installs pinned Chromium, and runs Playwright.
It uses the existing synthetic JWT fixture and ordinary API authentication middleware. It does not require Clerk settings or prove provider sign-in or email delivery.
Reports remain in `tests/Browser/playwright-report` and `test-results`. Both focused suites use `.audit/check-build` for build output.
Run suites sequentially within a checkout because they share that output and the browser fixture.

To check browser prerequisites without running tests:

```sh
bun run doctor browser
```

The default fixture ports are **5174** for the browser and **5055** for BrowserHost. The two ports must be different.
To override them, set both variables in the current shell before running doctor or browser tests.

Windows PowerShell:

```powershell
$env:DAMADAMA_BROWSER_PORT = '5176'
$env:DAMADAMA_API_PORT = '5057'
bun run doctor browser
bun run test:browser
```

Linux:

```bash
export DAMADAMA_BROWSER_PORT=5176
export DAMADAMA_API_PORT=5057
bun run doctor browser
bun run test:browser
```

`serve:browser-fixture` replaces the old `test:web` name. It starts only the fixture Vite server, which needs a separately prepared BrowserHost for API calls.
Use `test:browser` to run the complete browser suite.

The full check preserves the API contract gate after backend tests produce the current OpenAPI document and observed responses.
Its provider limits and report rules are in the [README](../README.md#check-a-change), [browser accessibility guide](../tests/Browser/accessibility.md), and [performance guide](../tests/Browser/performance.md).
If Docker is unavailable, record the failure and obtain passing full-check evidence for the current PR head on Linux CI.
Do not describe blocked tests as passed or weaken a gate to obtain green CI.

## Submit a focused pull request

1. Keep one reviewable outcome on your branch. Preserve the domain and migration rules in [AGENTS.md](../AGENTS.md).
2. Run `bun run check` and inspect `git diff --check` and `git diff`.
3. Commit reusable tests, scripts, contracts, and docs. Keep generated logs, reports, screenshots, and recordings out of Git.
4. Push your branch and open a PR using the [PR template](../.github/pull_request_template.md). Name any unmerged PR dependency and its published ref.
5. Record the full tested SHA with `git rev-parse HEAD`. Link current-head CI and non-secret verification output. Refresh evidence after each new push.
6. Obtain independent review. Keep unresolved failures and required external setup visible before requesting readiness.

Use this evidence outline in the PR template:

```text
Tested revision: <full current PR head SHA>
Environment: <OS, selected runtime versions, real capabilities or labeled fixtures>
Commands and exits: <each command, exit code, pass/fail/blocked boundary>
Proof: <CI run or PR attachment links>
Limitations: <unverified provider behavior, missing prerequisites, activation status>
```

For nonvisual changes, explain why visual evidence does not apply and link the command output.
For UI changes, attach the screenshots and recording required by the template.
CI artifacts expire after seven days. Use PR attachments for evidence needed beyond that period.
Upload only the intended non-secret outputs. Do not upload `.audit` broadly or include `.env` files, `fixture.json`, tokens, or habit content.
Use the [release runbook](../release/README.md) and [recovery procedure](../ops/recovery/README.md) for operational work.
