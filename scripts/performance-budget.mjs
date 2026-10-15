import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const budgets = {
  javascript: 170_000,
  css: 32_000,
  fonts: 150_000,
  totalGzipBytes: 360_000,
  assetCount: 10,
};

const directory = resolve(process.argv[2] ?? "server/wwwroot");
const report = resolve(process.argv[3] ?? ".audit/performance-assets.json");
const categories = {
  javascript: { assetCount: 0, bytes: 0, gzipBytes: 0 },
  css: { assetCount: 0, bytes: 0, gzipBytes: 0 },
  fonts: { assetCount: 0, bytes: 0, gzipBytes: 0 },
  other: { assetCount: 0, bytes: 0, gzipBytes: 0 },
};

async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(child)));
    else if (entry.isFile()) result.push(child);
    else throw new Error("Production assets must be regular files.");
  }
  return result.sort();
}

async function requireReference(reference, from) {
  if (reference.startsWith("data:")) return;
  const url = new URL(reference, `http://build.invalid/${from}`);
  if (url.origin !== "http://build.invalid")
    throw new Error("External assets are outside the production budget.");
  const path = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
  const name = relative(directory, path).split(sep).join("/");
  if (!path.startsWith(`${directory}${sep}`))
    throw new Error("Asset reference escapes the production build.");
  if (!(await stat(path).catch(() => null))?.isFile())
    throw new Error(`Missing referenced asset ${name}`);
  if (!path.startsWith(`${join(directory, "assets")}${sep}`))
    throw new Error(
      `Referenced asset ${name} is outside the inventoried assets directory.`,
    );
}

try {
  const index = await readFile(join(directory, "index.html"), "utf8");
  if (!(await stat(join(directory, "assets")).catch(() => null))?.isDirectory())
    throw new Error("Missing production assets directory");
  for (const match of index.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g,
  ))
    await requireReference(match[1], "index.html");
  const assets = [];
  for (const path of await files(join(directory, "assets"))) {
    const bytes = await readFile(path);
    const extension = extname(path).toLowerCase();
    let category = "other";
    if ([".js", ".mjs"].includes(extension)) category = "javascript";
    else if (extension === ".css") category = "css";
    else if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension))
      category = "fonts";
    const asset = {
      file: relative(directory, path).split(sep).join("/"),
      category,
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
    };
    assets.push(asset);
    categories[category].assetCount++;
    categories[category].bytes += asset.bytes;
    categories[category].gzipBytes += asset.gzipBytes;
    if (category === "css") {
      for (const match of bytes
        .toString("utf8")
        .matchAll(/url\(["']?([^"')]+)["']?\)/g))
        await requireReference(match[1], asset.file);
    }
  }
  const result = {
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    runtime: process.version,
    budgets,
    assetCount: assets.length,
    totalGzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    categories,
    assets,
    violations: [],
  };
  for (const category of ["javascript", "css", "fonts"]) {
    if (categories[category].gzipBytes > budgets[category])
      result.violations.push(
        `${category} gzip bytes ${categories[category].gzipBytes} exceed ${budgets[category]}`,
      );
  }
  for (const category of ["javascript", "css"]) {
    if (categories[category].assetCount === 0)
      result.violations.push(`Missing production ${category} assets`);
  }
  if (result.totalGzipBytes > budgets.totalGzipBytes)
    result.violations.push(
      `Total gzip bytes ${result.totalGzipBytes} exceed ${budgets.totalGzipBytes}`,
    );
  if (result.assetCount > budgets.assetCount)
    result.violations.push(
      `Asset count ${result.assetCount} exceeds ${budgets.assetCount}`,
    );
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, `${JSON.stringify(result, null, 2)}\n`);
  console.info(
    `Production assets ${result.totalGzipBytes} gzip bytes in ${result.assetCount} files. Report ${report}`,
  );
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
