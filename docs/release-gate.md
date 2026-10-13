# Staging before merge

`main` is the reviewed source branch. Staging and production are runtime environments, not Git branches.
The required `staging/verified` check belongs to a dedicated GitHub App. Ordinary PR workflows cannot issue that App's check.

## Delivery order

1. Review and merge the release-policy foundation under bootstrap CI and one approving review.
2. Review and merge the deployment and recovery tooling under the same bootstrap policy. Each tooling PR targets `main`.
3. Approve infrastructure and domain setup separately. Configure the verifier App and environment secrets.
4. Activate the full gate and read back its enforcement before permitting any application merge.
5. Update an application PR against the resulting `main`, run CI, and dispatch staging from `main` for that current candidate.
6. Verify staging and review the PR. After its approved merge, request an approved production promotion of the verified digest.

PR #11 is an application candidate, not a bootstrap exception. Its last observed head is `b07d9b4d2b536ce9a7ca56d8c2831ae367ba6357`.
Do not merge it during bootstrap. Its branch and checkout are left untouched by release setup.
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

Bootstrap requires `release-controls`, strict up-to-date checks, one approving review, dismissal of stale approvals,
approval of the latest push, resolved conversations, and no force pushes, deletions, or bypass actors.
It does not claim to enforce staging. An eligible reviewer other than the PR author must approve source changes.

The script creates three GitHub approval boundaries, all restricted to the `main` branch with administrator bypass disabled:

- `staging` authorizes deployment and automated runtime checks.
- `staging-verification` authorizes the final manual attestations and verifier check. Store the verifier App private key only here.
- `production` authorizes promotion. Its credentials never enter staging jobs.

There are only two hosting environments. `staging-verification` is an approval boundary, not another hosted app.
One operator can dispatch and explicitly approve deployments. PR source review remains independent of the PR author.
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

Full enforcement adds `check` from GitHub Actions and `staging/verified` from the specific verifier App.
An App ID of zero or GitHub Actions' ID is rejected.
Check conclusions must be actual success. Skipped, neutral, missing, or failed runtime work cannot publish verifier success.
Review the readback, including effective rules from any additional rulesets.

## Candidate identity and trust

The coordinator captures repository, PR number, head SHA, current base SHA, proposed merge SHA, and complete source tree SHA.
It verifies the merge commit's two parents. It builds that proposed result once in a secretless Docker job.
The production image excludes test hosts, fixture authentication, Aspire, local settings, and credentials.
The release record adds the trusted controller SHA, run ID and attempt, archive checksum, registry digest, version,
deployment identity, automated results, and manual approval evidence.

Before publishing success, the coordinator rechecks the source tuple and active staging deployment.
A source update produces a different candidate. A main update requires the branch to update and staging to run again.
The required check is published only on the proposed merge SHA, never as a successful fallback on the head.
Strict GitHub protection supplies the merge-time freshness check after the final API observation.

Production authenticates the record using the successful verifier check, its App ID and record hash, and the trusted staging run.
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
