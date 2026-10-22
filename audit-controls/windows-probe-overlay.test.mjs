import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { frozenSource, overlaySources } from "./windows-probe-overlay.mjs";

const paths = [
  "scripts/doctor-docker.test.ts",
  "scripts/doctor.ts",
  "scripts/fixtures/doctor-docker-child.ts",
];
const inputs = Object.fromEntries(
  paths.map((path) => [
    path,
    execFileSync("git", ["show", `${frozenSource}:${path}`], {
      encoding: "utf8",
    }),
  ]),
);

for (const mode of ["control", "formatter"]) {
  test(`${mode} overlay binds exact anchors, retains bounds, and contains one journey`, () => {
    const output = overlaySources(inputs, mode);
    assert.deepEqual(Object.keys(output), paths);
    const source = output[paths[0]];
    assert.equal((source.match(/\ntest\(/g) ?? []).length, 1);
    assert.match(source, /timeout: 15_000/);
    assert.match(source, /timeout: 60_000/);
    assert.match(output[paths[1]], /timeoutMs = 10_000/);
    assert.match(source, /case-observation-before-cleanup/);
    assert.match(source, /case-cleanup-failed/);
    assert.doesNotMatch(source, /const current = await invoke/);
    assert.doesNotMatch(source, /for \(const fixture of/);
    assert.match(output[paths[2]], /probeEnvironment\(\)/);
    assert.match(output[paths[1]], /capture-exit/);
    assert.match(output[paths[1]], /capture-close/);
    assert.match(output[paths[1]], /capture-timer/);
    if (mode === "control") {
      assert.match(source, /const old = await invoke/);
      assert.doesNotMatch(source, /await format\(/);
    } else {
      assert.match(source, /timeout: 20_000/);
      assert.equal(
        (source.match(/await format\("format:check"\)/g) ?? []).length,
        1,
      );
      assert.doesNotMatch(source, /await format\("format"\)/);
      assert.match(source, /formatter-observation-before-cleanup/);
    }
    if (typeof Bun !== "undefined") {
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      for (const value of Object.values(output))
        transpiler.transformSync(value);
    }
  });
}

test("overlay refuses a drifting source anchor", () => {
  assert.throws(
    () =>
      overlaySources(
        {
          ...inputs,
          [paths[1]]: inputs[paths[1]].replace(
            '    let output = "";',
            '    let changed = "";',
          ),
        },
        "control",
      ),
    /instrumentation anchor/,
  );
});

test("observer calibrates before the test and the workflow preserves cold ordering", () => {
  const observer = readFileSync(
    new URL("./windows-probe-observer.ps1", import.meta.url),
    "utf8",
  );
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/windows-probe-diagnostic.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    observer.indexOf("calibration-start-and-stop-observed") <
      observer.indexOf("& bun --no-env-file test"),
  );
  assert.ok(
    workflow.indexOf(
      "bun test scripts/doctor.test.ts scripts/developer.test.ts",
    ) < workflow.indexOf("windows-probe-overlay.mjs prepare"),
  );
  assert.match(workflow, /fail-fast: false/);
  assert.doesNotMatch(workflow, /path: application/);
  assert.match(observer, /Win32_ProcessStartTrace/);
  assert.match(observer, /Win32_ProcessStopTrace/);
  assert.match(observer, /nativeFileTime/);
  assert.match(observer, /collectorUtc/);
  assert.doesNotMatch(observer, /Get-CimInstance|Stop-Process|\.Kill\(/);
});

test("Handle query is exact-path, bounded, and never closes a foreign handle", () => {
  const handle = readFileSync(
    new URL("./windows-probe-handle.mjs", import.meta.url),
    "utf8",
  );
  const observer = readFileSync(
    new URL("./windows-probe-observer.ps1", import.meta.url),
    "utf8",
  );
  assert.match(handle, /timeout: 5000/);
  assert.match(handle, /16384 - stream.kept/);
  assert.match(handle, /\["-accepteula", "-nobanner", casePath\]/);
  assert.doesNotMatch(handle, /"-c"|"-y"|taskkill|Stop-Process/);
  assert.match(observer, /Get-AuthenticodeSignature/);
  assert.match(observer, /Microsoft Corporation/);
  assert.match(observer, /Get-FileHash/);
});

const observerPath = new URL("./windows-probe-observer.ps1", import.meta.url);
const observer = readFileSync(observerPath, "utf8");
const handle = readFileSync(
  new URL("./windows-probe-handle.mjs", import.meta.url),
  "utf8",
);

function powershell(script) {
  return JSON.parse(
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8" },
    ),
  );
}

test("native lineage binds the real root and retires reused PIDs", () => {
  const result = powershell(`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${fileURLToPath(observerPath).replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Observer parse failed' }
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ProbeLineage' }, $true)
if (-not $function) { throw 'Missing pure lineage function' }
Invoke-Expression $function.Extent.Text
$identity = @{ rootPid = 100; invocationUtc = '2026-10-22T12:00:00.0000000Z'; rootEntryUtc = '2026-10-22T12:00:00.010Z'; observerPid = 42; bunBasename = 'bun.exe' }
function Event($kind, $id, $parent, $name, $milliseconds) {
  $time = ([DateTime]'2026-10-22T12:00:00Z').AddMilliseconds($milliseconds)
  @{ kind = $kind; pid = $id; ppid = $parent; basename = $name; nativeUtc = $time.ToString('O'); nativeFileTime = [string]$time.ToFileTimeUtc() }
}
$lost = Get-ProbeLineage @((Event 'start' 100 999 'unrelated.exe' 1000), (Event 'start' 101 100 'unrelated-child.exe' 1001)) $identity
$probeOutcome = $identity.Clone(); $probeOutcome.kind = 'observed'; $probeOutcome.nativeRootStartObserved = $lost.nativeRootStartObserved; $probeExit = 0
${observer.match(/  if \(\$probeOutcome\.rootPid -and -not \$probeOutcome\.nativeRootStartObserved\).*$/m)?.[0] ?? "throw 'Missing incomplete coverage gate'"}
$lostOutcome = @{ kind = $probeOutcome.kind; exit = $probeExit }
$valid = Get-ProbeLineage @((Event 'start' 100 42 'bun.exe' 10.8), (Event 'start' 101 100 'child.exe' 20), (Event 'stop' 101 100 'child.exe' 30), (Event 'start' 101 999 'unrelated.exe' 40), (Event 'start' 102 101 'unrelated-child.exe' 41), (Event 'stop' 100 42 'bun.exe' 50), (Event 'start' 100 999 'bun.exe' 60), (Event 'start' 103 100 'unrelated-child.exe' 61)) $identity
$wrongParent = Get-ProbeLineage @((Event 'start' 100 999 'bun.exe' 5)) $identity
$wrongName = Get-ProbeLineage @((Event 'start' 100 42 'unrelated.exe' 5)) $identity
$late = Get-ProbeLineage @((Event 'start' 100 42 'bun.exe' 11.1)) $identity
$early = Get-ProbeLineage @((Event 'start' 100 42 'bun.exe' -1)) $identity
$reusedWithoutStop = Get-ProbeLineage @((Event 'start' 100 42 'bun.exe' 5), (Event 'start' 101 100 'child.exe' 20), (Event 'start' 101 999 'unrelated.exe' 30), (Event 'start' 102 101 'unrelated-child.exe' 40)) $identity
$unstarted = Get-ProbeLineage @() @{ kind = 'instrumentation-failure' }
@{ lost = $lost; lostOutcome = $lostOutcome; valid = $valid; wrongParent = $wrongParent; wrongName = $wrongName; late = $late; early = $early; reusedWithoutStop = $reusedWithoutStop; unstarted = $unstarted } | ConvertTo-Json -Depth 10 -Compress
`);
  assert.equal(result.lost.nativeRootStartObserved, false);
  assert.deepEqual(result.lost.lineage, []);
  assert.deepEqual(result.lostOutcome, {
    kind: "incomplete-native-root-coverage",
    exit: 1,
  });
  assert.deepEqual(result.unstarted, {
    lineage: [],
    nativeRootStartObserved: false,
  });
  assert.equal(result.valid.nativeRootStartObserved, true);
  assert.deepEqual(
    result.valid.lineage.map(({ kind, pid }) => [kind, pid]),
    [
      ["start", 100],
      ["start", 101],
      ["stop", 101],
      ["stop", 100],
    ],
  );
  for (const key of ["wrongParent", "wrongName", "late", "early"]) {
    assert.equal(result[key].nativeRootStartObserved, false);
    assert.deepEqual(result[key].lineage, []);
  }
  assert.deepEqual(
    result.reusedWithoutStop.lineage.map(({ kind, pid }) => [kind, pid]),
    [
      ["start", 100],
      ["start", 101],
    ],
  );
});

const scopeOutput = resolve(".audit/windows-probe-diagnostic");
const scopeOwner = resolve(scopeOutput, "../doctor-docker");
const scopeExamples = [];
for (const [mode, prefix] of [
  ["control", "case"],
  ["formatter", "format"],
]) {
  for (const [name, relative, expected] of [
    ["actual fixture layout", `fixture-Ab123/${prefix}-Cd456`, true],
    ["flat layout", `${prefix}-Cd456`, false],
    ["extra nesting", `fixture-Ab123/nested/${prefix}-Cd456`, false],
    ["wrong fixture prefix", `nested/${prefix}-Cd456`, false],
    ["invalid fixture suffix", `fixture-Ab_123/${prefix}-Cd456`, false],
    ["invalid scope suffix", `fixture-Ab123/${prefix}-Cd_456`, false],
    ["outside owner", `../outside/fixture-Ab123/${prefix}-Cd456`, false],
    ["escaped owner", `fixture-Ab123/../../outside/${prefix}-Cd456`, false],
    [
      "wrong mode",
      `fixture-Ab123/${mode === "control" ? "format" : "case"}-Cd456`,
      false,
    ],
  ]) {
    scopeExamples.push({
      name: `${mode} ${name}`,
      mode,
      scope: resolve(scopeOwner, relative),
      owner: scopeOwner,
      expected,
    });
  }
}
scopeExamples.push({
  name: "Windows owner comparison ignores case",
  mode: "control",
  scope: resolve(scopeOwner.toUpperCase(), "fixture-Ab123/case-Cd456"),
  owner: scopeOwner,
  expected: true,
});

test("JavaScript Handle guard accepts only the mode's scope inside an owned fixture", () => {
  const guard = handle.slice(
    handle.indexOf("const [executable"),
    handle.indexOf("const start ="),
  );
  const validate = new Function(
    "process",
    "assert",
    "basename",
    "dirname",
    "resolve",
    guard,
  );
  for (const { name, mode, scope, expected } of scopeExamples) {
    const invoke = () =>
      validate(
        { argv: ["node", "helper", "handle64.exe", scope, scopeOutput, mode] },
        assert,
        basename,
        dirname,
        resolve,
      );
    if (expected) assert.doesNotThrow(invoke, name);
    else assert.throws(invoke, undefined, name);
  }
});

test("PowerShell Handle guard accepts only the mode's scope inside an owned fixture", () => {
  const result = powershell(`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${fileURLToPath(observerPath).replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
$function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ProbeOwnedScope' }, $true)
if (-not $function) { throw 'Missing owned scope function' }
Invoke-Expression $function.Extent.Text
$examples = '${JSON.stringify(scopeExamples).replaceAll("'", "''")}' | ConvertFrom-Json
@($examples | ForEach-Object { @{ name = $_.name; accepted = (Test-ProbeOwnedScope $_.scope $_.owner $_.mode) } }) | ConvertTo-Json -Compress
`);
  assert.deepEqual(
    result,
    scopeExamples.map(({ name, expected }) => ({ name, accepted: expected })),
  );
});

test("stream collectors drain oversized input while retaining at most 16 KiB per stream", async () => {
  const runtime = readFileSync(
    new URL("./windows-probe-runtime.mjs", import.meta.url),
    "utf8",
  );
  const allocations = [];
  const boundedBuffer = {
    alloc(size) {
      const buffer = Buffer.alloc(size);
      allocations.push(buffer);
      return buffer;
    },
    concat: Buffer.concat,
  };
  const events = [];
  const probeText = new Function(
    "probeEvent",
    "Buffer",
    `return (${runtime.slice(runtime.indexOf("export async function probeText"), runtime.indexOf("export function probeEnvironment")).replace("export ", "")});`,
  )((kind, detail) => events.push({ kind, ...detail }), boundedBuffer);
  const chunks = [
    new Uint8Array(65536).fill(65),
    new Uint8Array(0),
    ...Array.from({ length: 256 }, () => new Uint8Array(4096).fill(66)),
  ];
  let reads = 0;
  const text = await probeText(
    {
      getReader: () => ({
        read: async () =>
          reads < chunks.length
            ? { done: false, value: chunks[reads++] }
            : (reads++, { done: true }),
      }),
    },
    "synthetic",
  );
  assert.equal(text, "A".repeat(16384));
  assert.equal(reads, chunks.length + 1);
  assert.deepEqual(events, [
    {
      kind: "stream-eof",
      stream: "synthetic",
      bytes: 1114112,
      truncated: true,
    },
  ]);
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].buffer.byteLength, 16384);

  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const collect = handle.slice(
    handle.indexOf("const streams ="),
    handle.indexOf("let errorCode ="),
  );
  const streams = new Function(
    "child",
    "Buffer",
    collect + "\nreturn streams;",
  )(child, boundedBuffer);
  for (const chunk of chunks) {
    child.stdout.emit("data", Buffer.from(chunk));
    child.stderr.emit("data", Buffer.from(chunk));
  }
  for (const stream of Object.values(streams)) {
    assert.equal(stream.bytes, 1114112);
    assert.equal(stream.kept, 16384);
    assert.equal(stream.buffer.toString(), "A".repeat(16384));
  }
  assert.equal(allocations.length, 3);
  assert.ok(allocations.every((buffer) => buffer.buffer.byteLength === 16384));
});
