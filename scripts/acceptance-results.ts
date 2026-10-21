import { readFileSync } from "node:fs";
import { SaxesParser } from "saxes";

const namespace = "http://microsoft.com/schemas/VisualStudio/TeamTest/2010";

export function requireCompleteBackendResults(path: string): void {
  const parser = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  let results = 0;
  let resultContainers = 0;
  let resultsClosed = false;
  let counters = 0;
  let summaries = 0;
  const reportedCounts = new Map<string, string>();
  const executions = new Set<string>();
  const fail = (reason: string): never => {
    throw new Error(`Backend acceptance incomplete in ${path}: ${reason}`);
  };
  parser.on("doctype", () => fail("DOCTYPE is not allowed."));
  parser.on("opentag", (tag) => {
    stack.push(tag.local);
    if (tag.uri !== namespace) fail("Use a namespaced TRX report.");
    const location = stack.join("/");
    if (stack.length === 1 && tag.local !== "TestRun")
      fail("The root must be TestRun.");
    const attribute = (name: string): string => {
      const value = tag.attributes[name];
      if (!value || value.uri) return fail(`Missing ${name}.`);
      return value.value;
    };
    if (location === "TestRun/Results") {
      resultContainers++;
      if (resultContainers !== 1)
        fail("Require exactly one Results container.");
    } else if (location === "TestRun/Results/UnitTestResult") {
      results++;
      const name = attribute("testName");
      const outcome = attribute("outcome");
      const execution = attribute("executionId");
      if (executions.has(execution)) fail(`Duplicate execution for ${name}.`);
      executions.add(execution);
      if (outcome !== "Passed") fail(`${name} has outcome ${outcome}.`);
    } else if (location === "TestRun/ResultSummary") {
      summaries++;
      if (!resultsClosed) fail("Results must precede their summary.");
      if (!["Completed", "Passed"].includes(attribute("outcome")))
        fail("The runner did not complete successfully.");
    } else if (location === "TestRun/ResultSummary/Counters") {
      counters++;
      for (const key of ["total", "executed", "passed"]) {
        reportedCounts.set(key, attribute(key));
      }
      for (const [key, value] of Object.entries(tag.attributes)) {
        if (
          !["total", "executed", "passed"].includes(key) &&
          value.value !== "0"
        )
          fail(`Counter ${key} is ${value.value}.`);
      }
    }
  });
  parser.on("closetag", () => {
    if (stack.join("/") === "TestRun/Results") resultsClosed = true;
    stack.pop();
  });
  parser.write(readFileSync(path, "utf8")).close();
  if (
    results === 0 ||
    resultContainers !== 1 ||
    counters !== 1 ||
    summaries !== 1
  )
    fail("Require passing results and exactly one summary with counters.");
  for (const key of ["total", "executed", "passed"]) {
    if (reportedCounts.get(key) !== String(results))
      fail(`${key} does not match the ${results} passing results.`);
  }
}
