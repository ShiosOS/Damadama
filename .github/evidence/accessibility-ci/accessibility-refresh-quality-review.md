# Accessibility refresh maintainability review

Verdict is PASS. No material maintainability finding requires a source change.

This independent read-only review covers PR23 at `48881246c132be4988d89b26ed91dffa3d000a79` against published performance parent `763c23bc89e4b102e85e894d2945f6ab6ed58cbc`. The merge commit has exactly two parents, old accessibility head `07c792789d7029d21063192ae40d73f5a9633a18` and that published performance parent. The latter inherits application PR11 at `859ffa5ec2da426e7024f0dcce67ba02e6165c3d`.

I did not write the changes. The root resumed this completed reviewer through the finished-reviewer capacity exception. This is one independent maintainability verdict and does not replace the separate correctness and security review.

The review follows the previously read thermo-nuclear quality and poteto-mode skills, TypeScript type discipline, technical-writing, and unslop. I reread repository `AGENTS.md` and the current source-pinned reports. Laziness Protocol shaped the decision to preserve the direct scanner and explicit keyboard assertions. Prove It Works shaped the comparison of canonical blobs and actual recorded assertion output instead of treating a successful merge as proof.

## The accessibility scope remains atomic

The actual diff against `763c23b` contains 53 files. Forty-four preserve reports, red controls, scan receipts, before and after screenshots, one keyboard recording, and their evidence README. Nine implement or document one accessibility outcome.

Those nine files retain the single pinned `@axe-core/playwright` 4.13.0 development dependency, its lock entries, one accessibility spec, five isolated test identities, two semantic contrast tokens, refusal-focus recovery, documentation, and two failure-artifact globs. No application authentication bypass, provider mode, service, deployment, or later feature is introduced.

Every file under `web`, `server`, `tests`, and `scripts`, plus `package.json`, `bun.lock`, and `docs/browser-accessibility.md`, is identical to old accessibility head `07c7927`. The merge refresh changes no executable accessibility behavior. The nine-file comparison against the performance parent retains only the originally reviewed application changes in `HabitsPage.vue` and `style.css`.

The scanner remains private to the 401-line accessibility spec. Its report types derive from axe, and its projection retains useful diagnosis without raw DOM or network payloads. The small accessibility assertion remains justified because the real-DOM missing-name control invokes the same gate as the positive states. The keyboard journey explicitly shows each key press and expected focused control. A generalized navigation helper would hide the behavior under review and would not materially simplify this code.

The six-line net focus change remains in the component that owns the request and rendered error. It uses the existing account generation guard, waits for Vue rendering, then checks the generation and open panel before focusing the alert. The 401 path still closes creation. No new state flag or cross-component policy is needed. The contrast values remain in the existing semantic-token block. The page is 285 lines, the stylesheet 213, and the spec 401. No source file crosses the quality skill's 1,000-line boundary.

## Check retains the inherited application detection

The complete Check diff against the performance parent adds only `.audit/accessibility-*.json` and `.audit/accessibility-*.png` to the existing failure artifact. A read-only exact text comparison confirmed that removing those two lines restores the parent file byte for byte.

The all-target PR trigger, application/setup detector, full-history checkout, disabled persisted checkout credentials, setup summary, application conditions, tool setup, permissions, dependency caches, cancellation, timeout, canonical `bun run check`, attempt-specific artifact name, and three-day retention remain the parent's code. The refresh adds no duplicate detector, new job, or special execution mode.

The inherited detector classifies commits with `package.json`, `server`, `web`, and `bun.lock` as applications. All four roots exist at the reviewed HEAD. The accessibility spec already matches the inherited `*.spec.ts` browser selection. Its existing dependency/build/preview sequence runs the scans through the same ordinary API and ephemeral PostgreSQL setup.

A comparison over `release`, `.github/workflows`, `.github/actions`, `docs/release-gate.md`, and `scripts` returned only Check. The `release` tree is `f1feeb5d799b598b989318a34f9bca1dd21eaed0` at both HEAD and the performance parent. The server tree also remains the parent's `f623bb52f5d6dade26fff7287bf9bddb676cb65d`. No release code or other release workflow differs. This is a repository-content conclusion. I did not query or change live external settings.

## Prior evidence and limits remain intact

The accessibility evidence tree is `a0b7e02478af51359f02bed2dc1756dd1f18b69a` at both old `07c7927` and reviewed HEAD. The inherited performance evidence tree is `12bedf64a5cbc3ff678bbe61453b9ae993481ab6` at both published parent and HEAD. The refresh preserves the prior reviews, negative controls, receipts, and media exactly.

I read the retained maintainability summary and details, the security review's canonical blob table, the evidence README, the scan documentation, the missing-name red log, focus-debug JSON, current refusal report, and the previous completed full-check summary. The seven executable, dependency, and accessibility-documentation blobs in the security review match this HEAD. Check and root README have the expected inherited release integration around their existing owned additions.

The missing-name red log has actual `button-name` against the expected empty violation list. The permanent control inserts that defect, verifies the exact rule and selector, invokes the same gate, removes the button, and requires a passing scan. The saved focus observations show BODY after refusal and loss of document focus after Tab. The current test requires focus on the alert and real keyboard traversal through the retry controls. The unrelated Docker failure remains excluded from regression proof.

The retained contrast reports explain the two semantic-token corrections, and the current refusal report has zero violations. It still records `aria-hidden-focus` as incomplete with one node. The documentation retains that distinction and the separate keyboard evidence. It does not claim full WCAG compliance.

The screenshot pairs document the darker alerts and visible error focus. The 418,418-byte keyboard recording remains present. These are the intended existing fixes, rather than a claim that this accessibility layer has no visual change. The original review also measured modest local recording volume. There is no changed recording mechanism to justify another mode or wrapper.

The production-entry test still fetches real configuration and replaces only the public key with null. The authenticated fixture still mounts the actual habit page and uses ordinary JWT middleware with ephemeral RSA tokens and PostgreSQL. Actual response assertions retain 400 refusal, 201 creation, 200 persistence after reload, and expired-token 401. The provider sign-in, email, screen-reader speech, native zoom, and assistive-technology limits remain explicit. CSS zoom is described as a repeatable layout check.

## Supplemental comments audit

A separate scoped search over the accessibility spec, changed application files, fixture host, and Check found no narrative code comments, suppression directives, skipped tests, or focused-only tests. This is a brief text audit. It does not replace any independent comment-review verdict required by the coordinator.

## Verification observed

The retained pre-publication full-check receipt reports five passing performance CLI controls, eighteen passing browser tests, and fifty-one passing backend tests. That receipt belongs to the earlier source-pinned implementation and is preserved as historical evidence.

The completed root-owned `.audit/accessibility-refresh-check.log` records five passing CLI controls, eighteen passing browser tests, and fifty-one passing backend tests with zero failures or skips. It also records passing formatting and builds and 313,307 gzip bytes in seven production assets within the inherited budgets. I read the final summaries. The root separately confirms process exit zero.

That completed log has SHA-256 `C6709166B447361F177C054AB0D9A45BED4E48A1B17066705D28A1593DF3BE29`. These are independently inspected results of the root's process. I did not start tests, servers, reproduction controls, or measurement scripts.

The canonical working-tree content diff was empty at the review snapshot after root-owned LF normalization. During the final report write, the root added a publication note to the accessibility evidence README. I inspected that note. It names the correct refreshed dependency, reviewed merge, completed check, and preserved historical baseline. That note was the only canonical tracked change then present. The executable, configuration, package, lock, and accessibility-documentation diff remained empty. Canonical Git blobs below identify the reviewed implementation independently of physical line endings. Remote PR CI needs its own observation after publication.

## Reviewed canonical blobs

| Path                                  | Git blob                                   |
| ------------------------------------- | ------------------------------------------ |
| `.github/workflows/check.yml`         | `6b4ebffdce430733e1366a69c44acce862061fe2` |
| `README.md`                           | `f955846280c4476e84ff12e0691b856ed186e361` |
| `bun.lock`                            | `2d9d566e46a7c09f7602f3658f4962b37b493f18` |
| `docs/browser-accessibility.md`       | `7ead496de20432d99566e627c238ec397f2c322f` |
| `package.json`                        | `b04326d373afaa25970572906dc9bfb2c49380bf` |
| `tests/Browser/accessibility.spec.ts` | `b6105f9d34aeb01c134ab636a75a04207999ced8` |
| `tests/BrowserHost/Program.cs`        | `c3561662f4bab661df0ec283e56c06b077d96c32` |
| `web/src/HabitsPage.vue`              | `31a1a09a79416a3bf8210b4f4aa8a0fa874fe705` |
| `web/src/style.css`                   | `6758e6a4138830c578314fd0ebf4d76aadcef3eb` |
| Inherited `release/application.mjs`   | `82110832422e5d1752547e1d9a5bdc1da4dd3242` |
| Inherited `scripts/check.ts`          | `50073ee05bbcd26b3cac1b7b07bcd82e80eb29c4` |

Read-only commands were Git comparisons and tree queries, scoped source and evidence reads, and the comment search. Only this report was written. No credential, vault, recovery identity, fixture-token file, source, branch, test, server, PR, deployment, or external setting was changed or accessed outside the review scope. I made no PR-status change. The root's stated constraint keeps both PRs draft, unmerged, and unarmed. This verdict does not authorize merging or automatic merge.
