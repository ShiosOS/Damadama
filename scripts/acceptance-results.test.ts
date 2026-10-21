import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireCompleteBackendResults } from "./acceptance-results";

function passingTrx(count = 1): string {
  const rows = Array.from(
    { length: count },
    (_, index) =>
      `<UnitTestResult executionId="${index}" testName="case ${index}" outcome="Passed"/>`,
  ).join("");
  return `<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>${rows}</Results><ResultSummary outcome="Completed"><Counters total="${count}" executed="${count}" passed="${count}" failed="0" notExecuted="0"/></ResultSummary></TestRun>`;
}

test("backend completeness accepts this run's positive count as the suite grows", async () => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-trx-"));
  try {
    for (const count of [1, 3]) {
      const path = join(root, "backend.trx");
      await writeFile(path, passingTrx(count));
      expect(() => requireCompleteBackendResults(path)).not.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, xml] of [
  ["missing results", passingTrx(0)],
  ["malformed XML", "<TestRun>"],
  ["wrong namespace", passingTrx().replace("TeamTest/2010", "TeamTest/other")],
  ["inconsistent total", passingTrx().replace('total="1"', 'total="2"')],
  [
    "skipped result",
    passingTrx().replace('outcome="Passed"', 'outcome="NotExecuted"'),
  ],
  [
    "failed result",
    passingTrx().replace('outcome="Passed"', 'outcome="Failed"'),
  ],
  [
    "excluded counter",
    passingTrx().replace('notExecuted="0"', 'notExecuted="1"'),
  ],
  ["missing counters", passingTrx().replace(/<Counters[^>]+\/>/, "")],
  [
    "duplicate summary",
    passingTrx().replace(
      "</TestRun>",
      '<ResultSummary outcome="Completed"/></TestRun>',
    ),
  ],
  [
    "external entity",
    '<!DOCTYPE TestRun SYSTEM "file:///private-sentinel"><TestRun/>',
  ],
  [
    "summary counters before result rows",
    passingTrx(0)
      .replace("<Results></Results>", "")
      .replace(
        "</TestRun>",
        '<Results><UnitTestResult executionId="late" testName="late result" outcome="Passed"/></Results></TestRun>',
      ),
  ],
  [
    "a second Results container after matching counters",
    passingTrx().replace(
      "</TestRun>",
      '<Results><UnitTestResult executionId="late" testName="late result" outcome="Passed"/></Results></TestRun>',
    ),
  ],
] satisfies [string, string][]) {
  test(`backend completeness rejects ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-trx-"));
    try {
      const path = join(root, "backend.trx");
      await writeFile(path, xml);
      expect(() => requireCompleteBackendResults(path)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("backend completeness refuses an absent report", () => {
  expect(() =>
    requireCompleteBackendResults("absent-acceptance-report.trx"),
  ).toThrow();
});
