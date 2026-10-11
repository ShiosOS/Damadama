import { spawn } from "bun";

async function run(command: string[]) {
  const result = await spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (result !== 0) process.exit(result);
}

const settings = [
  Bun.env.Clerk__Issuer,
  Bun.env.Clerk__PublishableKey,
  Bun.env.Parameters__postgresPassword,
];
if (
  settings.some(
    (value) =>
      !value ||
      value.includes("replace-with") ||
      value.includes("replace_with"),
  )
) {
  throw new Error(
    "Copy .env.example to .env.local and set Clerk development settings and a stable PostgreSQL password.",
  );
}
await run(["docker", "info", "--format", "{{.ServerVersion}}"]);
await run(["bun", "install", "--frozen-lockfile"]);
await run(["bun", "run", "--cwd", "web", "build"]);
await run(["dotnet", "run", "--project", "dev"]);
