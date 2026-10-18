#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export APPHOST_PROOF_DIR
APPHOST_PROOF_DIR=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/damadama-apphost.XXXXXX")
apphost_pid=""
dcp_pid=""
dcp_monitor=""
container_id=""
stage=preflight
volume=damadama-first-slice-postgres

record_resources() {
  local monitor output
  local -a monitors dcps containers
  mapfile -t monitors < <(sed -nE 's/.*Starting DCP with arguments: start-apiserver --monitor ([0-9]+).*/\1/p' "$APPHOST_PROOF_DIR/apphost.log" | sort -u)
  if (( ${#monitors[@]} == 1 )); then
    monitor=${monitors[0]}
    mapfile -t dcps < <(ps -C dcp -o pid=,args= | awk -v monitor="$monitor" '{ for (i=2; i<NF; i++) if ($i == "--monitor" && $(i+1) == monitor) print $1 }')
    if (( ${#dcps[@]} == 1 )); then dcp_pid=${dcps[0]}; dcp_monitor=$monitor; fi
    if (( ${#dcps[@]} > 1 )); then return 1; fi
  fi
  output=$(timeout 5 docker ps -aq --no-trunc --filter "volume=$volume") || return 1
  containers=()
  if [[ -n "$output" ]]; then mapfile -t containers <<<"$output"; fi
  if (( ${#containers[@]} == 1 )); then container_id=${containers[0]}; fi
  (( ${#monitors[@]} <= 1 && ${#containers[@]} <= 1 ))
}

resources_stopped() {
  if [[ -n "$dcp_pid" ]] && kill -0 "$dcp_pid" 2>/dev/null; then return 1; fi
  if [[ -n "$container_id" ]]; then
    local running
    running=$(timeout 5 docker ps -q --no-trunc --filter "id=$container_id") || return 1
    [[ -z "$running" ]] || return 1
  fi
}

cleanup() {
  local status=$? owned=true group_stopped=true complete=true forced=false dcp_stopped=true container_stopped=true
  trap - EXIT INT TERM
  set +e
  if [[ -n "$apphost_pid" ]]; then
    record_resources || owned=false
    kill -TERM -- "-$apphost_pid" 2>/dev/null
    local deadline=$((SECONDS + 20))
    while kill -0 -- "-$apphost_pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
    if kill -0 -- "-$apphost_pid" 2>/dev/null; then
      forced=true
      kill -KILL -- "-$apphost_pid" 2>/dev/null
      sleep 1
    fi
    wait "$apphost_pid" 2>/dev/null
    kill -0 -- "-$apphost_pid" 2>/dev/null && group_stopped=false
    deadline=$((SECONDS + 20))
    while ! resources_stopped && (( SECONDS < deadline )); do sleep 1; done
    if ! resources_stopped; then
      forced=true
      if [[ -n "$dcp_pid" ]] && ps -p "$dcp_pid" -o args= | awk -v monitor="$dcp_monitor" '{ for (i=1; i<NF; i++) if ($i == "--monitor" && $(i+1) == monitor) found=1 } END { exit !found }'; then
        kill -TERM "$dcp_pid" 2>/dev/null
      fi
      if [[ -n "$container_id" ]]; then timeout 7 docker stop --time 5 "$container_id" >/dev/null 2>&1; fi
      sleep 1
    fi
    resources_stopped || complete=false
    [[ "$owned" == true && "$group_stopped" == true ]] || complete=false
    if [[ -n "$dcp_pid" ]] && kill -0 "$dcp_pid" 2>/dev/null; then dcp_stopped=false; fi
    if [[ -z "$dcp_pid" ]] && pgrep -x dcp >/dev/null; then dcp_stopped=false; fi
    [[ "$dcp_stopped" == true ]] || complete=false
    if [[ -z "$container_id" ]]; then
      local remaining
      remaining=$(timeout 5 docker ps -q --filter "volume=$volume")
      if [[ $? != 0 || -n "$remaining" ]]; then container_stopped=false; fi
    else
      local running
      running=$(timeout 5 docker ps -q --no-trunc --filter "id=$container_id")
      if [[ $? != 0 || -n "$running" ]]; then container_stopped=false; fi
    fi
    [[ "$container_stopped" == true ]] || complete=false
  fi
  if [[ "$complete" != true && "$status" == 0 ]]; then status=1; fi
  APPHOST_STATUS=$status APPHOST_STAGE=$stage APPHOST_CLEANUP=$complete \
    APPHOST_GROUP_STOPPED=$group_stopped APPHOST_FORCED=$forced \
    APPHOST_DCP_STOPPED=$dcp_stopped APPHOST_CONTAINER_STOPPED=$container_stopped \
    APPHOST_DCP_RECORDED=$([[ -n "$dcp_pid" ]] && echo true || echo false) \
    APPHOST_CONTAINER_RECORDED=$([[ -n "$container_id" ]] && echo true || echo false) \
    node --input-type=module <<'NODE'
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const directory = process.env.APPHOST_PROOF_DIR;
const read = (name) => {
  try { return JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')); }
  catch { return null; }
};
const proof = {
  testedSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  result: Number(process.env.APPHOST_STATUS) === 0 ? 'pass' : 'fail',
  stage: process.env.APPHOST_STAGE,
  dependencies: read('dependencies.json'),
  ef: read('ef.json'),
  endpoints: read('endpoints.json'),
  cleanup: {
    complete: process.env.APPHOST_CLEANUP === 'true',
    processGroupStopped: process.env.APPHOST_GROUP_STOPPED === 'true',
    forcedStop: process.env.APPHOST_FORCED === 'true',
    dcpRecorded: process.env.APPHOST_DCP_RECORDED === 'true',
    containerRecorded: process.env.APPHOST_CONTAINER_RECORDED === 'true',
    dcpStopped: process.env.APPHOST_DCP_STOPPED === 'true',
    containerStopped: process.env.APPHOST_CONTAINER_STOPPED === 'true',
  },
};
if (proof.result === 'fail') {
  const log = ['apphost.log', 'ef-restore.log', 'ef-version.log', 'ef-model.log', 'ef-sql.log']
    .filter((name) => existsSync(`${directory}/${name}`)).map((name) => readFileSync(`${directory}/${name}`, 'utf8')).join('\n');
  proof.diagnosticSignals = ['Address already in use', 'Cannot connect to the Docker daemon',
    'Failed to start', 'NpgsqlException', 'SocketException', 'UnauthorizedAccessException',
    'FileNotFoundException', 'DllNotFoundException', 'Unhandled exception', 'Build failed',
    'pending changes', 'NU1004', 'NU1605', 'NU1903', 'NU1102'].filter((signal) => log.includes(signal));
}
const json = JSON.stringify(proof, null, 2);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nAppHost and EF compatibility proof\n\n\`\`\`json\n${json}\n\`\`\`\n`);
NODE
  if [[ $? != 0 && "$status" == 0 ]]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if pgrep -x dcp >/dev/null; then echo 'Refusing a pre-existing DCP process.' >&2; exit 1; fi
existing_volume=$(timeout 5 docker volume ls --filter "name=^${volume}$" --format '{{.Name}}')
if [[ -n "$existing_volume" ]]; then
  echo 'Refusing the pre-existing AppHost database volume.' >&2
  exit 1
fi
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24 for the proof');
for (const port of [5050, 5173, 17101, 17201, 17301]) {
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error(`Proof port ${port} is unavailable`)));
      server.listen({ port, host }, () => server.close(resolve));
    });
  }
}
const reference = readFileSync('dev/Damadama.AppHost.csproj', 'utf8').match(/<PackageReference Include="MessagePack" Version="([^"]+)"/)[1];
const lock = JSON.parse(readFileSync('dev/packages.linux-x64.lock.json', 'utf8'));
assert.equal(lock.dependencies['net10.0'].MessagePack.resolved, reference, 'AppHost lock must match its reference');
const files = readdirSync('.audit/check-build/bin', { recursive: true }).filter((file) => file.endsWith('/Damadama.AppHost.deps.json'));
assert.equal(files.length, 1, 'Use exactly one built AppHost dependency graph');
const deps = JSON.parse(readFileSync(`.audit/check-build/bin/${files[0]}`, 'utf8'));
const versions = Object.keys(deps.libraries).filter((name) => name.startsWith('MessagePack/'));
assert.deepEqual(versions, [`MessagePack/${reference}`], 'Built AppHost must use the declared patched dependency');
writeFileSync(`${process.env.APPHOST_PROOF_DIR}/dependencies.json`, JSON.stringify({ messagePackVersion: reference }));
console.log(`Built AppHost MessagePack version ${reference}. Proof ports are free.`);
NODE

stage=ef-tool
timeout 15 dotnet tool restore >"$APPHOST_PROOF_DIR/ef-restore.log" 2>&1
timeout 5 dotnet ef --version >"$APPHOST_PROOF_DIR/ef-version.log" 2>&1
stage=ef-model
timeout 30 dotnet ef migrations has-pending-model-changes --project server --context Damadama.Habits.HabitsDb >"$APPHOST_PROOF_DIR/ef-model.log" 2>&1
stage=ef-sql
timeout 15 dotnet ef migrations script --idempotent --no-build --project server --context Damadama.Habits.HabitsDb --output "$APPHOST_PROOF_DIR/migrations.sql" >"$APPHOST_PROOF_DIR/ef-sql.log" 2>&1
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const directory = process.env.APPHOST_PROOF_DIR;
const expected = JSON.parse(readFileSync('dotnet-tools.json', 'utf8')).tools['dotnet-ef'].version;
const actual = readFileSync(`${directory}/ef-version.log`, 'utf8').trim().split(/\r?\n/).at(-1);
assert.equal(actual, expected, 'Execute the repository EF tool version');
const sql = readFileSync(`${directory}/migrations.sql`, 'utf8');
assert(sql.includes('__EFMigrationsHistory') && sql.includes('IF NOT EXISTS'), 'Generate idempotent migration SQL');
writeFileSync(`${directory}/ef.json`, JSON.stringify({ version: actual, modelInSync: true, idempotentMigrationSql: true }));
console.log(`EF ${actual} loaded the unchanged model and generated idempotent migration SQL.`);
NODE

stage=apphost-readiness
export DOTNET_ENVIRONMENT=Development ASPNETCORE_ENVIRONMENT=Development
export ASPNETCORE_URLS=http://127.0.0.1:17101
export ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL=http://127.0.0.1:17301
export ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL=http://127.0.0.1:17201
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=true ASPIRE_DASHBOARD_SUPPRESS_BROWSER_TOKEN_IN_OUTPUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true ASPIRE_VERSION_CHECK_DISABLED=true
export ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE=false ASPIRE_INTERACTIVITY_ENABLED=false
export DcpPublisher__WaitForResourceCleanup=true
export Clerk__Issuer=https://apphost-proof.invalid
export Clerk__PublishableKey="pk_test_$(node -e 'process.stdout.write(Buffer.from("apphost-proof.invalid$").toString("base64"))')"
export Clerk__AuthorizedParties__0=http://127.0.0.1:5173
export Parameters__postgresPassword=hosted-apphost-proof-only
setsid dotnet run --project dev --no-launch-profile --no-build --artifacts-path .audit/check-build >"$APPHOST_PROOF_DIR/apphost.log" 2>&1 &
apphost_pid=$!
APPHOST_PID=$apphost_pid node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const expected = { clerkPublishableKey: process.env.Clerk__PublishableKey };
const json = (body) => { try { return JSON.parse(body); } catch { return null; } };
const config = (response, body) => response.headers.get('content-type')?.includes('application/json') && JSON.stringify(json(body)) === JSON.stringify(expected);
const html = (response, body) => response.headers.get('content-type')?.includes('text/html') && body.includes('<title>Damadama</title>') && /<div\s+id=["']app["']\s*>\s*<\/div>/.test(body);
const checks = [
  ['apiLive', 'http://127.0.0.1:5050/health/live', 200, (_, body) => body.trim() === 'Healthy'],
  ['apiReady', 'http://127.0.0.1:5050/health/ready', 200, (_, body) => body.trim() === 'Healthy'],
  ['apiConfig', 'http://127.0.0.1:5050/api/config', 200, config],
  ['builtFrontend', 'http://127.0.0.1:5050/', 200, html],
  ['viteFrontend', 'http://127.0.0.1:5173/', 200, html],
  ['proxyConfig', 'http://127.0.0.1:5173/api/config', 200, config],
  ['proxyUnauthorized', 'http://127.0.0.1:5173/api/habits', 401, (response, body) => response.headers.get('www-authenticate') === 'Bearer' && response.headers.get('content-type')?.includes('application/problem+json') && json(body)?.status === 401],
];
const live = () => process.kill(Number(process.env.APPHOST_PID), 0);
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  live();
  const results = await Promise.all(checks.map(async ([name, url, status, valid]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const body = await response.text();
      return { name, status: response.status, valid: response.status === status && Boolean(valid(response, body)) };
    } catch { return { name, status: null, valid: false }; }
  }));
  writeFileSync(`${process.env.APPHOST_PROOF_DIR}/endpoints.json`, JSON.stringify({ checks: results,
    readinessBody: results.find((result) => result.name === 'apiReady').valid ? 'Healthy' : null,
    proxyConfigEqualsExpected: results.find((result) => result.name === 'proxyConfig').valid }));
  live();
  if (results.every((result) => result.valid)) {
    console.log('AppHost API readiness, configuration, built frontend, Vite and authenticated-route refusal passed.');
    process.exit(0);
  }
  await setTimeout(1000);
}
assert.fail('AppHost endpoint assertions did not pass within 180 seconds');
NODE
stage=ownership
record_resources
[[ -n "$dcp_pid" && -n "$container_id" ]] || { echo 'AppHost DCP and database ownership could not be recorded.' >&2; exit 1; }
kill -0 "$apphost_pid"
stage=complete
