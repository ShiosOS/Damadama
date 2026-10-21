import { readOwnedFile, readInstalledNunitoFile } from "./quiet-save-files.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import ts from "typescript";
import { fontKinds } from "./quiet-save-schema.mjs";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const fontBuildProof = z.lazy(() =>
  z
    .object({
      schema: z.literal(1),
      assets: z
        .array(
          z
            .object({
              kind: z.enum(fontKinds),
              sha256: hex,
              bytes: z
                .number()
                .int()
                .min(1)
                .max(1024 * 1024),
            })
            .strict(),
        )
        .length(5),
    })
    .strict()
    .refine(
      (value) =>
        JSON.stringify(value.assets.map((asset) => asset.kind)) ===
        JSON.stringify(fontKinds),
      "Font asset order differs.",
    ),
);

export async function readFontAssets(selfTest = false) {
  const directory = resolve(
    selfTest
      ? ".audit/quiet-save-font-tests/assets"
      : ".audit/browser-build/assets",
  );
  const names = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (names.length >= 128) throw new Error("Font inventory bound exceeded.");
    names.push(entry.name);
  }
  const port = z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/)
    .transform(Number)
    .pipe(z.number().int().max(65535))
    .parse(process.env.DAMADAMA_BROWSER_PORT ?? "5174");
  const lookup = new Map();
  const assets = [];
  for (const kind of fontKinds) {
    const pattern = new RegExp(
      `^nunito-${kind}-wght-normal-[A-Za-z0-9_-]{8}\\.woff2$`,
    );
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length !== 1) throw new Error("Font asset selection differs.");
    const expected = await readInstalledNunitoFile(kind);
    const actual = await readOwnedFile(
      resolve(directory, matches[0]),
      0,
      1024 * 1024,
    );
    if (!expected.equals(actual)) throw new Error("Font asset bytes differ.");
    assets.push({ kind, sha256: digest(actual), bytes: actual.length });
    lookup.set(`http://127.0.0.1:${port}/assets/${matches[0]}`, kind);
  }
  return {
    proof: fontBuildProof.parse({ schema: 1, assets }),
    kindForUrl: (url) => lookup.get(url) ?? null,
  };
}
const coordinate = z.number().int().min(1).max(10000);
const preparedFiles = [
  "observed.pw.ts",
  "observed.config.ts",
  "passive.pw.ts",
  "passive.config.ts",
  "calibration.pw.ts",
  "calibration.config.ts",
  "observed-run.ts",
];
const diagnosticFiles = [
  "quiet-save-source.mjs",
  "quiet-save-schema.mjs",
  "quiet-save-reporter.mjs",
  "quiet-save-receipt.mjs",
  "quiet-save-run.mjs",
  "quiet-save-validate.mjs",
  "quiet-save-media.mjs",
  "quiet-save-files.mjs",
];
const preparedSchema = z
  .object({
    files: z
      .object(Object.fromEntries(preparedFiles.map((name) => [name, hex])))
      .strict(),
    generatorSha256: hex,
    collectorSha256: hex,
    calibrationSha256: hex,
    diagnostics: z
      .object(Object.fromEntries(diagnosticFiles.map((name) => [name, hex])))
      .strict(),
    protectedSha256: hex,
    siteManifestSha256: hex,
    runtime: z
      .object({
        version: z.literal("1.64.1"),
        sourceHashes: z.array(hex).length(4),
      })
      .strict(),
  })
  .strict();
export const sourceSite = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("unavailable"),
      line: z.null(),
      column: z.null(),
    })
    .strict(),
  ...["generated-test", "visual-support", "calibration-test"].map((source) =>
    z
      .object({
        source: z.literal(source),
        line: coordinate,
        column: z.number().int().min(1).max(1000),
      })
      .strict(),
  ),
]);
export const unavailableSite = {
  source: "unavailable",
  line: null,
  column: null,
};
export const operations = [
  "toBe",
  "toEqual",
  "toBeFocused",
  "toBeVisible",
  "toHaveScreenshot",
  "toMatchSnapshot",
  "page.waitForResponse",
  "page.evaluate",
  "locator.screenshot",
  "unknown",
];
export const failureSchema = z
  .object({
    stage: z.enum([
      "unknown",
      "before-dialog",
      "dialog-open",
      "creation-comparison",
      "before-waiter",
      "save-boundary",
      "after-save",
    ]),
    site: sourceSite,
    category: z.enum(["expect", "pw:api", "hook", "test.step", "unknown"]),
    operation: z.enum(operations),
    locationOrigin: z.enum(["step", "result-error", "unavailable"]),
    candidateOverflow: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.site.source === "unavailable") !==
      (value.locationOrigin === "unavailable")
    )
      context.addIssue({
        code: "custom",
        message: "Failure location origin differs.",
      });
  });

export function lineMapping(canonical, generated) {
  const original = canonical.split("\n");
  const lines = generated
    .split("\n")
    .map((line) =>
      line.replace(
        '"../../tests/Browser/visual-support"',
        '"./visual-support"',
      ),
    );
  const lengths = Array.from(
    { length: original.length + 1 },
    () => new Uint16Array(lines.length + 1),
  );
  for (let a = original.length - 1; a >= 0; a--)
    for (let b = lines.length - 1; b >= 0; b--)
      lengths[a][b] =
        original[a] === lines[b]
          ? lengths[a + 1][b + 1] + 1
          : Math.max(lengths[a + 1][b], lengths[a][b + 1]);
  const mapping = Array(lines.length).fill(null);
  let a = 0;
  let b = 0;
  while (a < original.length && b < lines.length) {
    if (original[a] === lines[b]) {
      mapping[b++] = ++a;
    } else if (lengths[a + 1][b] > lengths[a][b + 1]) a++;
    else b++;
  }
  return mapping;
}

export function sourceProof(canonical, generated, visualSupport) {
  const mapping = lineMapping(canonical, generated);
  return {
    schema: 1,
    mode: "canonical",
    canonicalBlob: committedBlob(
      "tests/Browser/compatibility.pw.ts",
      canonical,
    ),
    visualSupportBlob: committedBlob(
      "tests/Browser/visual-support.ts",
      visualSupport,
    ),
    canonicalSha256: digest(canonical),
    generatedSha256: digest(generated),
    visualSupportSha256: digest(visualSupport),
    mappingSha256: digest(JSON.stringify(mapping)),
    mapping,
  };
}

function committedBlob(path, source) {
  const result = spawnSync("git", ["rev-parse", `HEAD:${path}`], {
    encoding: "utf8",
  });
  const blob = createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");
  if (result.status !== 0 || result.stdout.trim() !== blob)
    throw new Error("Canonical source differs from committed blob.");
  return blob;
}

export function loadSources(selfTest = false) {
  if (selfTest) {
    const path = resolve(".audit/quiet-save-evidence-tests/probe.spec.mjs");
    try {
      const bytes = readFileSync(path, "utf8");
      const proof = z
        .object({
          schema: z.literal(1),
          mode: z.literal("calibration"),
          source: z.literal("calibration-test"),
          sha256: hex,
        })
        .strict()
        .parse(
          JSON.parse(
            readFileSync(
              ".audit/quiet-save-evidence-tests/source.json",
              "utf8",
            ),
          ),
        );
      if (proof.sha256 !== digest(bytes)) return [];
      return [{ source: "calibration-test", path, bytes }];
    } catch {
      return [];
    }
  }
  const proof = z
    .object({
      schema: z.literal(1),
      mode: z.literal("canonical-import"),
      passive: preparedSchema,
      canonicalBlob: z.string().regex(/^[a-f0-9]{40}$/),
      visualSupportBlob: z.string().regex(/^[a-f0-9]{40}$/),
      canonicalSha256: hex,
      generatedSha256: hex,
      visualSupportSha256: hex,
      mappingSha256: hex,
      mapping: z.array(coordinate.nullable()).max(10000),
    })
    .strict()
    .parse(
      JSON.parse(readFileSync(".audit/quiet-save/source-map.json", "utf8")),
    );
  const canonical = readFileSync("tests/Browser/compatibility.pw.ts", "utf8");
  const generated = readFileSync(".audit/quiet-save/observed.pw.ts", "utf8");
  const visualSupport = readFileSync("tests/Browser/visual-support.ts", "utf8");
  if (
    JSON.stringify({ ...proof, mode: "canonical", passive: undefined }) !==
    JSON.stringify(sourceProof(canonical, generated, visualSupport))
  )
    throw new Error("Source proof differs.");
  return [
    {
      source: "generated-test",
      path: resolve(".audit/quiet-save/observed.pw.ts"),
      bytes: generated,
    },
    {
      source: "visual-support",
      path: resolve("tests/Browser/visual-support.ts"),
      bytes: visualSupport,
    },
  ];
}

export function passivePreparationProof(files) {
  const listing = spawnSync(
    "git",
    ["ls-tree", "-rz", "HEAD", "--", "web", "server", "tests/Browser"],
    { encoding: "utf8" },
  );
  if (listing.status !== 0)
    throw new Error("Protected source inventory unavailable.");
  const protectedSources = listing.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match) throw new Error("Protected source entry differs.");
      const [, expected, path] = match;
      const bytes = readFileSync(path);
      const blob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blob !== expected) throw new Error("Protected source bytes differ.");
      return [path, blob, digest(bytes)];
    });
  return preparedSchema.parse({
    files: Object.fromEntries(
      preparedFiles.map((name) => [name, digest(files[name])]),
    ),
    generatorSha256: digest(
      readFileSync(".github/diagnostics/quiet-save-generate.mjs"),
    ),
    collectorSha256: digest(
      readFileSync(".github/diagnostics/quiet-save-passive.mjs"),
    ),
    calibrationSha256: digest(
      JSON.stringify(
        [
          ".github/diagnostics/quiet-save-passive.test.mjs",
          ".github/diagnostics/fixtures/passive-save.pw.mjs",
          ".github/diagnostics/fixtures/passive-save-page.html",
        ].map((path) => digest(readFileSync(path))),
      ),
    ),
    diagnostics: Object.fromEntries(
      diagnosticFiles.map((name) => [
        name,
        digest(readFileSync(`.github/diagnostics/${name}`)),
      ]),
    ),
    protectedSha256: digest(JSON.stringify(protectedSources)),
    siteManifestSha256: passiveSiteManifestDigest(),
    runtime: passiveRuntimeProof(),
  });
}

function passiveSiteManifestDigest() {
  return digest(
    JSON.stringify(
      loadPassiveSources(true)
        .filter((source) => source.source !== "calibration-test")
        .map(({ source, sites }) => ({ source, sites })),
    ),
  );
}

export function normalizeSite(location, sources) {
  if (typeof location?.file !== "string") return unavailableSite;
  const source = sources.find((item) => item.path === resolve(location.file));
  if (!source) return unavailableSite;
  const parsed = sourceSite.safeParse({
    source: source.source,
    line: location.line,
    column: location.column,
  });
  if (!parsed.success) return unavailableSite;
  const line = source.bytes.split("\n")[location.line - 1];
  if (line === undefined || location.column > line.length + 1)
    return unavailableSite;
  return parsed.data;
}

export function failedStep(step, sources) {
  let operation = "unknown";
  if (step.category === "expect") {
    const match = /^Expect "(?:not )?(to[A-Za-z]+)(?:"|\()/.exec(
      step.title ?? "",
    );
    if (match && operations.includes(match[1])) operation = match[1];
  } else if (operations.includes(step.title)) operation = step.title;
  let category = "unknown";
  if (["expect", "pw:api", "hook", "test.step"].includes(step.category))
    category = step.category;
  return { site: normalizeSite(step.location, sources), category, operation };
}

export function failureStage(observation) {
  if (!observation || observation.refusal !== "none") return "unknown";
  const records = observation.node;
  if (records.some((row) => row.event === "response")) return "after-save";
  if (records.some((row) => row.event === "waiter-armed"))
    return "save-boundary";
  const boundary = records
    .filter((row) => row.event === "phase-boundary")
    .at(-1);
  if (!boundary) return "before-dialog";
  if (boundary.edge === "start") return boundary.stage;
  return "before-waiter";
}

const passiveApis = new Map([
  ["page.keyboard.press", ["keyboard.press", /^Press "/]],
  ["page.keyboard.type", ["keyboard.type", /^Type "/]],
  [
    "page.clock.setFixedTime",
    ["other-admitted-source-call", /^Set fixed time "/],
  ],
  [
    "page.waitForResponse",
    ["page.waitForResponse", /^Wait for event "response"$/],
  ],
  ["page.goto", ["page.goto", /^Navigate$/]],
  ["page.reload", ["page.reload", /^Reload$/]],
  ["page.evaluate", ["page.evaluate", /^Evaluate$/]],
  ["page.addStyleTag", ["other-admitted-source-call", /^Add style tag$/]],
  ["locator.evaluate", ["locator.evaluate", /^Evaluate$/]],
  ["locator.screenshot", ["locator.screenshot", /^Screenshot$/]],
  ["target.screenshot", ["other-admitted-source-call", /^Screenshot$/]],
  ["style.evaluate", ["other-admitted-source-call", /^Evaluate$/]],
  ["response.json", ["other-admitted-source-call", /^Get response body$/]],
  ["context.newPage", ["other-admitted-source-call", /^Create page$/]],
  ["foreign.goto", ["page.goto", /^Navigate$/]],
  ["foreign.evaluate", ["page.evaluate", /^Evaluate$/]],
  ["foreign.close", ["other-admitted-source-call", /^Close page$/]],
]);
const passiveMatchers = new Set([
  "toBe",
  "toEqual",
  "toBeFocused",
  "toBeVisible",
  "toHaveCount",
  "toContainText",
  "toBeChecked",
  "toHaveValue",
  "toMatchObject",
  "toHaveLength",
  "toHaveScreenshot",
  "toBeGreaterThan",
  "toThrow",
  "toMatchSnapshot",
]);

export function passiveSites(source) {
  const ast = ts.createSourceFile(
    source.path,
    source.bytes,
    ts.ScriptTarget.Latest,
    true,
  );
  const sites = [];
  function visit(node, scope = "") {
    if (ts.isFunctionDeclaration(node)) scope = node.name?.text ?? "";
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression.getText(ast);
      let api = `${receiver}.${method}`;
      let operation = passiveApis.get(api)?.[0];
      if (passiveMatchers.has(method) && /^expect\(/.test(receiver)) {
        api = method;
        operation = "assertion";
      } else if (
        ["evaluate", "screenshot"].includes(method) &&
        (/^(add|row|saved)$/.test(receiver) ||
          /^page\.getByRole\(/.test(receiver))
      ) {
        api = `locator.${method}`;
        operation = passiveApis.get(api)?.[0];
      } else if (
        method === "json" &&
        /^(response|createdResponse|reloadedResponse)$/.test(receiver)
      ) {
        api = "response.json";
        operation = passiveApis.get(api)[0];
      }
      if (operation) {
        const coordinate = ast.getLineAndCharacterOfPosition(
          node.expression.name.getStart(ast),
        );
        let role = "other-original";
        if (
          api === "page.keyboard.press" &&
          node.arguments[0]?.getText(ast) === '"Enter"'
        ) {
          if (scope === "fillAndSave") role = "save-enter";
          if (scope === "openByKeyboard") role = "dialog-enter";
        }
        if (
          api === "page.waitForResponse" &&
          scope === "saveAndReload" &&
          ts.isVariableDeclaration(node.parent) &&
          node.parent.name.getText(ast) === "created"
        )
          role = "save-response-waiter";
        sites.push({
          source: source.source,
          line: coordinate.line + 1,
          column: coordinate.character + 1,
          operation,
          role,
          api,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(ast);
  return sites.map((site, index) => ({ id: index + 1, ...site }));
}

export function admitPassiveOperation(step, sources) {
  if (!["expect", "pw:api"].includes(step.category))
    return { kind: "excluded" };
  for (let parent = step.parent; parent; parent = parent.parent)
    if (["hook", "fixture"].includes(parent.category))
      return { kind: "excluded" };
  if (typeof step.location?.file !== "string")
    return { kind: "unverified", reason: "site-unadmitted" };
  const source = sources.find(
    (item) => item.path === resolve(step.location.file),
  );
  if (!source) return { kind: "unverified", reason: "site-unadmitted" };
  const site = source.sites.find(
    (item) =>
      item.line === step.location.line && item.column === step.location.column,
  );
  if (!site) return { kind: "unverified", reason: "site-unadmitted" };
  let matches = false;
  if (site.operation === "assertion") {
    const matcher = /^Expect "(?:not )?(to[A-Za-z]+)(?:"|\()/.exec(
      step.title ?? "",
    )?.[1];
    matches = step.category === "expect" && matcher === site.api;
  } else {
    matches =
      step.category === "pw:api" &&
      passiveApis.get(site.api)[1].test(step.title ?? "");
  }
  if (!matches) return { kind: "unverified", reason: "operation-mismatch" };
  const { api: _api, ...safe } = site;
  return { kind: "complete", value: safe };
}

export function loadPassiveSources(selfTest = false) {
  if (!selfTest) {
    const proof = JSON.parse(
      readFileSync(".audit/quiet-save/source-map.json", "utf8"),
    );
    if (proof.mode !== "canonical-import")
      throw new Error("Passive source profile differs.");
    const prepared = preparedSchema.parse(proof.passive);
    const files = Object.fromEntries(
      preparedFiles.map((name) => [
        name,
        readFileSync(resolve(".audit/quiet-save", name)),
      ]),
    );
    if (
      JSON.stringify(prepared) !==
      JSON.stringify(passivePreparationProof(files))
    )
      throw new Error("Passive preparation differs.");
  }
  const descriptors = [
    ["canonical-test", "tests/Browser/compatibility.pw.ts"],
    ["visual-support", "tests/Browser/visual-support.ts"],
  ];
  if (selfTest)
    descriptors.push([
      "calibration-test",
      ".github/diagnostics/fixtures/passive-save.pw.mjs",
    ]);
  return descriptors.map(([source, path]) => {
    const bytes = readFileSync(path, "utf8");
    if (source !== "calibration-test") committedBlob(path, bytes);
    const entry = { source, path: resolve(path), bytes };
    return { ...entry, sites: passiveSites(entry) };
  });
}

export function passiveRuntimeProof() {
  const expected = [
    [
      "node_modules/playwright/lib/worker/workerProcessEntry.js",
      "b7ae55d578fb3a2a6bd4d9acc0abf93146ae1d9062330bbc0e3f82acbff751b8",
    ],
    [
      "node_modules/playwright/lib/runner/index.js",
      "2cb242134ba364714f289100dbfc02fc496d74bde24274490556395e57109fdb",
    ],
    [
      "node_modules/playwright/lib/index.js",
      "90336f507074874af66f1d681d4fd7727f5946d1f37a3621d748caa3a8ae0485",
    ],
    [
      "node_modules/playwright-core/lib/coreBundle.js",
      "829521b67ed7be90c7d6d6098ff39f2241562d47e4ad7ccab13710924a56001d",
    ],
  ];
  const version = JSON.parse(
    readFileSync("node_modules/playwright/package.json", "utf8"),
  ).version;
  if (
    version !== "1.64.1" ||
    expected.some(([path, hash]) => digest(readFileSync(path)) !== hash)
  )
    throw new Error("Passive runtime contract differs.");
  return { version, sourceHashes: expected.map(([, hash]) => hash) };
}
