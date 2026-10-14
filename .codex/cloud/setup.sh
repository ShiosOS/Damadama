#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.local/share/damadama-cloud/node/bin:$HOME/.bun/bin:$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1

for tool in curl unzip tar xz sha256sum; do
  command -v "$tool" >/dev/null || { echo "Required setup tool missing: $tool" >&2; exit 1; }
done

apt=(env DEBIAN_FRONTEND=noninteractive apt-get)
if [[ "$(id -u)" != 0 ]]; then
  apt=(sudo -n env DEBIAN_FRONTEND=noninteractive apt-get)
fi
"${apt[@]}" update -qq
"${apt[@]}" install -y libicu74 libssl3t64 zlib1g tzdata

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  *) echo 'Setup requires Linux x64 to match the committed Aspire lockfile.' >&2; exit 1 ;;
esac

if [[ "$(node --version 2>/dev/null || true)" != v24.21.0 ]]; then
  archive="node-v24.21.0-linux-$node_arch.tar.xz"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v24.21.0/$archive" -o "$scratch/$archive"
  curl --fail --location --retry 3 https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -o "$scratch/SHASUMS256.txt"
  (cd "$scratch"; awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum --check --strict)
  mkdir -p "$HOME/.local/share/damadama-cloud/node"
  tar -xJf "$scratch/$archive" --strip-components=1 -C "$HOME/.local/share/damadama-cloud/node"
fi

if ! dotnet --list-sdks 2>/dev/null | grep -q '^10\.0\.112 '; then
  curl --fail --location --retry 3 https://dot.net/v1/dotnet-install.sh -o "$scratch/dotnet-install.sh"
  bash "$scratch/dotnet-install.sh" --version 10.0.112 --install-dir "$DOTNET_ROOT" --no-path
fi

if [[ "$(bun --version 2>/dev/null || true)" != 1.3.14 ]]; then
  curl --fail --location --retry 3 https://bun.com/install -o "$scratch/bun-install.sh"
  bash "$scratch/bun-install.sh" bun-v1.3.14
fi

printf 'Node %s\nBun %s\n' "$(node --version)" "$(bun --version)"
dotnet --list-sdks

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

node "$playwright" install --with-deps chromium
echo 'Dependency setup completed. Run bash .codex/cloud/verify.sh in the same environment.'
