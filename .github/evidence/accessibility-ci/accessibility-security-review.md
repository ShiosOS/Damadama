# Accessibility correctness and security review

Date: 2026-10-15 (America/New_York)
Verdict: No material correctness or security findings in the reviewed accessibility change.

## Scope and source

Read-only independent `pstack:thermo-nuclear-review` against parent `22a5a89a2e4293665eed6334a668da441e58c623` on `codex/accessibility-ci`, including the two untracked accessibility files. The seven tracked semantic changes and two additions are listed below. Other tracked status entries are line-ending-only; they do not appear in the semantic diff. No application source, test, server, suite, branch, workflow, or setting was changed by this reviewer.

Git canonical blob IDs reviewed:

| File                                | Blob                                     |
| ----------------------------------- | ---------------------------------------- |
| .github/workflows/check.yml         | fe31367696a2eae701f6c90101accfc958f41a4b |
| README.md                           | 1549a5fb819a9d70e0d8dbb4792c02cbb6548e19 |
| bun.lock                            | 2d9d566e46a7c09f7602f3658f4962b37b493f18 |
| package.json                        | b04326d373afaa25970572906dc9bfb2c49380bf |
| tests/BrowserHost/Program.cs        | c3561662f4bab661df0ec283e56c06b077d96c32 |
| web/src/HabitsPage.vue              | 31a1a09a79416a3bf8210b4f4aa8a0fa874fe705 |
| web/src/style.css                   | 6758e6a4138830c578314fd0ebf4d76aadcef3eb |
| tests/Browser/accessibility.spec.ts | b6105f9d34aeb01c134ab636a75a04207999ced8 |
| docs/browser-accessibility.md       | 7ead496de20432d99566e627c238ec397f2c322f |

## Audit evidence

- The axe wrapper derives report types from the engine, scans the whole page with the stated WCAG tags, retains violation IDs, selectors and summaries, and asserts that at least one rule passed. An actual unnamed DOM button must produce exactly `button-name` at its own selector. The control invokes the same empty-violations assertion and verifies that it throws; removing the button must restore a passing scan. This prevents an inert or reversed gate.
- The actual optimized application entry fetches the real configuration endpoint and checks its 200 response, loaded asset scripts, visible application heading and setup messages, absence of habit calls, and absence of page exceptions. The only intercepted field is the public publishable key, set to null. There is no fabricated Clerk session or production authentication bypass.
- The fixture mounts the actual HabitsPage. Added subjects are isolated from existing tests. Requests run through the existing ordinary JWT middleware with ephemeral RSA tokens and the existing temporary PostgreSQL host. The tests prove actual 400 refusal, 201 creation, 200 reload persistence, and expired-token 401 work rather than accepting screenshots of a synthetic result.
- Keyboard navigation checks each relevant control with actual Tab, Shift+Tab, Enter and Space, including initial focus, the reverse wrap, Escape return, the refusal alert, all retry controls, and successful return. There is no programmatic focus or click shortcut in the keyboard refusal/retry flow.
- The production focus fix checks account generation before showing an error and again after Vue flushes the rendered alert. It also checks that the panel is open. An obsolete account response cannot focus the new account's page. The 401 path closes the panel, so the removed alert is not focused. Existing stale-success/account-cleanup paths remain unchanged and still run in the full browser suite.
- The two shared semantic color overrides have narrow scope and are exercised against actual configuration, expired-session, and refusal alerts. Before reports contain real color-contrast violations; current reports have no violations. No broader styling, routing, release workflow, external setting, API authentication, or deployment behavior changed.
- Report construction omits response/request bodies, headers, tokens, raw DOM HTML, and the axe browser-environment payload. Videos and screenshots contain fixed fixture form values, not credentials. Tracing remains off. The workflow adds only accessibility report paths to existing failure artifacts; caching, superseded-run cancellation, the 15-minute job bound and three-day retention remain inherited and unchanged.
- The saved reports distinguish incomplete rules from violations. Current dialog states retain `aria-hidden-focus` incomplete results; explicit keyboard assertions provide separate containment evidence. These reports do not assert full WCAG compliance. Provider sign-in, screen-reader speech, native zoom and assistive technology remain documented manual checks.

## Validation observed

Read `.audit/accessibility-red.log`: the initial deliberate unnamed button failed with expected empty violations versus actual `button-name`.
Read `.audit/accessibility-focus-debug.log` and `.json`: before the production fix, focus remained BODY before and after axe, then left the document after the next Tab; the dialog focus-count assertion failed. The Docker startup failure in the separate focus-target attempt is not regression proof and was not counted.
Read the actual before contrast reports and current sanitized reports: current positive states have zero violations and 16-23 passed rules; incomplete dialog checks are retained explicitly.
Read `.audit/accessibility-full-check.log`: all 18 browser tests passed, including all six accessibility cases, inherited account isolation and stale acknowledgement behavior, and the inherited performance scenario. The five CLI checks and production-asset check also passed. The backend result is 51 passed, zero failed. The root agent confirmed the required full command exited 0; this reviewer independently read the completed log.

## Limits

No accessibility draft PR existed during this independent audit, and no material issue required a subsequent PR discussion review. This is a review of the frozen source blobs above, not a claim that live Clerk behavior or unrun manual assistive-technology checks were verified. Reports produced before committing naturally record the parent HEAD; final CI evidence should identify the committed review source.
