#!/usr/bin/env bash

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Cloud setup requires Linux x64 to match the committed Aspire lockfile.' >&2
  exit 1
fi

node_version=24.21.0
dotnet_version=10.0.112
bun_version=1.3.14
export DAMADAMA_CLOUD_ROOT="${DAMADAMA_CLOUD_ROOT:-$PWD/.audit/codex-cloud-runtime}"
if [[ "$DAMADAMA_CLOUD_ROOT" != /* ]]; then
  echo 'DAMADAMA_CLOUD_ROOT must be an absolute writable path.' >&2
  exit 1
fi

export DOTNET_ROOT="$DAMADAMA_CLOUD_ROOT/dotnet"
export DOTNET_CLI_HOME="$DAMADAMA_CLOUD_ROOT/dotnet-cli"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export NUGET_PACKAGES="$DAMADAMA_CLOUD_ROOT/cache/nuget/packages"
export NUGET_HTTP_CACHE_PATH="$DAMADAMA_CLOUD_ROOT/cache/nuget/http"
export NUGET_PLUGINS_CACHE_PATH="$DAMADAMA_CLOUD_ROOT/cache/nuget/plugins"
export BUN_INSTALL="$DAMADAMA_CLOUD_ROOT/bun"
export BUN_INSTALL_CACHE_DIR="$DAMADAMA_CLOUD_ROOT/cache/bun"
export npm_config_cache="$DAMADAMA_CLOUD_ROOT/cache/npm"
export PLAYWRIGHT_BROWSERS_PATH="$DAMADAMA_CLOUD_ROOT/cache/playwright"
export XDG_CACHE_HOME="$DAMADAMA_CLOUD_ROOT/cache/xdg"
export TMPDIR="$DAMADAMA_CLOUD_ROOT/tmp"
export PATH="$DAMADAMA_CLOUD_ROOT/node/bin:$BUN_INSTALL/bin:$DOTNET_ROOT:$PATH"

for directory in "$DOTNET_ROOT" "$DOTNET_CLI_HOME" "$NUGET_PACKAGES" \
  "$NUGET_HTTP_CACHE_PATH" "$NUGET_PLUGINS_CACHE_PATH" "$BUN_INSTALL" \
  "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" "$PLAYWRIGHT_BROWSERS_PATH" "$XDG_CACHE_HOME" "$TMPDIR"; do
  mkdir -p "$directory"
  probe=$(mktemp "$directory/.write-probe.XXXXXX")
  rm "$probe"
done

cloud_require_versions() {
  local commands=("$DAMADAMA_CLOUD_ROOT/node/bin/node" "$BUN_INSTALL/bin/bun" "$DOTNET_ROOT/dotnet")
  local expected=("v$node_version" "$bun_version" "$dotnet_version")
  local index actual
  for index in "${!commands[@]}"; do
    actual=$("${commands[index]}" --version)
    if [[ "$actual" != "${expected[index]}" ]]; then
      printf '%s requires %s; found %s. Run setup.sh.\n' "${commands[index]}" "${expected[index]}" "$actual" >&2
      return 1
    fi
  done
  printf 'Node %s\nBun %s\n.NET SDK %s\nRuntime root %s\n' \
    "$node_version" "$bun_version" "$dotnet_version" "$DAMADAMA_CLOUD_ROOT"
}
