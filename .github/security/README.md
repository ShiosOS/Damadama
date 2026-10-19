# Security controls

This guide describes the controls configured in this repository. [Private vulnerability reporting](https://github.com/ShiosOS/Damadama/security/advisories/new) is enabled at the repository level. The repository owner also read back enabled vulnerability alerts, automatic security updates, secret scanning, and push protection on 2026-10-18. These repository settings are separate from the workflow files in this directory.

## Dependency ownership

One [Dependabot configuration](../dependabot.yml) owns routine and security updates. Routine version updates run weekly, group minor and patch releases, leave major releases as separate reviewable pull requests, and cap open routine pull requests at three per updater. Security updates use a separate group where Dependabot supports it. The routine cap does not limit security updates.

| Ecosystem      | Owned paths                                               | Lockfile or update limit                                                                                                |
| -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Bun            | `/`, including the `web` workspace                        | Shared root `bun.lock`                                                                                                  |
| npm            | `/release`                                                | Separate `release/package-lock.json`                                                                                    |
| NuGet          | `/server`, `/dev`, `/tests/Backend`, `/tests/BrowserHost` | `dev` has Linux and Windows platform lockfiles; review both on updates                                                  |
| GitHub Actions | `/`                                                       | Commit-pinned actions need manual advisory review because ordinary dependency alerts do not cover those pins completely |
| Docker         | `/release`, `/ops/recovery`                               | Image updates do not update the embedded SDK download URL and checksum in `release/Dockerfile`                          |

The root `dotnet-tools.json` and `global.json` need manual review. The NuGet project updaters do not establish coverage of the unusual root tool manifest or the .NET SDK version. Review the SDK URL and checksum pair in `release/Dockerfile` together. Do not treat a Docker image update as proof that this pair was updated.

## Checks and policy

| Check name                                                                                  | Event                                                        | What it establishes                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security-dependency-review`                                                                | Pull requests                                                | The native GitHub dependency review action rejects newly introduced high or critical advisories in runtime, development, and unknown scopes for dependencies in GitHub's supported inventory. Lower severities remain visible for triage. |
| `security-bun-audit`                                                                        | Pull requests, main pushes, weekly schedule, manual dispatch | Bun 1.4.3 audits the complete root lockfile and fails on high or critical advisories or an audit service error. This includes preexisting findings and the `web` workspace. It does not install packages or run lifecycle scripts.        |
| `security-codeql-analysis (csharp)`                                                         | Pull requests, main pushes, weekly schedule, manual dispatch | CodeQL extracts C# after a locked solution restore and manual build.                                                                                                                                                                      |
| `security-codeql-analysis (javascript-typescript)` and `security-codeql-analysis (actions)` | Same                                                         | CodeQL extracts JavaScript, TypeScript, and Actions without a build.                                                                                                                                                                      |
| `security-codeql-upload (<language>)`                                                       | Same, after analysis                                         | A fresh job uploads each language's SARIF. It checks out the same commit for context and does not run repository code.                                                                                                                    |
| `security-fixtures`                                                                         | Pull requests and manual dispatch                            | Bun audits synthetic lockfiles against a loopback advisory service, including clean, below-threshold, high runtime, high development, critical, and service-error responses.                                                              |
| `security-fixtures-dependency-review`                                                       | Same                                                         | The pinned dependency review action reads synthetic comparison responses from a loopback GitHub API. Clean and moderate changes pass; high runtime, development, unknown-scope, and critical changes fail.                                |
| `security-fixtures-codeql (<language>)`                                                     | Same                                                         | Isolated C#, JavaScript, and Actions examples exercise native CodeQL analysis. Each job checks the expected query finding on its unsafe file and absence of that finding on its safe file. Fixture SARIF is never uploaded.               |

The CodeQL analysis jobs have read permission. They run `analyze` with `upload: never` and `upload-database: false`, then pass SARIF artifacts to upload jobs with `security-events: write`. The upload jobs use only checkout, artifact download, and CodeQL SARIF upload actions. Do not add a build, package install, or repository script to those upload jobs. CodeQL findings are uploaded for triage. This workflow does not classify findings by severity for merge decisions.

GitHub's dependency graph does not guarantee Bun transitive inventory. The complete-lockfile Bun audit is the operational check for that gap. Dependency review and Bun audit use their native severity decisions. They do not share a custom vulnerability classifier. A clean loopback fixture proves the configured Bun CLI behavior, not advisory completeness at the public registry.

The repository owner observed a safe GitHub [push protection test token](https://docs.github.com/en/get-started/learning-to-code/storing-your-secrets-safely) blocked in a separate probe on 2026-10-18. The rejected push reported `GH013`, `GITHUB PUSH PROTECTION`, and the probe file line. The token is absent from this repository. That probe covers the documented dummy pattern only.

## Reusable workflow calls

A workflow in this repository can call these controls with relative paths. Grant each caller job the permissions shown here. The called workflow sets narrower permissions on its own jobs where needed.

| Caller job   | `uses` path                                     | Caller job permissions                                      |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| CodeQL       | `./.github/workflows/security-codeql.yml`       | `contents: read`, `actions: read`, `security-events: write` |
| Dependencies | `./.github/workflows/security-dependencies.yml` | `contents: read`, `pull-requests: read`                     |
| Fixtures     | `./.github/workflows/security-fixtures.yml`     | `contents: read`                                            |

CodeQL analysis jobs keep `contents: read`. Fresh SARIF upload jobs also need `actions: read` and `security-events: write`. When the dependency workflow is called from a pull request, its dependency review job runs because the called workflow receives the caller's pull request context. On a non-pull-request call, that pull-request-only job skips; the Bun audit still runs.

Pull request security checks run through the reusable calls in `release-controls.yml`, whose native final gate requires all six caller outcomes to succeed. CodeQL and dependency scanning also run on main pushes, weekly schedules, and manual dispatch. Security fixtures also support manual dispatch. The three security workflows have no standalone pull request trigger.

## Activation and verification

Configuration, execution, and merge enforcement are separate states. These workflow files configure checks. A current commit's successful run establishes that its checks executed. Required status checks and any severity based merge policy require separate repository ruleset activation by the owner. A green CodeQL scan does not mean a finding blocks merge.

Run `bun audit --audit-level high` from the root with Bun 1.4.3 to reproduce the root lockfile audit. Run `bun run check` for the repository test suite. The fixture workflow generates temporary packages, source, and loopback API responses in the runner. It does not install or execute the vulnerable examples. Review the run's job logs for each accepted and rejected scenario. Use a current pull request run to verify GitHub's dependency review comparison and CodeQL extraction and upload on the proposed commit. Scheduled execution begins after these workflows reach `main`.
