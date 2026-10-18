# Retire the legacy staging worker

An existing staging browser loaded the legacy journal while the server served the rewrite. The server returned 404 for the installed worker's original `/sw.js` URL. A failed worker update leaves the installed worker active, so its cached navigation can keep returning the legacy shell.

The application now serves a retirement worker only at `/sw.js` on `staging.damadama.app`. It installs with `skipWaiting()` and unregisters during activation. It handles no fetches and does not claim other clients, navigate tabs, or delete browser storage. An open legacy page keeps its document and draft. A later user navigation loads the rewrite.

Other hosts and alternate ports receive no retirement script. This change does not deploy to production or import legacy data into Clerk accounts. Preserved pending records still belong to the legacy application.

## Regression evidence

The tests were committed before the endpoint. Before the fix, the endpoint matrix reported:

```text
Expected: OK
But was:  NotFound
Failed: 3, Passed: 11, Total: 14
```

The browser regression first confirmed that a worker controlled its isolated origin. After the network switched to rewrite HTML and the worker update returned 404, an ordinary reload still displayed `Legacy journal`. It then failed at the missing application endpoint:

```text
Expected: 200
Received: 404
1 failed
```

After the fix, the same commands passed:

```text
dotnet test tests/Backend --filter FullyQualifiedName~WorkerRetirementTests
Passed: 14, Failed: 0, Total: 14

node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts worker-retirement.spec.ts
1 passed
```

The browser test serves byte-identical JavaScript from the real application endpoint to an isolated loopback origin. It checks retirement, repeated normal navigation, an untouched second draft tab, local storage, IndexedDB records for two owners, and unrelated cache entries. Its navigation-cache predecessor is a small synthetic fixture. Record preservation is not an account-isolation test.

The full repository check and release-control tests also passed:

```text
bun run check
Build, format, lint, web build and performance checks passed.
19 browser tests passed.
65 backend tests passed.

node --test release/*.test.mjs
172 passed, 0 failed.
```

A separate local replay used the actual compiled legacy worker, SHA-256 `763b2a2f4802fc1335231f67c928775f40ff5dff12fea817a8db8af76d6f48e0`. It confirmed `/sw.js` control and reproduced the 404 update retaining the cached shell. That replay is retained in the local audit record and is not a portable CI fixture.

## Verification boundary

The local fixture does not prove genuine email delivery, a Clerk session, or the transition of the existing hosted browser. Those checks follow the staging deployment. The retirement endpoint does not register a worker in fresh browsers.

The behavior follows the [service worker lifecycle](https://web.dev/articles/service-worker-lifecycle#updates) and [same-URL worker retirement guidance](https://developer.chrome.com/docs/workbox/remove-buggy-service-workers). Issue [#30](https://github.com/ShiosOS/Damadama/issues/30) tracks the hosted transition.
