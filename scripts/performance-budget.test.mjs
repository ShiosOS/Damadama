import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "damadama-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">',
  );
  await writeFile(join(directory, "assets/app.js"), "console.info('built');");
  await writeFile(join(directory, "assets/app.css"), "body { color: black }");
  return { directory, report: join(directory, "report.json") };
}

test("accepts a complete small build and reports exact asset counts", async (t) => {
  const { directory, report } = await fixture(t);
  await run(process.execPath, [
    "scripts/performance-budget.mjs",
    directory,
    report,
  ]);
  const result = JSON.parse(await readFile(report, "utf8"));
  assert.equal(result.assetCount, 2);
  assert.equal(result.categories.javascript.assetCount, 1);
  assert.equal(result.categories.css.assetCount, 1);
  assert.ok(result.totalGzipBytes > 0);
  assert.deepEqual(result.violations, []);
});

test("rejects JavaScript above the committed gzip budget", async (t) => {
  const { directory, report } = await fixture(t);
  await writeFile(join(directory, "assets/app.js"), randomBytes(200_000));
  await assert.rejects(
    run(process.execPath, [
      "scripts/performance-budget.mjs",
      directory,
      report,
    ]),
    (error) =>
      error.code === 1 &&
      /javascript gzip bytes .* exceed 170000/.test(error.stderr),
  );
  const result = JSON.parse(await readFile(report, "utf8"));
  assert.ok(result.categories.javascript.gzipBytes > 170_000);
  assert.equal(result.violations.length, 1);
});

test("rejects a linked font outside the inventoried assets directory", async (t) => {
  const { directory, report } = await fixture(t);
  await writeFile(join(directory, "oversized.woff2"), randomBytes(400_000));
  await writeFile(
    join(directory, "assets/app.css"),
    "@font-face { src: url('../oversized.woff2'); }",
  );
  await assert.rejects(
    run(process.execPath, [
      "scripts/performance-budget.mjs",
      directory,
      report,
    ]),
    (error) =>
      error.code === 1 &&
      /Referenced asset oversized\.woff2 is outside the inventoried assets directory/.test(
        error.stderr,
      ),
  );
});

test("rejects an entrypoint that references a missing asset", async (t) => {
  const { directory, report } = await fixture(t);
  await rm(join(directory, "assets/app.css"));
  await assert.rejects(
    run(process.execPath, [
      "scripts/performance-budget.mjs",
      directory,
      report,
    ]),
    (error) =>
      error.code === 1 &&
      /Missing referenced asset assets\/app.css/.test(error.stderr),
  );
});

test("rejects an empty build instead of reporting zero-byte success", async (t) => {
  const { directory, report } = await fixture(t);
  await rm(join(directory, "assets"), { recursive: true });
  await writeFile(
    join(directory, "index.html"),
    "<div>No production assets</div>",
  );
  await assert.rejects(
    run(process.execPath, [
      "scripts/performance-budget.mjs",
      directory,
      report,
    ]),
    (error) =>
      error.code === 1 &&
      /Missing production assets directory/.test(error.stderr),
  );
});
