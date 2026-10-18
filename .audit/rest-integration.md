# REST integration evidence

Branch `codex/rest-compliance-ci` integrates the two REST implementation commits and the independent runtime contract guards on Type CI `e153f58`. Type follow-up `ea8942fc292c8ecf18458ab9e617ae37f77f3813` is included as cherry-pick `342cfcd`.

## Integration decisions

- Preserve the `EntryEdit` value contract and separate entry DTO source from the readability branch. `EntryStore.Save` accepts that contract and returns the REST outcome union.
- Preserve first-creation classification by insert affected count, the original conditional conflict UPSERT and its row lock, the separate Read Committed winner read, and commit-before-response behavior. No model or migration change.
- Preserve the `TodayRow` discriminated union, one controls rendering path, stable keys, and load identity guard. Both row variants now carry their already-discovered account/date-bound editor.
- Preserve named local Vue props and explicit return contracts. Use a contextual fetch callback with the real fetch static member to satisfy Bun's merged fetch typing. No any, assertions, non-null assertions, or suppressions added to TypeScript.
- Preserve strict TypeScript CI before runtime checks and the REST client test command in the canonical check sequence. Runtime backend contract tests remain part of the complete backend test gate.
- The newer base has an existing GET `/sw.js` worker retirement route. It remains a route with its existing authority restriction, JavaScript response and no-store behavior. Its exact name/path/GET/no-authorization/control-plane shape is now an inventory exception alongside exact health and SPA exceptions. Negative guard mutations reject different path, method, or authorization. Existing worker tests retain staging authority coverage. This follows the parent coordinator's explicit correction that this route is not middleware.
- Windows autocrlf working files were formatted to LF with Prettier. Staging normalization removed no-op file churn; no Git configuration changed.

## Verification

All commands run in `C:/Users/emofo/.codex/worktrees/rest-compliance-ci/Damadama Rewrite` with bundled Node 24.19.0 ahead of PATH, Bun 1.3.14 and .NET 10.

- `bun install --frozen-lockfile` passed.
- `bun run check:types` passed after integrating the follow-up. It inventoried 31 maintained files and passed web, browser TS, browser Vue, script compilation, strict typed lint, and all 7 positive/negative probes.
- `bun test tests/Browser/rest-client.test.ts` passed 7 of 7 boundary tests.
- `dotnet build tests/Backend --artifacts-path .audit/check-build` passed without warnings or errors.
- `dotnet build tests/BrowserHost --artifacts-path .audit/check-build` passed without warnings or errors.
- `dotnet test tests/Backend --no-build --artifacts-path .audit/check-build --filter FullyQualifiedName~Damadama.Protocol --logger trx --results-directory .audit/TestResults` passed all 3 pure contract guards without starting PostgreSQL.
- `dotnet format --no-restore --verify-no-changes` passed.
- `bun run --cwd web build` passed. Vite reports the existing advisory chunk warning; no budget is disabled or changed.
- `bun run check:performance` passed all 5 budget checks and the production asset budget. Measured 317359 total gzip bytes across 7 assets, within unchanged 360000-byte and 10-asset limits.
- `bun x --no-install vite build --config tests/Browser/vite.config.ts` passed.
- Playwright `--list` discovered 54 tests across 7 files. Discovery is not browser execution.

The complete PostgreSQL, forced-concurrency, live endpoint and browser flows require Docker and remain for the parent's CI run. Canonical check output is captured locally in `.audit/rest-canonical-check.log`. `bun run check` passed frozen installation and all strict TypeScript stages/probes, then exited 1 at `docker info --format {{.ServerVersion}}`. The exact Docker failure was `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.` This is not a passing full integration run.

The full configured Prettier check and `git diff --check` passed. No probe files or staged temporary probes remained.

Rebased REST commits are `fab6044` (server), `ab5f319` (client and browser fixtures), and `50b9213` (independent runtime guard tests). Integration fixes are `3428e8c`; Type follow-up cherry-pick is `342cfcd`. The parent coordinator retains publication, independent final review and any final Type CI ancestry merge. No PR, push, Notion edit or external message was performed by this unit.

Type System Discipline preserved explicit schema-derived contracts. Boundary Discipline kept raw responses parsed at HTTP boundaries. Test Behavior, Not Implementation preserved observable status, media, authoritative conflict adoption, route coverage, rendering and account/date behavior. The deslop pass removed no established behavior and introduced no suppression or gate relaxation.
