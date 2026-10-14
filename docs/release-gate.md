# Staging before merge

`main` is the reviewed source branch. Staging and production are runtime environments, not Git branches.
The required `ci/verified` and `staging/verified` checks belong to a dedicated GitHub App. Ordinary PR workflows cannot issue that App's checks.

## Delivery order

1. Manually review PR #13, the release-policy foundation, and merge it under bootstrap CI.
2. Use the native stack with `main` as its trunk. Keep the tooling order #13, #12, #14, then #15, with each child based on its immediate predecessor. After each parent lands, update the next PR against the resulting `main`, verify its current checks, and manually review it before merging under bootstrap policy.
3. Approve infrastructure and domain setup separately. Configure the verifier App and environment secrets.
4. Activate the full gate and read back its enforcement before permitting any application merge.
5. Update an application PR against the resulting `main`, run CI, and dispatch staging from `main` for that current candidate.
6. Verify staging and review the PR. After its approved merge, request an approved production promotion of the verified digest.

PR #11 is an application candidate, not a bootstrap exception. Its last observed head is `8d51f1f8e97c42ba539e91d15c0fd4a50b38de99`.
Keep PR #11 separate from the tooling stack until full staging enforcement is active. Do not merge it during bootstrap.
Its branch and checkout are left untouched by release setup.
The source tuple will change when release tooling lands or the feature updates against `main`; capture it again then.

The initial `main` has only a README. A dispatch workflow must exist on the default branch before GitHub can run it.
The reviewed tooling merges therefore precede gate activation. They receive no fabricated staging success.
This is a bounded bootstrap sequence, not a permanent path for skipping application staging.

## Prepare GitHub

Node.js 24 runs the release scripts with no package installation. Run `node --test release/*.test.mjs` before changing controls.
The CLI reads `GH_TOKEN`, or uses `gh auth token` locally. Do not put credentials in arguments or committed JSON.
Administration is needed only while applying repository rules and environment settings.

Render the initial policy, substituting the GitHub user ID of the release approver:

```powershell
node release/configure-github.mjs plan bootstrap 31512984
node release/configure-github.mjs apply bootstrap 31512984
node release/configure-github.mjs inspect bootstrap 31512984
```

Bootstrap requires `release-controls` from GitHub Actions, strict up-to-date checks, a pull request, resolved conversations,
and no force pushes, deletions, or bypass actors. The sole maintainer manually reviews source changes before merging.
Both bootstrap and full enforcement require zero approving reviews and disable last-push approval and extra approval for unattributed Copilot pull requests.
Stale review dismissal remains enabled. Bootstrap does not claim to enforce staging.

The script creates four GitHub approval boundaries, all restricted to the `main` branch with administrator bypass disabled:

- `staging` authorizes deployment and automated runtime checks.
- `staging-verification` authorizes the final manual attestations and verifier check. Store the verifier App private key only here.
- `production` authorizes promotion. Its credentials never enter staging jobs.
- `image-publication` authorizes registry publication only. It has no environment secrets and cannot deploy or issue verifier checks.

There are only two hosting environments. `staging-verification` and `image-publication` are approval boundaries, not hosted apps.
One operator can dispatch and explicitly approve deployments. These protected environment approval requirements remain unchanged.
The sole maintainer performs PR source review manually.
Repeating setup updates the same ruleset and environments. Unexpected branch policies require reconciliation.
The script refuses to replace an activated staging gate with bootstrap policy.

## Create the verifier App

Use `release/github-app.json` as the permission specification in GitHub's private App registration.
Disable webhooks. Grant only repository Checks write and mandatory Metadata read.
Install the App only on `ShiosOS/Damadama`. Record its App ID, not its installation ID.

Set repository variable `RELEASE_GATE_APP_ID` to that App ID.
Set environment secret `RELEASE_GATE_APP_PRIVATE_KEY` only in `staging-verification`.
Do not grant the App Contents write, Actions write, administration, or deployment permissions.
The trusted publisher requests a short-lived installation token restricted to this repository and Checks write.

After reviewed deployment tooling and approved infrastructure are ready, activate the full gate:

```powershell
$env:RELEASE_GATE_APP_ID = 'YOUR_APP_ID'
node release/configure-github.mjs plan gated 31512984
node release/configure-github.mjs apply gated 31512984
node release/configure-github.mjs inspect gated 31512984
node release/configure-github.mjs probe 11
```

Full enforcement replaces the bootstrap requirement with `ci/verified` and `staging/verified` from the specific verifier App.
The controller still requires actual successful `check` and `release-controls` jobs from GitHub Actions on the current head.
The verified record stores their check IDs, revision, producer, success, and run links.
An App ID of zero or GitHub Actions' ID is rejected.
Check conclusions must be actual success. Skipped, neutral, missing, or failed runtime work cannot publish verifier success.
Review the readback, including effective rules from any additional rulesets.

Standard PR Actions checks attach to the head SHA even though checkout uses the proposed merge.
The coordinator therefore requires head CI and proves that head includes current main and its full tree equals the proposed merge tree.
The App attests to those CI facts as `ci/verified` on the proposed merge, alongside `staging/verified`.
GitHub can prefer merge checks once that commit has a status. Keeping both required App checks on that merge avoids mixing required head and merge contexts.
No head success substitutes for either required verifier check.

## Candidate identity and trust

The coordinator captures repository, PR number, head SHA, current base SHA, proposed merge SHA, and complete source tree SHA.
It verifies the merge commit's two parents. It builds that proposed result once in a secretless Docker job.
The production image excludes test hosts, fixture authentication, Aspire, local settings, and credentials.
The release record adds the trusted controller SHA, run ID and attempt, archive checksum, registry digest, version,
deployment identity, automated results, and manual approval evidence.

Before publishing success, the coordinator rechecks the source tuple and active staging deployment.
A source update produces a different candidate. A main update requires the branch to update and staging to run again.
Both required checks are published only on the proposed merge SHA, never as a successful fallback on the head.
Strict GitHub protection supplies the merge-time freshness check after the final API observation.

Production authenticates the record using both successful verifier checks, their App ID and record hash, and the trusted staging run.
It confirms that the PR is merged, its merged result is current main, and main's full tree equals the staged tree.
Tree equality supports both merge commits and squash merges. Production deploys the same registry digest and never rebuilds.

## Demonstrate enforcement

Run the policy tests. Their negative cases exercise changed head, base, proposed merge, tree, forged App, missing runtime evidence,
test-code email bypass, unmerged source, unapproved promotion, and different main content.
These tests prove the local refusal predicates. They do not prove a real staging deployment or GitHub merge rejection.

After full activation, run the read-only `probe` for an application PR with no staging result.
Save the effective required context, App ID, strict policy, missing-success result, and GitHub's blocked mergeability display.
Do not call a merge endpoint as a test. A draft alone is not proof of the staging gate.

For stale evidence, use a disposable application probe PR. First obtain a genuine staged result through the normal workflow.
Push a harmless source change to that probe branch, then inspect the new proposed merge and missing required staging check.
Repeat with a base advance using a separately reviewed merge when permitted. Do not alter PR #11 merely to demonstrate staleness.
Do not manufacture successful `staging/verified` checks. Live missing/stale enforcement remains unverified until this exercise runs.

## Primary references

- [GitHub required-check semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- [GitHub rules and App producer selection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub manual-workflow prerequisites](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
