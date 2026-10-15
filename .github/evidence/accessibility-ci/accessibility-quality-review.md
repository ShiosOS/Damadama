# Accessibility maintainability review

Verdict: **PASS — no material maintainability findings.**

Reviewed on October 15, 2026, using `pstack:thermo-nuclear-code-quality-review`, the repository `AGENTS.md`, and the TypeScript type-discipline instructions. This is a read-only review of the accessibility change against parent `22a5a89a2e4293665eed6334a668da441e58c623` on `codex/accessibility-ci`. The working tree was uncommitted, so the exact file hashes below identify the reviewed implementation more precisely than HEAD alone.

The nine-file scope adds one pinned scanner dependency, a private browser scanner/report assertion, accessibility journeys, isolated fixture identities, two semantic contrast tokens, refusal-focus recovery, documentation, and failure-artifact paths. It introduces no application authentication mode or release-workflow behavior. I found no clear structural regression, misplaced policy, unnecessary generic abstraction, or missed simplification large enough to justify blocking the draft.

`tests/Browser/accessibility.spec.ts` is 401 lines. Its scanner centralizes stabilization, projection into a typed report, screenshots, and attachments. The small accessibility assertion earns its indirection because the real-DOM negative control invokes the same gate as every audited state. The long keyboard journey exposes each keyboard action and expected focus; replacing those sequences with a generalized navigation helper would hide the behavior being verified. The two mobile/zoom cases share one direct data-driven body.

`web/src/HabitsPage.vue` grows from 279 to 285 lines. The new focus policy belongs in the component that owns the creation request and rendered error. It extends the existing generation guard, waits for rendering, and checks that the panel remains open. The 401 path continues to close the panel. No new state flag, mode, event bus, or cross-component API is introduced. The contrast fix belongs in the existing semantic-token block rather than alert-specific exceptions.

The documentation distinguishes optimized production entry, authenticated local fixture, CSS zoom, provider UI, and manual assistive-technology review. It reports incomplete axe checks separately and does not claim full WCAG compliance. The suite does not disable rules, exclude elements, skip tests, or add suppression comments.

The video setting is confined to this spec. The completed run produced six flow recordings and 14 tiny axe blank-page recordings, totalling 1,117,851 bytes. Axe's installed implementation creates the extra pages during result aggregation. This volume does not warrant another recording mode or wrapper. CI uploads the existing reports only on failure and retains them for three days.

No remediation sequence is required. Preserve the reviewed structure, publish the draft with its limits and dependency stated, and treat the separate correctness/security review and CI result as independent gates.

Evidence and subsystem reasoning: [accessibility-quality-review-details.md](accessibility-quality-review-details.md).

## Verification observed

I did not start servers or run a suite. I read `.audit/accessibility-full-check.log`: all 18 browser tests passed, including the six accessibility tests, followed by 51 backend tests with zero failures or skips. Those are observations of the root-owned run. I also inspected the allowed contrast reports, focus-debug JSON, current scan reports, and generated recording inventory. The focus-target-red infrastructure failure was not used as red proof.

## Reviewed file snapshot

| File                                  | Lines | SHA-256                                                            |
| ------------------------------------- | ----: | ------------------------------------------------------------------ |
| `.github/workflows/check.yml`         |    54 | `BD8530E9CDB814292C83B1A8805ABD173DE4BA3E1B9A44E56302B99CCC1BFA42` |
| `README.md`                           |    60 | `55A54059A97243F1297B120BDA960C670ABE47C6360C5E3918C0C3A98E86D298` |
| `bun.lock`                            |   968 | `68E7BD1043B90B2793591164A0473AC135EE53A7307E05A15698F0061B16DF87` |
| `package.json`                        |    27 | `C5994AA90491F12600137D4E3B27FDECDCD445B58C03331C2E3714930D333A4D` |
| `tests/BrowserHost/Program.cs`        |    34 | `237896F7A302149AC276AD82C623E0515A4A4ACB379C8FDB9452A3126BA7B54D` |
| `web/src/HabitsPage.vue`              |   285 | `02FA8016E4262506DCAA07CA316DB21C551655EB528C8173A4958F630E8D7106` |
| `web/src/style.css`                   |   213 | `0092B9AC75AB91F79E909FDCF983628BE55E7B5C72BD687396FF6F2161B761D6` |
| `tests/Browser/accessibility.spec.ts` |   401 | `6358E2C2C8F3804987091CCB768BA3C7B48380FCE53CF5CC11817CB4CF6F31E7` |
| `docs/browser-accessibility.md`       |    62 | `B7DFD612B3265947C4CEAEB8966CDC3EFF7CC1C7BA878772385A7DBA780EF474` |
