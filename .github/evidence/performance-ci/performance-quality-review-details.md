# Performance CI review evidence

## Source and method

The reviewed checkout was `C:\Users\emofo\.codex\worktrees\ci-browser-quality\Damadama Rewrite`. `git rev-parse HEAD` returned `9c8437e1e4a46965513b53f60d7fa569c0fd18ea`, which is also the comparison base. This was an uncommitted, frozen layer; HEAD alone does not identify its additions. `git diff --name-only` identified the seven substantive tracked paths listed below. `git status --short` additionally identified the four new source/docs files and many files with line-ending-only working-tree status. The latter had no substantive diff. No source in the primary checkout or sibling checkout was accessed or changed.

Read-only inspection included `git status --short`, `git rev-parse HEAD`, `git diff --stat`, `git diff --name-only`, the full relevant diff, repository `AGENTS.md`, the four new files, the adjacent fixture/check configs, existing fixture entry, README, gitignore, and production Vite config. Narrow reads of `.audit/performance-*` evidence included the baseline inventory, five baseline JSON reports, baseline harness/config, red log, full check log, and current browser report. SHA-256 hashes came from PowerShell `Get-FileHash`. No suites or measurement scripts were executed by this reviewer.

| Reviewed path                         | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `scripts/performance-budget.mjs`      | `074F9BE06CD627AD5287FA039062B3639093360D1E2DDDCA09881E8393551D9F` |
| `scripts/performance-budget.test.mjs` | `169B46A0001DFCCDA2313F464A2D97D21DFEC3A4713B9660C445101CFD792A6D` |
| `tests/Browser/performance.spec.ts`   | `7ED3C1ED33E641A1EFFE7CF30B9F800AE9C99E6B65EEC4E7EE0B761415C553CD` |
| `docs/browser-performance.md`         | `6E4983C856DAB5F7AE86CD9EA4121AFD82820735A4ABDF59E64320086AD13933` |
| `.github/workflows/check.yml`         | `A7FFF4DF741BD21E0EDCAEEDEBCDF469681B442A5BB9C5AD5CFB53631CE65757` |
| `README.md`                           | `020425D1D552F48D1028063D47CB4A67E73679B25FCDB12A98BAC500E2125791` |
| `package.json`                        | `D0804FDD86C1E8CF76DF87561A5AAA6C6C83AF35F3414E60E2BA245413716F41` |
| `scripts/check.ts`                    | `55F3E26A6BF104CE6CD4C5E9ED2B86F7836F1EFEFC72948DF0966CFE9C069807` |
| `tests/Browser/playwright.config.ts`  | `0364F4C848E768FB9256B696B250364145AB4550F5C733C541E8BE86E364D502` |
| `tests/Browser/vite.config.ts`        | `DA68F959949F9B863866BE3B29A0C9144E5BE8C08E1B89BECA3838BE0AE7B9EE` |
| `tests/BrowserHost/Program.cs`        | `C3ED3129121C36667B6DDB4CDDDE1D69E0066BD17817205AA28598C2D76B245F` |

## P2: first-document layout observation ends before creation/save

At `tests/Browser/performance.spec.ts:38-68`, `page.addInitScript` installs a document-local CLS accumulator. It uses the maximum session-window score and filters recent-input entries. Initial navigation waits for a successful GET, saved-list content, fonts, and two animation frames. At line 88, `page.evaluate` serializes that accumulator into `initialLayout`; this is a snapshot, not a live reference to page state.

The panel then opens, fields are populated, and POST 201 plus the saved heading are asserted at lines 89-108. The browser observer keeps accumulating during this work, but no further snapshot is taken from this document. Reload at line 115 destroys that document. The initializer creates a zeroed accumulator for the second document. Line 130 captures only the reload state and line 140 combines it with the old initial-readiness snapshot.

Consequently, consider an eligible layout-shift entry of value 0.2 after the initial snapshot, during an asynchronous save that resolves more than 500 ms after input. The first-document accumulator will contain 0.2, but its value is discarded at reload. With initial/reload scores below 0.1, the final budget assertion still passes. This is a static execution-path finding; it was not reproduced by launching a test server, as that was outside this review assignment.

The smaller fix is to take the first-document snapshot after the saved heading is visible and rendering callbacks have drained, immediately before reload. Use that document score in the final maximum and retain the existing reload sample. There is no need for a cross-document telemetry service, injected test API, or new generic observer abstraction. The original `.audit/performance-baseline.spec.ts` already takes its first `cls` reading after saving, making the current gate's earlier observation boundary an unintended regression from the baseline harness. Verify the revised browser flow and, if practical, demonstrate an eligible injected post-readiness shift is observed.

## Structural assessment

The CLI is one small executable with an explicit budget object, deterministic sorted inventory, a local-reference boundary check, category totals, and a JSON report. Its recursive file traversal earns its keep by counting future nested assets; the reference validator earns its keep by failing an absent asset or external budget escape. Category accumulation includes unclassified files in the overall totals. A new bundler-analysis dependency or exported configuration framework would add more concepts without improving this small fixed gate.

The CLI tests invoke the actual executable against disposable directories. They demonstrate a positive build, an over-budget JavaScript payload, a missing referenced asset, and an absent build. They avoid mocking Node filesystem/compression behavior. Random incompressible bytes are comfortably beyond the threshold; this is not a machine-speed comparison. Although the controlled suite does not enumerate every future file-category policy, no structural test-design blocker was found.

The browser spec counts requests/errors, requires a loaded optimized JavaScript asset, checks GET 200 and POST 201, and verifies persisted name, all three level values, and Monday. These checks show actual work, not just page readiness. Durations are emitted as diagnostics without timing assertions. The test remains a direct user flow rather than introducing a new page-object/helper layer solely for one scenario. Two font/render waits and two GET predicates are small local repetition; extracting them would not materially reduce the concepts a reader must track.

The shared fixture now has a production build output and Vite preview server. BrowserHost adds one dedicated account and writes the same ephemeral token JSON for development and optimized fixture entries. Ordinary middleware and existing ephemeral database ownership remain intact. The conditional directory write preserves the existing development command. There is no application visual or release-source change. All tracked semantic changes are confined to Check, test/check infrastructure, and documentation.

The Check workflow removes only its main-target restriction, retaining one job and one canonical `bun run check` entry point for all PR targets. It retains cancellation, caches, a 15-minute job timeout, and explicit three-day failure artifact paths. Fixture directories and token JSON are excluded from those paths. Traces are disabled and metric reports contain counts rather than request headers or response bodies.

## Baseline and documentation

The saved production inventory contains seven assets totaling 313,242 gzip bytes: JavaScript 148,847, CSS 26,734, fonts 137,661. These match the documentation and current built-asset report. The smaller optimized fixture totals 304,586 bytes. Using the actual application's larger inventory for the byte ceilings correctly includes Clerk's client bundle rather than claiming the fixture represents sign-in.

All five baseline reports contain 15 requests, one optimized script path, empty runtime-error/failure arrays, and the same successful load/save/reload harness. Their rounded duration medians are 159 ms readiness, 277 ms save, and 72 ms reload. The rounded ranges are 156-1,912 ms, 267-595 ms, and 64-101 ms. The largest reported CLS is approximately 0.002025. These values support the docs. They support no comparative speed claim or live-provider claim, and the docs make neither. Initial cache state, shared API/database processes, host/runtime differences, active-machine load, no throttling, font-wait differences, and absent Clerk/email behavior are stated.

Byte ceilings are fixed in the CLI, browser ceilings in the scenario, and their values are stated in one short docs table. No automatic ratchet adjusts them to the observed build. A central policy subsystem would add indirection for two consumers with different measurements. The docs require a refreshed inventory and user-benefit explanation for budget changes. No material documentation uncertainty was found apart from the first-document observation gap described above.

## Verification provenance

`.audit/performance-red.log` shows the over-budget JavaScript test fail because no rejection occurred before enforcement. `.audit/performance-full-check.log` then shows four CLI tests, twelve browser tests, and fifty-one backend tests passing, with successful frontend type/build, lint, formatting, restore, and .NET build checks. The log reports zero .NET build warnings/errors. The current browser JSON reports 15 requests, zero runtime errors/failed requests/non-success responses, one optimized script, and CLS approximately 0.002025.

Those are author-run artifacts. This reviewer did not independently rerun tests and does not treat the green suite as disproving the sampling-gap finding. After its repair, the affected browser test should be rerun and source context refreshed. No additional broad suite is requested solely for a review report.
