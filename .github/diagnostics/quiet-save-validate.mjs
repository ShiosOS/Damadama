import { readOwnedFile, readOwnedReceipt } from "./quiet-save-files.mjs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  controls,
  caseNames,
  mediaDirectory,
  validateRetainedMedia,
} from "./quiet-save-media.mjs";
import {
  parseReceipt,
  invocationOutcome,
  validateReceiptPrefix,
  concludeInvocation,
  calibrationMatched,
} from "./quiet-save-receipt.mjs";
import { prepare } from "./quiet-save-generate.mjs";
import {
  digest,
  loadSources,
  normalizeSite,
  fontBuildProof,
  readFontAssets,
  loadPassiveSources,
} from "./quiet-save-source.mjs";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const token = z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/);
const sourceSchema = z
  .object({
    schema: z.literal(2),
    fontBuild: fontBuildProof,
    head: sha,
    tree: sha,
    node: z.literal("v24.21.0"),
    kernel: token,
    arch: z.enum(["x64", "arm64"]),
    cpus: z.number().int().positive().max(1024),
    memoryBytes: z.number().int().positive(),
    imageOS: token.nullable(),
    imageVersion: token.nullable(),
    canonicalSha256: hex,
    generatedSha256: hex,
    visualSupportSha256: hex,
    mappingSha256: hex,
    mode: z.literal("canonical-import"),
    preparationSha256: hex,
    kind: z.literal("diagnostic-not-acceptance"),
    invocations: z.number().int().min(1).max(20),
    phases: z.literal(6),
    deadlineMinutesAfterJobStart: z.literal(39),
  })
  .strict();
const outcomesSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z
        .object({
          outcome: invocationOutcome,
          kind: z.literal("calibration"),
          control: z.enum(controls.slice(1)),
          matched: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("passive-calibration"),
          target: z.enum(["chromium", "firefox", "webkit", "desktop"]),
          outcome: invocationOutcome,
          matched: z.boolean(),
        })
        .strict(),
      z
        .object({
          outcome: invocationOutcome,
          kind: z.literal("normal-invocation"),
          iteration: z.number().int().min(1).max(20),
        })
        .strict(),
    ]),
  )
  .max(29);

export const passiveCalibrationCases = [
  "fresh",
  "pre-enter",
  "held",
  "consumed",
  "foreign",
  "two-posts",
  "subframe",
  "missing",
  "duplicate",
  "clock",
  "owner",
  "late",
  "worker-exit",
  "unmatched",
  "overflow",
  "duplicate-install",
  "canonical-direct",
  "canonical-passive",
];

function admitPassiveSites(detail, sources) {
  const sites = [];
  if (detail.operations.kind === "complete")
    sites.push(...detail.operations.value.map((operation) => operation.site));
  if (detail.errors.kind === "complete")
    sites.push(
      ...detail.errors.value
        .filter((error) => error.correlation.kind === "result-site")
        .map((error) => error.correlation.site),
    );
  for (const site of sites) {
    const known = sources
      .find((source) => source.source === site.source)
      ?.sites.find((candidate) => candidate.id === site.id);
    if (!known) throw new Error("Retained passive site differs.");
    const { api: _api, ...safe } = known;
    if (JSON.stringify(safe) !== JSON.stringify(site))
      throw new Error("Retained passive site differs.");
  }
}

export async function validatePassiveCalibrationCapture(
  directory,
  target,
  head,
) {
  const names = await readdir(directory);
  const expected = new Set();
  const captures = new Map();
  let mediaFiles = 0;
  let mediaBytes = 0;
  const sources = loadPassiveSources(true);
  for (const mode of target === "desktop"
    ? ["desktop"]
    : passiveCalibrationCases) {
    const name = `${mode}.jsonl`;
    if (!names.includes(name)) continue;
    expected.add(name);
    const bytes = await readOwnedFile(resolve(directory, name), 0, 1024 * 1024);
    const rows = parseReceipt(bytes.toString("utf8"), "presave-assertion", 0);
    const results = rows.filter((row) => row.kind === "test-result");
    if (
      rows[0]?.kind !== "phase-start" ||
      rows.some((row) => row.phase !== "calibration") ||
      rows.filter((row) => row.kind === "phase-start").length !== 1 ||
      rows.filter((row) => row.kind === "phase-end").length > 1 ||
      rows.some(
        (row, index) => row.kind === "phase-end" && index !== rows.length - 1,
      )
    )
      throw new Error("Calibration phase inventory differs.");
    const canonical = mode.startsWith("canonical-");
    const project = canonical ? "firefox-smoke" : "chromium-desktop";
    const cases = canonical ? [...caseNames.keys()] : [1];
    if (
      rows[0].cases !== cases.length ||
      results.some(
        (row, index) => row.project !== project || row.case !== cases[index],
      ) ||
      results.length > cases.length
    )
      throw new Error("Calibration case inventory differs.");
    const seen = new Set();
    for (const row of results) {
      const key = `${row.project}:${row.case}`;
      if (seen.has(key)) throw new Error("Duplicate calibration case.");
      seen.add(key);
      if (row.passive) admitPassiveSites(row.passive, sources);
    }
    const result = results.find((row) => row.status !== "skipped");
    if (
      !result ||
      results.filter((row) => row.status !== "skipped").length !== 1
    )
      continue;
    if (target === "desktop" && result.media) {
      const mediaName = basename(mediaDirectory(result.media.owner));
      expected.add(mediaName);
      await validateRetainedMedia(
        result.media,
        resolve(directory, mediaName),
        head,
      );
      for (const entry of result.media.entries)
        if (entry.state === "present") {
          mediaFiles++;
          mediaBytes += entry.bytes;
        }
    } else if (result.media !== null)
      throw new Error("Controlled fixture emitted media.");
    if (
      rows.at(-1)?.kind !== "phase-end" ||
      rows.at(-1).status !== "failed" ||
      results.length !== cases.length ||
      rows.some((row) => row.kind === "runner-error") ||
      results.some(
        (row) =>
          row.observation !== null ||
          row.failure !== null ||
          row.observationRejected ||
          row.errorOverflow ||
          row.mediaRejected,
      ) ||
      results
        .filter((row) => row.status === "skipped")
        .some(
          (row) => row.passive !== null || row.errorCategories.length !== 0,
        ) ||
      result.passive?.operations.kind !== "complete" ||
      result.passive.errors.kind !== "complete"
    )
      continue;
    captures.set(mode, result);
  }
  let matched = false;
  if (target === "desktop") {
    const result = captures.get("desktop");
    const detail = result?.passive;
    const mutationSite = sources
      .find((source) => source.source === "canonical-test")
      .sites.find((site) => site.api === "style.evaluate");
    const ledger = detail?.operations.value ?? [];
    const mutationEnd = ledger.find(
      (row) =>
        row.site.id === mutationSite.id &&
        row.site.source === "canonical-test" &&
        row.end.kind === "success",
    );
    matched = Boolean(
      result &&
      result.status === "failed" &&
      detail.errors.value.length === 8 &&
      detail.errors.value.every(
        (error) =>
          error.category === "other-error" &&
          error.correlation.kind === "unavailable" &&
          error.correlation.reason === "no-site",
      ) &&
      result.media?.refusal === "none" &&
      detail.budget.configuredWholeTestMs === 30000 &&
      ledger.length > 77 &&
      ledger.every((row) => row.end.kind !== "not-observed") &&
      mutationEnd &&
      ledger.some(
        (row) =>
          row.sequence < mutationEnd.sequence &&
          row.site.operation === "assertion" &&
          row.end.kind === "error",
      ) &&
      ledger.some(
        (row) =>
          row.sequence > mutationEnd.sequence &&
          row.site.operation === "assertion" &&
          row.end.kind === "success",
      ) &&
      detail.network.kind === "complete" &&
      detail.network.value.events.some(
        (event) =>
          event.event.kind === "response" && event.event.status === 201,
      ),
    );
  } else {
    if (names.includes("engine.json")) {
      expected.add("engine.json");
      const identity = z
        .object({
          schema: z.literal(1),
          engine: z.literal(target),
          browserVersion: token,
          playwright: z.literal("1.64.1"),
          node: z.literal("v24.21.0"),
          platform: z.literal("linux"),
        })
        .strict()
        .parse(
          JSON.parse(
            (
              await readOwnedFile(resolve(directory, "engine.json"), 0, 4096)
            ).toString("utf8"),
          ),
        );
      matched =
        identity.engine === target &&
        captures.size === passiveCalibrationCases.length;
    }
    if (matched) {
      const events = (mode) => captures.get(mode).passive.network;
      for (const [mode, result] of captures) {
        const expectedStatus = ["pre-enter", "held", "consumed"].includes(mode)
          ? "timedOut"
          : "failed";
        if (result.status !== expectedStatus) matched = false;
      }
      for (const [mode, reason] of [
        ["missing", "missing"],
        ["duplicate", "duplicate"],
        ["owner", "owner-mismatch"],
        ["worker-exit", "missing"],
        ["unmatched", "lifecycle-incomplete"],
        ["overflow", "overflow"],
      ])
        if (
          events(mode).kind !== "unverified" ||
          events(mode).reason !== reason
        )
          matched = false;
      for (const mode of [
        "fresh",
        "foreign",
        "subframe",
        "late",
        "duplicate-install",
      ])
        if (
          JSON.stringify(
            events(mode).value?.events.map((event) => event.event.kind),
          ) !== '["request","response"]'
        )
          matched = false;
      for (const mode of ["held", "consumed"])
        if (
          JSON.stringify(
            events(mode).value?.events.map((event) => event.event.kind),
          ) !== '["request"]' ||
          captures.get(mode).status !== "timedOut" ||
          !captures
            .get(mode)
            .passive.errors.value.some(
              (error) =>
                error.errorIndex > 0 &&
                error.correlation.kind === "unique-step",
            )
        )
          matched = false;
      if (
        events("pre-enter").value?.events.length !== 0 ||
        captures.get("pre-enter").status !== "timedOut" ||
        !captures
          .get("pre-enter")
          .passive.operations.value.some(
            (row) => row.site.role === "save-response-waiter",
          ) ||
        captures
          .get("pre-enter")
          .passive.operations.value.some(
            (row) => row.site.role === "save-enter",
          ) ||
        captures.get("clock").passive.budget.wallOffsets !== "unavailable"
      )
        matched = false;
      for (const mode of ["held", "consumed"])
        if (
          !captures
            .get(mode)
            .passive.operations.value.some(
              (row) =>
                row.site.role === "save-enter" && row.end.kind === "success",
            )
        )
          matched = false;
      if (
        JSON.stringify(
          events("two-posts").value?.events.map((event) => [
            event.requestOrdinal,
            event.event.kind,
          ]),
        ) !== '[[1,"request"],[1,"response"],[2,"request"],[2,"response"]]' ||
        !captures
          .get("worker-exit")
          .passive.operations.value.some(
            (row) => row.end.kind === "not-observed",
          )
      )
        matched = false;
      const direct = captures.get("canonical-direct").passive;
      const passive = captures.get("canonical-passive").passive;
      if (
        direct.network.kind !== "unverified" ||
        direct.network.reason !== "missing" ||
        passive.network.kind !== "complete" ||
        passive.errors.value.length !== 8 ||
        direct.errors.value.length !== 8 ||
        passive.operations.value.length <= 70 ||
        passive.operations.value.some((row) => row.end.kind !== "success") ||
        JSON.stringify(direct.operations.value.map((row) => row.site)) !==
          JSON.stringify(passive.operations.value.map((row) => row.site))
      )
        matched = false;
    }
  }
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(names.sort()))
    throw new Error("Unexpected calibration evidence file.");
  return { matched, mediaFiles, mediaBytes };
}

export async function validateEvidence(
  directory = resolve(".audit/quiet-save/evidence"),
) {
  const sources = loadSources();
  const passiveSources = loadPassiveSources();
  const prepared = await prepare();
  for (const [name, bytes] of Object.entries(prepared.files)) {
    const actual = await readOwnedFile(
      resolve(".audit/quiet-save", name),
      0,
      128 * 1024,
    );
    if (actual.toString("utf8") !== bytes)
      throw new Error("Prepared executable differs.");
  }
  const json = async (name, bound = 1024 * 1024) =>
    JSON.parse(
      (await readOwnedFile(resolve(directory, name), 0, bound)).toString(
        "utf8",
      ),
    );
  const source = sourceSchema.parse(await json("source.json", 16384));
  if (
    JSON.stringify(source.fontBuild) !==
    JSON.stringify((await readFontAssets()).proof)
  )
    throw new Error("Retained font inventory differs.");
  for (const [key, reference] of [
    ["head", "HEAD"],
    ["tree", "HEAD^{tree}"],
  ]) {
    const result = spawnSync("git", ["rev-parse", reference], {
      encoding: "utf8",
    });
    if (result.status !== 0 || source[key] !== result.stdout.trim())
      throw new Error("Diagnostic revision differs.");
  }
  const mapBytes = await readOwnedFile(
    resolve(directory, "source-map.json"),
    0,
    128 * 1024,
  );
  const generatedMap = await readOwnedFile(
    resolve(".audit/quiet-save/source-map.json"),
    0,
    128 * 1024,
  );
  if (!mapBytes.equals(generatedMap))
    throw new Error("Retained source mapping differs.");
  const mapping = JSON.parse(mapBytes.toString("utf8"));
  if (
    JSON.stringify(mapping) !== JSON.stringify(prepared.proof) ||
    source.preparationSha256 !== digest(JSON.stringify(prepared.proof))
  )
    throw new Error("Retained preparation differs.");
  for (const key of [
    "canonicalSha256",
    "generatedSha256",
    "visualSupportSha256",
    "mappingSha256",
  ])
    if (source[key] !== mapping[key])
      throw new Error("Retained source differs.");
  const outcomes = outcomesSchema.parse(await json("outcomes.json", 16384));
  const expected = new Set(["source.json", "source-map.json", "outcomes.json"]);
  const listing = await readdir(directory);
  let mediaBytes = 0;
  let mediaFiles = 0;
  let normal = 0;
  let calibration = 0;
  let passiveCalibration = 0;
  let stopped = false;
  for (const entry of outcomes) {
    if (stopped) throw new Error("Outcome follows terminal stop.");
    if (entry.kind === "passive-calibration") {
      const target = ["chromium", "firefox", "webkit", "desktop"][
        passiveCalibration++
      ];
      if (calibration !== 5 || normal !== 0 || entry.target !== target)
        throw new Error("Passive calibration order differs.");
      const name = `passive-calibration-${target}`;
      const outcome = entry.outcome;
      stopped = !entry.matched;
      if (outcome.kind === "not-started" || outcome.receipt === "missing") {
        if (
          listing.includes(name) ||
          entry.matched ||
          (outcome.kind === "started" && outcome.conclusion !== "incomplete")
        )
          throw new Error("Passive calibration absence differs.");
        continue;
      }
      if (outcome.receipt !== "bounded-prefix")
        throw new Error("Malformed passive calibration evidence.");
      expected.add(name);
      const capture = await validatePassiveCalibrationCapture(
        resolve(directory, name),
        target,
        source.head,
      );
      const matched =
        capture.matched &&
        outcome.termination === "none" &&
        outcome.exitCode === (target === "desktop" ? 1 : 0);
      let conclusion = "incomplete";
      if (matched)
        conclusion =
          target === "desktop" ? "failure-observed" : "complete-pass";
      if (entry.matched !== matched || outcome.conclusion !== conclusion)
        throw new Error("Passive calibration conclusion differs.");
      mediaFiles += capture.mediaFiles;
      mediaBytes += capture.mediaBytes;
      continue;
    }
    let control;
    let iteration;
    if (entry.kind === "calibration") {
      control = controls.slice(1)[calibration++];
      iteration = 0;
      if (entry.control !== control || normal !== 0)
        throw new Error("Calibration order differs.");
    } else {
      control = "normal";
      iteration = ++normal;
      if (
        calibration !== 5 ||
        passiveCalibration !== 4 ||
        entry.iteration !== iteration ||
        iteration > source.invocations
      )
        throw new Error("Normal invocation order differs.");
    }
    const name = `${control}-${iteration}.jsonl`;
    const outcome = entry.outcome;
    stopped =
      entry.kind === "calibration"
        ? !entry.matched
        : outcome.kind !== "started" || outcome.conclusion !== "complete-pass";
    if (outcome.kind === "not-started") {
      if (
        listing.includes(name) ||
        (entry.kind === "calibration" && entry.matched)
      )
        throw new Error("Not-started outcome has evidence.");
      continue;
    }
    if (outcome.receipt === "missing") {
      if (
        listing.includes(name) ||
        outcome.conclusion !== "incomplete" ||
        (entry.kind === "calibration" && entry.matched)
      )
        throw new Error("Missing receipt outcome differs.");
      continue;
    }
    if (outcome.receipt === "malformed")
      throw new Error("Malformed receipt refused.");
    expected.add(name);
    const receipt = await readOwnedReceipt(resolve(directory, name));
    if (outcome.receipt === "empty") {
      if (
        receipt.length !== 0 ||
        outcome.conclusion !== "incomplete" ||
        (entry.kind === "calibration" && entry.matched)
      )
        throw new Error("Empty receipt outcome differs.");
      continue;
    }
    const rows = validateReceiptPrefix(
      parseReceipt(receipt.toString("utf8"), control, iteration),
      control,
    );
    if (
      JSON.stringify(concludeInvocation(outcome, rows, control)) !==
      JSON.stringify(outcome)
    )
      throw new Error("Retained outcome conclusion differs.");
    if (
      entry.kind === "calibration" &&
      entry.matched !==
        (outcome.termination === "none" &&
          calibrationMatched(rows, control, outcome.exitCode))
    )
      throw new Error("Retained calibration conclusion differs.");
    for (const row of rows) {
      if (row.kind !== "test-result") continue;
      if (entry.kind === "calibration" && row.passive != null)
        throw new Error("Legacy calibration profile differs.");
      if (row.passive) admitPassiveSites(row.passive, passiveSources);
      if (row.failure && row.failure.site.source !== "unavailable") {
        const known = sources.find(
          (item) => item.source === row.failure.site.source,
        );
        if (
          !known ||
          normalizeSite(
            {
              file: known.path,
              line: row.failure.site.line,
              column: row.failure.site.column,
            },
            sources,
          ).source === "unavailable"
        )
          throw new Error("Retained site differs.");
      }
      if (!row.media) continue;
      const mediaName = basename(mediaDirectory(row.media.owner));
      const mediaPath = resolve(directory, mediaName);
      if (expected.has(mediaName)) throw new Error("Duplicate media owner.");
      expected.add(mediaName);
      await validateRetainedMedia(row.media, mediaPath, source.head);
      for (const entry of row.media.entries) {
        if (entry.state !== "present") continue;
        mediaBytes += entry.bytes;
        mediaFiles++;
      }
    }
  }
  if (mediaBytes > 20 * 1024 * 1024 || mediaFiles > 90)
    throw new Error("Retained media bound exceeded.");
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(listing.sort()))
    throw new Error("Unexpected evidence file.");
  if (digest(sources[0].bytes) !== source.generatedSha256)
    throw new Error("Generated source differs.");
  return { files: expected.size, mediaFiles, mediaBytes };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.info(JSON.stringify(await validateEvidence()));
  } catch {
    console.error("Quiet evidence refused.");
    process.exitCode = 1;
  }
}
