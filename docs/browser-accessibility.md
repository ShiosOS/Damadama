# Browser accessibility checks

`bun run check` builds the actual application and optimized browser fixture, then runs `tests/Browser/accessibility.spec.ts` with every other browser spec.
The accessibility spec uses pinned `@axe-core/playwright` 4.13.0 and its locked axe-core dependency.
It audits the entire page with the installed engine's WCAG 2.0 A and AA, 2.1 A and AA, and 2.2 AA tags.
Any detected violation fails the check. The suite disables no rules and excludes no elements.

## Audited states

The production entry runs at port 5055. The test fetches the real `/api/config` response, replaces only its public publishable key with `null`, and checks the actual application's missing-configuration message.
It confirms that optimized JavaScript loaded and that the configuration endpoint returned 200.
This exercises `web/src/main.ts` and `App.vue` without impersonating a Clerk session.

The fixture runs at port 5174 and mounts the actual `HabitsPage.vue`.
Dedicated account subjects isolate accessibility data from other browser tests.
The suite audits the signed-out presentation, empty saved list, creation panel, API validation refusal, saved list, reloaded list, and expired-session message.
It observes actual API responses of 400 for a missing weekday, 201 for creation, 200 for persistence after reload, and 401 for the expired token.
The API uses the existing ephemeral RSA tokens through normal JWT middleware and an ephemeral PostgreSQL database.

The keyboard flow reaches every creation control with Tab and Shift+Tab, checks a weekday with Space, and submits with Enter.
It checks initial Name focus, focus containment in both directions, Escape dismissal, return to Add habit, the accessible validation alert, and successful persistence.
After a rejected save, focus moves to the creation error alert. Tab then reaches every form control without leaving the dialog.
The mobile check uses a 390 by 640 viewport.
The zoom check uses a 1280 by 800 viewport and CSS zoom of 2.
Both checks verify that Save is fully visible after scrolling, that content has no horizontal overflow, and that creation and saved content pass axe scans.
CSS zoom is a repeatable layout check. It does not prove every browser's native zoom behavior.

## Reports and controls

Scans wait for fonts, finite UI animations, and two animation frames before calling axe.
Each scan saves `.audit/accessibility-<state>.json` and a screenshot, and attaches both to the Playwright report.
The typed `ScanReport` retains the source revision, audited state, rule IDs, affected selectors, failure summaries, passed-rule count, and incomplete rule node counts.
It omits axe's DOM markup, browser environment payload, HTTP headers and bodies, and fixture tokens.
Playwright records the accessibility flows in `test-results`. Tracing stays disabled because traces can capture bearer tokens.
The Check workflow retains failed reports for three days.

A control inserts a real unnamed button into the browser DOM, proves that axe reports `button-name`, and verifies that the same assertion used by the suite rejects the report.
Removing the button restores a passing scan.
The first scan before the gate was complete failed with `Received ["button-name"]` against `Expected []`.

The initial actual configuration, validation-refusal, and expired-session scans found `color-contrast` violations in the solid warning and error alerts.
White warning text on `#f0b100` measured 1.91, and white error text on `#fb2c36` measured 3.8, below the required 4.5.
The shared `--ui-warning` and `--ui-error` tokens now use `#92400e` and `#b91c1c`.
The alerts retain their messages and layout, with darker backgrounds that satisfy the same scans.

The keyboard regression also found that disabling Save during a request leaves focus on the document body after a validation refusal.
The next Tab can leave the page because the dialog dependency does not recover focus from a disabled control.
The creation error alert is now a programmatic focus target after the current request's error renders.
The generation and open-panel checks prevent an old response from moving focus after an account change or dismissal.
The 401 path still closes the panel and does not focus its removed alert.

## Limits

Automated scans do not establish full WCAG compliance.
Axe may mark checks incomplete rather than decide them. Reports retain those counts for review.
The creation dialog can produce an incomplete `aria-hidden-focus` result. The keyboard assertions separately verify focus containment and accessible dismissal in the actual dialog.
The suite does not waive incomplete checks or convert them into passes.

The fixture does not contact Clerk or send email codes.
The production entry audit proves the application's configuration state, not provider sign-in, sign-up, account menus, email delivery, or provider accessibility.
Verify those states in a provider-enabled environment with real sign-in.
Screen-reader speech, native browser zoom, and assistive-technology interoperability still need manual review.
