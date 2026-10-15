# Accessibility refresh correctness and security review

Date: 2026-10-15, America/New_York.
Verdict: PASS. No material correctness or security finding in the refreshed accessibility source. Final full-check and remote CI results are separate verification facts.

## Revision and independence

Reviewed `codex/accessibility-ci` at `48881246c132be4988d89b26ed91dffa3d000a79` against published performance parent `763c23bc89e4b102e85e894d2945f6ab6ed58cbc`. The exact merge parents are old accessibility head `07c792789d7029d21063192ae40d73f5a9633a18` and that published performance parent. The stack inherits application boundary `859ffa5ec2da426e7024f0dcce67ba02e6165c3d` and main boundary `5eb0bf5ec0b1eb5d25b04131cf4654e5128ee27c`.

The root resumed this finished independent reviewer under poteto-mode's documented capacity exception after fresh dispatch hit the runtime agent limit. This reviewer did not author these changes. The review read the current parent diff, merge integration, Check workflow, application selector, repository instructions, prior pinned review and preserved accessibility evidence index. No source, branch, PR, setting, suite or server was modified or started. No credential, vault, recovery identity or fixture-token file was read. Only this report was written.

## Canonical source identity

| File                                | Git blob at reviewed head                |
| ----------------------------------- | ---------------------------------------- |
| .github/workflows/check.yml         | 6b4ebffdce430733e1366a69c44acce862061fe2 |
| README.md                           | f955846280c4476e84ff12e0691b856ed186e361 |
| bun.lock                            | 2d9d566e46a7c09f7602f3658f4962b37b493f18 |
| package.json                        | b04326d373afaa25970572906dc9bfb2c49380bf |
| tests/BrowserHost/Program.cs        | c3561662f4bab661df0ec283e56c06b077d96c32 |
| web/src/HabitsPage.vue              | 31a1a09a79416a3bf8210b4f4aa8a0fa874fe705 |
| web/src/style.css                   | 6758e6a4138830c578314fd0ebf4d76aadcef3eb |
| tests/Browser/accessibility.spec.ts | b6105f9d34aeb01c134ab636a75a04207999ced8 |
| docs/browser-accessibility.md       | 7ead496de20432d99566e627c238ec397f2c322f |
| release/application.mjs             | 82110832422e5d1752547e1d9a5bdc1da4dd3242 |
| tests/Browser/playwright.config.ts  | 836a7ecba1145ec378b426e6f00113096d94696e |

The seven accessibility executable, dependency and documentation blobs match the original nine-file pinned security review. Check and README carry the inherited parent refresh. A read-only canonical working-tree comparison returned 0 after the root's local line-ending normalization.

The release tree `f1feeb5d799b598b989318a34f9bca1dd21eaed0` and server tree `f623bb52f5d6dade26fff7287bf9bddb676cb65d` match the published performance parent exactly. Authentication entry and client files `web/src/main.ts`, `web/src/SignedInApp.vue` and `web/src/habits.ts`, all scripts, and all other workflows also match that parent.

The web tree `165e0ec330de21c62c000ed217d098d2f817be9b` and tests tree `8404f7fed058ebf0da2054375a63dd6c7a251f44` match old accessibility head `07c7927` exactly. The entire `.github/evidence/accessibility-ci` tree remains `a0b7e02478af51359f02bed2dc1756dd1f18b69a`, identical to that old accessibility head. Existing red controls, before/after reports, source-pinned reviews, screenshots and keyboard recording remain intact with their original source context.

## Integration assessment

- Relative to the performance parent, the sole workflow difference adds `.audit/accessibility-*.json` and `.audit/accessibility-*.png` to existing failed-report artifacts. It does not alter the all-target PR trigger, read-only permissions, application/setup conditions, dependency/browser caches, superseded-run cancellation, fifteen-minute bound or three-day retention. The globs select the scanner's sanitized reports and screenshots. They do not include the token fixture or optimized fixture directory.
- The inherited selector runs before application checks using full Git history and a resolved immutable commit. The reviewer invoked the existing selector read-only for exact head `48881246c132be4988d89b26ed91dffa3d000a79` and observed `application`. The accessibility layer therefore runs its ordinary full check and does not pass through the setup exception.
- The ordinary browser suite still discovers the accessibility spec through `*.spec.ts`. The inherited check sequence still builds the actual application and optimized fixture before starting the existing API/PostgreSQL hosts. The dependency remains exactly pinned at axe Playwright 4.13.0 with axe-core 4.13.0 in the lockfile. No extra service, credential, production secret or application authentication bypass is added.
- The unchanged scanner scans the whole page, retains incomplete results, requires nonzero passed rules, and rejects any detected WCAG violation. Its unnamed-button control exercises the same assertion and proves both refusal and repaired acceptance. The unchanged report construction omits raw DOM markup, tokens, headers and bodies. Playwright tracing remains off.
- The unchanged application-entry case observes the real configuration endpoint and optimized application assets, replacing only the public publishable key with null. It does not fabricate a Clerk identity. The isolated actual-component fixture still asserts real 400 refusal, 201 creation, 200 reload persistence and expired-token 401 through normal JWT middleware and temporary PostgreSQL.
- The unchanged keyboard test requires alert focus after refusal and then reaches each retry control with keyboard events. The production catch checks account generation before displaying the error and again after nextTick, then checks the panel remains open before focusing its alert. Obsolete account responses cannot move focus. The 401 path closes the panel and cannot focus its removed alert. The two semantic color overrides retain the same narrow warning/error scope reviewed previously.
- The exact merge introduces no release-code or release-workflow change, no authentication-policy change, no setting mutation and no merge or queue action. The existing drafts remain subject to their parent dependency order. This report is not authorization to arm or merge either PR.

## Verification and limits

The original `.github/evidence/accessibility-ci/accessibility-security-review.md` pins the reviewed focus, contrast, fixture and scanner source. Its genuine red evidence and original passing full check retain their original revision context. They have not been rerun or relabeled as fresh measurements by this reviewer. The Docker-only failed attempt remains explicitly excluded from regression proof. The preserved media documents the same unchanged executable accessibility content.

At the latest report update, `.audit/accessibility-refresh-check.log` had passed build, format, all five performance CLI controls and all eighteen browser tests. Backend tests were running. No terminal full-check success or remote CI result is inferred here. The root owns the final full-check exit and fresh GitHub checks. The locally normalized checkout had zero canonical diff when independently inspected.

Automated axe results are not a full WCAG-compliance claim. The recorded `aria-hidden-focus` incomplete result remains visible and has separate keyboard containment evidence. CSS zoom does not prove native zoom. Live Clerk sign-in, sign-up, menus, email, screen-reader speech and assistive-technology interoperability remain explicitly unverified.

The Prove It Works principle shaped the review. The reviewer used exact current Git trees, current file blobs, the actual parent diff and the real read-only application selector rather than assuming the previous green review covered the merge. No medium or high issue required a subsequent PR-discussion audit.
