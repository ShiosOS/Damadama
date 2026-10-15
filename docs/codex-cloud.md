# Set up Damadama in Codex Cloud

Use the current [OpenAI cloud environment workflow](https://learn.chatgpt.com/docs/environments/cloud-environments).
The legacy Codex cloud interface and the Agents API are separate products.

## Select or create an environment

1. Open **Settings > Codex Cloud > Environments** in ChatGPT or the desktop app.
2. Inspect existing environments for the exact repository `ShiosOS/Damadama` before creating another.
3. Reuse a suitable private environment. Otherwise, select **Create environment** and select only that repository.
4. Use existing authorized GitHub access. If GitHub requests a new security grant, have the repository owner approve that grant.
5. Keep **Who can use** set to **Only me**. Leave network secrets, provider identities, and VPN connections empty.

`main` currently contains release tooling. The application is on the unmerged `feat/create-list-habits` branch in PR11.
Keep cloud setup changes on their own branch. Select the application branch explicitly for application verification.

## Prepare and test dependencies

Use Linux x64 with Bash, curl, unzip, tar, xz, Git, and SHA-256 tools.
The existing cloud VM runs Debian 13.6. Local validation uses Ubuntu 24.04.
Use the repository install script after this setup PR is available on the selected revision:

```bash
bash .codex/cloud/setup.sh
bash .codex/cloud/setup.sh
bash .codex/cloud/verify.sh
```

The script pins .NET SDK 10.0.112, Bun 1.3.14, and Node.js 24.21.0.
The shared `runtime.sh` puts runtimes, .NET CLI state, and package/browser caches under `.audit/codex-cloud-runtime`.
That directory is excluded from Git and the application's existing lint rules.
To use another writable volume, export an absolute `DAMADAMA_CLOUD_ROOT` consistently for both commands.
The scripts preserve `HOME`, which is read-only in the existing cloud VM.
They restore locked dependencies and install the lockfile's Playwright Chromium.
The host must already supply .NET's ICU, OpenSSL, and zlib dependencies, Chromium's native libraries, and `tzdata` for IANA device calendar dates.
Setup does not install system packages. Preserve vendor diagnostics when a host dependency is missing.
On a revision with application manifests, it restores Bun dependencies, .NET tools, and NuGet packages.
On today's `main`, it restores the release package with `npm ci --ignore-scripts` and installs its pinned Chromium.
Run setup sequentially within one checkout.

To prepare an older branch without copying setup files into tracked source, retain all three scripts together outside the checkout.
Pass the target checkout as their optional first argument:

```bash
export DAMADAMA_CLOUD_ROOT=/workspace/.damadama/dev-runtime
bash /workspace/.damadama/cloud-tools/setup.sh /workspace/Damadama
bash /workspace/.damadama/cloud-tools/verify.sh /workspace/Damadama
```

Extract those scripts with `git show` from an explicitly reviewed setup commit after fetching it from this repository.
Record that full commit in the environment's installation instructions.

Allow package downloads using **Package managers** and the additional hosts actually required by setup.
Typical extra hosts include `nodejs.org`, `github.com`, `release-assets.githubusercontent.com`, `dot.net`, `builds.dotnet.microsoft.com`, `ci.dot.net`,
`api.nuget.org`, `globalcdn.nuget.org`, `cdn.playwright.dev`, `playwright.download.prss.microsoft.com`,
`storage.googleapis.com`, and Docker Hub's `auth.docker.io`, `registry-1.docker.io`, and image download hosts.
Use failed download logs to identify redirect hosts before expanding access.

Run the capability probe early. It checks an actual Docker daemon, a disposable PostgreSQL container, and a headless Chromium page.
The PostgreSQL probe has no network access or published ports. It removes its anonymous data volume with the disposable container.
It uses a generated password that exists only for that probe.

If Docker is unavailable, record PostgreSQL, Testcontainers, and Aspire startup as unverified.
The probe does not run the full application check.
If its other probes succeed, it exits with code 2 to report missing Docker.
In the measured cloud VM, the command tool's scoped network permission was required to reach the existing local Docker socket.
Use that supported permission when needed. Keep the inherited daemon and proxy configuration.
Keep the existing check command and tests intact.
An installed PostgreSQL executable does not establish Testcontainers support.

OpenAI lists built-in computer and browser use as unsupported in the current cloud environment guide.
This is separate from executing the project's headless Playwright CLI.
Verify Chromium launch directly before claiming Playwright support.

## Publish and verify a fresh task

1. Review the setup output and saved **Install script**. Set it to run `bash .codex/cloud/setup.sh` where this file exists.
2. Record the setup instructions for older branches in the environment itself until this PR reaches `main`.
3. Save the draft, then select **Publish** after reviewing the prepared files and capability results.
4. Confirm **Environment published** and record the displayed environment name and identifier.
5. Start a new cloud task from that environment. Select the desired repository branch explicitly.
6. Run the following task and retain its link and command output:

```text
Verify ShiosOS/Damadama in this cloud task. Do not change source, deploy,
merge, add secrets, or provision infrastructure. Print the remote URL and
HEAD SHA. Run the saved dependency setup twice, then the capability probe.
On main, run node --test release/*.test.mjs and state that application code
is absent. On feat/create-list-habits, run the unchanged bun run check if
Docker and Chromium work. If a capability is absent, report the command,
exit status, and affected checks. Never bypass authentication or weaken tests.
Report the environment identifier, task link, revision, and exact results.
```

Repository refresh preserves caches but does not rerun installation or startup commands.
Rerun setup after a branch or lockfile change. Republish after changing the reusable installation.
Existing tasks retain their own state, so verify changes in a fresh task.

## Start the application when supported

Use the application branch's `README.md` and `bun run start` for Aspire startup.
That flow needs Docker, a persistent development PostgreSQL password, and Clerk development configuration.
Supply development values separately when interactive sign-in is required.
Do not copy production or provider secrets into cloud development.
Keep the cloud environment free of local `.env.local`, audit credential files, vault content, and recovery identities.

The application's test host uses ephemeral signed tokens through the ordinary JWT middleware.
Those tests do not verify Clerk email-code sign-in or email delivery.
Record interactive Clerk verification separately when the cloud product can support it.

## Current verification record

The setup branch is refreshed onto `main` at `a8a51bd`.
The revised scripts passed setup twice, Docker/PostgreSQL, Chromium launch, and all 162 current release tests locally with a read-only home.
The unchanged application check also passed all 11 browser and 51 backend tests with the new default cache path.
These are local Ubuntu results. The initial baseline at `465b816` completed dependency setup twice, launched Chromium, queried PostgreSQL 17,
and passed all 171 release tests. The probe used the existing local Docker Desktop daemon.
The [local output excerpt](../.github/evidence/codex-cloud/local-results.txt) records the source revision and commands.
On PR11's unchanged application source at `9c8437e1`, setup twice and `bun run check` passed locally,
including all 11 browser and 51 backend tests. Adding `tzdata` resolved the minimal image's IANA timezone validation failures.
The run used `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal` for local Docker Desktop's nested-container topology.
Detect the actual Docker endpoint in cloud instead of copying that local override.
Repeated application checks can lint generated browser reports in a reused checkout.
That separate application issue is [tracked in issue 20](https://github.com/ShiosOS/Damadama/issues/20).
This local container does not establish cloud runtime support.
The existing private **Damadama** environment for `ShiosOS/Damadama` was reused after sign-in.
A [fresh cloud acceptance task](https://chatgpt.com/local/01a13dcd-fbd4-7240-86d4-967b1aed90dc) ran on Debian 13.6 x64 at `465b816`.
It passed all 171 release tests with zero skips, repeated locked npm setup, queried PostgreSQL 17.11 through Docker 28.4.0,
and installed and ran .NET 10.0.112 and Bun 1.3.14 in writable workspace paths.
The supplied Node was 24.19.0, so this run does not verify the script's Node 24.21.0 pin.
Pinned Chromium installation and launch failed because its download redirects to `storage.googleapis.com`, where the proxy returned HTTP 403.
The [second fresh task](https://chatgpt.com/local/01a13de0-85b9-7534-9141-5caa97ad30ff) ran the exact revised scripts at `5ee2e42`, based on current main `a8a51bd`.
It verified Node 24.21.0, Bun 1.3.14, .NET 10.0.112, Docker/PostgreSQL, and all 162 release tests in actual Debian cloud execution.
Both setup runs and verification exited 1 because pinned Chromium remained blocked at the same redirected host.
The [cloud results](../.github/evidence/codex-cloud/cloud-results.md) distinguish measured capabilities from remaining checks.
The setup conversation's browser panel reports **Couldn't confirm publishing status** and disables **Save draft** and **Publish**.
It instructs the user to reopen setup where it started. Publication of the corrected development setup remains unverified.
Planning and the decision record are in the private [Notion setup page](https://app.notion.com/p/3f99c0510118811a9c60fbb6107a8e54).
