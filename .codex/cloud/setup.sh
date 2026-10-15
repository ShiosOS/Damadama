#!/usr/bin/env bash
set -euo pipefail
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${1:-$script_directory/../..}"

source "$script_directory/runtime.sh"

for tool in curl unzip tar xz sha256sum; do
  command -v "$tool" >/dev/null || { echo "Required setup tool missing: $tool" >&2; exit 1; }
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [[ "$("$DAMADAMA_CLOUD_ROOT/node/bin/node" --version 2>/dev/null || true)" != "v$node_version" ]]; then
  archive="node-v$node_version-linux-x64.tar.xz"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v$node_version/$archive" -o "$scratch/$archive"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$scratch/SHASUMS256.txt"
  (cd "$scratch"; awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum --check --strict)
  mkdir -p "$DAMADAMA_CLOUD_ROOT/node"
  tar -xJf "$scratch/$archive" --strip-components=1 -C "$DAMADAMA_CLOUD_ROOT/node"
fi

if [[ "$("$DOTNET_ROOT/dotnet" --version 2>/dev/null || true)" != "$dotnet_version" ]]; then
  curl --fail --location --retry 3 https://dot.net/v1/dotnet-install.sh -o "$scratch/dotnet-install.sh"
  bash "$scratch/dotnet-install.sh" --version "$dotnet_version" --install-dir "$DOTNET_ROOT" --no-path
fi

if [[ "$("$BUN_INSTALL/bin/bun" --version 2>/dev/null || true)" != "$bun_version" ]]; then
  curl --fail --location --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-linux-x64.zip" -o "$scratch/bun.zip"
  unzip -q "$scratch/bun.zip" -d "$scratch/bun"
  mkdir -p "$BUN_INSTALL/bin"
  install -m 755 "$scratch/bun/bun-linux-x64/bun" "$BUN_INSTALL/bin/bun"
fi

cloud_require_versions

if [[ -f package.json ]]; then
  bun install --frozen-lockfile
  dotnet tool restore
  dotnet restore --locked-mode
  playwright=node_modules/@playwright/test/cli.js
else
  npm ci --prefix release --ignore-scripts
  playwright=release/node_modules/@playwright/test/cli.js
  echo 'This revision contains release tooling only. Application setup does not apply.'
fi

node "$playwright" install chromium
echo 'Dependency setup completed. Run bash .codex/cloud/verify.sh in the same environment.'
