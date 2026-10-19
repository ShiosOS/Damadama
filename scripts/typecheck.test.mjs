import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ESLint } from "eslint";

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
      await mkdir(dirname(path), { recursive: true });
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

test("coverage accepts directive names in strings, templates, and regular expressions", async () => {
  const typed = resolve(root, "web/src/type-probe-literals.ts");
  const vue = resolve(root, "web/src/type-probe-literals.vue");
  await withProbes(
    [
      [
        typed,
        'export const text = "@ts-ignore eslint-disable";\nexport const template = `prefix ${1} // @ts-ignore`;\nexport const pattern = /[/*] @ts-ignore/;\n',
      ],
      [
        vue,
        '<script setup data-note=">" lang="ts">\nconst text = "@vue-ignore @vue-expect-error";\n</script>\n<template><span>{{ text }}</span></template>\n',
      ],
    ],
    () => {
      accepts("scripts/type-coverage.mjs", []);
      accepts("node_modules/vue-tsc/bin/vue-tsc.js", [
        "-p",
        "web/tsconfig.json",
        "--noEmit",
      ]);
    },
  );
});

test("coverage rejects real TypeScript and Vue suppression comments", async () => {
  const typed = resolve(root, "web/src/type-probe-directives.ts");
  const trailing = resolve(root, "web/src/type-probe-trailing.ts");
  const interpolation = resolve(root, "web/src/type-probe-interpolation.ts");
  const jsx = resolve(root, "web/src/type-probe-jsx.tsx");
  const ignored = resolve(root, "web/src/type-probe-ignored.vue");
  const expected = resolve(root, "web/src/type-probe-expected.vue");
  await withProbes(
    [
      [
        typed,
        'export const label = `value ${Math.random()}`;\n// @ts-expect-error: incompatible assignment\nexport const value: number = "invalid";\n',
      ],
      [trailing, "export const value = 1; // eslint-disable"],
      [
        interpolation,
        "export const value = `prefix ${ /* eslint-disable */ 1 }`;\n",
      ],
      [jsx, "export const value = <>{/* eslint-disable */}</>;\n"],
      [
        ignored,
        '<script setup lang="ts">\ndefineProps<{ count: number }>();\n</script>\n<template><span><!-- @vue-ignore -->{{ count.toUpperCase() }}</span></template>\n',
      ],
      [
        expected,
        '<script setup lang="ts">\ndefineProps<{ count: number }>();\n</script>\n<template><span><!-- @vue-expect-error -->{{ count.toUpperCase() }}</span></template>\n',
      ],
    ],
    () => {
      accepts("node_modules/vue-tsc/bin/vue-tsc.js", [
        "-p",
        "web/tsconfig.json",
        "--noEmit",
      ]);
      rejects(
        "scripts/type-coverage.mjs",
        [],
        [
          /web\/src\/type-probe-directives\.ts: type or lint suppression is forbidden/,
          /web\/src\/type-probe-trailing\.ts: type or lint suppression is forbidden/,
          /web\/src\/type-probe-interpolation\.ts: type or lint suppression is forbidden/,
          /web\/src\/type-probe-jsx\.tsx: type or lint suppression is forbidden/,
          /web\/src\/type-probe-ignored\.vue: type or lint suppression is forbidden/,
          /web\/src\/type-probe-expected\.vue: type or lint suppression is forbidden/,
        ],
      );
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

test("typed ESLint requires return types for exported object methods and const arrows", async () => {
  const object = resolve(root, "scripts/type-probe-object.ts");
  const arrow = resolve(root, "scripts/type-probe-const-arrow.ts");
  await withProbes(
    [
      [
        object,
        "export const api = { value(input: string) { return input.length; } };\n",
      ],
      [
        arrow,
        'export const singleton = () => ({ status: "ready" } as const);\n',
      ],
    ],
    () => {
      rejects(
        "node_modules/eslint/bin/eslint.js",
        [object],
        [/@typescript-eslint\/explicit-function-return-type/],
      );
      rejects(
        "node_modules/eslint/bin/eslint.js",
        [arrow],
        [/@typescript-eslint\/explicit-function-return-type/],
      );
    },
  );
});

test("inline ESLint configuration cannot disable explicit function contracts", async () => {
  const path = resolve(root, "scripts/type-probe-inline.ts");
  await withProbes(
    [
      [
        path,
        '/* eslint @typescript-eslint/explicit-function-return-type: "off" */\nexport function value(input: string) { return input.length; }\n',
      ],
    ],
    () => {
      rejects(
        "node_modules/eslint/bin/eslint.js",
        [path],
        [/@typescript-eslint\/explicit-function-return-type/],
      );
      rejects(
        "scripts/type-coverage.mjs",
        [],
        [
          /scripts\/type-probe-inline\.ts: type or lint suppression is forbidden/,
        ],
      );
    },
  );
});

test("coverage rejects new files outside projects and JavaScript Vue scripts", async () => {
  const omitted = resolve(root, "web/type-probe.ts");
  const untypedVue = resolve(root, "web/src/type-probe.vue");
  const mixedVue = resolve(root, "web/src/type-probe-mixed.vue");
  await withProbes(
    [
      [omitted, "export const omitted = true;\n"],
      [
        untypedVue,
        "<script setup>const value = 1;</script>\n<template>{{ value }}</template>\n",
      ],
      [
        mixedVue,
        '<script setup lang="ts">const value = 1;</script>\n<script>export default {};</script>\n<template>{{ value }}</template>\n',
      ],
    ],
    () => {
      rejects(
        "scripts/type-coverage.mjs",
        [],
        [
          /web\/type-probe\.ts: outside checked projects/,
          /web\/src\/type-probe\.vue: every Vue script must use lang="ts"/,
          /web\/src\/type-probe-mixed\.vue: every Vue script must use lang="ts"/,
        ],
      );
    },
  );
});

test("coverage rejects tracked files outside compiler and typed lint", async () => {
  const omitted = resolve(root, "web/type-probe-tracked.ts");
  const moduleFile = resolve(root, "web/type-probe-tracked.mts");
  const commonJsFile = resolve(root, "web/type-probe-tracked.cts");
  const ignored = resolve(root, ".audit/type-probe-ignored.ts");
  await withProbes(
    [
      [omitted, "export const omitted = true;\n"],
      [moduleFile, "export const omitted = true;\n"],
      [commonJsFile, "export const omitted = true;\n"],
      [ignored, "export const ignored = true;\n"],
    ],
    () => {
      try {
        execFileSync(
          "git",
          [
            "add",
            "-f",
            "-N",
            "--",
            "web/type-probe-tracked.ts",
            "web/type-probe-tracked.mts",
            "web/type-probe-tracked.cts",
            ".audit/type-probe-ignored.ts",
          ],
          { cwd: root },
        );
        rejects(
          "scripts/type-coverage.mjs",
          [],
          [
            /web\/type-probe-tracked\.ts: outside checked projects/,
            /web\/type-probe-tracked\.mts: outside checked projects/,
            /web\/type-probe-tracked\.cts: outside checked projects/,
            /\.audit\/type-probe-ignored\.ts: outside typed ESLint coverage/,
          ],
        );
      } finally {
        execFileSync(
          "git",
          [
            "reset",
            "-q",
            "--",
            "web/type-probe-tracked.ts",
            "web/type-probe-tracked.mts",
            "web/type-probe-tracked.cts",
            ".audit/type-probe-ignored.ts",
          ],
          { cwd: root },
        );
      }
    },
  );
});

const eslint = new ESLint({ cwd: root });
for (const [name, source, rejected] of [
  [
    "exactly 1000 physical lines",
    "// kept\n".repeat(999) + "export {};\n",
    false,
  ],
  [
    "1001 lines including comments",
    "// kept\n".repeat(1000) + "export {};\n",
    true,
  ],
  ["1001 blank lines", "\n".repeat(1001), true],
  [
    "an inline attempt to disable the cap",
    "/* eslint max-lines: off */\n" + "// kept\n".repeat(1000),
    true,
  ],
]) {
  test(`configured ESLint ${rejected ? "refuses" : "accepts"} ${name}`, async () => {
    const result = await eslint.lintText(source, {
      filePath: join(root, "release/line-limit-proof.mjs"),
    });
    const errors = result.flatMap((file) =>
      file.messages.filter((message) => message.severity === 2),
    );
    if (rejected) {
      assert.ok(errors.some((message) => message.ruleId === "max-lines"));
    } else {
      assert.deepEqual(errors, []);
    }
  });
}
