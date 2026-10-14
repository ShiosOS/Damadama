# Performance CI correctness and security review

Verdict: changes requested. Two P2 correctness findings; no material security finding in the reviewed snapshot. This verdict must be replaced by an independent re-review after fixes before opening the draft PR.

## Source context

Reviewed October 14, 2026, in `C:/Users/emofo/.codex/worktrees/ci-browser-quality/Damadama Rewrite`. Git HEAD and comparison base were `9c8437e1e4a46965513b53f60d7fa569c0fd18ea` (application PR 11). Scope was the tracked performance CI diff plus untracked performance checker/tests/browser spec/docs. No PR existed, so no PR discussion was available to inspect.

Read repository `AGENTS.md` and pstack thermo-nuclear-review, TypeScript/type-system, and benchmark-checklist instructions. Review performed without writing application code, running servers, starting databases, spawning agents, reading credentials, or reading unrelated `.audit` files. Only permitted performance baseline/check evidence was inspected. The two additional controls ran entirely in memory and are dataflow/checker proofs, not browser measurements.

SHA-256 values pin the reviewed code snapshot (not subsequent author fixes):

| File                                | SHA-256                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| scripts/performance-budget.mjs      | 074F9BE06CD627AD5287FA039062B3639093360D1E2DDDCA09881E8393551D9F |
| scripts/performance-budget.test.mjs | 169B46A0001DFCCDA2313F464A2D97D21DFEC3A4713B9660C445101CFD792A6D |
| tests/Browser/performance.spec.ts   | 7ED3C1ED33E641A1EFFE7CF30B9F800AE9C99E6B65EEC4E7EE0B761415C553CD |
| scripts/check.ts                    | 55F3E26A6BF104CE6CD4C5E9ED2B86F7836F1EFEFC72948DF0966CFE9C069807 |
| tests/Browser/playwright.config.ts  | 0364F4C848E768FB9256B696B250364145AB4550F5C733C541E8BE86E364D502 |
| tests/Browser/vite.config.ts        | DA68F959949F9B863866BE3B29A0C9144E5BE8C08E1B89BECA3838BE0AE7B9EE |
| tests/BrowserHost/Program.cs        | C3ED3129121C36667B6DDB4CDDDE1D69E0066BD17817205AA28598C2D76B245F |
| .github/workflows/check.yml         | A7FFF4DF741BD21E0EDCAEEDEBCDF469681B442A5BB9C5AD5CFB53631CE65757 |
| docs/browser-performance.md         | 6E4983C856DAB5F7AE86CD9EA4121AFD82820735A4ABDF59E64320086AD13933 |

## Material findings

### P2: keep the first document's CLS through the save flow

`tests/Browser/performance.spec.ts:88,115,140`

`initialLayout` is serialized before opening the panel. The observer continues recording while the user creates and saves, but `page.reload()` destroys that document. The final maximum uses only the early snapshot and the reloaded document. A qualifying shift after initial readiness, including a save response occurring after the recent-input exclusion window, therefore cannot fail the 0.1 ceiling. The original baseline sampled the first document after save, so the committed guard also drops a baseline measurement boundary.

Evidence: an in-memory execution of the unchanged, TypeScript-transpiled test gave the first-document observer a CLS of 0.2 after initial readiness and before reload. The first document had 0.2 immediately before reload, the produced report contained CLS 0, and all current assertions passed. This demonstrates the loss of recorded state; it does not claim to simulate browser layout semantics.

Fix: settle rendering and snapshot the first-document observer immediately before reload, include that score in the maximum, and add a browser negative control for a qualifying shift after initial readiness.

### P2: reject references outside the inventoried assets directory

`scripts/performance-budget.mjs:34-44,56`

Reference validation accepts any regular file inside the production root, while byte/category/count accounting only walks `assets/`. A CSS-linked root font or other public-root asset can therefore be arbitrarily large while the checker passes. The current build has no such root asset, but the new guard fails to detect that ordinary asset-growth regression.

Evidence: executed the unchanged checker against an in-memory filesystem containing complete small application JavaScript and CSS plus a CSS-linked `/oversized.woff2`. The root font compressed to 400,143 bytes, exceeding both the 150,000 font ceiling and 360,000 total ceiling. The checker exited 0, reported only 116 gzip bytes and two assets, and recorded no violations. No filesystem files were created by this control.

Fix: reject local references outside the inventoried `assets/` directory (retaining the existing data-URL exception, whose CSS bytes are counted), or expand accounting to cover those references. Add a controlled oversized-root-reference rejection test.

## Other checks and evidence

- `.audit/performance-red.log` demonstrates the JavaScript negative control failing when the ceiling enforcement is absent. `.audit/performance-full-check.log` records the restored green run: four CLI controls, twelve browser tests, and fifty-one backend tests. Those supplied results are evidence inspected, not tests rerun by this reviewer.
- Production assets contain seven files and 313,242 gzip bytes; the inventory sums JavaScript 148,847, CSS 26,734, and fonts 137,661. Budgets have fixed headroom and use Node's default gzip rather than relying on Vite's displayed compression size.
- Five permitted baseline reports show fifteen requests, successful API responses, no recorded runtime/request failures, and real save/reload persistence. Timing variation is documented and durations remain diagnostic. No speed ratio or live Clerk/provider claim is made.
- The optimized browser fixture imports the actual habit page, proxies to the actual API, and uses ephemeral PostgreSQL and RSA-signed JWTs validated by ordinary JWT middleware. No authentication bypass was introduced.
- Reports contain counts, paths, source revision, viewport, and durations; they do not serialize headers, response bodies, tokens, or exception text. Traces are disabled. Artifact upload paths exclude `fixture.json` and `.audit/browser-build`, including its token fixture. Screenshots contain the fixture UI.
- Check now covers every PR target branch, retains read-only contents permission, dependency/Chromium caching, cancellation of superseded runs, a fifteen-minute limit, and three-day failure reports. Only `check.yml` has a semantic workflow diff; release workflow changes were not introduced.
- Browser requests and runtime failures are counted across navigation, save, and reload. The test asserts API GET 200 / POST 201, actual saved name/levels/day after reload, observer support, and JavaScript asset loading, so successful measurements are nonvacuous.

Residual limits: this is a local fixture guard, not a live provider or production-load benchmark. Remote CI has not yet run for a draft PR. Post-fix full-check evidence and updated source hashes must accompany the re-review.
