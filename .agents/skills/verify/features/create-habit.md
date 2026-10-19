# Create a habit

Create a private habit with Good, Better and Best definitions and its weekday/repeat schedule. A rejected form remains recoverable, and a saved habit appears without reloading.

## Sub-features

- `create-open` opens the creation dialog and focuses Name.
- `create-cancel` returns focus after Escape or Close without submitting, retaining an ordinary dismissed draft.
- `create-validate` preserves an invalid draft and permits a corrected retry.
- `create-save` waits for acknowledgement, then shows the accepted name, definitions, weekdays and repeat interval before reload.
- `create-accessible` supports keyboard focus, mobile layout and double CSS zoom.

## How to get to it (user POV)

Open the app's signed-in habit page and choose `Add habit`. The integrated fixture reaches the same production controls at `/`. The dialog is named `Create a habit`.

## Driving it with Playwright

Preconditions: canonical preparation and fresh session ownership from [SKILL.md](../SKILL.md). Use [habits.spec.ts](../../../../tests/Browser/habits.spec.ts) and [accessibility.spec.ts](../../../../tests/Browser/accessibility.spec.ts) for the actual selectors and assertions.

```sh
node node_modules/@playwright/test/cli.js test --config tests/Browser/playwright.config.ts habits.spec.ts accessibility.spec.ts
```

- Open with `getByRole("button", { name: "Add habit", exact: true })`. Expect the named dialog and focused Name input.
- Fill labels `Name`, `Good`, `Better` and `Best`. Check `Monday` and `Wednesday`, then fill `Repeat every` with `2`. Choose `Save habit`.
- Require the dialog to close and region `Saved habits` to display Walking, all three definitions, both weekdays and `Every 2 weeks` before reloading. The existing `saved values appear in the list before any reload` test captures `.audit/habits-immediate.png`.
- Exercise the no-weekday refusal. Require the focused alert and retained draft, then select weekdays and save successfully. Dismiss the error and require it to clear.
- Exercise both Escape and Close paths. Require focus to return to `Add habit` and no POST to be submitted. Ordinary dismissal retains the draft; account changes clear it. The [complete map pass](../SKILL.md#drive) explicitly checks retained fields after Escape, saves through the UI and captures immediate and independently reloaded values.
- Use `save acknowledgement cannot reveal the previous accounts habit`. While the real response is held, require Save and Close to be disabled, Escape to leave the panel open and no saved row to appear. Switch accounts before releasing the response and require the old row to remain absent.
- Run keyboard creation and the mobile and zoom creation examples in `accessibility.spec.ts`. Require focus containment, the API refusal, corrected save and usable controls.

## Gotchas

The UI's weekday names are stable handles; the API's ISO weekday integers are a different boundary. Save success follows the real API acknowledgement. Fixture account switching is a test control and does not exercise Clerk. Check reload persistence through [saved habits](saved-habits.md).
