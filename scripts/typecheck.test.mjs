import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function rejects(tool, args, diagnostics) {
  const result = spawnSync(process.execPath, [resolve(root, tool), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  for (const diagnostic of diagnostics) assert.match(output, diagnostic);
}

function accepts(tool, args) {
  const result = spawnSync(process.execPath, [resolve(root, tool), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function withProbes(files, check) {
  const created = [];
  try {
    for (const [path, source] of files) {
      await writeFile(path, source, { flag: "wx" });
      created.push(path);
    }
    check();
  } finally {
    await Promise.all(created.map((path) => rm(path)));
  }
}

test("checked TypeScript rejects unsafe boundaries and incomplete returns", async () => {
  const path = resolve(root, "web/src/type-probe.ts");
  await withProbes(
    [
      [
        path,
        `
export function implicit(value) { return value; }
const rows: string[] = [];
export const unchecked: string = rows[0];
type Options = { label?: string };
export const optional: Options = { label: undefined };
export function incomplete(value: boolean): string { if (value) return "yes"; }
export async function unparsed(): Promise<string> {
  const data: unknown = await (await fetch("/")).json();
  return data.name;
}
`,
      ],
    ],
    () => {
      rejects(
        "node_modules/vue-tsc/bin/vue-tsc.js",
        ["-p", "web/tsconfig.json", "--noEmit"],
        [
          /type-probe\.ts.*TS7006/s,
          /TS2322.*undefined/s,
          /TS2375|TS2379/,
          /TS2366/,
          /TS18046/,
        ],
      );
    },
  );
});

test("Vue checking rejects typed props, emits, and template expressions", async () => {
  const child = resolve(root, "web/src/type-probe-child.vue");
  const parent = resolve(root, "web/src/type-probe-parent.vue");
  await withProbes(
    [
      [
        child,
        `<script setup lang="ts">
defineProps<{ count: number }>();
defineEmits<{ selected: [id: number] }>();
</script>
<template><span>{{ count.toUpperCase() }}</span></template>
`,
      ],
      [
        parent,
        `<script setup lang="ts">
import Child from "./type-probe-child.vue";
</script>
<template><Child count="wrong" @selected="(id: string) => id" /></template>
`,
      ],
    ],
    () => {
      rejects(
        "node_modules/vue-tsc/bin/vue-tsc.js",
        ["-p", "web/tsconfig.json", "--noEmit"],
        [
          /type-probe-child\.vue.*toUpperCase/s,
          /type-probe-parent\.vue.*Type 'string' is not assignable to type 'number'/s,
          /type-probe-parent\.vue.*Type '\(id: string\)/s,
        ],
      );
    },
  );
});

test("schema-derived boundaries and safe local inference compile", async () => {
  const path = resolve(root, "web/src/type-probe-positive.ts");
  await withProbes(
    [
      [
        path,
        `
import { z } from "zod";
const schema = z.object({ count: z.number().int() });
type Input = z.infer<typeof schema>;
function double(input: Input): number { return input.count * 2; }
const parsed = schema.parse({ count: 2 });
const first = ["ready"][0] ?? "empty";
export const result = first + double(parsed);
`,
      ],
    ],
    () => {
      accepts("node_modules/vue-tsc/bin/vue-tsc.js", [
        "-p",
        "web/tsconfig.json",
        "--noEmit",
      ]);
    },
  );
});

test("browser fixture Vue templates are checked", async () => {
  const path = resolve(root, "tests/Browser/type-probe.vue");
  await withProbes(
    [
      [
        path,
        `<script setup lang="ts">
defineProps<{ name: string }>();
</script>
<template>{{ name.missing() }}</template>
`,
      ],
    ],
    () => {
      rejects(
        "node_modules/vue-tsc/bin/vue-tsc.js",
        ["-p", "tests/Browser/tsconfig.json", "--noEmit"],
        [/type-probe\.vue.*TS2339.*missing/s],
      );
    },
  );
});

test("typed ESLint rejects any, unsafe assignment, assertions, and non-null escape", async () => {
  const path = resolve(root, "scripts/type-probe.ts");
  await withProbes(
    [
      [
        path,
        `
const untyped: any = JSON.parse("{}");
export const value: string = untyped;
export const asserted = ({ count: 1 } as { count: string });
const optional: string | undefined = undefined;
export const forced = optional!;
`,
      ],
    ],
    () => {
      rejects(
        "node_modules/eslint/bin/eslint.js",
        [path],
        [
          /@typescript-eslint\/no-explicit-any/,
          /@typescript-eslint\/no-unsafe-assignment/,
          /@typescript-eslint\/consistent-type-assertions/,
          /@typescript-eslint\/no-non-null-assertion/,
        ],
      );
    },
  );
});

test("coverage rejects new files outside projects and JavaScript Vue scripts", async () => {
  const omitted = resolve(root, "web/type-probe.ts");
  const untypedVue = resolve(root, "web/src/type-probe.vue");
  await withProbes(
    [
      [omitted, "export const omitted = true;\n"],
      [
        untypedVue,
        "<script setup>const value = 1;</script>\n<template>{{ value }}</template>\n",
      ],
    ],
    () => {
      rejects(
        "scripts/type-coverage.mjs",
        [],
        [
          /web\/type-probe\.ts: outside checked projects/,
          /web\/src\/type-probe\.vue: Vue script must use lang="ts"/,
        ],
      );
    },
  );
});
