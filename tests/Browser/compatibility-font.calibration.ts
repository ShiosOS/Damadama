import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { z } from "zod";
import {
  beginFontEvidence,
  finishFontEvidence,
  recordSaveMarker,
} from "./font-evidence";
import { sourceRoot } from "./font-evidence-admission";
import { calibrationMode } from "./font-evidence-schema";
import { startToy, type Toy } from "./font-calibration-server";
import {
  captureOrCompare,
  checkpointFor,
  clockInstant,
  candidateDir,
} from "./visual-support";

let toy: Toy | null = null;
let previousCwd = "";
let privateCwd = "";
let counts: number[] = [];
let baselineListeners: unknown[] = [];
let ownedListeners: unknown[] = [];
let validated = false;
let mixed: { text: string; loaded: string[] } | null = null;
const nativeEvent = z.object({ event: z.enum(["invalid", "submit"]) }).strict();
let nativeEvents: z.infer<typeof nativeEvent>["event"][] = [];
function unrelatedListener(): void {}
const events = [
  "request",
  "response",
  "requestfinished",
  "requestfailed",
  "framenavigated",
  "close",
];
function listeners(page: Page): number[] {
  const count = z
    .function({ input: [z.string()], output: z.number().int().nonnegative() })
    .parse(Reflect.get(page, "listenerCount"));
  return events.map((event) => count.call(page, event));
}
function references(page: Page): unknown[] {
  const list = z
    .function({ input: [z.string()], output: z.array(z.unknown()) })
    .parse(Reflect.get(page, "listeners"));
  return events.flatMap((event) => list.call(page, event));
}

test.beforeEach(async ({ page }, info) => {
  validated = false;
  mixed = null;
  nativeEvents = [];
  const mode = calibrationMode.parse(info.title);
  previousCwd = process.cwd();
  const audit = join(sourceRoot, ".audit/browser-font-implementation");
  await mkdir(audit, { recursive: true });
  privateCwd = await mkdtemp(join(audit, `${mode}-`));
  assert.equal(await realpath(privateCwd), privateCwd);
  const metadataDir = join(privateCwd, "node_modules/@playwright/test");
  await mkdir(metadataDir, { recursive: true });
  await copyFile(
    join(sourceRoot, "node_modules/@playwright/test/package.json"),
    join(metadataDir, "package.json"),
  );
  process.chdir(privateCwd);
  process.env["COMPAT_MODE"] = "capture";
  process.env["COMPAT_OS_DISTRIBUTION"] = "ubuntu";
  process.env["COMPAT_OS_VERSION"] = "24.04";
  toy = await startToy(mode);
  page.on("request", unrelatedListener);
  page.on("close", unrelatedListener);
  process.env["DAMADAMA_BROWSER_PORT"] = String(toy.port);
  if (["invalid-form", "held-response", "later-font-failure"].includes(mode)) {
    page.on("console", (message) => {
      const text = message.text();
      if (!text.startsWith("compatibility-form ") || text.length > 1024) return;
      const payload: unknown = JSON.parse(
        text.slice("compatibility-form ".length),
      );
      const observed = nativeEvent.parse(payload);
      assert.ok(nativeEvents.length < 8);
      nativeEvents.push(observed.event);
      console.info("compatibility-form", JSON.stringify(observed));
    });
    page.on("request", (request) => {
      if (request.method() === "POST")
        console.info("compatibility-diagnostic create-request");
    });
    page.on("response", (response) => {
      if (response.request().method() === "POST")
        console.info(
          `compatibility-diagnostic create-response ${response.status()}`,
        );
    });
  }
  counts = listeners(page);
  baselineListeners = references(page);
  if (mode === "refused")
    process.env["COMPAT_FONT_CONTEXT"] =
      '{"privacy-canary-invalid-context":true}';
  await beginFontEvidence(page, info);
  ownedListeners = references(page).filter(
    (listener) => !baselineListeners.includes(listener),
  );
});

test.afterEach(async ({ page }, info) => {
  finishFontEvidence(page, info);
  finishFontEvidence(page, info);
  const actual = listeners(page);
  const remaining = references(page);
  const ownedRemaining = ownedListeners.filter((listener) =>
    remaining.includes(listener),
  ).length;
  const unrelatedPreserved =
    remaining.filter((listener) => listener === unrelatedListener).length === 2;
  const owned = toy;
  try {
    assert.equal(
      ownedRemaining,
      0,
      "exact font listeners detach after every status and page close",
    );
    assert.equal(
      unrelatedPreserved,
      true,
      "font teardown preserves unrelated listeners",
    );
  } finally {
    await owned?.close();
    toy = null;
    process.chdir(previousCwd);
    await writeFile(
      join(privateCwd, "lifecycle.json"),
      JSON.stringify({
        mode: info.title,
        status: info.status,
        before: counts,
        after: actual,
        ownedInstalled: ownedListeners.length,
        ownedRemaining,
        unrelatedPreserved,
        partial: owned?.partial() ?? false,
        posts: owned?.posts() ?? 0,
        released: owned?.released() ?? false,
        validated,
        mixed,
        nativeEvents,
        platform: process.platform,
        nodeVersion: process.version,
        ubuntuStrings: "fixture-inputs-only",
        cwdRestored: process.cwd() === previousCwd,
      }),
    );
  }
});

for (const mode of calibrationMode.options) {
  test(mode, async ({ page, browser }, info) => {
    const owned = toy;
    if (!owned) throw new Error("Owned toy server missing.");
    await page.clock.setFixedTime(new Date(clockInstant));
    if (mode === "abort")
      await page.route("**/assets/*.woff2", (route) => route.abort("aborted"));
    await page.goto(owned.origin, { waitUntil: "domcontentloaded" });
    if (mode === "mixed")
      assert.equal(await page.locator("p").textContent(), "Walking Прогулка");
    const checkpoint = checkpointFor("chromium-desktop", "desktop-creation");
    if (mode === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    if (mode === "invalid-form" || mode === "held-response")
      await captureOrCompare(page, browser, info, checkpoint, page);
    if (
      ["invalid-form", "held-response", "later-font-failure"].includes(mode)
    ) {
      await page.evaluate(() => {
        for (const event of ["invalid", "submit"])
          document.addEventListener(
            event,
            () => console.info("compatibility-form", JSON.stringify({ event })),
            true,
          );
      });
      const created = page.waitForResponse(
        (response) => response.request().method() === "POST",
      );
      recordSaveMarker(page, "create-waiter-armed");
      await page.getByRole("button", { name: "Save habit" }).focus();
      console.info("compatibility-diagnostic before-save-enter");
      await page.keyboard.press("Enter");
      console.info("compatibility-diagnostic after-save-enter");
      recordSaveMarker(page, "create-response-await-start");
      const response = await created;
      recordSaveMarker(page, "create-response-await-complete");
      expect(response.status()).toBe(201);
      z.object({ saved: z.literal(true) })
        .strict()
        .parse(await response.json());
      recordSaveMarker(page, "create-json-complete");
      await expect(page.locator("#saved")).toHaveText("Saved");
      recordSaveMarker(page, "saved-assertions-complete");
    }
    const capture = captureOrCompare(page, browser, info, checkpoint, page);
    if (mode === "delayed") {
      let finished = false;
      void capture.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      assert.equal(finished, false);
      await owned.release();
      assert.equal(
        finished,
        false,
        "Release occurs while the actual guard is pending.",
      );
    }
    if (
      ["abort", "corrupt", "missing", "unused", "later-font-failure"].includes(
        mode,
      )
    ) {
      await assert.rejects(capture, {
        name: "Error",
        message: "Bundled Nunito Variable FontFace did not load.",
      });
    } else {
      await capture;
      if (mode === "mixed") {
        mixed = await page.evaluate(() => ({
          text: document.querySelector("p")?.textContent ?? "",
          loaded: [...document.fonts]
            .filter(
              (face) =>
                face.family.replaceAll('"', "") === "Nunito Variable" &&
                face.status === "loaded",
            )
            .map((face) => face.unicodeRange),
        }));
        assert.equal(mixed.text, "Walking Прогулка");
        assert.equal(mixed.loaded.length, 2);
        assert.ok(mixed.loaded.some((range) => range.includes("U+400-45F")));
        assert.ok(mixed.loaded.some((range) => range.includes("U+0-FF")));
      }
      const image = await readFile(join(candidateDir, "desktop-creation.png"));
      assert.ok(image.length > 8);
      assert.deepEqual(
        [...image.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }
    validated = true;
    if (mode === "pass") return;
    if (mode === "skip") test.skip();
    if (mode === "page-close") await page.close();
    throw new Error("privacy-canary-deliberate-failure");
  });
}
