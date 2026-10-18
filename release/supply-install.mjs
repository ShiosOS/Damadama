import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  root,
  json,
  hash,
  insist,
  isolated,
  run,
  installScopes,
} from "./supply-internal.mjs";

const scope = process.argv[2] ?? "all";
insist(Object.hasOwn(installScopes, scope), "unknown pinned installer scope");
const platform = `${process.platform}-${process.arch}`;
const pins = await json(join(root, "supply-tools.json"));
const destination = join(root, "../.audit/supply-tools", platform);
await mkdir(destination, { recursive: true });

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  insist(response.ok, `tool download failed ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

await isolated(async (cwd) => {
  for (const name of installScopes[scope]) {
    const tool = pins[name];
    const pin = tool.executables[platform];
    insist(pin, `unsupported tool platform ${platform}`);
    const base = `https://github.com/${tool.repository}/releases/download/v${tool.version}/`;
    const bytes = await download(`${base}${pin.asset}`);
    insist(
      hash(bytes) === (pin.archiveSha256 ?? pin.sha256),
      `${name} release integrity mismatch`,
    );
    const archive = join(cwd, pin.asset);
    await writeFile(archive, bytes);
    if (name === "syft" || name === "grype") {
      const checksums = `${name}_${tool.version}_checksums.txt`;
      const checksumsPath = join(cwd, checksums);
      const bundlePath = `${checksumsPath}.sigstore.json`;
      const checksumsBytes = await download(`${base}${checksums}`);
      await writeFile(checksumsPath, checksumsBytes);
      await writeFile(
        bundlePath,
        await download(`${base}${checksums}.sigstore.json`),
      );
      run(
        join(destination, pins.cosign.executables[platform].name),
        [
          "verify-blob",
          "--bundle",
          bundlePath,
          "--certificate-identity",
          `https://github.com/anchore/${name}/.github/workflows/release.yaml@refs/heads/main`,
          "--certificate-oidc-issuer",
          "https://token.actions.githubusercontent.com",
          checksumsPath,
        ],
        { cwd },
      );
      insist(
        checksumsBytes
          .toString()
          .split(/\r?\n/)
          .includes(`${pin.archiveSha256}  ${pin.asset}`),
        `${name} archive missing from authenticated checksum list`,
      );
    }
    let executable = bytes;
    if (pin.member)
      executable = run("tar", ["-xOf", archive, pin.member], {
        cwd,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      });
    insist(
      hash(executable) === pin.sha256,
      `${name} executable integrity mismatch`,
    );
    const target = join(destination, pin.name);
    await writeFile(target, executable);
    await chmod(target, 0o755);
    console.log(`Authenticated ${name} ${tool.version}`);
  }
});
