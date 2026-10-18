import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, coverage, freshness } from "./supply-policy.mjs";
import {
  authenticatedStatement,
  production,
  proof,
  slsa,
  spdx,
  toolEnvironment,
  fileHash,
  json,
  root,
  databaseMetadata,
} from "./supply-internal.mjs";
import { validateEvidence, scanArchive } from "./supply-chain.mjs";
import { manifestFiles } from "./supply-evidence.mjs";

const source = {
  repository: "ShiosOS/Damadama",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};
const authority = { sha: source.commit, runId: 123, attempt: 2 };
const scope = "ghcr.io/shiosos/damadama";
const now = Date.parse("2026-10-18T12:00:00Z");
const policy = await json(join(root, "supply-policy.json"));
const match = {
  vulnerability: {
    namespace: "github:language:javascript",
    id: "GHSA-35jh-r3h4-6jhm",
    severity: "High",
    fix: { state: "not-fixed", versions: [] },
  },
  artifact: {
    name: "lodash",
    purl: "pkg:npm/lodash@4.17.15",
    version: "4.17.15",
  },
};
const report = (matches = []) => ({
  descriptor: {
    name: "grype",
    version: "0.120.1",
    db: {
      status: {
        valid: true,
        schemaVersion: "v6.1.10",
        built: "2026-10-18T01:00:00Z",
      },
    },
  },
  source: { type: "image" },
  matches,
  ignoredMatches: [],
});
const exception = {
  namespace: match.vulnerability.namespace,
  id: match.vulnerability.id,
  purl: match.artifact.purl,
  version: match.artifact.version,
  image: scope,
  owner: "security-owner",
  reviewer: "security-reviewer",
  reason: "Time bounded review",
  issue: "https://github.com/ShiosOS/Damadama/issues/42",
  expires: "2026-10-19T12:00:00Z",
};
const sbom = {
  spdxVersion: "SPDX-2.3",
  packages: [
    {
      externalRefs: [
        {
          referenceType: "purl",
          referenceLocator: "pkg:deb/debian/base-files@12",
        },
      ],
    },
    {
      externalRefs: [
        { referenceType: "purl", referenceLocator: "pkg:nuget/Npgsql@10.0.0" },
      ],
    },
  ],
};

test("policy retains lower findings and refuses high and critical including unfixed", () => {
  assert.equal(
    assess([{ kind: "runtime", report: report() }], policy, scope, now).status,
    "accepted",
  );
  for (const severity of ["Low", "Medium", "Negligible"])
    assert.equal(
      assess(
        [
          {
            kind: "runtime",
            report: report([
              { ...match, vulnerability: { ...match.vulnerability, severity } },
            ]),
          },
        ],
        policy,
        scope,
        now,
      ).status,
      "accepted",
    );
  for (const severity of ["High", "Critical"])
    assert.equal(
      assess(
        [
          {
            kind: "runtime",
            report: report([
              { ...match, vulnerability: { ...match.vulnerability, severity } },
            ]),
          },
        ],
        policy,
        scope,
        now,
      ).blocked[0].id,
      match.vulnerability.id,
    );
});

test("a reviewed exact exception passes only the selected package and image until expiry", () => {
  const selected = { ...policy, exceptions: [exception] };
  assert.equal(
    assess([{ kind: "runtime", report: report([match]) }], selected, scope, now)
      .status,
    "accepted",
  );
  for (const change of [
    { expires: "2026-10-18T12:00:00Z" },
    { purl: "pkg:npm/*" },
    { id: "other" },
    { namespace: "other" },
    { version: "4.17.16" },
    { image: "ghcr.io/other/image" },
    { reviewer: "" },
    { issue: "https://example.com/42" },
    { unexpected: true },
  ])
    assert.throws(() =>
      assess(
        [{ kind: "runtime", report: report([match]) }],
        { ...policy, exceptions: [{ ...exception, ...change }] },
        scope,
        now,
      ),
    );
  assert.throws(
    () =>
      assess(
        [{ kind: "runtime", report: report([match]) }],
        { ...policy, exceptions: [exception, exception] },
        scope,
        now,
      ),
    /duplicate/,
  );
  assert.throws(
    () => assess([{ kind: "runtime", report: report() }], selected, scope, now),
    /unmatched/,
  );
});

test("unknown or filtered scanner output cannot produce acceptance", () => {
  assert.equal(
    assess(
      [{ kind: "runtime", report: { ...report(), ignoredMatches: null } }],
      policy,
      scope,
      now,
    ).status,
    "accepted",
  );
  assert.equal(
    assess(
      [{ kind: "runtime", report: { ...report(), ignoredMatches: undefined } }],
      policy,
      scope,
      now,
    ).status,
    "accepted",
  );
  for (const change of [
    { ignoredMatches: [match] },
    { ignoredMatches: {} },
    { matches: null },
    { descriptor: { name: "grype", version: "other" } },
    {
      matches: [
        {
          ...match,
          vulnerability: { ...match.vulnerability, severity: "Unknown" },
        },
      ],
    },
    { matches: [{}] },
  ])
    assert.throws(() =>
      assess(
        [{ kind: "runtime", report: { ...report(), ...change } }],
        policy,
        scope,
        now,
      ),
    );
});

test("native Grype v6 status metadata is normalized without inventing a checksum", () => {
  const status = {
    schemaVersion: "v6.1.10",
    built: "2026-10-17T06:27:09Z",
    from: "https://grype.anchore.io/databases/v6/example.tar.zst",
    path: "/isolated/db/6/vulnerability.db",
    valid: true,
  };
  assert.deepEqual(databaseMetadata(status), {
    schemaVersion: status.schemaVersion,
    built: status.built,
  });
  for (const value of [
    { status },
    { ...status, valid: false },
    { ...status, error: "database corrupt" },
    { ...status, schemaVersion: "v7.0.0" },
    { ...status, built: "2027-02-30T00:00:00Z" },
  ])
    assert.throws(() => databaseMetadata(value));
});

test("scan and DB ages are checked at the current clock", () => {
  freshness("2026-10-18T11:00:00Z", "2026-10-14T12:00:00Z", policy, now);
  for (const [scan, database] of [
    ["2026-10-17T11:59:59Z", "2026-10-17T01:00:00Z"],
    ["2026-10-18T11:00:00Z", "2026-10-13T11:59:59Z"],
    ["2026-10-18T12:00:01Z", "2026-10-18T01:00:00Z"],
    ["2026-10-18T11:00:00Z", "2026-10-18T11:00:01Z"],
    ["yesterday", "2026-10-18T01:00:00Z"],
  ])
    assert.throws(() => freshness(scan, database, policy, now));
});

test("inventory measures OS and .NET without claiming frontend completeness", () => {
  assert.deepEqual(coverage(sbom, report()).osPackages, 1);
  assert.deepEqual(coverage(sbom, report()).dotnetPackages, 1);
  assert.equal(coverage(sbom, report()).frontend.status, "incomplete");
  assert.throws(() =>
    coverage({ spdxVersion: "SPDX-2.3", packages: [] }, report()),
  );
  assert.throws(() => coverage(sbom, { source: { type: "directory" } }));
  assert.equal(spdx, "https://spdx.dev/Document/v2.3");
});

function parsedVerification() {
  const identity =
    "https://github.com/ShiosOS/Damadama/.github/workflows/stage.yml@refs/heads/main";
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: identity,
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryURI: "https://github.com/ShiosOS/Damadama",
            sourceRepositoryIdentifier: "1412858535",
            sourceRepositoryOwnerURI: "https://github.com/ShiosOS",
            sourceRepositoryOwnerIdentifier: "31512984",
            sourceRepositoryDigest: source.commit,
            sourceRepositoryRef: "refs/heads/main",
            buildSignerDigest: authority.sha,
            buildSignerURI: identity,
            runnerEnvironment: "github-hosted",
            runInvocationURI:
              "https://github.com/ShiosOS/Damadama/actions/runs/123/attempts/2",
          },
        },
        verifiedTimestamps: [
          {
            type: "Tlog",
            uri: "https://rekor.sigstore.dev",
            timestamp: "2026-10-18T12:00:00Z",
          },
        ],
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: slsa,
          subject: [
            { name: "manifest.json", digest: { sha256: "d".repeat(64) } },
          ],
        },
      },
    },
  ];
}

test("parsed native output validates every authenticated identity field; this is not a crypto proof", () => {
  assert(
    authenticatedStatement(
      parsedVerification(),
      production,
      source,
      authority,
      slsa,
      "d".repeat(64),
    ),
  );
  for (const key of Object.keys(
    parsedVerification()[0].verificationResult.signature.certificate,
  )) {
    const parsed = parsedVerification();
    parsed[0].verificationResult.signature.certificate[key] += "wrong";
    assert.throws(
      () =>
        authenticatedStatement(
          parsed,
          production,
          source,
          authority,
          slsa,
          "d".repeat(64),
        ),
      new RegExp(key),
    );
  }
  assert.throws(
    () =>
      authenticatedStatement(
        parsedVerification(),
        proof,
        source,
        authority,
        slsa,
        "d".repeat(64),
      ),
    /subjectAlternativeName/,
  );
  const parsed = parsedVerification();
  parsed[0].verificationResult.verifiedTimestamps = [
    { type: "CurrentTime", uri: "", timestamp: "2026-10-18T12:00:00Z" },
  ];
  assert.throws(
    () =>
      authenticatedStatement(
        parsed,
        production,
        source,
        authority,
        slsa,
        "d".repeat(64),
      ),
    /timestamp/,
  );
  assert.throws(() =>
    authenticatedStatement(
      [],
      production,
      source,
      authority,
      slsa,
      "d".repeat(64),
    ),
  );
  assert.throws(() =>
    authenticatedStatement(
      parsedVerification(),
      production,
      source,
      authority,
      spdx,
      "d".repeat(64),
    ),
  );
  assert.throws(() =>
    authenticatedStatement(
      parsedVerification(),
      production,
      source,
      authority,
      slsa,
      "e".repeat(64),
    ),
  );
});

test("scanner subprocess environment drops suppressions, credentials and alternate trust roots", () => {
  assert.deepEqual(
    toolEnvironment({
      PATH: "/bin",
      GRYPE_ONLY_FIXED: "true",
      GRYPE_CONFIG: "/evil",
      SYFT_CONFIG: "/evil",
      GH_TOKEN: "secret",
      GH_DEBUG: "api",
      SSL_CERT_FILE: "/evil",
      NODE_EXTRA_CA_CERTS: "/evil",
      GH_HOST: "evil",
    }),
    { PATH: "/bin" },
  );
});

test("incomplete runtime evidence cannot enter signed validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supply-incomplete-"));
  try {
    await writeFile(join(directory, "image.tar"), "legacy runtime only");
    await assert.rejects(
      validateEvidence(directory, source, authority, proof),
      /ENOENT/,
    );
    await assert.rejects(
      validateEvidence(directory, source, authority, production),
      /ENOENT/,
    );
    await assert.rejects(manifestFiles(directory), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive mismatch refuses before invoking native scanners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supply-archive-"));
  try {
    const archivePath = join(directory, "image.tar");
    await writeFile(archivePath, "wrong bytes");
    await assert.rejects(
      scanArchive({
        source,
        authority,
        archivePath,
        evidenceDirectory: directory,
        build: {
          kind: "application",
          source,
          authority,
          version: "main-aaaaaaaaaaaa",
          archiveSha256: "0".repeat(64),
        },
      }),
      /differs from build record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing archive preserves the filesystem refusal before invoking native scanners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supply-missing-archive-"));
  try {
    await assert.rejects(
      scanArchive({
        source,
        authority,
        archivePath: join(directory, "absent.tar"),
        evidenceDirectory: join(directory, "scan"),
        build: {
          kind: "application",
          source,
          authority,
          version: "main-aaaaaaaaaaaa",
          archiveSha256: "0".repeat(64),
        },
      }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one exception registry covers frontend-only findings and preserves duplicate raw occurrences", () => {
  const lower = {
    ...match,
    vulnerability: { ...match.vulnerability, id: "low", severity: "Low" },
  };
  const reports = [
    { kind: "runtime", report: report([lower]) },
    { kind: "frontend", report: report([match, match]) },
  ];
  const refused = assess(reports, policy, scope, now);
  assert.equal(refused.status, "refused");
  assert.equal(refused.blocked.length, 1);
  assert.deepEqual(refused.blocked[0].occurrences, [
    { report: "frontend", index: 0 },
    { report: "frontend", index: 1 },
  ]);
  assert.equal(refused.findings.length, 2);
  const permitted = assess(
    reports,
    { ...policy, exceptions: [exception] },
    scope,
    now,
  );
  assert.equal(permitted.status, "accepted");
  assert.equal(permitted.exceptions.length, 1);
  for (const change of [
    { expires: "2000-01-01T00:00:00Z" },
    { purl: "pkg:npm/*" },
    { reviewer: "" },
    { id: "other" },
  ])
    assert.throws(() =>
      assess(
        reports,
        { ...policy, exceptions: [{ ...exception, ...change }] },
        scope,
        now,
      ),
    );
  assert.throws(
    () =>
      assess(
        reports,
        { ...policy, exceptions: [exception, exception] },
        scope,
        now,
      ),
    /duplicate/,
  );
});

test("blocking runtime findings never short-circuit validation of later raw reports", () => {
  const runtime = { kind: "runtime", report: report([match]) };
  for (const frontend of [
    report([{}]),
    { ...report(), ignoredMatches: [match] },
    { ...report(), matches: null },
    report([
      {
        ...match,
        vulnerability: { ...match.vulnerability, severity: "Unknown" },
      },
    ]),
  ])
    assert.throws(() =>
      assess(
        [runtime, { kind: "frontend", report: frontend }],
        policy,
        scope,
        now,
      ),
    );
  for (const invalid of [
    [],
    [runtime, runtime],
    [{ kind: "other", report: report() }],
  ])
    assert.throws(() => assess(invalid, policy, scope, now));
});

test("an existing evidence directory refuses before native tools can mix completed results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supply-fresh-"));
  try {
    const archivePath = join(directory, "image.tar");
    await writeFile(archivePath, "archive bytes");
    await writeFile(
      join(directory, "assessment.json"),
      "old completed evidence",
    );
    await assert.rejects(
      scanArchive({
        source,
        authority,
        archivePath,
        evidenceDirectory: directory,
        build: {
          kind: "application",
          source,
          authority,
          version: "main-aaaaaaaaaaaa",
          archiveSha256: await fileHash(archivePath),
        },
      }),
      /EEXIST/,
    );
    assert.equal(
      await readFile(join(directory, "assessment.json"), "utf8"),
      "old completed evidence",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime Grype IDs join unique SPDX packages without losing duplicate findings", async () => {
  const { reconcileRuntimeReport } = await import("./supply-policy.mjs");
  const artifact = {
    id: "a".repeat(16),
    type: "deb",
    name: "perl-base",
    version: "5.38.2-3.2ubuntu0.6",
    purl: "pkg:deb/ubuntu/perl-base@5.38.2-3.2ubuntu0.6",
  };
  const packageItem = {
    SPDXID: `SPDXRef-Package-deb-perl-base-${artifact.id}`,
    name: artifact.name,
    versionInfo: artifact.version,
    externalRefs: [{ referenceType: "purl", referenceLocator: artifact.purl }],
  };
  const inventory = { packages: [packageItem] };
  const raw = { matches: [{ artifact }, { artifact }] };
  reconcileRuntimeReport(inventory, raw);
  for (const field of ["id", "type", "name", "version", "purl"])
    assert.throws(() =>
      reconcileRuntimeReport(inventory, {
        matches: [{ artifact: { ...artifact, [field]: "wrong" } }],
      }),
    );
  assert.throws(
    () => reconcileRuntimeReport({ packages: [packageItem, packageItem] }, raw),
    /duplicate/,
  );
});
