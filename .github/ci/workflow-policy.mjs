import { readFile } from "node:fs/promises";

export async function queueErrors(files) {
  const errors = [];
  for (const file of files) {
    const workflow = Bun.YAML.parse(await readFile(file, "utf8"));
    const scopes = [["workflow", workflow?.concurrency]];
    for (const [job, definition] of Object.entries(workflow?.jobs ?? {})) {
      scopes.push([`jobs.${job}`, definition?.concurrency]);
    }
    for (const [scope, concurrency] of scopes) {
      if (concurrency?.queue === undefined) continue;
      const location = `${file}:${scope}.concurrency`;
      if (concurrency.queue !== "max") {
        errors.push(`${location}: queue must be "max"`);
      }
      if (
        concurrency["cancel-in-progress"] !== undefined &&
        concurrency["cancel-in-progress"] !== false
      ) {
        errors.push(
          `${location}: queue requires cancel-in-progress: false or omitted`,
        );
      }
    }
  }
  return errors;
}
