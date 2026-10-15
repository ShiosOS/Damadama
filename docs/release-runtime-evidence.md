# Runtime tooling evidence

Historical evidence below describes the earlier premerge design. It is not a schema 2 staging receipt and cannot authorize current promotion. The main staging implementation still requires hosted Railway metadata, ordinary Clerk access, and actual recovery observations.

Verified locally on 2026-10-12 against PR #11's explicitly captured proposed result.
The feature branch and its original worktree were not changed by release setup.

| Identity                    | Value                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| PR head                     | `8d51f1f8e97c42ba539e91d15c0fd4a50b38de99`                         |
| Current main/base           | `543880fc46ccc7c664d8ae36ae416ed3b58f1e56`                         |
| Proposed merge              | `3d1e5784c08ec3ee78944af030e3b1e4cef40c72`                         |
| Complete proposed tree      | `4a5bd5847383b9274b693706b142948559ce3bb7`                         |
| Local candidate version     | `pr-11-8d51f1f8e97c-543880fc46cc`                                  |
| Local image archive SHA-256 | `6d1ad6d202af0814a83fe8ff27e9e2513d1c7ff49cef86489e28596dc421ef2d` |

- The actual Docker packaging command completed. The image runs as UID 1654 and starts only `dotnet Damadama.dll`.
- Image inspection found no test assemblies, BrowserHost, TestApp, or source/test directory. The static release identity matches the captured proposed tree.
- The build emitted the idempotent EF migration SQL and fresh Vue assets. Node 24 fixed a reproduced Vue compilation failure under Bun's fallback Node wrapper.
- The exact .NET SDK 10.0.112 archive passed Microsoft's published SHA-512 verification. The absent SDK Docker tag required this packaging adjustment.
- `bun run check` in a clean isolated clone passed 51 backend tests and 11 Node Playwright tests, including formatting, types, migration, transaction, ownership, and stored-date behavior.
- The initial Windows clone used CRLF and failed formatting. Rechecking out that disposable clone with LF fixed the check. The feature checkout was untouched.
- `node --test release/runtime.test.mjs` passed 28 runtime-policy tests after missing deployment/isolation/recovery refusal cases failed in the red phase.
- Independent review corrected running-image versus configured-source confusion, invalid retention values, and stopped production being treated as an initial release.
- GitHub's merge-check precedence prompted paired App attestations: actual successful head CI is recorded and attested on the proposed merge alongside staging. Foundation refusal/publication/promotion tests passed 54 cases. Hosted check publication remains pending.
- Railway's live public GraphQL schema confirms image-source updates, environment project tokens, deployment metadata, active deployment IDs, no-sleep settings, variables, and readiness settings.

Actionlint v1.7.12 accepts the remaining workflow syntax but rejects the current documented `queue: max` property.
The queue property was checked against GitHub's official concurrency documentation; the old validator limitation is explicit.
GitHub parses the CI workflows when these draft changes are pushed. Staging/promotion definitions still need to land on main before dispatch.

Large image-transfer artifacts expire after three days. Source, migration metadata, and verified records remain for 90 days.
Production deploys the same retained registry digest and checks matching build metadata; it has no rebuild step.

This is local packaging, regression, and policy evidence. No image was pushed to a registry and no hosting service was deployed.
The isolated recovery exercise starts this same local image against fresh and restored PostgreSQL and checks readiness, unauthorized refusal, and retained data.
It does not verify real Clerk signin, email delivery, or production backward compatibility.

The Railway deployment metadata field containing the immutable registry image reference still needs authenticated observation during approved setup.
Until it is established, the adapter refuses automated deployment/verification. No staged result or live App-bound missing/stale merge-gate proof exists yet.
