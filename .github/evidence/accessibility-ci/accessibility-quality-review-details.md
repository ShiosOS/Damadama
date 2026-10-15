# Accessibility maintainability review details

## Scope and method

The baseline was `22a5a89a2e4293665eed6334a668da441e58c623`, and HEAD remained at that parent while the accessibility patch was uncommitted. `git diff` against that parent showed seven tracked files: two lines in Check, one README line, five lockfile lines, one package dependency, five fixture identity lines, seven additions and one deletion in HabitsPage, and two CSS lines. The new accessibility spec and its documentation were reviewed in full as the other two files. Unrelated files shown as modified by status had no normalized content diff against this parent and were outside this review.

I read `AGENTS.md`; the quality-review skill; the TypeScript skill and its type-system principle; the complete nine-file change; the actual page, fixture entry, Vite/Playwright configuration, check runner, application entry, existing browser checks, and relevant installed axe result-aggregation code. Source and tests were left untouched. No servers or suites were started. No credentials, vault files, recovery identities, or unrelated audit files were read.

Commands used were read-only `git diff`, `git rev-parse`, `git branch --show-current`, `Get-Content`, `rg`, scoped `Get-ChildItem`, `Measure-Object`, and `Get-FileHash`. Only this report and its summary were written. The summary carries the exact SHA-256 snapshot.

## Scanner, types, and control

`tests/Browser/accessibility.spec.ts:6-17` derives its projected result shape from `AxeBuilder.analyze`. The application does not depend on this testing type. It retains the fields actually needed for diagnosis while omitting bulky DOM, browser, and network payloads. There are no casts, optional configuration bags, rule waivers, exclusion selectors, or new schema framework.

`tests/Browser/accessibility.spec.ts:21-74` has one private scanner. It waits for fonts, finite animations, and two frames, runs the configured WCAG tags, projects reports, attaches evidence, and asserts that rules actually ran. The helper owns all repeated reporting work; its page/state/test-info inputs are concrete. Extracting serialization and screenshot layers would add navigation overhead without deleting a second implementation.

`tests/Browser/accessibility.spec.ts:76-102` uses one assertion in both actual page states and the missing-name negative control. This small wrapper is justified: the control proves the same gate rejects an actual browser-discovered violation and that removing the defective DOM restores a pass. It does not merely feed a fabricated result into a separate checker.

## Browser behavior and coupling

`tests/Browser/accessibility.spec.ts:105-139` exercises the optimized application entry through the real API host. Replacing only the public config key after `route.fetch` is a narrow boundary fixture, not a fake Clerk context. Endpoint status, loaded script requests, absence of habit requests, rendered configuration text, and page errors are explicit observations. Provider behavior is not inferred from this test.

`tests/Browser/accessibility.spec.ts:142-166` and `tests/BrowserHost/Program.cs:18-22` reuse the existing ordinary JWT/API/database fixture and add isolated subjects. They do not introduce application branches or an alternative authentication mechanism. The stale, expired, and signed-out concepts remain distinct.

`tests/Browser/accessibility.spec.ts:169-333` is the largest body. Its explicit focus expectations are useful review evidence, not incidental duplication. It tests opening, reverse containment, cancellation, reopening, complete keyboard entry, actual API refusal, focused error, forward control traversal, keyboard correction, real save, return focus, and reload persistence. The repeated weekday labels are a single local list. Pulling field entry from the existing click-oriented habit helper would weaken the keyboard-only requirement. A generic focus-walking abstraction would obscure which controls and boundaries are asserted.

`tests/Browser/accessibility.spec.ts:336-401` shares one body for two real layout cases. These are fixed input scenarios with readable values, not runtime feature modes. They check viewport overflow and save visibility as well as scans and actual saving. The test does not claim that CSS zoom establishes native-browser zoom or screen-reader interoperability.

Some behavioral overlap with existing habit specs is warranted because scans must run after the actual relevant states exist. The new journeys add scan enforcement and keyboard-only recovery; deleting their state setup in favor of broad shared fixture builders would move complexity out of view rather than remove it.

## UI policy and lifetime

`web/src/HabitsPage.vue:109-114` handles focus in the existing request owner. The early generation check prevents an old account's failure from changing current state. `showError` renders the error; `nextTick` lets the alert exist; the second generation check and `adding` guard prevent stale or closed-panel focus. The target in `web/src/HabitsPage.vue:172-180` is explicit and programmatically focusable. This follows the component's existing ID-based initial focus and saved-row behavior. It requires no new state-machine layer or reusable focus service.

The added conditions guard an asynchronous render boundary that already exists; they are not scattered special cases. `showError` still handles 401 by closing creation, so that branch does not attempt to focus an absent alert. The existing disabled/dismissible saving behavior remains intact.

The pre-fix `.audit/accessibility-focus-debug.json` records BODY before and after the refusal and a subsequent Tab leaving document focus, with zero focus moves. The final browser log records the strict alert-focus and traversal test passing. I did not use `.audit/accessibility-focus-target-red.log` as test evidence because its reported failure was infrastructure-related.

`web/src/style.css:13-14` changes semantic warning and error tokens in their canonical block. The allowed before reports show actual white-text contrast failures on the existing alerts. The fix avoids per-test CSS and alert-specific overrides. Current scans report no violations. `HabitsPage.vue` is 285 lines and the CSS file 213; neither crosses the skill's file-size threshold. The lockfile remains 968 lines and is generated dependency data.

## Reports, recordings, and documentation

The Check diff only adds accessibility report paths to its existing failure artifact. Dependency caches, superseded-run cancellation, three-day retention, and the existing check command are preserved. No deployment or release controls change.

`test.use` scopes `video: on` to six accessibility tests. I inventoried 20 generated WebM files: six flow recordings and 14 additional files of 1,410 bytes each, 1,117,851 bytes in total. The installed axe package's `node_modules/@axe-core/playwright/dist/index.mjs:313-334` creates and closes a blank page for `axe.finishRun`, which explains those extra tiny recordings. The evidence volume is modest and the mechanism is the existing Playwright recorder. Avoid adding another recording mode merely to suppress these files.

`docs/browser-accessibility.md:10-26` accurately names production configuration versus local fixture coverage, observed API statuses, viewport dimensions, and CSS zoom. Lines 30-35 match report projection and recording/retention configuration. The exact local scan revision names the parent while changes are uncommitted; therefore these review hashes and root's source-context notes remain necessary for local evidence. CI reports will identify the checked-out commit.

Lines 54-62 make incomplete-rule, provider, screen-reader, and native-zoom limits explicit. The actual creation-panel and validation-refusal JSON reports contain `aria-hidden-focus` as incomplete with one node and no violations. The assertions and documentation do not reclassify that result as a completed axe pass or promise full compliance. Manual review remains required.

A scoped search found no suppression directives, TODO/FIXME/HACK comments, disabled rules, exclusions, `.skip`, or `.only` in the reviewed additions. The parent is also running its separate no-comments pass.

## Verification observed and conclusion

The root-owned `.audit/accessibility-full-check.log` records all six accessibility tests passing, all 18 browser tests passing, then 51 backend tests passing with zero failures and zero skips. I did not rerun those commands or infer live Clerk behavior from the fixtures.

No high-conviction material maintainability findings were identified. No source changes are requested by this review.
