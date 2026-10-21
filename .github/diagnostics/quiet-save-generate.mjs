import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  sourceProof,
  digest,
  passivePreparationProof,
} from "./quiet-save-source.mjs";

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Quiet observation anchor is not unique.");
  return source.replace(before, after);
}

export function instrument(source) {
  source = replaceOnce(
    source,
    "  await openByKeyboard(page);",
    '  quiet.mark(page, "phase-boundary", { stage: "dialog-open", edge: "start" });\n  await openByKeyboard(page);\n  quiet.mark(page, "phase-boundary", { stage: "dialog-open", edge: "complete" });',
  );
  source = replaceOnce(
    source,
    "  if (beforeSave) await beforeSave();",
    '  if (beforeSave) {\n    quiet.mark(page, "phase-boundary", { stage: "creation-comparison", edge: "start" });\n    if (process.env["QUIET_CONTROL"] === "presave-assertion") expect(false).toBe(true);\n    if (process.env["QUIET_CONTROL"] === "pixel-mismatch") await page.getByRole("dialog", { name: "Create a habit" }).evaluate(element => { element.style.border = "30px solid rgb(255, 0, 0)"; });\n    await beforeSave();\n    quiet.mark(page, "phase-boundary", { stage: "creation-comparison", edge: "complete" });\n  }',
  );
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

export async function prepare() {
  const source = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
  if (source.includes("compatibility-diagnostic"))
    throw new Error(
      "Quiet probe requires the canonical uninstrumented source.",
    );
  const generated = instrument(source);
  const legacy = sourceProof(
    source,
    generated,
    await readFile("tests/Browser/visual-support.ts", "utf8"),
  );
  const config = (
    entry,
  ) => `import shared from "../../tests/Browser/compatibility.config";
export default {
  ...shared,
  testDir: ".",
  testMatch: "${entry}",
  snapshotPathTemplate: ${JSON.stringify(resolve("tests/Browser/baselines/{arg}{ext}").replaceAll("\\", "/"))},
  reporter: [[${JSON.stringify(resolve(".github/diagnostics/quiet-save-reporter.mjs").replaceAll("\\", "/"))}]],
};
`;
  let runner = await readFile("tests/Browser/compatibility-run.ts", "utf8");
  runner = replaceOnce(
    runner,
    '"./visual-support"',
    '"../../tests/Browser/visual-support"',
  );
  runner = replaceOnce(
    runner,
    '"tests/Browser/compatibility.config.ts"',
    '".audit/quiet-save/passive.config.ts"',
  );
  runner = replaceOnce(
    runner,
    "      COMPAT_MODE: mode,",
    "      QUIET_PHASE: phase,\n      COMPAT_MODE: mode,",
  );
  const files = {
    "observed.pw.ts": generated,
    "observed.config.ts": config("observed.pw.ts"),
    "passive.pw.ts":
      'import "../../tests/Browser/compatibility.pw";\nimport { installPassiveSaveHooks } from "../../.github/diagnostics/quiet-save-passive.mjs";\ninstallPassiveSaveHooks();\n',
    "passive.config.ts": config("passive.pw.ts"),
    "calibration.pw.ts":
      'import "../../tests/Browser/compatibility.pw";\nimport { test, expect } from "@playwright/test";\nimport { installPassiveSaveHooks } from "../../.github/diagnostics/quiet-save-passive.mjs";\ntest.afterEach(({}, info) => { if (info.status === "passed") for (let index = 0; index < 8; index++) expect.soft(index).toBe(-1); });\ninstallPassiveSaveHooks();\n',
    "calibration.config.ts": config("calibration.pw.ts"),
    "observed-run.ts": runner,
  };
  const proof = {
    ...legacy,
    mode: "canonical-import",
    passive: passivePreparationProof(files),
  };
  return { files, proof };
}

export async function generate() {
  const directory = resolve(".audit/quiet-save");
  await mkdir(directory, { recursive: true });
  const { files, proof } = await prepare();
  for (const [name, bytes] of Object.entries(files))
    await writeFile(resolve(directory, name), bytes);
  await writeFile(
    resolve(directory, "source-map.json"),
    JSON.stringify(proof) + "\n",
  );
  return {
    mode: "canonical-import",
    preparationSha256: digest(JSON.stringify(proof)),
    canonicalSha256: proof.canonicalSha256,
    generatedSha256: proof.generatedSha256,
    visualSupportSha256: proof.visualSupportSha256,
    mappingSha256: proof.mappingSha256,
  };
}
