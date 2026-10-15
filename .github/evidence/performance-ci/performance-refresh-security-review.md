# Performance refresh correctness and security review

Date: 2026-10-15, America/New_York.
Verdict: PASS. No material correctness or security finding in the refreshed PR22 source. The final full-check result is recorded separately below and is not assumed from this source verdict.

## Revision and independence

Reviewed head `b8689dbb1ee64606c700e4b909eb58f957d4e290` on `codex/performance-ci` against application boundary `859ffa5ec2da426e7024f0dcce67ba02e6165c3d`. The merge parents are the previous performance head `22a5a89a2e4293665eed6334a668da441e58c623` and that application boundary. The application boundary inherits main `5eb0bf5ec0b1eb5d25b04131cf4654e5128ee27c`.

This reviewer did not author the change. The root resumed this finished independent reviewer under poteto-mode's capacity exception after fresh dispatch failed at the runtime agent limit. The review read the current source and repository instructions rather than relying on the previous verdict. No source, branch, workflow, setting, server, test, fixture token, credential, vault, or recovery identity was modified or accessed by this reviewer. The sole written file is this report.

## Source identity

Canonical Git blob IDs at the reviewed head:

| File                                | Blob                                     |
| ----------------------------------- | ---------------------------------------- |
| .github/workflows/check.yml         | a7ad9513df7b4c75599bb74fc1a79b192e119b8a |
| README.md                           | 348a098c1dbd12f38e35ca8798e1b7bb8a8edc80 |
| docs/browser-performance.md         | 99e83281aec29f9161e5a2f7e827bd7bb31b9164 |
| package.json                        | d91566348f25e4f096543c875ff1ea5536336998 |
| release/application.mjs             | 82110832422e5d1752547e1d9a5bdc1da4dd3242 |
| release/application.test.mjs        | be52152edd1fe4df6be8b19fe31aba02134d90da |
| scripts/check.ts                    | 50073ee05bbcd26b3cac1b7b07bcd82e80eb29c4 |
| scripts/performance-budget.mjs      | 2a1dd5e2bfd1ee2ce08d92592190da10ca5ec1ab |
| scripts/performance-budget.test.mjs | 0783ddf037da6934efa3c94b8564e12a2db1a209 |
| tests/Browser/performance.spec.ts   | bf3231229b399a434e125222bfb86cba8f23f88a |
| tests/Browser/playwright.config.ts  | 836a7ecba1145ec378b426e6f00113096d94696e |
| tests/Browser/vite.config.ts        | 9fe175d27ab669162874282c9416e2ff1bf39f14 |
| tests/BrowserHost/Program.cs        | 76f97bc6a3f19abaa8605f04ff233d3545f666a9 |

The release tree is `f1feeb5d799b598b989318a34f9bca1dd21eaed0` at both the application boundary and reviewed head. The web tree is `0d8a48c99dd59765b95e28d6d2895b49e3486060` at both. The server tree is `f623bb52f5d6dade26fff7287bf9bddb676cb65d` at both.

The entire `.github/evidence/performance-ci` tree remains `3feeb7f1a9b0892a6e75cff135dc26d41e3dc189`, identical to the previous performance head. Prior source-pinned reviews, red controls, original production baseline and media remain intact. No performance executable file changed during this refresh.

## Integration assessment

- The actual diff against the application boundary changes only `.github/workflows/check.yml` among workflows. It removes the main-only PR target filter and adds three explicit performance report paths. All release workflows and all release code match the application boundary exactly. No deployment permission, secret, production approval, image promotion, merge, queue, or external setting change is introduced.
- Check continues to run under `pull_request` with read-only contents permission. Expanding target branches allows application-dependent stacked PRs to exercise the gate. It does not change the workflow to `pull_request_target`, grant a write token, or add a secret-bearing job.
- The inherited setup/application decision remains before every application tool, cache, browser installation and `bun run check` step. Checkout fetches complete history and does not persist credentials. The selector accepts only an immutable 40-character commit and returns only application or setup. Partial roots, unknown setup history and deletion after application installation throw and fail the selection step. The shell assignment preserves a nonzero Node exit under the Actions shell's failure behavior.
- The reviewer invoked the existing selector read-only against the exact reviewed head, application boundary and main boundary. Outputs were application, application and setup respectively. Thus this PR enters the application checks rather than passing via the setup exception. No reproduction or test suite was rerun by this reviewer.
- The three additional artifact paths name only `.audit/performance-assets.json`, `.audit/performance-browser.json` and `.audit/performance-saved.png`. They remain under failure-only upload conditioned on application detection, with three-day retention and a per-attempt artifact name. They do not include `fixture.json` or the optimized fixture directory. The inherited Playwright configuration leaves tracing off.
- The fifteen-minute job bound, dependency and browser caches, and superseded-run cancellation remain present. Performance checks remain inside the ordinary `bun run check` sequence, after the actual production build and before optimized browser preview. A rejected budget or child command returns a failing check.
- The inspected performance code still counts actual production assets, checks references against the inventoried directory, rejects absent builds, and keeps fixed byte/count limits. The browser scenario still requires optimized scripts, actual GET 200, POST 201 and persisted values after reload, zero recorded errors, and both document-lifetime layout scores. The previously repaired root-font and pre-reload CLS guards are present. Diagnostic durations do not become machine-specific pass thresholds.
- The source and reports keep the distinction between production-entry payload bytes and local actual-component/API/PostgreSQL fixture behavior. Nothing in this refresh claims provider sign-in, email, live Clerk latency or production web vitals.

## Evidence and validation limits

The canonical `.audit/refresh-pr11-inspect.json` receipt records PR11 open at application boundary `859ffa5ec2da426e7024f0dcce67ba02e6165c3d`, based on main `5eb0bf5ec0b1eb5d25b04131cf4654e5128ee27c`, with no pending auto-merge or queue entry. The PR22 and PR23 cancel receipts record no pending auto-merge or queue entry and no merge commit. They describe those receipt revisions, not an assumption about a future publish. This reviewer did not arm or merge anything.

The first refreshed full command failed at Prettier on 32 checkout files and exited 1. Its output is preserved in `.audit/performance-refresh-format-red.log`. The root identified Windows CRLF formatting, ran the existing formatter, and reported a zero canonical diff afterward. The reviewer inspected that failed output and the unchanged canonical source blobs, then independently observed `git -c core.safecrlf=false diff --quiet` return 0. This formatting failure is not a budget regression control, a source defect, or a passing full check.

At the latest report update, the new `.audit/performance-refresh-check.log` had passed formatting, all five CLI controls and all twelve browser tests. The backend command was still in progress, so no final full-check success or remote CI result is claimed here. The root owns final command and remote CI observation. Previous passing checks and genuine red controls remain preserved with their original source context; their results are not relabeled as new refresh executions.

The Prove It Works principle shaped this review. Exact Git trees and the real application's read-only state selector established integration behavior; prior green reviews alone were not treated as proof. The review followed the thermo-nuclear correctness/security scope and read the current source before assessing the supplied receipts. No medium or high finding required a subsequent PR-discussion audit.
