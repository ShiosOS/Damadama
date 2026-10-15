# Configure PR checks and release environments

Main requires a pull request, resolved review conversations, strict current checks from GitHub Actions, and no bypass actors. Required jobs are `release-controls` and `check`. Deletion and force-push protections remain enabled. The sole maintainer does not need a second approving reviewer.

Inspect the plan with the GitHub numeric user ID that approves production:

```powershell
node release/configure-github.mjs plan 31512984
node release/configure-github.mjs inspect 31512984
```

Apply the reviewed plan within the approved repository-configuration scope:

```powershell
node release/configure-github.mjs apply 31512984
node release/configure-github.mjs inspect 31512984
```

`staging` allows only main and has no human reviewer or blocking deployment protection. `production` allows only main, requires the designated reviewer, and forbids administrator bypass. Their credentials remain separate.
Remove unused verifier App credentials and obsolete staging-verification and image-publication environments through a separately reviewed configuration change. This script manages only the two active environments.

A setup-only main revision is nondeployable. All application roots must be absent, and immutable ancestry from controls baseline `465b8165c1b4b0f29c4daed33d6f3a13b09a8e14` must show that none was ever installed. Partial roots or later deletion refuse setup. PR setup checks report this explicit state. They never fabricate application test or staging evidence.

After application merge, the main-push DAG runs actual application checks and automatically stages the image. Staging does not gate the earlier PR merge. See [stage main and promote the tested image](release-operations.md).
