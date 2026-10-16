# Playwright reports and repository checks

Issue #20 reproduced on base `01b804e14d74f6f3acf4325ef03357abb5894f62`.
The committed Playwright configuration writes its HTML report to
`tests/Browser/playwright-report`. Its test results remain in `test-results`.
ESLint's root-only report ignore missed the nested report directory.

The reproduction used a temporary `tests/Browser/issue20-report-probe.spec.ts`
with an intentionally failing assertion and the committed Playwright configuration.
`PLAYWRIGHT_HTML_DO_NOT_INLINE_ASSETS=1` made the HTML reporter write its real
JavaScript asset as `report.js`, exposing generated JavaScript to ESLint instead
of keeping that JavaScript inside the HTML file. The probe was removed before
rerunning the unchanged `bun run check`. The generated report stayed in place.

The unchanged check failed during lint with this output:

```text
✖ 167 problems (167 errors, 0 warnings)

error: script "lint" exited with code 1
error: script "check" exited with code 1
```

The retained `tests/Browser/playwright-report/report.js` has SHA256
`0ECF5329CE34F0B809753392B8715521C30EEB46E24F7749D2537C06AA5BCEA4`.
Local reproduction logs are `.audit/issue20-external-assets-report.log`,
`.audit/issue20-unchanged-check-before.log`, and `.audit/issue20-lint-before.log`.
These logs and generated reports remain ignored.

The fix excludes `test-results` and `playwright-report` directories at any depth
from ESLint. Both failure-report upload lists now use the actual nested HTML
report path. The reporter configuration and root test-results path are unchanged.

## Verification recipe

1. Keep the generated report and remove the temporary failing spec.
2. Hash `tests/Browser/playwright-report/report.js` with `Get-FileHash -Algorithm SHA256` and compare it with the value above.
3. Run `bun run lint` with the fixed ignores and the retained report.
4. Run `bun run check` with the retained report present at startup.
5. Confirm both workflow upload lists include `tests/Browser/playwright-report` and `test-results`.

With the fix, `bun run lint` exits 0 with the retained report's hash unchanged.
The ESLint boundary check ignores root and nested generated directories while
keeping `tests/Browser/habits.spec.ts` in scope. A nested conditional in authored
browser source still produces one `no-restricted-syntax` error.

`bun run check` exits 0 with 19 browser tests and 65 backend tests passing.
The report was present at startup; Playwright writes the next run's report as usual.
Four focused release-workflow tests also pass with no failures.

These runs used the local Windows checkout with the repository's LF file bytes.
This change does not alter application behavior or verify a new email sign-in.
