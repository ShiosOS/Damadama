import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { fileIdentity, fixtureFiles, sameFile } from "./owned-resources.mjs";

export const mediaFiles = Object.freeze([
  ".audit/verification-skill/habit-immediate.png",
  ".audit/verification-skill/habit-reloaded.png",
  ".audit/verification-skill/saved-list-loading.png",
  ".audit/verification-skill/saved-list-refused.png",
  ".audit/verification-skill/calendar-past.png",
  ".audit/verification-skill/calendar-today.png",
  ".audit/entries-immediate.png",
  ".audit/entries-reloaded.png",
  ".audit/entries-support-reference.png",
  ".audit/entries-support-reference.webm",
  ".audit/today-flow.webm",
  ".audit/accessibility-creation-panel.png",
  ".audit/accessibility-reloaded-list.png",
  ".audit/history-edit-immediate.png",
  ".audit/history-edit-reloaded.png",
  ".audit/history-edit.webm",
  ".audit/history-schedule-retained.png",
  ".audit/history-archive-keep.png",
  ".audit/history-archive-remove.png",
  ".audit/history-archive.webm",
  ".audit/history-editor-mobile.png",
  ".audit/history-pending-entry.png",
  ".audit/history-pending-retry.png",
  ".audit/heatmap-immediate.png",
  ".audit/heatmap-reloaded.png",
  ".audit/heatmap-flow.webm",
  ".audit/heatmap-schedule-remove.png",
  ".audit/heatmap-archive-choices-reloaded.png",
  ".audit/heatmap-history-flow.webm",
  ".audit/heatmap-keyboard.png",
  ".audit/heatmap-mobile.png",
]);

export async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}

function savedListObservation(result) {
  const attachments = (result.attachments ?? []).filter(
    (attachment) => attachment.name === "saved-list-state-observations",
  );
  if (attachments.length === 0) return null;
  const [attachment] = attachments;
  if (
    attachments.length !== 1 ||
    attachment.contentType !== "application/json" ||
    typeof attachment.body !== "string" ||
    attachment.body.length > 256
  )
    throw new Error("saved-list-observation-invalid");
  let value;
  try {
    value = JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
  } catch {
    throw new Error("saved-list-observation-invalid");
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "emptyAfterRefusal,emptyWhileLoading" ||
    typeof value.emptyWhileLoading !== "boolean" ||
    typeof value.emptyAfterRefusal !== "boolean"
  )
    throw new Error("saved-list-observation-invalid");
  return {
    emptyWhileLoading: value.emptyWhileLoading,
    emptyAfterRefusal: value.emptyAfterRefusal,
  };
}

export function summarizeTests(raw, expectedFiles) {
  if (!Array.isArray(raw.suites) || !Array.isArray(raw.errors))
    throw new Error("selected-test-report-invalid");
  const cases = [];
  let savedList = null;
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      if (typeof spec.file !== "string")
        throw new Error("selected-test-file-invalid");
      const file = spec.file.replaceAll("\\", "/");
      if (!expectedFiles.includes(file) || typeof spec.title !== "string")
        throw new Error("selected-test-file-invalid");
      for (const test of spec.tests) {
        if (
          !["passed", "failed", "skipped"].includes(test.expectedStatus) ||
          !Array.isArray(test.results)
        )
          throw new Error("selected-test-result-invalid");
        cases.push({
          file,
          title: spec.title,
          expected: test.expectedStatus,
          results: test.results.map((result) => {
            if (
              ![
                "passed",
                "failed",
                "timedOut",
                "skipped",
                "interrupted",
              ].includes(result.status) ||
              !Number.isFinite(result.duration) ||
              result.duration < 0
            )
              throw new Error("selected-test-result-invalid");
            if (file === ".agents/skills/verify/observations.spec.mjs") {
              const observation = savedListObservation(result);
              if (observation) {
                if (savedList)
                  throw new Error("saved-list-observation-duplicate");
                savedList = observation;
              }
            }
            return { status: result.status, duration: result.duration };
          }),
        });
      }
    }
    for (const nested of suite.suites ?? []) walk(nested);
  };
  for (const suite of raw.suites) walk(suite);
  const files = [...new Set(cases.map((test) => test.file))].sort();
  const complete =
    files.length === expectedFiles.length &&
    expectedFiles.every((file) => files.includes(file));
  const passed =
    complete &&
    savedList !== null &&
    cases.length > 0 &&
    raw.errors.length === 0 &&
    cases.every(
      (test) =>
        test.expected === "passed" &&
        test.results.length === 1 &&
        test.results[0].status === "passed",
    );
  return { passed, count: cases.length, files, cases, savedList };
}

async function fingerprint(root, relative) {
  const hash = createHash("sha256");
  let files = 0;
  const visit = async (path) => {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error("input-link-refused");
    if (stat.isDirectory()) {
      for (const entry of (await readdir(join(root, path))).sort()) {
        if (!fixtureFiles.includes(`${path}/${entry}`))
          await visit(`${path}/${entry}`);
      }
    } else if (stat.isFile()) {
      hash.update(path + "\0").update(await readFile(join(root, path)));
      files++;
    } else throw new Error("input-type-refused");
  };
  await visit(relative);
  return { path: relative, files, sha256: hash.digest("hex") };
}

export async function preparedInputs(root) {
  return Promise.all(
    [
      "bun.lock",
      "server/wwwroot",
      ".audit/browser-build",
      ".audit/check-build/bin/BrowserHost",
    ].map((path) => fingerprint(root, path)),
  );
}

export async function createEvidenceDirectory(root, id) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw new Error("native-run-id-invalid");
  let path = root;
  for (const part of `.audit/verification-skill/retained/${id}`.split("/")) {
    path = join(path, part);
    await mkdir(path).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error("evidence-directory-link-refused");
  }
  return path;
}

export async function mediaSnapshot(root) {
  return Object.fromEntries(
    await Promise.all(
      mediaFiles.map(async (path) => [path, await fileIdentity(root, path)]),
    ),
  );
}

export async function retainMedia(root, directory, before) {
  const hashes = {};
  for (const path of mediaFiles) {
    const current = await fileIdentity(root, path);
    if (!current || sameFile(before[path], current)) continue;
    const target = join(directory, basename(path));
    await copyFile(join(root, path), target);
    hashes[basename(path)] = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
  }
  return hashes;
}

export async function verifyMedia(directory, hashes) {
  for (const [path, expected] of Object.entries(hashes)) {
    const actual = createHash("sha256")
      .update(await readFile(join(directory, path)))
      .digest("hex");
    if (actual !== expected) throw new Error("retained-evidence-changed");
  }
}
