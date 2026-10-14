# Performance CI post-fix correctness and security review

Verdict: clean. No remaining material correctness or security finding in the frozen eleven-file performance CI layer. Both P2 findings from `performance-security-review.md` are resolved. The earlier report is preserved.

## Reviewed source

Independent post-fix review on October 14, 2026, in `C:/Users/emofo/.codex/worktrees/ci-browser-quality/Damadama Rewrite`. HEAD and comparison base remain `9c8437e1e4a46965513b53f60d7fa569c0fd18ea`, the application PR 11 head. The work is still uncommitted and there is no draft PR or discussion to inspect. Scope: seven tracked modified files plus four untracked performance files. The reviewer authored neither fix.

Read the prior report, the complete current modified scope, repository `AGENTS.md`, and the permitted performance control/check evidence. Review used pstack thermo-nuclear correctness/security, TypeScript/type-system, and benchmark-checklist requirements. No application code was written, no server or suite was started, no agent was spawned, and no credential/vault/recovery identity was read.

SHA-256 snapshot:

| File                                | SHA-256                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| .github/workflows/check.yml         | A7FFF4DF741BD21E0EDCAEEDEBCDF469681B442A5BB9C5AD5CFB53631CE65757 |
| README.md                           | 020425D1D552F48D1028063D47CB4A67E73679B25FCDB12A98BAC500E2125791 |
| package.json                        | D0804FDD86C1E8CF76DF87561A5AAA6C6C83AF35F3414E60E2BA245413716F41 |
| scripts/check.ts                    | 55F3E26A6BF104CE6CD4C5E9ED2B86F7836F1EFEFC72948DF0966CFE9C069807 |
| tests/Browser/playwright.config.ts  | 0364F4C848E768FB9256B696B250364145AB4550F5C733C541E8BE86E364D502 |
| tests/Browser/vite.config.ts        | DA68F959949F9B863866BE3B29A0C9144E5BE8C08E1B89BECA3838BE0AE7B9EE |
| tests/BrowserHost/Program.cs        | C3ED3129121C36667B6DDB4CDDDE1D69E0066BD17817205AA28598C2D76B245F |
| scripts/performance-budget.mjs      | 701832C84B2033A5E023F073B3803CCBD93693B385ED9AF1764064578393AF9C |
| scripts/performance-budget.test.mjs | 3B7E17CB388CE914B23C8C8636E859B5431B5D790F3232BCF68F6D3A40695AFD |
| tests/Browser/performance.spec.ts   | 0F0E2E8FD05EB7172F78462BC81257D32C7459F1B2D9BC580CDF6D2BF9032C72 |
| docs/browser-performance.md         | FDEB59456DAC6150FE94963A40F98A5E1A928C4B64F37FE4B086E5A9AD94E448 |

The three changed code hashes and documentation hash were rechecked after reading controls and remained unchanged.

## Closure of earlier findings

**Root assets:** `scripts/performance-budget.mjs:45-48` rejects local references outside the directory that byte/category/count accounting inventories. Both HTML references and CSS URL references go through this function. Existing data URLs remain permitted. The committed new CLI control creates a real, oversized root font and a relative CSS reference, then requires the exact rejection and exit code 1.

Inspected `performance-fix-cli-red.log` (missing expected rejection before the fix), `performance-fix-cli-green.log` (all five controls pass), the reproducible root-font control, and its before/after logs. The real font has 400,143 gzip bytes. Before the fix the checker exited 0 and counted only 108 gzip bytes; after the fix it exits 1 with the inventoried-directory refusal. Additional permitted reference controls show rejection of external, escaping, and missing references, with inline data accepted.

**First-document CLS:** `tests/Browser/performance.spec.ts:113-120` waits for fonts and two animation frames after save, then serializes the full first-document score before reload. Line 147 includes that score in the maximum with the settled reload score. Observer support is asserted for both documents. No earlier snapshot replaces the first document's accumulated score.

Inspected the reproducible DOM-mutation control, observed scores, and before/after test evidence. A real 600-pixel body-padding mutation after initial readiness produced observer CLS 0.3031966923236847. Before the fix the report still contained 0.0020248173236846923 and the gate passed. After the fix the gate fails with expected <= 0.1 and received 0.3031966923236847. The mutation and its reporting code are absent from the current source. This evidence tests actual browser layout behavior rather than assigning a synthetic score.

## Full-check and boundary assessment

The completed fresh check evidence is `.audit/performance-fix-check.log` (the parent initially named `performance-fix-full-check.log`, which is absent). Its output includes build/format/lint/type checks, five passing CLI controls, twelve passing browser tests, and fifty-one passing backend tests. The parent reports the command completed with exit 0. These are inspected supplied results; this reviewer did not rerun the suite.

Current reports show 313,242 gzip bytes across seven production assets, CLS 0.0020248173236846923, fifteen browser requests, one optimized script, and zero runtime errors, failed requests, or non-success responses. Load/save/reload assertions require GET 200, POST 201, visible saved name, and persisted level/day values. The measured work is nonvacuous.

The test host still uses the actual API and ephemeral PostgreSQL, with RSA-signed fixture JWTs validated by the ordinary JWT middleware. No authentication bypass or provider secret is added. Reports serialize counts, paths, revision, viewport, and diagnostic durations rather than tokens, headers, bodies, or error messages. Traces remain disabled; artifact paths exclude both `fixture.json` and the fixture build containing it.

Check runs on every PR target branch with read-only contents permission, cached dependencies/Chromium, superseded-run cancellation, a fifteen-minute timeout, and three-day failure-report retention. Only `check.yml` has a semantic workflow diff. Release workflows are unchanged. No new dependency or external service is introduced.

Budgets are fixed and reviewable, with production-entry asset evidence. Elapsed timings remain diagnostic; documented fixture/provider and host/cache limits avoid a live Clerk or production-latency claim. Source revisions in local reports still name the common HEAD while the layer is uncommitted; the hashes above pin the actual reviewed layer. Remote PR CI remains to be observed after draft creation.
