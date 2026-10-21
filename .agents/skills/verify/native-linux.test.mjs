import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  descendants,
  fixtureFiles,
  fixtureSnapshot,
  listenerIds,
  processIdentity,
  removeOwnedFixtures,
} from "./owned-resources.mjs";

assert.equal(
  process.platform,
  "linux",
  "Native OS tests require Linux and are not stand-in live evidence.",
);

test("actual child/listener identity becomes absent after its owned termination", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    const [data] = await once(child.stdout, "data");
    const port = Number(data.toString().trim());
    const identity = await processIdentity(child.pid);
    assert.equal(identity.pid, child.pid);
    assert.ok(identity.startTicks);
    assert.deepEqual(listenerIds(port), [child.pid]);
    assert.ok(
      (await descendants(process.pid)).some((row) => row.pid === child.pid),
    );
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    assert.equal(await processIdentity(child.pid), null);
    assert.deepEqual(listenerIds(port), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});

test(
  "an actual process exit between opening and reading stat is absence",
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let readErrorCode;
    try {
      await once(child.stdout, "data", { signal: t.signal });
      const identity = await processIdentity(
        child.pid,
        async (path, encoding) => {
          if (path.endsWith("boot_id")) return readFile(path, encoding);
          const handle = await open(path, "r");
          try {
            const exited = once(child, "exit", { signal: t.signal });
            child.kill("SIGTERM");
            await exited;
            return await handle.readFile(encoding);
          } catch (error) {
            readErrorCode = error.code;
            throw error;
          } finally {
            await handle.close();
          }
        },
      ).catch((error) => ({ failure: error.message }));
      assert.equal(readErrorCode, "ESRCH");
      assert.equal(identity, null);
      assert.equal(await processIdentity(child.pid), null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }
  },
);

test("actual Linux cleanup removes only fresh owned fixtures and is repeatable", async () => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "damadama-native-cleanup-"));
  try {
    for (const path of fixtureFiles) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "before");
    }
    const before = await fixtureSnapshot(root);
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "owned-current-run");
    const owned = await fixtureSnapshot(root);
    await writeFile(join(root, "preserved.txt"), "unrelated");
    await removeOwnedFixtures(root, before, owned);
    await removeOwnedFixtures(root, before, owned);
    assert.equal(
      await readFile(join(root, "preserved.txt"), "utf8"),
      "unrelated",
    );
    assert.deepEqual(
      await fixtureSnapshot(root),
      Object.fromEntries(fixtureFiles.map((path) => [path, null])),
    );
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "before-again");
    const nextBefore = await fixtureSnapshot(root);
    for (const path of fixtureFiles)
      await writeFile(join(root, path), "next-owned-current-run");
    const nextOwned = await fixtureSnapshot(root);
    const outside = join(root, "preserved.txt");
    await unlink(join(root, fixtureFiles[0]));
    await symlink(outside, join(root, fixtureFiles[0]));
    await assert.rejects(
      removeOwnedFixtures(root, nextBefore, nextOwned),
      /file-type-refused/,
    );
    assert.equal(await readFile(outside, "utf8"), "unrelated");
  } finally {
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  }
});
