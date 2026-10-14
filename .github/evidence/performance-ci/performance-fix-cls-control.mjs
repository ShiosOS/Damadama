import { readFile, writeFile } from "node:fs/promises";

const path = "tests/Browser/performance.spec.ts";
const source = await readFile(path, "utf8");
const anchor =
  '  await page.getByRole("button", { name: "Add habit", exact: true }).click();';
const mutation = `  await page.evaluate(async () => {
    document.body.style.paddingTop = "600px";
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const lateLayout = JSON.stringify(await page.evaluate(() => window.qualityLayout));
  await writeFile(".audit/performance-fix-cls-observed.json", lateLayout);
  await testInfo.attach("late-layout-control", {
    body: lateLayout,
    contentType: "application/json",
  });
`;
if (process.argv[2] === "inject") {
  if (!source.includes(anchor) || source.includes(mutation))
    throw new Error("Unexpected source or already injected");
  await writeFile(path, source.replace(anchor, mutation + anchor));
} else if (process.argv[2] === "remove") {
  if (!source.includes(mutation)) throw new Error("Mutation not found");
  await writeFile(path, source.replace(mutation, ""));
} else throw new Error("Use inject or remove");
