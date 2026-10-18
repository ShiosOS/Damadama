import {
  bucket,
  defineRailway,
  github,
  image,
  preserve,
  project,
  service,
  volume,
  type ProjectDefinition,
  type VariableValue,
} from "railway/iac";

export default defineRailway((ctx): ProjectDefinition => {
  const environment = ctx.environment;
  const limits = { containers: { cpu: 0.5, memoryBytes: 500_000_000 } };

  if (environment === "preview-base") {
    const data = volume("preview-postgres-volume", {
      region: "us-west2",
      sizeMB: 1_000,
      forkFromBaseEnvironment: false,
    });
    const previewDatabase = service("preview-postgres", {
      source: image(
        "postgres:17-alpine@sha256:bb377b7239d2774ac8cc76f481596ce96c5a6b5e9d141f6d0a0ee371a6e7c0f2",
      ),
      replicas: { "us-west2": 1 },
      deploy: { limitOverride: limits },
      volumeMounts: { "/var/lib/postgresql/data": data },
      env: {
        PGDATA: "/var/lib/postgresql/data/pgdata",
        POSTGRES_DB: "damadama_preview",
        POSTGRES_USER: "preview",
        POSTGRES_PASSWORD: {
          generator:
            'secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
        },
      },
    });

    const app = service("preview-app", {
      source: github("ShiosOS/Damadama", { branch: "main" }),
      build: {
        builder: "DOCKERFILE",
        dockerfilePath: ".railway/Preview.Dockerfile",
      },
      healthcheck: "/health/ready",
      healthcheckTimeout: 300,
      replicas: { "us-west2": 1 },
      deploy: {
        limitOverride: limits,
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 2,
      },
      env: {
        ConnectionStrings__habits:
          "Host=${{preview-postgres.RAILWAY_PRIVATE_DOMAIN}};Port=5432;Database=${{preview-postgres.POSTGRES_DB}};Username=${{preview-postgres.POSTGRES_USER}};Password=${{preview-postgres.POSTGRES_PASSWORD}}",
        Clerk__Issuer: {
          type: "sharedReference",
          name: "PREVIEW_CLERK_ISSUER",
        } satisfies VariableValue,
        Clerk__PublishableKey: {
          type: "sharedReference",
          name: "PREVIEW_CLERK_PUBLISHABLE_KEY",
        } satisfies VariableValue,
        Clerk__AuthorizedParties__0:
          "https://${{preview-app.RAILWAY_PUBLIC_DOMAIN}}",
      },
    });
    return project("Damadama", {
      environments: [environment],
      resources: [app, previewDatabase, data],
    });
  }

  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      "Select staging, production or the isolated preview-base explicitly.",
    );
  }

  let appName = "app";
  let domain = "staging.damadama.app";
  if (environment === "production") {
    appName = "app-production";
    domain = "prod.damadama.app";
  }
  const data = volume(`postgres-${environment}-volume`, {
    region: "us-west2",
    sizeMB: 50_000,
  });
  const trustedDatabase = service(`postgres-${environment}`, {
    build: { builder: "RAILPACK", buildEnvironment: "V3" },
    replicas: { "us-west2": 1 },
    deploy: {
      limitOverride: limits,
      runtime: "V2",
      useLegacyStacker: false,
      ipv6EgressEnabled: false,
    },
    env: {
      PGDATA: preserve(),
      POSTGRES_DB: preserve(),
      POSTGRES_PASSWORD: preserve(),
      POSTGRES_USER: preserve(),
    },
    volumeMounts: { "/var/lib/postgresql/data": data },
  });
  const app = service(appName, {
    build: { builder: "RAILPACK", buildEnvironment: "V3" },
    healthcheck: "/health/ready",
    healthcheckTimeout: 300,
    replicas: { "us-west2": 1 },
    domains: [{ domain, port: 8080 }],
    deploy: {
      limitOverride: limits,
      runtime: "V2",
      useLegacyStacker: false,
      ipv6EgressEnabled: false,
    },
    env: {
      Clerk__AuthorizedParties__0: preserve(),
      Clerk__Issuer: preserve(),
      Clerk__PublishableKey: preserve(),
      ConnectionStrings__habits: preserve(),
    },
  });
  const backup = service(`backup-${environment}`, {
    build: { builder: "RAILPACK", buildEnvironment: "V3" },
    start: "sh /opt/recovery/backup.sh",
    replicas: { "us-west2": 1 },
    deploy: {
      limitOverride: limits,
      runtime: "V2",
      useLegacyStacker: false,
      ipv6EgressEnabled: false,
      restartPolicyType: "NEVER",
      cronSchedule: "0 3 * * *",
    },
    env: {
      AGE_RECIPIENT: preserve(),
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_DEFAULT_REGION: preserve(),
      AWS_ENDPOINT_URL: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      BACKUP_ENVIRONMENT: preserve(),
      PGDATABASE: preserve(),
      PGHOST: preserve(),
      PGPASSWORD: preserve(),
      PGPORT: preserve(),
      PGUSER: preserve(),
      S3_BUCKET: preserve(),
    },
  });
  const backups = bucket(`damadama-${environment}-backups`, { region: "sjc" });
  return project("Damadama", {
    environments: [environment],
    resources: [app, trustedDatabase, backup, data, backups],
  });
});
