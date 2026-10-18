import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, relative, dirname, extname } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const projects = ["web", "tests/Browser", "scripts"];
const maintained = [
  ...new Set(
    execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "*.ts",
        "*.tsx",
        "*.vue",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  ),
].map((file) => resolve(root, file));

const covered = new Set();
for (const project of projects) {
  const configPath = resolve(root, project, "tsconfig.json");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"),
    );
  const directory = dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    directory,
    undefined,
    configPath,
    undefined,
    [
      {
        extension: ".vue",
        isMixedContent: true,
        scriptKind: ts.ScriptKind.Deferred,
      },
    ],
  );
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    );
  }
  for (const file of parsed.fileNames) covered.add(resolve(file).toLowerCase());
}

const eslint = new ESLint();
const failures = [];
for (const file of maintained) {
  const name = relative(root, file).replaceAll("\\", "/");
  if (!covered.has(file.toLowerCase()))
    failures.push(`${name}: outside checked projects`);
  const config = await eslint.calculateConfigForFile(file);
  if (
    config?.languageOptions?.parserOptions?.projectService !== true ||
    config.rules?.["@typescript-eslint/no-unsafe-assignment"]?.[0] !== 2 ||
    config.rules?.["@typescript-eslint/explicit-function-return-type"]?.[0] !==
      2
  )
    failures.push(`${name}: outside typed ESLint coverage`);
  const source = await readFile(file, "utf8");
  if (
    extname(file) === ".vue" &&
    !/<script\b[^>]*\blang=["']ts["'][^>]*>/.test(source)
  ) {
    failures.push(`${name}: Vue script must use lang="ts"`);
  }
  if (
    /\b(?:@ts-(?:ignore|expect-error|nocheck)|eslint-disable)\b/.test(source)
  ) {
    failures.push(`${name}: type or lint suppression is forbidden`);
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.info(
  `Type coverage: ${maintained.length} maintained TypeScript and Vue files`,
);
