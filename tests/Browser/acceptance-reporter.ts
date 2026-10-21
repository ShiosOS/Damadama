import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";

export default class AcceptanceReporter implements Reporter {
  private suite: Suite | undefined;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  async onEnd(result: FullResult): Promise<{ status: "failed" } | void> {
    const tests = this.suite?.allTests() ?? [];
    const incomplete = tests.filter(
      (test) =>
        test.expectedStatus !== "passed" ||
        test.results.length !== 1 ||
        test.results[0]?.status !== "passed",
    );
    for (const test of incomplete) {
      const outcomes = test.results.map((attempt) => attempt.status).join(", ");
      console.error(
        `Browser acceptance incomplete: ${test.titlePath().join(" > ")} expected ${test.expectedStatus}, observed ${outcomes || "not executed"}.`,
      );
    }
    if (tests.length === 0)
      console.error("Browser acceptance incomplete: no tests were discovered.");
    if (
      result.status !== "passed" ||
      tests.length === 0 ||
      incomplete.length > 0
    )
      return { status: "failed" };
  }
}
