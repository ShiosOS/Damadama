import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, relative, dirname, extname } from "node:path";
import { ESLint } from "eslint";
import { parse } from "@vue/compiler-sfc";
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
        "*.mts",
        "*.cts",
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
const suppression =
  /(?:@ts-(?:ignore|expect-error|nocheck)|@vue-(?:ignore|expect-error|skip)|eslint-disable)\b/;

function hasScriptSuppression(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      suppression.test(scanner.getTokenText())
    )
      return true;
  }
  return false;
}

function hasTemplateSuppression(nodes) {
  return nodes.some(
    (node) =>
      (node.type === 3 && suppression.test(node.content)) ||
      (node.children && hasTemplateSuppression(node.children)),
  );
}
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
  if (extname(file) === ".vue") {
    const scripts = [...source.matchAll(/<script\b([^>]*)>/g)];
    if (
      scripts.length === 0 ||
      scripts.some(
        ([, attributes]) => !/\blang=["']ts["']/.test(attributes ?? ""),
      )
    )
      failures.push(`${name}: every Vue script must use lang="ts"`);
  }
  let suppressed = hasScriptSuppression(source);
  if (extname(file) === ".vue") {
    const descriptor = parse(source).descriptor;
    suppressed =
      [descriptor.script, descriptor.scriptSetup].some(
        (script) => script && hasScriptSuppression(script.content),
      ) ||
      (descriptor.template &&
        hasTemplateSuppression(descriptor.template.ast.children));
  }
  if (suppressed) {
    failures.push(`${name}: type or lint suppression is forbidden`);
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.info(
  `Type coverage: ${maintained.length} maintained TypeScript and Vue files`,
);
