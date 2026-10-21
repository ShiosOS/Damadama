import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Quiet observation anchor is not unique.");
  return source.replace(before, after);
}

export function instrument(source) {
  for (const [action, stage] of [
    ["  await page.keyboard.type(habitName);", '"Name"'],
    [
      '    await page.keyboard.press("Tab");\n    await expect(dialog.getByLabel(label, { exact: true })).toBeFocused();\n    await page.keyboard.type(value);',
      "label",
    ],
  ]) {
    source = replaceOnce(
      source,
      action,
      `  quiet.mark(page, "fill-boundary", { stage: ${stage}, edge: "before" });\n${action}\n  quiet.mark(page, "fill-boundary", { stage: ${stage}, edge: "after" });`,
    );
  }
  for (const [before, after, stage] of [
    [
      "  const repeat = dialog.getByLabel",
      '  await expect(repeat).toHaveValue("2");',
      "repeat",
    ],
    [
      "  const save = dialog.getByRole",
      "  await expect(save).toBeFocused();",
      "save-focus",
    ],
  ]) {
    source = replaceOnce(
      source,
      before,
      `  quiet.mark(page, "fill-boundary", { stage: "${stage}", edge: "before" });\n${before}`,
    );
    source = replaceOnce(
      source,
      after,
      `${after}\n  quiet.mark(page, "fill-boundary", { stage: "${stage}", edge: "after" });`,
    );
  }
  source = replaceOnce(
    source,
    "  for (const day of [",
    '  quiet.mark(page, "fill-boundary", { stage: "weekdays", edge: "before" });\n  for (const day of [',
  );
  source = replaceOnce(
    source,
    "  const repeat = dialog.getByLabel",
    '  quiet.mark(page, "fill-boundary", { stage: "weekdays", edge: "after" });\n  const repeat = dialog.getByLabel',
  );
  source = replaceOnce(
    source,
    '"./visual-support"',
    '"../../tests/Browser/visual-support"',
  );
  source = replaceOnce(
    source,
    '  quiet.mark(page, "fill-boundary", { stage: "save-focus", edge: "after" });\n  await page.keyboard.press("Enter");',
    '  quiet.mark(page, "fill-boundary", { stage: "save-focus", edge: "after" });\n  if (quiet.isDeadline(page) && !(await quiet.deadlineGate(page))) return;\n  quiet.mark(page, "enter-sent");\n  await page.keyboard.press("Enter");\n  quiet.mark(page, "enter-returned");',
  );
  source = replaceOnce(
    source,
    "  await fillAndSave(page);",
    '  quiet.mark(page, "waiter-armed");\n  await fillAndSave(page);',
  );
  source = replaceOnce(
    source,
    "  await page.reload();",
    "  await quiet.preserveBeforeReload(page);\n  await page.reload();",
  );
  return (
    'import * as quiet from "../../.github/diagnostics/quiet-save-observer.mjs";\n' +
    source +
    `
test.beforeEach(async ({ page }) => {
  await quiet.begin(page, process.env["QUIET_CONTROL"] ?? "normal");
});
test.afterEach(async ({ page }, testInfo) => {
  await quiet.finish(page, testInfo);
});
`
  );
}

export async function generate() {
  const directory = resolve(".audit/quiet-save");
  await mkdir(directory, { recursive: true });
  const source = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
  if (source.includes("compatibility-diagnostic"))
    throw new Error(
      "Quiet probe requires the canonical uninstrumented source.",
    );
  const generated = instrument(source);
  await writeFile(resolve(directory, "observed.pw.ts"), generated);
  await writeFile(
    resolve(directory, "observed.config.ts"),
    `import shared from "../../tests/Browser/compatibility.config";
export default {
  ...shared,
  testDir: ".",
  testMatch: "observed.pw.ts",
  snapshotPathTemplate: ${JSON.stringify(resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"))},
  reporter: [[${JSON.stringify(resolve(".github/diagnostics/quiet-save-reporter.mjs").replaceAll("\\", "/"))}]],
};
`,
  );
  let runner = await readFile("tests/Browser/compatibility-run.ts", "utf8");
  runner = replaceOnce(
    runner,
    '"./visual-support"',
    '"../../tests/Browser/visual-support"',
  );
  runner = replaceOnce(
    runner,
    '"tests/Browser/compatibility.config.ts"',
    '".audit/quiet-save/observed.config.ts"',
  );
  runner = replaceOnce(
    runner,
    "      COMPAT_MODE: mode,",
    "      QUIET_PHASE: phase,\n      COMPAT_MODE: mode,",
  );
  await writeFile(resolve(directory, "observed-run.ts"), runner);
  return {
    canonicalSha256: createHash("sha256").update(source).digest("hex"),
    generatedSha256: createHash("sha256").update(generated).digest("hex"),
  };
}
