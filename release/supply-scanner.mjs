import { databaseMetadata, insist, same } from "./supply-internal.mjs";

export function requireSameDatabase(expected, observed) {
  const identities = [expected, observed].map((identity) => {
    insist(
      identity &&
        same(Object.keys(identity).sort(), [
          "built",
          "schemaVersion",
          "sha256",
        ]) &&
        /^[a-f0-9]{64}$/.test(identity.sha256),
      "invalid database comparison identity",
    );
    return {
      ...databaseMetadata({
        valid: true,
        schemaVersion: identity.schemaVersion,
        built: identity.built,
      }),
      sha256: identity.sha256,
    };
  });
  insist(
    same(identities[0], identities[1]),
    `database changed since scan; rescan exact archive and sign new evidence; expected=${JSON.stringify(identities[0])}; observed=${JSON.stringify(identities[1])}`,
  );
}

const effectiveScannerProfile = {
  output: ["json"],
  file: "",
  pretty: false,
  distro: "",
  "add-cpes-if-none": false,
  "output-template-file": "",
  "check-for-app-update": false,
  "only-fixed": false,
  "only-notfixed": false,
  "ignore-wontfix": "",
  platform: "",
  search: {
    scope: "squashed",
    "unindexed-archives": false,
    "indexed-archives": true,
  },
  ignore: [
    {
      vulnerability: "",
      "include-aliases": false,
      reason: "",
      namespace: "",
      "fix-state": "",
      package: {
        name: "kernel-headers",
        version: "",
        language: "",
        type: "rpm",
        location: "",
        "upstream-name": "kernel",
      },
      "vex-status": "",
      "vex-justification": "",
      "match-type": "exact-indirect-match",
    },
    {
      vulnerability: "",
      "include-aliases": false,
      reason: "",
      namespace: "",
      "fix-state": "",
      package: {
        name: "linux(-.*)?-headers-.*",
        version: "",
        language: "",
        type: "deb",
        location: "",
        "upstream-name": "linux.*",
      },
      "vex-status": "",
      "vex-justification": "",
      "match-type": "exact-indirect-match",
    },
    {
      vulnerability: "",
      "include-aliases": false,
      reason: "",
      namespace: "",
      "fix-state": "",
      package: {
        name: "linux-libc-dev",
        version: "",
        language: "",
        type: "deb",
        location: "",
        "upstream-name": "linux",
      },
      "vex-status": "",
      "vex-justification": "",
      "match-type": "exact-indirect-match",
    },
    {
      vulnerability: "",
      "include-aliases": false,
      reason: "",
      namespace: "",
      "fix-state": "",
      package: {
        name: "linux-kbuild-.*",
        version: "",
        language: "",
        type: "deb",
        location: "",
        "upstream-name": "linux.*",
      },
      "vex-status": "",
      "vex-justification": "",
      "match-type": "exact-indirect-match",
    },
  ],
  exclude: [],
  externalSources: {
    enable: false,
    maven: {
      searchUpstreamBySha1: true,
      baseUrl: "https://search.maven.org/solrsearch/select",
      rateLimit: 300000000,
    },
  },
  match: {
    java: {
      "using-cpes": false,
    },
    jvm: {
      "using-cpes": true,
    },
    dotnet: {
      "using-cpes": false,
    },
    golang: {
      "using-cpes": false,
      "always-use-cpe-for-stdlib": false,
      "allow-main-module-pseudo-version-comparison": false,
    },
    javascript: {
      "using-cpes": false,
    },
    python: {
      "using-cpes": false,
    },
    ruby: {
      "using-cpes": false,
    },
    rust: {
      "using-cpes": false,
    },
    hex: {
      "using-cpes": false,
    },
    stock: {
      "using-cpes": true,
    },
    dpkg: {
      "using-cpes": false,
      "missing-epoch-strategy": "zero",
      "use-cpes-for-eol": false,
    },
    rpm: {
      "using-cpes": false,
      "missing-epoch-strategy": "auto",
      "use-cpes-for-eol": false,
    },
  },
  "fail-on-severity": "",
  registry: {
    "insecure-skip-tls-verify": false,
    "insecure-use-http": false,
    "ca-cert": "",
  },
  "show-suppressed": false,
  "include-matcher-suppressions": false,
  "by-cve": false,
  SortBy: {
    "sort-by": "risk",
  },
  name: "",
  "default-image-pull-source": "",
  from: null,
  "vex-documents": [],
  "vex-add": [],
  "match-upstream-kernel-headers": false,
  "fix-channel": {
    "redhat-eus": {
      apply: "auto",
      versions: ">= 8.0",
    },
    "ubuntu-esm": {
      apply: "auto",
      versions: "",
    },
  },
  timestamp: true,
  alerts: {
    "enable-eol-distro-warnings": true,
  },
  db: {
    "cache-dir": "$SESSION/db",
    "update-url": "https://grype.anchore.io/databases",
    "ca-cert": "",
    "auto-update": false,
    "validate-by-hash-on-start": true,
    "validate-age": true,
    "max-allowed-built-age": 432000000000000,
    "require-update-check": true,
    "update-available-timeout": 30000000000,
    "update-download-timeout": 300000000000,
    "max-update-check-frequency": 0,
  },
  exp: {},
  dev: {
    db: {
      debug: false,
    },
  },
};

export function validateScannerConfiguration(report, cacheDirectory) {
  const configuration = structuredClone(report.descriptor?.configuration);
  insist(
    configuration?.db?.["cache-dir"] === cacheDirectory,
    "scanner cache differs",
  );
  configuration.db["cache-dir"] = "$SESSION/db";
  insist(
    same(configuration, effectiveScannerProfile),
    "unsupported effective scanner configuration",
  );
}

export function scannerConfiguration(cacheDirectory) {
  return {
    "check-for-app-update": false,
    "only-fixed": false,
    "only-notfixed": false,
    ignore: [],
    "vex-documents": [],
    db: {
      "cache-dir": cacheDirectory,
      "auto-update": false,
      "require-update-check": true,
      "validate-by-hash-on-start": true,
      "validate-age": true,
      "max-allowed-built-age": "120h",
      "max-update-check-frequency": "0s",
    },
  };
}
