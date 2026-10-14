#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.local/share/damadama-cloud/node/bin:$HOME/.bun/bin:$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

repository=$(git remote get-url origin)
revision=$(git rev-parse HEAD)
printf 'Repository %s\nRevision %s\n' "$repository" "$revision"
node --version
bun --version
dotnet --list-sdks

docker_ready=false
if command -v docker >/dev/null && timeout 20 docker info --format '{{.ServerVersion}}'; then
  docker_ready=true
  name="damadama-cloud-probe-$(cat /proc/sys/kernel/random/uuid)"
  password=$(cat /proc/sys/kernel/random/uuid)
  trap 'docker rm --force --volumes "$name" >/dev/null 2>&1 || true' EXIT
  docker run --detach --network none --name "$name" --env POSTGRES_PASSWORD="$password" postgres:17-alpine >/dev/null
  for attempt in {1..30}; do
    if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec --env PGPASSWORD="$password" "$name" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -c 'SELECT version();'
  docker rm --force --volumes "$name" >/dev/null
  trap - EXIT
  echo 'Docker and disposable PostgreSQL verified.'
else
  echo 'Docker engine unavailable. PostgreSQL/Testcontainers and Aspire startup are NOT VERIFIED.'
fi

if [[ -f package.json ]]; then
  playwright_package=./node_modules/@playwright/test
else
  playwright_package=./release/node_modules/@playwright/test
fi
node --input-type=module - "$playwright_package" <<'JS'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Damadama cloud probe</title>');
  if (await page.title() !== 'Damadama cloud probe') throw new Error('Chromium page failed');
  console.log(`Chromium launch verified: ${browser.version()}`);
} finally {
  await browser.close();
}
JS

if [[ -f package.json ]]; then
  if [[ "$docker_ready" != true ]]; then
    echo 'Full application check is blocked by the missing Docker engine.' >&2
    exit 2
  fi
  bun run check
else
  node --test release/*.test.mjs
  echo 'Release tooling checks passed. No application exists on this revision.'
fi
