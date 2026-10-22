import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { digest, passiveRuntimeProof } from "../quiet-save-source.mjs";

export async function runNativeBoundary() {
  const repository = process.cwd();
  const parent = resolve(".audit/passive-admission-correction");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "native-"));
  const canonical = await readFile("tests/Browser/compatibility.pw.ts", "utf8");
  const visual = await readFile("tests/Browser/visual-support.ts", "utf8");
  const ast = (bytes) =>
    ts.createSourceFile("original.ts", bytes, ts.ScriptTarget.Latest, true);
  const declaration = (bytes, name) => {
    const file = ast(bytes);
    const node = file.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert(node, `Original ${name} declaration must exist.`);
    return node.getText(file);
  };
  const mutation = declaration(canonical, "mutationControl");
  const missing = declaration(canonical, "missingControl");
  const nonempty = declaration(visual, "nonemptyDiffs");
  const visualAst = ast(visual);
  const options = visualAst.statements
    .find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(visualAst) === "screenshotOptions",
        ),
    )
    .getText(visualAst);
  const sequenceStart = visual.indexOf(
    "  await expect(target).toHaveScreenshot(",
  );
  const sequenceEnd = visual.indexOf(
    "  expect(image).toMatchSnapshot(`${checkpoint.id}.png`);",
    sequenceStart,
  );
  assert(sequenceStart > 0 && sequenceEnd > sequenceStart);
  const sequence = visual.slice(
    sequenceStart,
    sequenceEnd +
      "  expect(image).toMatchSnapshot(`${checkpoint.id}.png`);".length,
  );
  const url = (path) => JSON.stringify(pathToFileURL(resolve(path)).href);
  const manifest = JSON.parse(
    await readFile("tests/Browser/baselines/manifest.json", "utf8"),
  );
  const results = [];
  for (const mode of ["normal", "mutation", "missing", "restoration-failure"]) {
    for (const passive of [false, true]) {
      const directory = resolve(
        root,
        `${mode}-${passive ? "passive" : "direct"}`,
      );
      await mkdir(resolve(directory, "tests/Browser/baselines"), {
        recursive: true,
      });
      await writeFile(
        resolve(directory, "tests/Browser/baselines/manifest.json"),
        JSON.stringify(manifest),
      );
      const sourcePath = resolve(directory, "boundary.pw.ts");
      const source = `import {test, expect, type Page, type TestInfo, type Locator} from "@playwright/test";
import {access, readFile, writeFile, mkdir, readdir} from "node:fs/promises";
import {join} from "node:path";
import {digest} from ${url(".github/diagnostics/quiet-save-source.mjs")};
import {retainFailureMedia} from ${url(".github/diagnostics/quiet-save-media.mjs")};
import {installPassiveSaveHooks} from ${url(".github/diagnostics/quiet-save-passive.mjs")};
const baselineDir = "tests/Browser/baselines";
${options}
${nonempty}
${mutation}
${missing}
let bodyCompleted = false;
test.beforeEach(async ({page, browser}, info) => {
  await page.setContent('<section aria-label="Saved habits"><article class="habit-row" style="padding-top:8px">Owned toy pixels</article></section>');
  const image = await page.getByRole("region", {name: "Saved habits"}).screenshot(screenshotOptions);
  await writeFile(join(baselineDir, "desktop-saved.png"), image);
  const manifest = JSON.parse(await readFile(join(baselineDir, "manifest.json"), "utf8"));
  manifest.images.find(image => image.id === "desktop-saved").sha256 = digest(image);
  await writeFile(join(baselineDir, "manifest.json"), JSON.stringify(manifest));
  await info.attach("boundary-engine", {body: JSON.stringify({browserVersion: browser.version(), platform: process.platform, node: process.version}), contentType: "application/json"});
  if (process.env.BOUNDARY_MODE === "restoration-failure") await page.evaluate(() => {
    new MutationObserver(records => {
      if (records.some(record => [...record.removedNodes].some(node => node.nodeName === "STYLE")))
        document.querySelector("section").style.backgroundColor = "red";
    }).observe(document.documentElement, {childList: true, subtree: true});
  });
});
test("desktop creation and saved details remain stable", async ({page}, testInfo) => {
  const checkpoint = {id: "desktop-saved"};
  const target = page.getByRole("region", {name: "Saved habits"});
${sequence}
  if (["mutation", "restoration-failure"].includes(process.env.BOUNDARY_MODE)) await mutationControl(page, testInfo);
  if (process.env.BOUNDARY_MODE === "missing") await missingControl(page);
  bodyCompleted = true;
});
test.afterEach(async ({}, info) => {
  await info.attach("boundary-body", {body: JSON.stringify({bodyCompleted}), contentType: "application/json"});
  if (bodyCompleted) expect(false, "External boundary-only failure after successful original body").toBe(true);
});
if (process.env.BOUNDARY_PASSIVE === "1") installPassiveSaveHooks();
else test.afterEach(async ({}, info) => {
  const owner = {control: "presave-assertion", iteration: 0, phase: "calibration", project: "chromium-desktop", case: 1};
  const media = await retainFailureMedia({outputDir: info.outputDir, outputRoot: info.project.outputDir, started: 0, owner, head: "a".repeat(40), selfTest: true});
  await info.attach("quiet-save-media", {body: Buffer.from(JSON.stringify(media)), contentType: "application/json"});
});
`;
      for (const [name, original] of [
        ["mutationControl", mutation],
        ["missingControl", missing],
        ["nonemptyDiffs", nonempty],
      ])
        assert.equal(
          declaration(source, name),
          original,
          `Entire ${name} declaration bytes must remain unchanged.`,
        );
      assert(source.includes(sequence));
      await writeFile(sourcePath, source);
      const reporter = `import Reporter from ${url(".github/diagnostics/quiet-save-reporter.mjs")};
import {passiveSites} from ${url(".github/diagnostics/quiet-save-source.mjs")};
import {readFileSync, writeFileSync} from "node:fs";
export default class BoundaryReporter extends Reporter {
  constructor() {
    const directory = process.cwd();
    process.chdir(${JSON.stringify(repository)});
    super();
    process.chdir(directory);
    const source = {source: "canonical-test", path: ${JSON.stringify(sourcePath)}, bytes: readFileSync(${JSON.stringify(sourcePath)}, "utf8")};
    this.sources = [{...source, sites: passiveSites(source)}];
    this.directory = ${JSON.stringify(resolve(directory, "receipts"))};
  }
  onTestEnd(test, result) {
    const body = result.attachments.find(item => item.name === "boundary-body");
    const engine = result.attachments.find(item => item.name === "boundary-engine");
    writeFileSync(${JSON.stringify(resolve(directory, "runtime.json"))}, JSON.stringify({
      status: result.status, body: body && JSON.parse(body.body.toString()), engine: engine && JSON.parse(engine.body.toString()), errors: result.errors,
      outputDir: test.outputDir,
    }));
    super.onTestEnd(test, result);
  }
}
`;
      await writeFile(resolve(directory, "reporter.mjs"), reporter);
      const launchOptions = {};
      if (process.env.QUIET_BOUNDARY_EXECUTABLE)
        launchOptions.executablePath = process.env.QUIET_BOUNDARY_EXECUTABLE;
      await writeFile(
        resolve(directory, "config.mjs"),
        `export default ${JSON.stringify({
          testDir: directory,
          testMatch: "boundary.pw.ts",
          outputDir: resolve(directory, "results"),
          snapshotPathTemplate: resolve(
            directory,
            "tests/Browser/baselines/{arg}{ext}",
          ),
          updateSnapshots: "none",
          workers: 1,
          retries: 0,
          timeout: 30000,
          reporter: [[resolve(directory, "reporter.mjs")]],
          projects: [
            {
              name: "chromium-desktop",
              use: {
                browserName: "chromium",
                baseURL: "http://127.0.0.1:1",
                viewport: { width: 1280, height: 900 },
                launchOptions,
              },
            },
          ],
        })};\n`,
      );
      const exitCode = await new Promise((done, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolve(repository, "node_modules/@playwright/test/cli.js"),
            "test",
            "--config",
            resolve(directory, "config.mjs"),
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              TEMP: directory,
              TMP: directory,
              TMPDIR: directory,
              QUIET_SELF_TEST: "1",
              QUIET_PROFILE: "passive",
              QUIET_CONTROL: "presave-assertion",
              QUIET_ITERATION: "0",
              QUIET_PHASE: "calibration",
              COMPAT_CURRENT_SHA: "a".repeat(40),
              BOUNDARY_MODE: mode,
              BOUNDARY_PASSIVE: passive ? "1" : "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.once("error", reject);
        child.once("close", async (code) => {
          await writeFile(resolve(directory, "runner.log"), output);
          done(code);
        });
      });
      assert.equal(
        exitCode,
        1,
        `Boundary ${mode} must fail only at its expected assertion; ${directory}`,
      );
      const runtime = JSON.parse(
        await readFile(resolve(directory, "runtime.json"), "utf8"),
      );
      const receipt = await readFile(
        resolve(directory, "receipts/presave-assertion-0.jsonl"),
        "utf8",
      );
      const nativeFiles = (
        await readdir(resolve(directory, "results"), { recursive: true })
      )
        .filter((name) => name.endsWith(".png"))
        .map((name) => basename(name))
        .sort();
      results.push({ mode, passive, directory, runtime, receipt, nativeFiles });
    }
  }
  const proof = {
    label:
      "Local toy boundary replay, not the canonical application or hosted Linux visual proof. Manifest environments are schema-only copies, not observed environment equivalence.",
    runtime: passiveRuntimeProof(),
    canonicalSha256: digest(canonical),
    visualSha256: digest(visual),
    copiedDeclarationSha256: {
      mutationControl: digest(mutation),
      missingControl: digest(missing),
      nonemptyDiffs: digest(nonempty),
    },
    sequenceSha256: digest(sequence),
    results,
  };
  await writeFile(resolve(root, "proof.json"), JSON.stringify(proof, null, 2));
  return proof;
}
