# TypeScript gate integration

Rebased `codex/typescript-ci` from `e973800` onto PR 33 head `4062819` with `git rebase --onto 4062819 e973800`. The conflict resolution keeps the extracted `entries.schema.ts` and `habits.schema.ts` contracts, `WriteEntryInput`, and the current Today row and load models. The gate covers 28 maintained TypeScript and Vue files, including `tests/Browser/worker-retirement.spec.ts`.

The follow-up requires every Vue `<script>` block to use `lang="ts"` and inventories `.ts`, `.tsx`, `.mts`, `.cts`, and `.vue`. A tracked probe confirms that files outside checked projects or typed ESLint coverage fail. The coverage guard now inspects TypeScript and Vue comment nodes. Literal directive names in strings pass, while real `@ts-ignore`, `eslint-disable`, `@vue-ignore`, and `@vue-expect-error` comments fail. The Vue probes include typed template errors that vue-tsc accepts only with the directives in place. Typed ESLint now requires explicit returns on exported object methods and arrows returning `as const`; behavior probes exercise both. The worker retirement test has explicit `void` contracts on IndexedDB callbacks to satisfy the tighter rule.

## Local checks

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed. No lockfile changes. |
| `bun run check:types` | Passed. Web, browser, and script compilers, ESLint, and 10 positive and negative probes. |
| `bun run --cwd web build` | Passed. |
| `bun x --no-install vite build --config tests/Browser/vite.config.ts` | Passed. |
| `bun run check:performance` | Passed. 5 budget tests and 315879 gzip bytes across 7 production assets. |
| `bun x --no-install prettier --check web tests/Browser scripts package.json tsconfig.base.json eslint.config.mjs .github README.md AGENTS.md dev/Properties/launchSettings.json` | Passed after formatting the Windows checkout. The Git diff contains only intended source changes. |
| `git diff --check` | Passed. |
| `bun run check` | Type gate passed, then stopped at `docker info` because the Docker Desktop Linux engine pipe is unavailable. Backend, PostgreSQL, and browser runtime checks did not run locally. |

The type probes removed their temporary files and index entries. No `type-probe` files remain.

An independent follow-up found that a standalone TypeScript scanner loses template and regular-expression context. Comment detection now uses the pinned TypeScript ESLint parser's comment collection. Probes accept directive text inside interpolated templates and regular expressions. They reject real comments at end of file, inside interpolation and JSX, and after interpolation where a suppression otherwise lets an incompatible assignment pass both the compiler and typed lint.
