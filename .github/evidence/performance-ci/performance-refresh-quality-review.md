# Performance refresh maintainability review

Verdict is PASS. No material maintainability finding requires a source change.

This independent read-only review covers PR22 at `b8689dbb1ee64606c700e4b909eb58f957d4e290` against application parent `859ffa5ec2da426e7024f0dcce67ba02e6165c3d`. The merge commit has exactly two parents, prior performance head `22a5a89a2e4293665eed6334a668da441e58c623` and that application parent. The application baseline remains `9c8437e1e4a46965513b53f60d7fa569c0fd18ea`.

I did not write the changes. The root resumed this completed reviewer through the capacity exception because a fresh dispatch hit the agent limit. This review counts as one independent maintainability verdict. It does not replace the separate correctness and security review.

I read repository `AGENTS.md`, the thermo-nuclear quality skill, poteto-mode, the TypeScript instructions, benchmark-checklist, technical-writing, and unslop. Laziness Protocol shaped the decision to retain the direct existing asset checker and browser sequence. Prove It Works shaped the use of actual Git blobs, the exact Check comparison, and saved assertion output instead of a claimed pass.

## Scope remains atomic

The current diff contains 42 files. Thirty-one files preserve baseline, control, media, and review evidence. Eleven files implement or document one performance-check outcome. No dependency was added. The implementation retains a built-in Node asset checker, five executable CLI controls, one browser scenario, optimized fixture startup, its isolated test subject, the canonical check command, documentation, and failure reports.

The performance executables, fixture configuration, package command, check runner, documentation, and evidence have no content diff from `22a5a89a2e4293665eed6334a668da441e58c623`. The refresh does not reopen their previously resolved CLS or asset-inventory findings. No helper, configuration mode, feature branch, or product behavior was added during the refresh.

The evidence subtree has Git tree `3feeb7f1a9b0892a6e75cff135dc26d41e3dc189` at both performance heads. This identity includes the original baseline recording, panel and saved screenshots, five baseline runs, asset inventories, negative controls, red and green logs, and source-pinned review reports.

The application's `web` tree is `0d8a48c99dd59765b95e28d6d2895b49e3486060` at both HEAD and the application parent. Its `server` tree is `f623bb52f5d6dade26fff7287bf9bddb676cb65d` at both revisions. There is no application source or visual change in PR22.

## Check integration preserves the parent policy

The entire Check diff against `859ffa5` removes the main-only PR target filter and adds three explicit performance report paths to the existing failure artifact. A read-only text comparison proved the current file equals the parent after reversing exactly those owned changes.

The new application/setup detector, full-history checkout, disabled persisted checkout credentials, setup summary, application conditions, permissions, cancellation, tool setup, dependency caches, timeout, failure-only upload, attempt-specific artifact name, and three-day retention all remain the parent's code. Check still runs one canonical `bun run check` command for application revisions.

`release/application.mjs` classifies a commit with all four application roots as an application. The reviewed HEAD contains `package.json`, `server`, `web`, and `bun.lock`. Removing the target-branch filter therefore enables the existing application check for the dependent stack without inventing another detector or a special performance job. The setup-only path remains the inherited policy.

A comparison over `release`, `.github/workflows`, `.github/actions`, `docs/release-gate.md`, `web`, and `server` returned only `.github/workflows/check.yml`. No release code or other release workflow differs from the application parent. This conclusion covers repository content. I did not query or change external settings and do not certify their live state.

## Existing evidence remains useful

I inspected the initial and post-fix maintainability reports, the post-fix security report, the baseline asset inventory, all five baseline result summaries, and the saved red and green controls. The prior post-fix reports identify exact source hashes and explain their two resolved findings. Their detail remains in `.github/evidence/performance-ci/performance-quality-postfix-details.md`.

The retained baseline inventories the actual production entry at 313,242 gzip bytes across seven assets. Each of the five browser reports records 15 requests with zero errors and failures. The documentation distinguishes those local optimized-fixture observations from live Clerk and production behavior. It keeps elapsed timings diagnostic and introduces no machine-specific speed ratio or latency threshold.

The saved oversized-JavaScript red log fails with `Missing expected rejection`. The saved root-font red log fails with the same expected-rejection disagreement. The fixed root-font control then exits one with `Referenced asset oversized.woff2 is outside the inventoried assets directory.` The persistent CLI controls retain both cases.

The retained layout control first observes a real score of about 0.303 while the old capture reports about 0.002025 and passes. Its fixed run fails with expected `<= 0.1` and received `0.3031966923236847`. The clean report passes after removal. The current browser code samples the complete first-document accumulator after save and before reload, then compares it with the settled reload score. The mutation is absent from the executable spec.

Those controls establish budget detection. They do not establish a speed improvement. The refresh needs no new reproduction because the executable and evidence blobs are unchanged. The no-visual-change rationale and original UI media remain present.

## Supplemental comments audit

A separate scoped search over the performance scripts, browser spec, Check, and check runner found no narrative code comments, suppression directives, skipped tests, or focused-only tests. The only matches were the inherited YAML dependency glob lines beginning with `**`. This is a brief text audit, not a replacement for any required independent comment-review verdict.

## Verification observed

The retained earlier full-check log records five passing CLI controls, twelve passing browser tests, and fifty-one passing backend tests. That evidence belongs to the earlier source-pinned layer, not a fresh pass at the merge commit.

The first refresh attempt failed Prettier checks on Windows checkout line endings. The root preserved that attempt in `.audit/performance-refresh-format-red.log` and used the existing formatter. I observed an empty canonical Git content diff afterward. The line-ending status is not a source-design finding or a performance control.

The completed root-owned `.audit/performance-refresh-check.log` records passing formatting, production and fixture builds, five CLI controls, twelve browser tests, and fifty-one backend tests with zero failures or skips. It reports 313,242 gzip bytes in seven production assets. The root reports process exit zero. I read the completed log, whose SHA-256 is `F2BEA534AAEA769F0BD83767B06410C1D2ADAE1EDBF63F0EBDF46F94849F4D3B`.

The separate `.audit/performance-refresh-boundary-check.log` records all five inherited application-selector and Check-shell controls passing. They cover the approved setup baseline, unrooted absence, historical application deletion, partial roots, and deleted roots. Its SHA-256 is `727C644FF291B32CC09105BF3CBEFDEAF782230B8355325F17BCA9362BFF4258`.

These are independently inspected results of root-owned processes. I started no tests, servers, measurement scripts, or external operations. HEAD still matched the reviewed merge commit, and a final canonical content diff remained empty. Remote PR CI still needs its own observation after publication.

## Reviewed Git blobs

These are committed content identities at the exact reviewed HEAD. They remain stable across local line-ending normalization.

| Path                                  | Git blob                                   |
| ------------------------------------- | ------------------------------------------ |
| `.github/workflows/check.yml`         | `a7ad9513df7b4c75599bb74fc1a79b192e119b8a` |
| `README.md`                           | `348a098c1dbd12f38e35ca8798e1b7bb8a8edc80` |
| `docs/browser-performance.md`         | `99e83281aec29f9161e5a2f7e827bd7bb31b9164` |
| `package.json`                        | `d91566348f25e4f096543c875ff1ea5536336998` |
| `scripts/check.ts`                    | `50073ee05bbcd26b3cac1b7b07bcd82e80eb29c4` |
| `scripts/performance-budget.mjs`      | `2a1dd5e2bfd1ee2ce08d92592190da10ca5ec1ab` |
| `scripts/performance-budget.test.mjs` | `0783ddf037da6934efa3c94b8564e12a2db1a209` |
| `tests/Browser/performance.spec.ts`   | `bf3231229b399a434e125222bfb86cba8f23f88a` |
| `tests/Browser/playwright.config.ts`  | `836a7ecba1145ec378b426e6f00113096d94696e` |
| `tests/Browser/vite.config.ts`        | `9fe175d27ab669162874282c9416e2ff1bf39f14` |
| `tests/BrowserHost/Program.cs`        | `76f97bc6a3f19abaa8605f04ff233d3545f666a9` |
| Inherited `release/application.mjs`   | `82110832422e5d1752547e1d9a5bdc1da4dd3242` |

The read-only commands were Git comparisons and tree queries, scoped source and evidence reads, JSON summary extraction, and a scoped comment search. Only this review report was written. No credential, vault, recovery identity, or fixture-token file was read. No source, branch, server, PR, deployment, or external setting was changed. The root retains ownership of both draft PRs. This verdict does not authorize merging or automatic merge.
