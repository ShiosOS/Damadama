import { readFile, writeFile, appendFile } from "node:fs/promises";
import { requireController } from "./controller.mjs";
import { captureSource, requireCI } from "./github.mjs";
import { publishImages } from "./publication.mjs";

const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2));

if (process.argv[2] === "snapshot") {
  const authority = await requireController();
  const source = await captureSource(Number(process.env.PR_NUMBER));
  await requireCI(source);
  await write("source.json", source);
  await write("candidate.json", { schema: 1, source, authority });
  await appendFile(process.env.GITHUB_OUTPUT, `merge=${source.merge}\n`);
} else if (process.argv[2] === "publish") {
  const receipt = await publishImages(await read("candidate.json"), {
    application: { archivePath: "image.tar", build: await read("build.json") },
    recovery: {
      archivePath: "recovery-image.tar",
      build: await read("recovery-build.json"),
    },
  });
  await write("publication.json", receipt);
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `Published application ${receipt.application.image.reference}\n\nPublished recovery ${receipt.recovery.image.reference}\n\nThis receipt records publication only. No deployment or runtime verification was performed.\n`,
  );
} else {
  throw new Error("unknown trusted image publication operation");
}
