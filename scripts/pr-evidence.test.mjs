import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/pr-evidence.yml", import.meta.url),
  "utf8",
);
const lines = workflow.split(/\r?\n/);
const start = lines.findIndex((line) => line === "          script: |");
assert.notEqual(start, -1, "The PR evidence workflow must contain its script.");
const script = [];
for (const line of lines.slice(start + 1)) {
  if (line.trim() && !line.startsWith("            ")) break;
  script.push(line.slice(12));
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const validate = new AsyncFunction(
  "context",
  "github",
  "core",
  script.join("\n"),
);
const revision = "0123456789abcdef0123456789abcdef01234567";
const verification = "https://github.com/ShiosOS/Damadama/actions/runs/123";
const screenshot = "https://github.com/user-attachments/assets/screenshot";
const recording = "https://github.com/user-attachments/assets/recording";
const uiEvidence = `## Evidence

Tested revision: ${revision}
[Passing check](${verification})

### Screenshots

![Desktop](${screenshot})

### Screen recording

[Changed flow](${recording})
`;
const nonvisualEvidence = `## Evidence

Tested revision: ${revision}
Visual evidence does not apply because this change only updates server validation.
[Passing check](${verification})
`;
const missingEvidence =
  "Add an ## Evidence section with an HTTPS link to actual verification output.";
const missingMedia =
  "UI changes require an HTTPS Markdown image under ### Screenshots and an HTTPS recording link under ### Screen recording.";
const missingExplanation =
  "Include screenshots and a recording, or explain 'Visual evidence does not apply because ...' and link actual verification output.";
const missingRevision =
  "Include 'Tested revision: <full 40-character SHA>' in ## Evidence matching the current PR head. Update it after testing each push.";
const committedMedia =
  "Use PR attachments or CI artifacts for screenshot and recording evidence, not repository blob or raw URLs.";

async function failures(
  body = uiEvidence,
  files = [{ filename: "web/src/TodayView.vue", status: "modified" }],
) {
  const result = [];
  const listFiles = Symbol("GitHub pull request files endpoint");
  await validate(
    {
      repo: { owner: "ShiosOS", repo: "Damadama" },
      payload: { pull_request: { body, number: 31, head: { sha: revision } } },
    },
    {
      rest: { pulls: { listFiles } },
      paginate: async (endpoint, options) => {
        assert.equal(endpoint, listFiles);
        assert.deepEqual(options, {
          owner: "ShiosOS",
          repo: "Damadama",
          pull_number: 31,
        });
        return files;
      },
    },
    { setFailed: (message) => result.push(message) },
  );
  return result;
}

test("accepts UI attachment proof and a current tested revision", async () => {
  assert.deepEqual(await failures(), []);
});

test("accepts nonvisual proof with the required explanation", async () => {
  assert.deepEqual(
    await failures(nonvisualEvidence, [
      { filename: "server/Program.cs", status: "modified" },
    ]),
    [],
  );
});

for (const [name, body] of [
  ["missing body", null],
  [
    "missing Evidence heading",
    uiEvidence.replace("## Evidence", "## Verification"),
  ],
  [
    "missing HTTPS verification output",
    nonvisualEvidence.replace(verification, "http://example.invalid/run"),
  ],
  [
    "link outside Evidence",
    `${verification}\n## Evidence\nTested revision: ${revision}`,
  ],
]) {
  test(`refuses ${name}`, async () => {
    assert.deepEqual(await failures(body), [missingEvidence]);
  });
}

for (const [name, body] of [
  ["screenshot", uiEvidence.replace(`![Desktop](${screenshot})`, "")],
  ["screenshot Markdown", uiEvidence.replace("![Desktop]", "[Desktop]")],
  [
    "HTTPS screenshot",
    uiEvidence.replace(screenshot, "http://example.invalid/screen.png"),
  ],
  ["Screenshots heading", uiEvidence.replace("### Screenshots", "### Images")],
  ["recording", uiEvidence.replace(`[Changed flow](${recording})`, "")],
  [
    "HTTPS recording",
    uiEvidence.replace(recording, "http://example.invalid/flow.webm"),
  ],
  [
    "Screen recording heading",
    uiEvidence.replace("### Screen recording", "### Video"),
  ],
]) {
  test(`refuses UI evidence without ${name}`, async () => {
    assert.deepEqual(await failures(body), [missingMedia]);
  });
}

test("renaming a web file away still requires visual proof", async () => {
  assert.deepEqual(
    await failures(nonvisualEvidence, [
      {
        filename: "docs/old-view.vue",
        previous_filename: "web/src/TodayView.vue",
        status: "renamed",
      },
    ]),
    [missingMedia],
  );
});

test("refuses nonvisual changes without the required explanation or media", async () => {
  assert.deepEqual(
    await failures(
      nonvisualEvidence.replace(
        "Visual evidence does not apply because",
        "No screenshots because",
      ),
      [{ filename: "server/Program.cs", status: "modified" }],
    ),
    [missingExplanation],
  );
});

for (const [name, body] of [
  ["missing revision", uiEvidence.replace(`Tested revision: ${revision}`, "")],
  ["short revision", uiEvidence.replace(revision, revision.slice(0, 7))],
  ["nonhex revision", uiEvidence.replace(revision, "z".repeat(40))],
  ["stale revision", uiEvidence.replace(revision, "f".repeat(40))],
  [
    "revision outside Evidence",
    `Tested revision: ${revision}\n${uiEvidence.replace(`Tested revision: ${revision}`, "")}`,
  ],
]) {
  test(`refuses ${name}`, async () => {
    assert.deepEqual(await failures(body), [missingRevision]);
  });
}

for (const directory of ["docs/evidence", ".github/evidence"]) {
  for (const extension of [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "mp4",
    "webm",
    "mov",
    "log",
    "txt",
    "trx",
    "html",
    "zip",
  ]) {
    const filename = `${directory}/run/proof.${extension}`;
    test(`refuses generated evidence at ${filename}`, async () => {
      assert.deepEqual(
        await failures(uiEvidence, [{ filename, status: "added" }]),
        [
          `Move generated verification output out of Git and link PR attachments or CI artifacts instead: ${filename}`,
        ],
      );
    });
  }
}

for (const file of [
  { filename: "docs/evidence/run/screen.png", status: "modified" },
  { filename: ".github/evidence/run/FLOW.WEBM", status: "added" },
  {
    filename: "docs/evidence/run/moved.png",
    previous_filename: "tests/Browser/baselines/screen.png",
    status: "renamed",
  },
  { filename: ".audit/current/result.json", status: "added" },
  { filename: "tests/Browser/.audit/output.md", status: "modified" },
  { filename: "test-results/result.json", status: "added" },
  { filename: "tests/Browser/test-results/result.json", status: "added" },
  { filename: "tests/Browser/playwright-report/report.js", status: "added" },
  {
    filename: "playwright-report/report.md",
    previous_filename: "docs/report.md",
    status: "renamed",
  },
]) {
  test(`refuses ${file.status} output at ${file.filename}`, async () => {
    assert.deepEqual(await failures(uiEvidence, [file]), [
      `Move generated verification output out of Git and link PR attachments or CI artifacts instead: ${file.filename}`,
    ]);
  });
}

for (const file of [
  { filename: "docs/evidence/today/desktop.png", status: "removed" },
  { filename: ".audit/old/output.json", status: "removed" },
  { filename: "tests/Browser/playwright-report/index.html", status: "removed" },
  { filename: "docs/scheduled-habits.md", status: "added" },
  { filename: "docs/architecture.png", status: "added" },
  { filename: "tests/Browser/baselines/screen.png", status: "added" },
  { filename: ".github/evidence/recovery/receipt.json", status: "modified" },
  { filename: "docs/evidence/recovery.md", status: "modified" },
  {
    filename: "tests/Browser/baselines/moved.png",
    previous_filename: "docs/evidence/today/desktop.png",
    status: "renamed",
  },
]) {
  test(`allows ${file.status} ${file.filename}`, async () => {
    assert.deepEqual(await failures(uiEvidence, [file]), []);
  });
}

for (const mediaURL of [
  "https://github.com/ShiosOS/Damadama/blob/main/docs/screen.png",
  "https://github.com/another/repository/raw/main/flow.webm",
  "https://raw.githubusercontent.com/ShiosOS/Damadama/main/docs/screen.png",
  "https://raw.github.com/ShiosOS/Damadama/main/docs/screen.png",
]) {
  for (const [name, original] of [
    ["screenshot", screenshot],
    ["recording", recording],
  ]) {
    test(`refuses repository-hosted ${name} ${mediaURL}`, async () => {
      assert.deepEqual(await failures(uiEvidence.replace(original, mediaURL)), [
        committedMedia,
      ]);
    });
  }
}

test("allows repository links to lasting contracts outside media proof", async () => {
  const contract =
    "https://github.com/ShiosOS/Damadama/blob/main/docs/scheduled-habits.md";
  assert.deepEqual(
    await failures(
      `${uiEvidence}\n### Runtime verification and limitations\n\n[Evaluator contract](${contract})`,
    ),
    [],
  );
});
