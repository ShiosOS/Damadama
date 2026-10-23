# Browser compatibility

This suite runs Firefox and WebKit through a keyboard-operated habit creation, a real API save, and a reload. Chromium compares a desktop creation panel, desktop saved details, and the mobile layout. It reuses the production Habits page and the existing BrowserHost/PostgreSQL fixture. The fixture authenticates with synthetic tokens; this suite does not exercise provider sign-in.

On Ubuntu 24.04, run `bun install --frozen-lockfile`, `dotnet restore --locked-mode --artifacts-path .audit/check-build`, `dotnet build --no-restore --artifacts-path .audit/check-build`, and `bun x --no-install vite build --config tests/Browser/compatibility.vite.config.ts` before either mode. Before capture, run `node node_modules/@playwright/test/cli.js install --with-deps chromium`. Before verification, run `node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit`. Docker must provide the PostgreSQL Testcontainer used by BrowserHost. The owned `compatibility.html` loads the existing fixture app with the production viewport declaration, and the owned Vite config builds that entry into the shared browser output directory.

Run `bun run browser:compatibility:capture` to produce candidate PNGs and a measured generation manifest under `.audit/browser-quality/candidates/`. The invocation uses `.audit/browser-quality/test-results/capture-1/`, and `.audit/browser-quality/receipts/capture.json` records its exit code and output directory. Capture does not write expected images. Review the three images, including the true 390-pixel mobile layout, then copy those exact PNGs to `tests/Browser/baselines/` and copy `manifest.json` alongside them. Keep `generationSHA` as the source revision that produced the pixels, even if the reviewed files are committed in a later revision. The expected image paths never contain a revision. The candidate artifact from the targeted pull request workflow supports initial review before the workflow exists on the default branch.

Run `bun run browser:compatibility:verify` after reviewed baselines are committed. It validates the PNG hashes and measured browser environment, runs Firefox/WebKit once, then starts three fresh Playwright/BrowserHost/PostgreSQL invocations for unchanged Chromium comparisons. A separate desktop run changes saved-row padding, requires a native screenshot pixel mismatch with a nonempty diff PNG, removes the style, and compares the same baseline successfully. Another run requests a deliberately absent baseline and requires a missing-snapshot diagnostic without creating an expected file. Snapshot updates are disabled in both config and test code. Each invocation has its own numbered output directory, so the mutation diff survives the missing-baseline run. Verification writes a sanitized receipt with the actual checkout SHA, baseline generation SHA, exit codes, and output directories to `.audit/browser-quality/receipts/verify.json`. Successful checkpoints also write a screenshot that is separately asserted against the reviewed PNG and measured environment metadata alongside the comparison output. That metadata records the comparison revision separately from the baseline generation revision and binds both images by SHA-256.

Both commands require Ubuntu 24.04 and exit before browser work on other platforms. Use the GitHub workflow's `ubuntu-24.04` runner for canonical capture and verification. The runner reads and validates Ubuntu identity and version from `/etc/os-release`. The manifest records that observed distribution and version, the kernel release, actual browser and Playwright versions, platform, runner image labels when available, configured viewport, measured CSS layout viewport, screen, device scale, loaded Nunito Variable font, locale, timezone, and fixed clock. Both measured layout widths must equal the checkpoint width, including 390 pixels on mobile. The image SHA-256 hashes bind the reviewed PNGs to the manifest. Capture from another OS cannot become the Linux baseline. The runner's `ImageVersion` may advance independently of the Ubuntu release, so the receipt records it without treating a monthly runner-image update as an automatic pixel change.

The dedicated workflow checks out the exact pull request head and runs independent capture and strict verification jobs when the suite, application, fixture, backend, or build inputs change. Before reviewed baselines are added, capture can succeed while verification correctly fails with a missing-baseline message. Schedules and manual dispatch become active after this workflow reaches the default branch. The workflow uploads only candidate PNGs, the measured manifest, sanitized receipt, and named screenshot comparison PNGs. It excludes fixture tokens, request data, traces, videos, full HTML reports, and arbitrary `.audit` output.

# Font evidence in failed child logs

The compatibility scenario records the actual Nunito predicate and bounded face
counts in the same evaluation. The predicate still searches every face. More than
32 matching faces makes the diagnostic sample unavailable without changing the
guard. Entry without readiness fulfillment records a pending guard, not a false
predicate. Node receive order and browser performance time are separate clocks.

`font-evidence.ts` owns only its font request, response, completion, failure,
navigation, and close listeners. It detaches those exact listeners on close or
after each case. The existing native form and POST observers remain separate.
An owner is registered before admission starts. Teardown seals even a pending
owner with `admission-incomplete`; late admission cannot attach listeners or
change that receipt. A closed page cannot start observation.
Waiter, response-await, JSON, and saved-assertion markers identify save boundaries.
Neither these markers nor a later font refusal reconstructs issue #117's original
first incorrect state.

The fixed `bundled-nunito-not-loaded` category comes from the original refusal
branch before the unchanged Error. It does not classify arbitrary exceptions.
Passing and skipped cases discard the buffered journal. A guard refusal emits an
immediate frame; a failed case emits a final disposal frame. A missing final frame,
pending observation, overflow, or unavailable sample stays partial. Missing frames
stay absent. Invalid, conflicting, foreign, or unsupported frames are refused.

`compatibility-diagnostic-admission.json` is reviewed source input. Admission
compares working bytes with its digests and committed Git blobs. It also binds
the entire current `web/src` tree and rejects a changed Git source path set.
Its `reviewedBuild` digest must match the complete stable emitted HTML, CSS,
JavaScript, and font inventory. The existing HTML-to-CSS-to-font checks and exact
installed Nunito byte comparisons remain additional checks. BrowserHost's runtime
`fixture.json` is explicitly excluded without reading it.

A change anywhere in the small production source tree or emitted inventory,
including a cross-platform build difference, requires explicit review and
recalibration. Before changing the manifest, independently rebuild and inspect
the active HTML, stylesheet, script, and font chain. Review any input imported
outside the supported roots when reviewing its changed importer. Pin the reviewed
source and build digests, then commit before calibration. Admission and calibration
never bless observed bytes automatically. The consumer rechecks admission after
the child finishes.

Only exact admitted GET font URLs from the owned main frame enter the journal.
Foreign font URLs refuse evidence without retaining the URL. New frames exclude
user values, arbitrary errors, headers, HTML, local paths, and executable identity.
They reference the existing form stream without claiming ownership of it.
Current-page events must name the current main document. Only responses and
request terminal events may retain their recorded request's older document.
A guard spanning navigation requires an unavailable `document-changed` sample.

The list reporter and the runner's existing failed-child stdout carry frames
prefixed with `compatibility-evidence-v1`. The consumer enforces 16 KiB per frame
and 64 KiB per invocation. Original child status and failure output survive.
Existing raw Playwright errors are not newly sanitized. Job logs retain these
frames; image ZIPs do not. Workflow upload lists are unchanged.
Before starting children, the runner logs one bounded
`compatibility-evidence-admission` record from the parsed Admission value.
Passing canonical jobs can therefore prove diagnostic admission without case
failure frames. A diagnostic refusal does not change application acceptance.

Run the portable contract checks with:

```sh
bun test tests/Browser/font-evidence.test.ts tests/Browser/font-evidence-files.test.ts tests/Browser/font-evidence-lifecycle.test.ts
```

They also run in `bun run check` before Docker. To calibrate supported committed
sources, first build the compatibility fixture, then run the dedicated matrix:

```sh
bun x --no-install vite build --config tests/Browser/compatibility.vite.config.ts
bun tests/Browser/font-calibration-run.ts
```

The matrix uses Node 24.21.0 and Bun 1.4.3 with a 120-second outer limit.
Worker Node versions are distinct from the Bun supervisor's compatibility value.
Each Playwright case retains its
30-second timeout, one worker, and zero retries. It uses owned loopback servers,
the real guard and screenshot path, installed fonts, list reporter, and strict
consumer. Deliberate child failures retain exit 1. Outer timeout is incomplete
proof. Raw logs and receipts stay under `.audit/browser-font-implementation`.
The UTF-8 mixed case checks literal Cyrillic text, admitted Cyrillic and Latin
requests, loaded faces, and the real screenshot. Its lifecycle receipt retains
the observed text and loaded Unicode ranges.
The `.calibration.ts` suffix excludes the matrix from canonical discovery.
Only the exclusive calibration worker changes directory, and it restores its
previous directory. Fixed candidate paths therefore stay inside private fixtures.

Ubuntu environment strings supplied by the Windows toy are fixture inputs.
The matrix does not establish canonical Ubuntu acceptance, a hosted failure's
cause, or closure of issues #117 and #127. Listener and server disposal checks
do not prove whole-machine resource absence. Existing job provenance remains the
runtime record; the scenario does not discover or hash browser executables.
