# Daily entries

Record Good, Better, Best, Rest or Clear for an eligible habit/date. The visible result follows a committed response, persists after reload, and retains the original recorded definitions.

## Sub-features

- `entry-results` treats all five results as distinct outcomes.
- `entry-commit` waits for acknowledgement before displaying a saved result.
- `entry-persist` preserves the acknowledged result after reload.
- `entry-retry` retries the same edit after a failed save.
- `entry-support` shows a safe support reference and a usable Retry save control after a simulated service refusal.
- `entry-boundaries` protects account/date transitions and retained historical definitions.
- `entry-overlap` preserves pending commands through habit changes and adopts the current stored winner after refresh.

## How to get to it (user POV)

In Today or a past Calendar date, find the habit and the group named `Result for <habit name>`. Choose a result button. Use `Retry save` after a failed request. Use Calendar date and Today to move between dates.

## Driving it with Playwright

Preconditions: [canonical fresh session](../SKILL.md). [entries.spec.ts](../../../../tests/Browser/entries.spec.ts) and [history.spec.ts](../../../../tests/Browser/history.spec.ts) provide real API seeds, controlled clocks and separate accounts.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts entries.spec.ts history.spec.ts
```

- Use `the committed result appears before any reload`. Click Good in the named result group, require the real PUT response, `aria-pressed="true"` and `Good is saved.` before reloading. Its screenshot is `.audit/entries-immediate.png`.
- Exercise the reload and five-outcome examples. The five-outcome test acknowledges all five choices sequentially and reloads only final Clear. Other examples reload Better, Good and Rest. Report those actual assertions, rather than claiming five individual reload proofs. Clear is an explicit outcome with `Entry cleared.` and a retained edit timestamp.
- Hold the save response to prove the UI waits for acknowledgement. Exercise retry and competing-edit examples using their existing assertions, not a local UI setter.
- Run account/sign-out/date transitions, past dates and retained-definition cases. Require the selected date's actual result and original recorded definitions. Distinguish API seeding from the result action under test.
- Use `a simulated entry failure displays its safe support reference`. Require the simulated 503 message, `Support reference: fixture-entry-support-01.`, unchanged saved status and Retry save fully in the viewport. Retain its named PNG and WEBM. This proves client refusal presentation, not a storage outage.
- Use `an entry acknowledgement survives a completed habit-change refresh`. Hold the actual first PUT, edit the habit's Good definition and let the refresh finish. Release the PUT and require the saved result with the edited definition immediately and after reload. First insert captures the current locked definitions; an already recorded entry keeps its original definitions.
- Use `a pending entry removed by archive retains its failed command and unchanged retry`. Archive while the first PUT is held, require `Pending entry`, then abort the held request. Require a visible error and `Retry save`. Inspect an empty real entry read before retry, equal original/retry bodies, acknowledged Good, `Retained entry` and the independently reloaded result.
- Use `a delayed entry acknowledgement cannot replace a newer stored winner after refresh`. Hold the older Good acknowledgement, complete the habit-change refresh and store a newer Best. Require Best before and after releasing Good and after reload. A stale response must trigger an authoritative reread rather than replace that winner.

## Gotchas

Browser edit instants and calendar dates have separate meanings. Retry preserves the entry result and original edit timestamp while recomputing the current device date and timezone. Equal complete request bodies are proved in the unchanged-clock archive example. A routed 503 or aborted request proves client retry/refusal behavior, not a real database rollback. PostgreSQL conflict/rollback coverage belongs to the backend tests. Synthetic fixture controls do not prove provider sign-out or JWT revocation.
