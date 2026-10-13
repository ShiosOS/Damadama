# Release control design

The release record is the shared data shape. `release/policy.mjs` owns its identity and promotion predicates.
`release/github.mjs` captures GitHub facts and requires successful Actions CI on the current head after proving main ancestry and complete head/proposed-tree equality.
`release/configure-github.mjs` renders, reconciles, and reads back rules and approval boundaries.
Trusted deployment tooling owns Docker, registry, Railway, and Clerk operations. Provider data never becomes a shell command.

Callers select a PR for staging or a successful staging run for promotion. They cannot supply an arbitrary image or check SHA.
The workflows run from a pinned `main` controller revision. Candidate source runs only inside the secretless Docker build.
Fresh privileged jobs execute trusted controls and inspect the artifact without running candidate scripts on their runner.
The verifier key is confined to the final approval boundary. Production receives separate credentials and no verifier key.

Two independent design sketches compared manual dispatch with an event-driven release ledger and reconciler.
The manual design won on bootstrap and operating cost. Both required the complete source tuple and a dedicated App.
The synthesis kept immutable hash-bound records and fresh observations from the ledger design.
Current GitHub `queue: max` avoids a separate queue database while preserving active deploy-and-verify runs.
The workflow holds one staging queue slot through automated checks, manual approval, and publication.

The design accepts manual staging dispatch and manual email/migration/rollback attestations.
It accepts artifact and registry retention requirements. Missing historical evidence fails closed.
It preserves startup EF migrations, which makes previous-binary compatibility a release prerequisite.
The first release has no previous production image; record that explicitly rather than claiming an image rollback test.

The implementation replaces separate stage/verify dispatches with one workflow and a second approval job.
This binds the human review to one run and prevents another candidate from replacing staging mid-review.
Operator attestations remain human evidence. Automated Clerk ticket sessions do not verify inbox delivery.

Paid resources, domain setup, actual deployment, and production promotion remain separate approval decisions.
The full gate requires reviewed tooling on main and the verifier App's credentials before activation.
