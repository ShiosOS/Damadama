# Post-fix performance CI maintainability evidence

## Reviewed source

The review was performed on October 14, 2026 against the uncommitted frozen layer in `C:\Users\emofo\.codex\worktrees\ci-browser-quality\Damadama Rewrite`. `git rev-parse HEAD` returned application PR 11 base `9c8437e1e4a46965513b53f60d7fa569c0fd18ea`. The entire diff against that base and the four untracked additions were reviewed. Many other paths still have line-ending-only working-tree status; `git diff --name-only` contains only the seven tracked paths below. The source hashes identify the actual reviewed layer because HEAD does not include the changes.

| Reviewed path                         | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `scripts/performance-budget.mjs`      | `701832C84B2033A5E023F073B3803CCBD93693B385ED9AF1764064578393AF9C` |
| `scripts/performance-budget.test.mjs` | `3B7E17CB388CE914B23C8C8636E859B5431B5D790F3232BCF68F6D3A40695AFD` |
| `tests/Browser/performance.spec.ts`   | `0F0E2E8FD05EB7172F78462BC81257D32C7459F1B2D9BC580CDF6D2BF9032C72` |
| `docs/browser-performance.md`         | `FDEB59456DAC6150FE94963A40F98A5E1A928C4B64F37FE4B086E5A9AD94E448` |
| `.github/workflows/check.yml`         | `A7FFF4DF741BD21E0EDCAEEDEBCDF469681B442A5BB9C5AD5CFB53631CE65757` |
| `README.md`                           | `020425D1D552F48D1028063D47CB4A67E73679B25FCDB12A98BAC500E2125791` |
| `package.json`                        | `D0804FDD86C1E8CF76DF87561A5AAA6C6C83AF35F3414E60E2BA245413716F41` |
| `scripts/check.ts`                    | `55F3E26A6BF104CE6CD4C5E9ED2B86F7836F1EFEFC72948DF0966CFE9C069807` |
| `tests/Browser/playwright.config.ts`  | `0364F4C848E768FB9256B696B250364145AB4550F5C733C541E8BE86E364D502` |
| `tests/Browser/vite.config.ts`        | `DA68F959949F9B863866BE3B29A0C9144E5BE8C08E1B89BECA3838BE0AE7B9EE` |
| `tests/BrowserHost/Program.cs`        | `C3ED3129121C36667B6DDB4CDDDE1D69E0066BD17817205AA28598C2D76B245F` |

Inspection commands were read-only: `git status --short`, `git rev-parse HEAD`, `git diff --stat`, `git diff --name-only`, the full tracked diff, `Get-Content` of new source/docs and approved evidence, `rg -n` for fix locations and installed browser metadata, and `Get-FileHash` for source/control identity. Repository AGENTS was read. The previous review summary was read, and audit evidence reads were confined to `performance-fix-*`. The seven unchanged tracked hashes match the prior review exactly.

## Resolution: document-lifetime CLS

The browser initializer still owns the complete session-window accumulator for each document. The corrected scenario samples the first document after the POST 201, visible saved heading, fonts, and two animation frames. Sampling occurs at line 120 before reload at line 122. The reload accumulator is read at line 137, and line 147 combines the two complete observed document scores. The corresponding support assertion uses both documents. This directly removes the earlier snapshot gap without changing the observer policy or budget.

The preserved `.audit/performance-fix-cls-control.mjs` inserts a 600-pixel top-padding change after initial readiness and before opening the panel. It waits for two frames and records the actual `window.qualityLayout`; it does not overwrite the metric. Its observed-before and observed-after JSON both contain CLS `0.3031966923236847`. The before metric JSON contains only `0.0020248173236846923`, and its log has one passing browser test. The after metric JSON contains `0.3031966923236847`, and its log fails exactly at the `<= 0.1` budget assertion. The clean green report returns to `0.0020248173236846923`, 15 requests, and zero failures. Current source contains no injected padding or control attachment.

The control script is a review artifact, outside the source diff. It supports deliberate `inject` and `remove` modes with explicit anchor/presence checks and preserves a concrete way to reproduce the evidence. It is not a new permanent test-infrastructure subsystem. A generic telemetry module or browser metric service would be larger and less direct than the repaired sampling sequence.

## Resolution: reference outside the inventoried asset tree

The CLI's existing reference boundary continues to reject external origins, decoded paths escaping the production build, and missing files. It now also checks that an existing local linked file is below the same `assets` directory the inventory traverses. This is one guard in the canonical reference validator; it is not scattered among callers. Inline data URLs retain their explicit exemption, and their containing CSS bytes remain inventoried.

The persistent CLI test creates an actual 400,000-byte incompressible font at the build root and references it from `assets/app.css` through `../oversized.woff2`. Before enforcement, `.audit/performance-fix-cli-red.log` records missing expected rejection. After enforcement, `.audit/performance-fix-cli-green.log` records all five CLI tests passing.

The separate root-font control reports `400143` gzip bytes for the linked font. Its before log has exit code 0 and claims only 108 inventoried gzip bytes; its after log has exit code 1 and the error `Referenced asset oversized.woff2 is outside the inventoried assets directory.` The reference-controls log additionally confirms external, decoded escaping, and missing links exit 1 with their specific errors, while inline data inside CSS exits 0. These checks operate on the real CLI/filesystem rather than mocked parsing or compression.

No budget changed: JavaScript remains 170,000 gzip bytes, CSS 32,000, fonts 150,000, total 360,000, and asset count 10. Browser request/CLS limits remain 20 and 0.1. The clean application report still inventories seven assets totaling 313,242 gzip bytes, with the same JavaScript/CSS/font totals as the original baseline.

## Full-layer structural judgment and docs

The original direct implementation remains intact. The asset inventory and browser flow have separate purposes and measurements, so neither benefits from an additional shared policy wrapper. The CLI's category object and fixed budgets are readable local data; the browser scenario's document accumulator and request/error counters are a sufficient explicit state model. No new dependency, exported API, cast-heavy boundary, identity wrapper, generic mode, or feature leak was introduced by the repairs.

The optimized fixture uses the already existing Vue page, API host, ephemeral JWT middleware setup, and Testcontainers PostgreSQL lifecycle. Building before preview is a dependency, so that sequencing is necessary. The browser scenario is sequential because save/reload depends on prior work. Keeping it direct exposes the observation boundaries a reviewer needs to inspect. The small repeated font/frame waits are visible at the exact document checkpoints and do not justify a new framework. No file approaches the 1,000-line threshold.

Check remains one workflow over all PR targets and one `bun run check` command, with existing dependency/Chromium caches and superseded-run cancellation. Failure artifact paths remain explicit and exclude the token JSON/optimized fixture directory. Traces remain off. Release workflows and application visuals/behavior have no substantive diff. The updated documentation explains the new inventory constraint and complete observed first-document CLS score while retaining the distinction between production asset bytes and fixture-browser behavior.

The installed `node_modules/@playwright/test/package.json:3` reports version `1.64.0`; `node_modules/playwright-core/browsers.json:5-8` reports Chromium revision `1248`, browser version `156.0.8078.4`. This supports the clarified documentation terminology. No live-provider behavior or comparable timing improvement is claimed. No material docs ambiguity remains from the two repaired gaps.

## Verification provenance and evidence identity

The reviewed `.audit/performance-fix-check.log` has successful restore/build/type/lint/format steps, five passing CLI tests, twelve passing browser tests, and fifty-one passing backend tests. The browser suite includes the ordinary habit/user-account refusal flows as well as the performance scenario. The current clean report used in the re-review is `.audit/performance-fix-cls-green.json`, which records one optimized script, 15 requests, zero runtime errors, zero failed requests, zero non-success responses, and approximately 0.002025 CLS. A full-check exit of zero was reported by the author; the log's final backend summary contains no failures.

| Evidence                                       | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `.audit/performance-fix-check.log`             | `C9AE734CAFD2779C3F6F86CAE8A398DF32FB2B3932104F8BCB61A03B1A5FB1F4` |
| `.audit/performance-fix-cls-control.mjs`       | `C9B9BD723AEA34ED62FE91A18F7BCC8ACD8A041E8742BE17A443C88BA1AD67D5` |
| `.audit/performance-fix-reference-control.mjs` | `29615AE866FD55FE4704E5AA42FF89E2E3ECAB4EE2300588ADA313589FA29B56` |
| `.audit/performance-fix-root-font-control.mjs` | `520192D2945D4E9CA7BAB4B14009C1741795EB9E489436015FC00123530F4A41` |

This reviewer did not run those controls, tests, servers, or measurement scripts. The findings are closed by independently inspecting the final source plus specific failing/passing author-run artifacts, rather than by assuming the full green suite covers them. The prior review remains unchanged. Only this report and its summary were written, and no credential, vault, encrypted recovery identity, or fixture-token file was read. No further refactor or verification is required by this maintainability review.
