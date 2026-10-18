# Configure PR checks and release environments

Main requires a pull request, resolved review conversations, strict current checks from GitHub Actions, and no bypass actors. Required jobs are `release-controls` and `check`. Deletion and force-push protections remain enabled. The sole maintainer does not need a second approving reviewer.

The plan also declares one native `code_scanning` rule for `CodeQL`, with `security_alerts_threshold: high_or_higher` and `alerts_threshold: none`. The pull-request rule keeps an empty `required_reviewers` list and zero required approvals. This source declaration alone does not activate the native rule in GitHub.

Inspect the plan and verify saved configuration with the GitHub numeric user ID that approves production:

```powershell
node release/configure-github.mjs plan 31512984
node release/configure-github.mjs inspect 31512984 --verify
```

`plan` makes no provider request. Verified `inspect` uses only GET requests and refuses missing, duplicate, or changed native configuration. Object-key order does not affect verification. The CLI prints its snapshot before verification, so require a successful exit.

`apply` writes both environment settings and any missing deployment branch policies before updating the complete ruleset. A later failure can leave earlier writes in place. Run it only within an approved scope covering all those writes:

```powershell
node release/configure-github.mjs apply 31512984
node release/configure-github.mjs inspect 31512984 --verify
```

Configuration readback does not prove CodeQL query execution, category authenticity, refusal while analysis is in progress, or integration with the product's merge checkout. Those require separate evidence.

`staging` allows only main and has no human reviewer or blocking deployment protection. `production` allows only main, requires the designated reviewer, and forbids administrator bypass. Their credentials remain separate.
Remove unused verifier App credentials and obsolete staging-verification and image-publication environments through a separately reviewed configuration change. This script manages only the two active environments.

A setup-only main revision is nondeployable. All application roots must be absent, and immutable ancestry from controls baseline `465b8165c1b4b0f29c4daed33d6f3a13b09a8e14` must show that none was ever installed. Partial roots or later deletion refuse setup. PR setup checks report this explicit state. They never fabricate application test or staging evidence.

After application merge, the main-push DAG runs actual application checks and automatically stages the image. Staging does not gate the earlier PR merge. See [stage main and promote the tested image](README.md).
