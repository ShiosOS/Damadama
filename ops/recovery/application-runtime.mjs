import assert from "node:assert/strict";

export class ApplicationRuntime {
  constructor({ image, configuration, run, docker, wait, onCheck }) {
    this.image = image;
    this.configuration = configuration;
    this.run = run;
    this.docker = docker;
    this.wait = wait;
    this.onCheck = onCheck;
  }

  origin(id) {
    const port = this.docker("port", id, "8080/tcp").match(/:(\d+)$/)?.[1];
    return `http://127.0.0.1:${port}`;
  }

  async ready(origin, label) {
    await this.wait(async () => {
      try {
        return (
          (
            await fetch(`${origin}/health/ready`, {
              signal: AbortSignal.timeout(2000),
            })
          ).status === 200
        );
      } catch {
        return false;
      }
    }, label);
  }

  async start(host, credentials, stage) {
    const id = this.run(
      "-p",
      "127.0.0.1::8080",
      "-e",
      `ConnectionStrings__habits=Host=${host};Database=habits;Username=postgres;Password=${credentials}`,
      ...this.configuration,
      this.image,
    );
    const origin = this.origin(id);
    this.onCheck(`${stage}-application-readiness`);
    await this.ready(origin, "production image readiness");
    this.onCheck(`${stage}-anonymous-refusal`);
    const response = await fetch(`${origin}/api/habits`, {
      signal: AbortSignal.timeout(10_000),
    });
    this.onCheck(`${stage}-anonymous-refusal`, response.status);
    assert.equal(response.status, 401);
    return { id, origin };
  }

  async restart(running) {
    this.docker("restart", running.id);
    running.origin = this.origin(running.id);
    await this.ready(running.origin, "restart readiness");
  }
}
