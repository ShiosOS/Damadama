import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  bindingSchema,
  digest,
  subset,
  type Admission,
  type Binding,
} from "./font-evidence-schema";

export const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
export const manifestPath =
  "tests/Browser/compatibility-diagnostic-admission.json";
export const sourcePaths = [
  "tests/Browser/compatibility.pw.ts",
  "tests/Browser/visual-support.ts",
  "tests/Browser/font-evidence-schema.ts",
  "tests/Browser/font-evidence-admission.ts",
  "tests/Browser/font-evidence.ts",
  "tests/Browser/font-evidence-consumer.ts",
  "tests/Browser/font-evidence.test.ts",
  "tests/Browser/font-evidence-files.test.ts",
  "tests/Browser/compatibility-font.calibration.ts",
  "tests/Browser/font-calibration-server.ts",
  "tests/Browser/font-calibration-run.ts",
  "tests/Browser/font-calibration.config.ts",
  "tests/Browser/compatibility-run.ts",
  "tests/Browser/compatibility.config.ts",
  "tests/Browser/playwright.config.ts",
  "tests/Browser/compatibility.vite.config.ts",
  "tests/Browser/vite.config.ts",
  "tests/Browser/compatibility.html",
  "tests/Browser/main.ts",
  "tests/Browser/FixtureApp.vue",
  "web/src/style.css",
  "package.json",
  "web/package.json",
  "bun.lock",
  "tests/BrowserHost/Program.cs",
];
const entrySchema = z
  .object({ path: z.enum(sourcePaths), sha256: digest })
  .strict();
export const manifestSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(entrySchema).length(sourcePaths.length),
    installed: z.array(z.object({ subset, sha256: digest }).strict()).length(5),
    installedCss: digest,
    installedPlaywright: digest,
    installedNunitoPackage: digest,
  })
  .strict()
  .refine(
    (value) =>
      value.sources.every(
        (entry, index) => entry.path === sourcePaths[index],
      ) &&
      value.installed.every(
        (entry, index) => entry.subset === subset.options[index],
      ),
  );

export function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readInstalled(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error("installed");
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.isSymbolicLink() ||
    bytes.length !== before.size
  )
    throw new Error("installed");
  return bytes;
}

export async function readOwned(
  root: string,
  path: string,
  limit: number,
): Promise<Buffer> {
  const base = resolve(root);
  if ((await realpath(base)) !== base) throw new Error("ownership");
  const target = resolve(base, path);
  if (target === base || !target.startsWith(base + sep))
    throw new Error("ownership");
  for (let part = target; ; part = dirname(part)) {
    const stat = await lstat(part);
    if (stat.isSymbolicLink()) throw new Error("ownership");
    if (part === base) break;
  }
  const before = await lstat(target);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit)
    throw new Error("ownership");
  const bytes = await readFile(target);
  const after = await lstat(target);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    after.nlink !== 1 ||
    after.isSymbolicLink() ||
    bytes.length !== before.size
  )
    throw new Error("changed-file");
  return bytes;
}

async function inventory(
  root: string,
): Promise<{ path: string; sha256: string }[]> {
  const entries: { path: string; sha256: string }[] = [];
  let total = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = [directory, entry.name].filter(Boolean).join("/");
      if (!/^[A-Za-z0-9_./-]{1,160}$/.test(path) || entry.isSymbolicLink())
        throw new Error("inventory");
      if (entry.isDirectory()) {
        if (directory !== "" || entry.name !== "assets")
          throw new Error("inventory");
        await visit(path);
      } else {
        if (path === "fixture.json" && entry.isFile()) continue;
        if (entries.length >= 128) throw new Error("inventory");
        const bytes = await readOwned(root, path, 8 * 1024 * 1024);
        total += bytes.length;
        if (total > 16 * 1024 * 1024) throw new Error("inventory");
        entries.push({ path, sha256: hash(bytes) });
      }
    }
  }
  await visit("");
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function prepareAdmission(root = sourceRoot): Promise<Admission> {
  let stage: "unsupported-source" | "unsupported-build" = "unsupported-source";
  try {
    const raw = await readOwned(root, manifestPath, 32768);
    const input: unknown = JSON.parse(raw.toString("utf8"));
    const manifest = manifestSchema.parse(input);
    const tree = spawnSync(
      "git",
      ["ls-tree", "-r", "HEAD", "--", ...sourcePaths, manifestPath],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32768,
      },
    );
    if (tree.status !== 0) throw new Error("source");
    const blobs = new Map<string, string>();
    for (const row of tree.stdout.trim().split("\n")) {
      const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(row);
      if (!match?.[1] || !match[2]) throw new Error("source");
      blobs.set(match[2], match[1]);
    }
    for (const path of [...sourcePaths, manifestPath]) {
      const bytes = await readOwned(root, path, 1024 * 1024);
      const blob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blob !== blobs.get(path)) throw new Error("source");
      if (
        path !== manifestPath &&
        hash(bytes) !==
          manifest.sources.find((entry) => entry.path === path)?.sha256
      )
        throw new Error("source");
    }
    stage = "unsupported-build";
    const buildRoot = join(root, ".audit/browser-build");
    const entries = await inventory(buildRoot);
    const html = await readOwned(buildRoot, "compatibility.html", 32768);
    const htmlText = html.toString("utf8");
    const cssNames = [
      ...htmlText.matchAll(
        /<link rel="stylesheet" crossorigin href="\/(assets\/[A-Za-z0-9_-]+\.css)">/g,
      ),
    ].map((match) => match[1]);
    if (cssNames.length !== 1 || !cssNames[0]) throw new Error("css");
    const css = await readOwned(buildRoot, cssNames[0], 2 * 1024 * 1024);
    const cssText = css.toString("utf8");
    const packageRoot = await realpath(
      join(root, "node_modules/@fontsource-variable/nunito"),
    );
    const installedCss = await readInstalled(
      join(packageRoot, "index.css"),
      32768,
    );
    const playwrightRoot = await realpath(
      join(root, "node_modules/@playwright/test"),
    );
    if (
      hash(await readInstalled(join(playwrightRoot, "package.json"), 32768)) !==
        manifest.installedPlaywright ||
      hash(await readInstalled(join(packageRoot, "package.json"), 32768)) !==
        manifest.installedNunitoPackage
    )
      throw new Error("installed");
    if (hash(installedCss) !== manifest.installedCss)
      throw new Error("installed");
    const assets: Binding["assets"] = [];
    const faces = [...cssText.matchAll(/@font-face\{([^}]+)\}/g)].map(
      (match) => match[1] ?? "",
    );
    const nunito = faces.filter((face) =>
      /font-family:["']?Nunito Variable["']?;/.test(face),
    );
    if (nunito.length !== 5) throw new Error("css");
    for (const kind of subset.options) {
      const names = entries.filter((entry) =>
        new RegExp(
          `^assets/nunito-${kind}-wght-normal-[A-Za-z0-9_-]{8}\\.woff2$`,
        ).test(entry.path),
      );
      if (names.length !== 1 || !names[0]) throw new Error("font");
      const file = names[0].path;
      const bytes = await readOwned(buildRoot, file, 256 * 1024);
      const installed = await readInstalled(
        join(packageRoot, `files/nunito-${kind}-wght-normal.woff2`),
        256 * 1024,
      );
      if (
        !bytes.equals(installed) ||
        hash(installed) !==
          manifest.installed.find((entry) => entry.subset === kind)?.sha256
      )
        throw new Error("font");
      const matching = nunito.filter((face) =>
        face.includes(`src:url(/${file})format("woff2-variations");`),
      );
      if (matching.length !== 1) throw new Error("css");
      assets.push({
        subset: kind,
        file,
        sha256: hash(bytes),
        bytes: bytes.length,
      });
    }
    if (entries.filter((entry) => entry.path.endsWith(".woff2")).length !== 5)
      throw new Error("font");
    if (JSON.stringify(entries) !== JSON.stringify(await inventory(buildRoot)))
      throw new Error("changed-build");
    return {
      kind: "admitted",
      binding: bindingSchema.parse({
        manifest: hash(raw),
        source: hash(JSON.stringify(manifest.sources)),
        build: hash(JSON.stringify(entries)),
        html: hash(html),
        css: hash(css),
        assets,
        playwright: "1.64.1",
        nunito: "5.3.0",
        runtimeFixture: "excluded-unread",
      }),
    };
  } catch {
    return { kind: "refused", reason: stage };
  }
}

export function fontSelection(
  binding: Binding,
  origin: string,
): (url: string) => Binding["assets"][number] | null {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) ||
    new URL(origin).port === ""
  )
    throw new Error("origin");
  const assets = new Map(
    binding.assets.map((asset) => [`${origin}/${asset.file}`, asset]),
  );
  return (url) => assets.get(url) ?? null;
}
