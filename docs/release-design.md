# Main staging and manual production

The release source is the actual main commit and Git tree. A schema 2 record separates that source from the controller SHA, workflow run, and attempt. There is one source format.

One main-push workflow runs real control and application checks, builds without secrets, and stages from a fresh privileged runner. Ordinary PR checks remain merge requirements. Automatic staging has no human gate.

Production selects a successful staging run. A secretless preflight freezes a reviewable plan before protected approval. The protected job authenticates the exact run, attempt jobs, immutable artifacts, record hash, and plan again. It deploys the same image digest and preserves backup, restore, isolation, and schema compatibility predicates.

Historical staged evidence is sufficient. Production independently proves its own actual running image and does not need staging credentials. Missing Railway immutable-image metadata remains a refusal.

Main freshness is checked around publication and provider effects. GitHub and Railway cannot commit atomically. A race after mutation reports applied-but-unverified with the actual deployment identity, leaves the release draft, and makes no rollback claim.

The approved controls baseline can advance before the first application merge. The setup exception requires absent app roots and immutable history proving they were never installed after that baseline. It emits no promotable receipt. Deleting an application cannot reopen the exception.

The obsolete PR source tuple, premerge publication workflow, paired App checks, and staging approval were removed together. Recovery packaging, private Docker credential lifetime, API read retries, and provider observation remain shared capabilities.
