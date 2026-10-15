# Browser performance checks

`bun run check` builds the actual production entry and checks its compressed assets before running browser tests against an optimized build of the existing habit fixture.
The Check workflow runs that command for pull requests to every target branch, including application-dependent stacks.
It caches dependencies and Chromium, cancels superseded runs, and keeps failed reports for three days.
Release workflows are unchanged.

## Run the checks

Use the Bun, Node.js, .NET, and Docker versions listed in the README. Run `bun run check` from the repository root.
The command creates `.audit/browser-build` before BrowserHost starts, then BrowserHost writes its ephemeral JWT fixture into that directory.
Vite preview serves the optimized habit fixture at `http://127.0.0.1:5174` and proxies API requests to the actual test host at port 5055.
Testcontainers creates and removes a separate PostgreSQL database. JWT requests go through the normal authentication middleware.

To check assets after a frontend build, run `bun run --cwd web build`, then `bun run check:performance`.
The second command runs the controlled budget tests and checks `server/wwwroot`.
It writes `.audit/performance-assets.json`. The browser flow writes `.audit/performance-browser.json` and `.audit/performance-saved.png`.
Reports contain byte counts, asset names, source revision, request and error counts, layout shifts, and diagnostic durations.
They exclude request headers, response bodies, and authentication tokens. Browser traces are disabled because a trace can record the fixture tokens.
Do not upload `fixture.json` or the optimized fixture directory.

## Fixed budgets

The baseline is application PR 11 at `9c8437e1e4a46965513b53f60d7fa569c0fd18ea`, measured before source changes on October 14, 2026.
The production entry includes the Clerk Vue client. The separate browser fixture mounts the actual `HabitsPage` with the existing test-token interface.
The asset checker inventories every file under the production `assets` directory and uses Node.js `gzipSync` with its default compression level.
CSS asset references and HTML script and link references must exist inside the inventoried `assets` directory, except for inline `data:` URLs.
An absent build or missing JavaScript or CSS fails.
Files outside the listed categories still count toward the total bytes and file count. External linked assets fail because the checker cannot budget their bytes.

| Measure                                        | Unchanged production build | Maximum |
| ---------------------------------------------- | -------------------------: | ------: |
| JavaScript gzip bytes                          |                    148,847 | 170,000 |
| CSS gzip bytes                                 |                     26,734 |  32,000 |
| Font gzip bytes                                |                    137,661 | 150,000 |
| Total asset gzip bytes                         |                    313,242 | 360,000 |
| Asset files                                    |                          7 |      10 |
| Browser requests across load, save, and reload |                         15 |      20 |
| Cumulative layout shift                        |  0.002025 maximum observed |     0.1 |

The ceilings leave modest room for normal edits while detecting an accidental library, font, or request increase.
They are fixed reviewable limits. The checker does not raise them automatically to match a build.
Update a budget only with a new production-build inventory and an explanation of the user benefit.
Compressed file sizes estimate payload cost. They do not assert that the server currently sends gzip responses.

## Baseline method and limits

Five sequential runs used Playwright 1.64.0 with bundled Chromium 156.0.8078.4 at a 1280 by 800 viewport, the America/New_York timezone, and fresh browser contexts.
Each run loaded optimized assets, observed GET 200, saved a unique habit through POST 201, and observed that saved habit after a reload and GET 200.
All five runs reported 15 requests, no failed requests, no non-success responses, and no browser runtime errors.
The browser layout observer uses the largest session-window score, with one-second gaps and a five-second window, and excludes shifts after recent input.
The check waits for fonts and two animation frames before it captures the complete first-document score immediately before reload.
It compares the larger of that score and the settled reload score with the layout budget.

The optimized fixture had 304,586 gzip bytes across seven files, including 140,165 bytes of JavaScript and 26,760 bytes of CSS.
Production asset budgets use the larger actual application entry, rather than using that smaller fixture as the application budget.
The browser check confirms that hashed JavaScript assets loaded, so a development server or a zero-work page cannot pass.
It checks the saved name and level text after reload, along with the successful API responses.

The baseline host was Windows on an Intel i5-9600K with six logical processors, Node.js 24.19.0, Bun 1.3.14, and .NET SDK 10.0.113 using the repository's patch roll-forward setting.
CI uses the repository's .NET SDK 10.0.112 pin and Node.js 24. Other processes were active, with a 43 percent CPU load sample before the run.
The browser cache was cold at initial navigation and warm at reload. The API and PostgreSQL process caches were shared across runs.
There was no CPU or network throttle. The backend used the existing test build and ephemeral database.

Elapsed times are diagnostics only. The five baseline medians were 159 ms until the initial list appeared, 277 ms from Save to the saved heading, and 72 ms for reload persistence.
Ranges were 156 to 1,912 ms, 267 to 595 ms, and 64 to 101 ms respectively.
The large initial-load variation makes a machine-specific time threshold unsuitable. No speed improvement or live-service latency claim follows from these numbers.
The current browser report also waits for fonts before recording readiness and reload durations, so its times are not a before-and-after comparison with those baseline durations.

The fixture does not contact Clerk, send email codes, or measure provider sign-in, network latency, production database load, or real-user web vitals.
The 0.1 layout budget applies to the local habit fixture. A live sign-in measurement needs a separate provider-enabled environment.
This change adds checks and reports without changing application visuals or behavior. The screenshot records the existing saved-list behavior.
