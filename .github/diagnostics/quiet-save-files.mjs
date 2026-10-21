import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fontKinds } from "./quiet-save-schema.mjs";

export async function readOwnedFile(
  path,
  minimumTime = 0,
  maximumBytes = 4 * 1024 * 1024,
) {
  return readFileWithIdentity(path, minimumTime, maximumBytes, true);
}
export async function readInstalledNunitoFile(kind) {
  if (!fontKinds.includes(kind))
    throw new Error("Installed font selection refused.");
  return readFileWithIdentity(
    resolve(
      `node_modules/@fontsource-variable/nunito/files/nunito-${kind}-wght-normal.woff2`,
    ),
    0,
    1024 * 1024,
    false,
  );
}

export async function directoryIdentity(path) {
  const identities = [];
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(current)) !== current
    )
      throw new Error("Directory ownership refused.");
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return identities;
}
export async function checkDirectories(identities) {
  for (const identity of identities) {
    const stat = await lstat(identity.path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    )
      throw new Error("Directory replaced.");
  }
}
async function readFileWithIdentity(
  path,
  minimumTime,
  maximumBytes,
  singleLink,
) {
  const parents = await directoryIdentity(dirname(path));
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (singleLink && before.nlink !== 1) ||
    before.size < 1 ||
    before.size > maximumBytes ||
    before.mtimeMs < minimumTime
  )
    throw new Error("File ownership refused.");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("File replaced.");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      after.size !== before.size ||
      bytes.length !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink() ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.nlink !== before.nlink
    )
      throw new Error("File changed.");
    await checkDirectories(parents);
    return bytes;
  } finally {
    await handle.close();
  }
}
