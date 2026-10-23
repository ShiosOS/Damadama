import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fontSelection,
  hash,
  manifestPath,
  prepareAdmission,
  readOwned,
  sourcePaths,
  sourceRoot,
} from "./font-evidence-admission";
import {
  contextSchema,
  frameSchema,
  prefix,
  subset,
  type Binding,
} from "./font-evidence-schema";
import { runCompatibilityChild } from "./font-evidence-consumer";

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
}
async function fixture(root: string): Promise<void> {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "core.autocrlf", "false"]);
  const sources = [];
  for (const path of sourcePaths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "source\n");
    sources.push({ path, sha256: hash("source\n") });
  }
  const installed = [];
  let css = "";
  const packageRoot = join(root, "node_modules/@fontsource-variable/nunito");
  await mkdir(join(packageRoot, "files"), { recursive: true });
  await mkdir(join(root, ".audit/browser-build/assets"), { recursive: true });
  for (const kind of subset.options) {
    const bytes = await readFile(
      join(
        sourceRoot,
        `node_modules/@fontsource-variable/nunito/files/nunito-${kind}-wght-normal.woff2`,
      ),
    );
    await writeFile(
      join(packageRoot, `files/nunito-${kind}-wght-normal.woff2`),
      bytes,
    );
    await writeFile(
      join(
        root,
        `.audit/browser-build/assets/nunito-${kind}-wght-normal-12345678.woff2`,
      ),
      bytes,
    );
    installed.push({ subset: kind, sha256: hash(bytes) });
    css += `@font-face{font-family:Nunito Variable;src:url(/assets/nunito-${kind}-wght-normal-12345678.woff2)format("woff2-variations");}`;
  }
  const installedCss = await readFile(
    join(sourceRoot, "node_modules/@fontsource-variable/nunito/index.css"),
  );
  await writeFile(join(packageRoot, "index.css"), installedCss);
  const installedPlaywright = await readFile(
    join(sourceRoot, "node_modules/@playwright/test/package.json"),
  );
  const installedNunitoPackage = await readFile(
    join(sourceRoot, "node_modules/@fontsource-variable/nunito/package.json"),
  );
  await mkdir(join(root, "node_modules/@playwright/test"), { recursive: true });
  await writeFile(
    join(root, "node_modules/@playwright/test/package.json"),
    installedPlaywright,
  );
  await writeFile(join(packageRoot, "package.json"), installedNunitoPackage);
  await writeFile(
    join(root, ".audit/browser-build/compatibility.html"),
    '<link rel="stylesheet" crossorigin href="/assets/fixture.css">',
  );
  await writeFile(join(root, ".audit/browser-build/assets/fixture.css"), css);
  await writeFile(
    join(root, ".audit/browser-build/assets/fixture.js"),
    "globalThis.reviewed = true;",
  );
  const entries = [];
  for (const path of [
    "compatibility.html",
    ...(await readdir(join(root, ".audit/browser-build/assets"))).map(
      (name) => `assets/${name}`,
    ),
  ])
    entries.push({
      path,
      sha256: hash(await readFile(join(root, ".audit/browser-build", path))),
    });
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  await writeFile(
    join(root, manifestPath),
    JSON.stringify({
      version: 1,
      reviewedBuild: hash(JSON.stringify(entries)),
      sources,
      installed,
      installedCss: hash(installedCss),
      installedPlaywright: hash(installedPlaywright),
      installedNunitoPackage: hash(installedNunitoPackage),
    }),
  );
  git(root, ["add", "--", ...sourcePaths, manifestPath]);
  git(root, ["commit", "--quiet", "-m", "Fixture"]);
}

test.each([
  "web/src/HabitsPage.vue",
  "web/src/habits.ts",
  "web/src/new-source.ts",
])("unreviewed application source %s refuses admission", async (changed) => {
  const root = await mkdtemp(join(tmpdir(), "font-app-source-"));
  try {
    await fixture(root);
    expect((await prepareAdmission(root)).kind).toBe("admitted");
    await writeFile(join(root, changed), "unreviewed\n");
    if (changed !== "web/src/new-source.ts")
      expect(await prepareAdmission(root)).toEqual({
        kind: "refused",
        reason: "unsupported-source",
      });
    git(root, ["add", changed]);
    git(root, ["commit", "--quiet", "-m", "Unreviewed application"]);
    expect(await prepareAdmission(root)).toEqual({
      kind: "refused",
      reason: "unsupported-source",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["compatibility.html", "assets/fixture.css", "assets/fixture.js"])(
  "unreviewed emitted bytes %s require build review",
  async (changed) => {
    const root = await mkdtemp(join(tmpdir(), "font-reviewed-build-"));
    try {
      await fixture(root);
      expect((await prepareAdmission(root)).kind).toBe("admitted");
      const target = join(root, ".audit/browser-build", changed);
      const original = await readFile(target, "utf8");
      let changedBytes = "globalThis.unreviewed = true;";
      if (changed.endsWith(".html")) changedBytes = `<!--${original}-->`;
      if (changed.endsWith(".css")) changedBytes = `/*${original}*/`;
      await writeFile(target, changedBytes);
      expect(await prepareAdmission(root)).toEqual({
        kind: "refused",
        reason: "unsupported-build",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reviewed source and committed bytes, not current hashes alone, decide evidence admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "font-source-"));
  try {
    await fixture(root);
    expect((await prepareAdmission(root)).kind).toBe("admitted");
    for (const path of [
      "tests/Browser/visual-support.ts",
      "tests/Browser/font-evidence.ts",
      "tests/Browser/compatibility.config.ts",
      "web/src/style.css",
      "bun.lock",
    ]) {
      await writeFile(join(root, path), "unsupported\n");
      expect(await prepareAdmission(root)).toEqual({
        kind: "refused",
        reason: "unsupported-source",
      });
      git(root, ["add", path]);
      git(root, ["commit", "--quiet", "-m", "Unsupported fixture change"]);
      expect(await prepareAdmission(root)).toEqual({
        kind: "refused",
        reason: "unsupported-source",
      });
      await writeFile(join(root, path), "source\n");
      git(root, ["add", path]);
      git(root, ["commit", "--quiet", "-m", "Restore fixture"]);
    }
    expect((await prepareAdmission(root)).kind).toBe("admitted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("emitted CSS, HTML, exact installed bytes, duplicates, links and missing build files refuse safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "font-files-"));
  try {
    await fixture(root);
    for (const path of [
      ".audit/browser-build/assets/nunito-latin-wght-normal-12345678.woff2",
      "node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2",
      "node_modules/@fontsource-variable/nunito/index.css",
      ".audit/browser-build/assets/fixture.css",
      ".audit/browser-build/compatibility.html",
    ]) {
      const bytes = await readFile(join(root, path));
      await writeFile(join(root, path), "privacy-canary-changed-bytes");
      expect(await prepareAdmission(root)).toEqual({
        kind: "refused",
        reason: "unsupported-build",
      });
      await rm(join(root, path));
      expect((await prepareAdmission(root)).kind).toBe("refused");
      await writeFile(join(root, path), bytes);
    }
    const file = join(
      root,
      ".audit/browser-build/assets/nunito-latin-wght-normal-12345678.woff2",
    );
    const duplicate = join(
      root,
      ".audit/browser-build/assets/nunito-latin-wght-normal-87654321.woff2",
    );
    await cp(file, duplicate);
    expect((await prepareAdmission(root)).kind).toBe("refused");
    await rm(duplicate);
    await link(file, duplicate);
    expect((await prepareAdmission(root)).kind).toBe("refused");
    await rm(duplicate);
    await symlink(
      join(root, ".audit/browser-build/assets"),
      join(root, "linked-assets"),
      "junction",
    );
    await assert.rejects(
      readOwned(
        root,
        "linked-assets/nunito-latin-wght-normal-12345678.woff2",
        100000,
      ),
    );
    await assert.rejects(readOwned(root, "../privacy-canary", 100000));
    expect((await prepareAdmission(root)).kind).toBe("admitted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only exact main-origin font URLs select an admitted asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "font-urls-"));
  try {
    await fixture(root);
    const admission = await prepareAdmission(root);
    if (admission.kind !== "admitted")
      throw new Error("Fixture admission failed.");
    const asset: Binding["assets"][number] | undefined =
      admission.binding.assets[4];
    if (!asset) throw new Error("Fixture asset missing.");
    const origin = "http://127.0.0.1:5294";
    const select = fontSelection(admission.binding, origin);
    const url = `${origin}/${asset.file}`;
    expect(select(url)?.subset).toBe("latin");
    for (const foreign of [
      url + "?privacy-canary",
      url + "#privacy-canary",
      url + ".extra",
      url.replace("5294", "5295"),
      url.replace("127.0.0.1", "localhost"),
      url.replace("http://", "http://privacy-canary@"),
      url.replace("/assets/", "/other/"),
    ])
      expect(select(foreign)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BrowserHost runtime input is excluded unread while the real child consumer preserves status and proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "font-runtime-input-"));
  try {
    await fixture(root);
    const admission = await prepareAdmission(root);
    assert.equal(admission.kind, "admitted");
    const context = contextSchema.parse({
      run: "a".repeat(64),
      admission,
      phase: { mode: "verify", invocation: 1, control: "none" },
    });
    const data = [
      { kind: "navigation" },
      { kind: "entered", guard: 1, checkpoint: "desktop-creation" },
      { kind: "ready-fulfilled", guard: 1 },
      {
        kind: "decision",
        guard: 1,
        dispatchMs: 3,
        decision: {
          fontLoaded: true,
          sample: {
            kind: "available",
            sampledAt: "guard-decision",
            clock: "browser-performance",
            browserMs: 99,
            setStatus: "loaded",
            counts: { unloaded: 4, loading: 0, loaded: 1, error: 0 },
          },
        },
      },
    ];
    const frame = frameSchema.parse({
      version: 1,
      kind: "case-final",
      context,
      receipt: {
        identity: {
          scenario: "desktop",
          project: "chromium-desktop",
          retry: 0,
          ordinal: 0,
          calibration: null,
        },
        admission,
        timeout: 30000,
        startMs: 0,
        stopMs: 5,
        loss: "none",
        failureCategory: "unclassified",
        lifecycle: { kind: "disposed", detached: true, status: "failed" },
        legacyStream: "referenced-not-owned",
        events: data.map((event, index) => ({
          sequence: index + 1,
          clock: "node-performance",
          nodeMs: index + 1,
          document: 1,
          data: event,
        })),
      },
    });
    const result = await runCompatibilityChild({
      cwd: root,
      env: process.env,
      context,
      args: [
        "-e",
        `require('node:fs').writeFileSync('.audit/browser-build/fixture.json', 'privacy-canary-runtime-token'); console.log(${JSON.stringify(prefix + JSON.stringify(frame))}); console.error('original-child-failure'); process.exit(7);`,
      ],
    });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("original-child-failure");
    expect(result.consumption.kind).toBe("complete");
    expect(JSON.stringify(result)).not.toContain(
      "privacy-canary-runtime-token",
    );
    expect(await prepareAdmission(root)).toEqual(admission);
    await writeFile(
      join(root, ".audit/browser-build/fixture.json"),
      "a different runtime input",
    );
    expect(await prepareAdmission(root)).toEqual(admission);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
