import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { requireCompleteBackendResults } from "./acceptance-results";

const root = fileURLToPath(new URL("../", import.meta.url));

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stdout + stderr).toBe(0);
  return stdout + stderr;
}

test("actual pinned NUnit TRX exposes ignored, runtime ignored and explicit cases without a fixed count", async () => {
  await mkdir(join(root, ".audit/acceptance-native"), { recursive: true });
  const directory = await mkdtemp(join(root, ".audit/acceptance-native/run-"));
  try {
    const packages: string[] = [];
    const wanted = new Set([
      "Microsoft.NET.Test.Sdk",
      "NUnit",
      "NUnit3TestAdapter",
    ]);
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentag", (tag) => {
      if (tag.name !== "PackageReference") return;
      const name = tag.attributes["Include"];
      const version = tag.attributes["Version"];
      if (name && wanted.delete(name)) {
        if (!version) throw new Error(`Missing ${name} version.`);
        packages.push(
          `<PackageReference Include="${name}" Version="[${version}]"/>`,
        );
      }
    });
    parser
      .write(
        await readFile(
          join(root, "tests/Backend/Damadama.Tests.csproj"),
          "utf8",
        ),
      )
      .close();
    expect(wanted.size).toBe(0);
    const project = join(directory, "Probe.csproj");
    await writeFile(
      project,
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup>${packages.join("")}</ItemGroup></Project>`,
    );
    await run([
      "dotnet",
      "restore",
      project,
      "--artifacts-path",
      join(directory, "build"),
    ]);
    const report = join(directory, "results/backend.trx");
    const cases: [string, string, string, boolean][] = [
      ["one passing case", "", "", true],
      [
        "additional passing case",
        "[Test] public void Additional() {}",
        "",
        true,
      ],
      [
        "ignored case",
        '[Test, Ignore("probe")] public void Excluded() {}',
        "",
        false,
      ],
      [
        "runtime ignored case",
        '[Test] public void Excluded() { Assert.Ignore("probe"); }',
        "",
        false,
      ],
      [
        "explicit case",
        '[Test, Explicit("probe")] public void Excluded() {}',
        "",
        false,
      ],
      ["ignored fixture", "", '[Ignore("probe")]', false],
    ];
    for (const [name, additional, fixtureAttribute, complete] of cases) {
      await writeFile(
        join(directory, "Tests.cs"),
        `using NUnit.Framework;\n${fixtureAttribute}\npublic class Cases { [Test] public void Passing() {} ${additional} }\n`,
      );
      await rm(report, { force: true });
      const output = await run([
        "dotnet",
        "test",
        project,
        "--no-restore",
        "--artifacts-path",
        join(directory, "build"),
        "--logger",
        "trx;LogFileName=backend.trx",
        "--results-directory",
        join(directory, "results"),
      ]);
      expect(output, name).toContain("Results File:");
      if (complete) {
        expect(() => requireCompleteBackendResults(report), name).not.toThrow();
      } else {
        expect(() => requireCompleteBackendResults(report), name).toThrow(
          /outcome NotExecuted|passing results/,
        );
      }
      console.info(`NUnit completeness probe ${name}: complete=${complete}.`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
