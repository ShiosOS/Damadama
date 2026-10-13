export function requireLiveImage(expected, observed) {
  if (
    observed.id !== expected.id ||
    observed.activeId !== expected.id ||
    observed.status !== "SUCCESS" ||
    observed.image !== expected.image
  ) {
    throw new Error("active deployment does not match verified candidate");
  }
}

export function requireRecovery(recovery, previousImage, now = Date.now()) {
  const completed = Date.parse(recovery?.completedAt);
  if (
    !recovery?.backupId ||
    !Number.isFinite(completed) ||
    completed > now ||
    now - completed > 86_400_000 ||
    !Number.isSafeInteger(recovery.retentionDays) ||
    recovery.retentionDays < 7 ||
    !Number.isFinite(recovery.restoreSeconds) ||
    recovery.restoreSeconds <= 0 ||
    recovery.restoreSeconds > 3600 ||
    !/^https:\/\//.test(recovery.restoreEvidence) ||
    recovery.previousImage !== previousImage
  ) {
    throw new Error(
      "recovery requires a recent backup, seven-day retention, measured one-hour restore, and the actual previous image",
    );
  }
  if (previousImage && !/^https:\/\//.test(recovery.compatibilityEvidence))
    throw new Error(
      "previous image needs forward-schema compatibility evidence",
    );
  if (!previousImage && recovery.compatibilityEvidence !== "initial-release")
    throw new Error(
      "recovery must declare an initial release with no previous image",
    );
}

export function deployedImage(metadata, path) {
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(path ?? ""))
    throw new Error(
      "Railway deployment image metadata path must be established during approved setup",
    );
  let value = metadata;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("deployment image metadata is unavailable");
    value = value[key];
  }
  if (
    typeof value !== "string" ||
    !/^ghcr\.io\/shiosos\/damadama@sha256:[a-f0-9]{64}$/.test(value)
  )
    throw new Error(
      "deployment metadata does not expose an immutable Damadama image reference",
    );
  return value;
}

export function requireIsolation(config) {
  const fields = [
    "railwayEnvironmentId",
    "volumeId",
    "backupBucket",
    "databaseName",
    "databaseUser",
    "clerkApplicationId",
    "clerkIssuer",
    "clerkPublishableKey",
    "origin",
  ];
  for (const name of ["staging", "production"]) {
    for (const field of [
      ...fields,
      "railwayProjectId",
      "appServiceId",
      "databaseServiceId",
    ]) {
      if (
        typeof config?.[name]?.[field] !== "string" ||
        !config[name][field] ||
        /REPLACE/i.test(config[name][field])
      )
        throw new Error(`isolation requires concrete ${name} ${field}`);
    }
    for (const field of ["origin", "clerkIssuer"]) {
      const url = new URL(config[name][field]);
      if (url.protocol !== "https:" || url.origin !== config[name][field])
        throw new Error(`isolation requires an exact HTTPS ${field}`);
    }
    if (!config[name].clerkPublishableKey.startsWith("pk_live_"))
      throw new Error("hosted isolation requires production Clerk instances");
  }
  for (const field of fields)
    if (config.staging[field] === config.production[field])
      throw new Error(`isolation forbids shared ${field}`);
  return config;
}
