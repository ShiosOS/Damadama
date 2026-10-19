import assert from "node:assert/strict";

export function verifyReceiverTriggers(workflow) {
  assert.deepEqual(
    workflow.on?.schedule,
    [{ cron: "2-57/5 * * * *" }],
    "receiver schedule declaration",
  );
  assert.ok(
    Object.hasOwn(workflow.on, "workflow_dispatch"),
    "receiver manual declaration",
  );
  assert.equal(
    workflow.on.workflow_dispatch,
    null,
    "receiver manual declaration",
  );
  for (const event of ["pull_request", "push"])
    assert.deepEqual(
      workflow.on[event],
      {
        paths: [
          "ops/diagnostics/**",
          "server/**",
          "tests/Backend/**",
          "Directory.Build.props",
          "global.json",
          ".github/workflows/ops-request-errors.yml",
        ],
      },
      `receiver ${event} path scope declaration`,
    );
}

export const receiverTriggerMutations = [
  [
    "schedule deleted",
    (changed) => delete changed.on.schedule,
    /receiver schedule declaration/,
  ],
  [
    "schedule changed",
    (changed) => (changed.on.schedule[0].cron = "0 0 * * *"),
    /receiver schedule declaration/,
  ],
  [
    "manual trigger deleted",
    (changed) => delete changed.on.workflow_dispatch,
    /receiver manual declaration/,
  ],
  [
    "manual trigger changed",
    (changed) => (changed.on.workflow_dispatch = { inputs: { bypass: {} } }),
    /receiver manual declaration/,
  ],
  ...["pull_request", "push"].flatMap((event) => [
    [
      `${event} deleted`,
      (changed) => delete changed.on[event],
      /path scope declaration/,
    ],
    [
      `${event} paths deleted`,
      (changed) => delete changed.on[event].paths,
      /path scope declaration/,
    ],
    [
      `${event} paths changed`,
      (changed) => (changed.on[event].paths[0] = "ops/monitoring/**"),
      /path scope declaration/,
    ],
    [
      `${event} path removed`,
      (changed) => changed.on[event].paths.pop(),
      /path scope declaration/,
    ],
  ]),
];
