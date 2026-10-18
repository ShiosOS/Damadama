import { recordHash } from "./policy.mjs";
import { insist, instant, same } from "./supply-internal.mjs";

export function freshness(scanTime, databaseTime, policy, now = Date.now()) {
  const scanned = instant(scanTime, "scan time");
  const built = instant(databaseTime, "database time");
  insist(
    scanned <= now && now - scanned <= policy.maximumScanAgeHours * 3_600_000,
    "scan is stale or in the future; rescan exact archive",
  );
  insist(
    built <= scanned &&
      scanned - built <= policy.maximumDatabaseAgeHours * 3_600_000 &&
      now - built <= policy.maximumDatabaseAgeHours * 3_600_000,
    "vulnerability database is stale or in the future; rescan exact archive",
  );
}

export function assess(reports, policy, imageScope, now = Date.now()) {
  insist(
    policy?.schema === 1 &&
      same(policy.blockedSeverities, ["High", "Critical"]) &&
      policy.maximumScanAgeHours === 24 &&
      policy.maximumDatabaseAgeHours === 120 &&
      Array.isArray(policy.exceptions),
    "unsupported scan policy",
  );
  insist(Array.isArray(reports) && reports.length > 0, "missing scan reports");
  const tags = new Set();
  for (const { kind, report } of reports) {
    insist(
      ["runtime", "frontend"].includes(kind) && !tags.has(kind),
      "invalid or duplicate scan report role",
    );
    tags.add(kind);
    insist(
      report?.descriptor?.name === "grype" &&
        report.descriptor.version === "0.120.1" &&
        Array.isArray(report.matches),
      "unsupported Grype report",
    );
    insist(
      report.ignoredMatches == null ||
        (Array.isArray(report.ignoredMatches) &&
          report.ignoredMatches.length === 0),
      "filtered or ignored vulnerability matches are forbidden",
    );
  }
  const decisions = [];
  const keys = new Set();
  const allowed = new Map();
  const fields = [
    "namespace",
    "id",
    "purl",
    "version",
    "image",
    "owner",
    "reviewer",
    "reason",
    "issue",
    "expires",
  ];
  for (const entry of policy.exceptions) {
    insist(
      entry && same(Object.keys(entry).sort(), [...fields].sort()),
      "malformed vulnerability exception fields",
    );
    for (const field of fields)
      insist(
        typeof entry[field] === "string" &&
          entry[field].trim() === entry[field] &&
          entry[field].length > 0 &&
          !/[\r\n*]/.test(entry[field]),
        `broad or malformed exception ${field}`,
      );
    insist(
      entry.purl.startsWith("pkg:") &&
        entry.image === imageScope &&
        /^https:\/\/github\.com\/ShiosOS\/Damadama\/issues\/[1-9][0-9]*$/.test(
          entry.issue,
        ),
      "exception requires exact package, image scope and repository issue",
    );
    insist(
      instant(entry.expires, "exception expiry") > now,
      `expired exception ${entry.id}`,
    );
    const key = [entry.namespace, entry.id, entry.purl, entry.version].join(
      "\n",
    );
    insist(!allowed.has(key), "duplicate vulnerability exception");
    allowed.set(key, entry);
  }
  const findings = new Map();
  for (const { kind, report } of reports) {
    for (const [index, match] of report.matches.entries()) {
      const v = match?.vulnerability;
      const a = match?.artifact;
      insist(
        v &&
          a &&
          typeof v.id === "string" &&
          v.id.length > 0 &&
          typeof v.namespace === "string" &&
          v.namespace.length > 0 &&
          typeof a.purl === "string" &&
          a.purl.startsWith("pkg:") &&
          typeof a.version === "string" &&
          a.version.length > 0,
        "malformed vulnerability match",
      );
      insist(
        ["Negligible", "Low", "Medium", "High", "Critical"].includes(
          v.severity,
        ),
        `unknown vulnerability severity for ${v.id}`,
      );
      const key = [v.namespace, v.id, a.purl, a.version].join("\n");
      const findingKey = `${key}\n${v.severity}`;
      if (!findings.has(findingKey))
        findings.set(findingKey, {
          namespace: v.namespace,
          id: v.id,
          severity: v.severity,
          purl: a.purl,
          version: a.version,
          occurrences: [],
        });
      findings.get(findingKey).occurrences.push({ report: kind, index });
      if (allowed.has(key)) {
        keys.add(key);
        decisions.push(allowed.get(key));
      }
    }
  }
  const normalized = [...findings.values()];
  const blocked = normalized.filter(
    (item) =>
      policy.blockedSeverities.includes(item.severity) &&
      !allowed.has(
        [item.namespace, item.id, item.purl, item.version].join("\n"),
      ),
  );
  insist(keys.size === allowed.size, "unmatched vulnerability exception");
  return {
    status: blocked.length ? "refused" : "accepted",
    blocked,
    findings: normalized,
    exceptions: [
      ...new Map(decisions.map((entry) => [recordHash(entry), entry])).values(),
    ],
  };
}

export function coverage(sbom, report) {
  insist(
    sbom?.spdxVersion === "SPDX-2.3" &&
      Array.isArray(sbom.packages) &&
      sbom.packages.length > 0,
    "missing SPDX 2.3 package inventory",
  );
  insist(
    report?.source?.type === "image",
    "scan source is not an image archive",
  );
  const purls = sbom.packages
    .flatMap((entry) => entry.externalRefs ?? [])
    .filter((ref) => ref.referenceType === "purl")
    .map((ref) => ref.referenceLocator);
  insist(purls.length > 0, "SBOM has no package identifiers");
  return {
    osPackages: purls.filter((purl) => /^pkg:(deb|rpm|apk)\//.test(purl))
      .length,
    dotnetPackages: purls.filter((purl) => purl.startsWith("pkg:nuget/"))
      .length,
    frontend: {
      status: "incomplete",
      basis:
        "Final runtime has compiled frontend assets without node_modules; no bound supplemental inventory is supplied.",
    },
  };
}

export function reconcileRuntimeReport(sbom, report) {
  const byId = new Map();
  for (const item of sbom.packages) {
    insist(
      typeof item.SPDXID === "string" && !byId.has(item.SPDXID),
      "duplicate or missing runtime SPDX identifier",
    );
    byId.set(item.SPDXID, item);
  }
  for (const match of report.matches) {
    const artifact = match.artifact;
    insist(
      /^[a-f0-9]{16}$/.test(artifact?.id),
      "unsupported runtime Grype artifact ID",
    );
    const packages = sbom.packages.filter(
      (item) =>
        item.SPDXID.startsWith(`SPDXRef-Package-${artifact.type}-`) &&
        item.SPDXID.endsWith(`-${artifact.id}`),
    );
    insist(
      packages.length === 1,
      "runtime Grype artifact lacks unique SPDX package",
    );
    const item = packages[0];
    const purls = (item.externalRefs ?? []).filter(
      (ref) => ref.referenceType === "purl",
    );
    insist(
      item.name === artifact.name &&
        item.versionInfo === artifact.version &&
        purls.length === 1 &&
        purls[0].referenceLocator === artifact.purl,
      "runtime Grype artifact differs from SPDX",
    );
  }
}
