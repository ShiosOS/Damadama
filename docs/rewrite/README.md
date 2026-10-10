# Damadama rewrite tracking

Start with the [rewrite tracker](https://github.com/ShiosOS/Damadama/issues/9). The [milestone](https://github.com/ShiosOS/Damadama/milestone/1) groups the proposed work. Coding still needs approval.

## Documents

- [Requirements](requirements.md) records the target behavior and constraints.
- [System design](design.md) explains the proposed implementation, test plan, and open decisions.
- [Domain glossary](CONTEXT.md) defines the terms used in both documents.

These documents live under `docs/rewrite` on the `docs/damadama-rewrite-plan` review branch. The tracker links to that branch until the documentation PR merges.

## Proposed work

- [Decide the first slice and its product rules](https://github.com/ShiosOS/Damadama/issues/1).
- [Create and list account-owned habits](https://github.com/ShiosOS/Damadama/issues/2).
- [Add recurring schedules with preserved history](https://github.com/ShiosOS/Damadama/issues/3).
- [Save dated entries with atomic conflict resolution](https://github.com/ShiosOS/Damadama/issues/4).
- [Show the combined historical heatmap](https://github.com/ShiosOS/Damadama/issues/5).
- [Persist and reconcile offline entry changes](https://github.com/ShiosOS/Damadama/issues/6).
- [Refresh other devices after committed saves](https://github.com/ShiosOS/Damadama/issues/7).
- [Document reproducible hosting and verify recovery](https://github.com/ShiosOS/Damadama/issues/8).

The first issue settles the scope and product decisions. The other seven are proposed implementation slices. Each issue lists its dependencies. There are no committed dates or effort estimates.

## Work on one slice

1. Explain the slice's design and resolve the product decisions it depends on. Record approval to implement it in the issue or a linked discussion.
2. Build a small change on its own branch. Update the requirements or design in the same PR when the change affects them.
3. Attach the relevant test results, real PostgreSQL evidence, and browser evidence. State what remains unverified and stop for review.
4. Close the issue after its acceptance criteria and review are complete. Update the tracker checklist to match the linked issue states.

Leave later product decisions open until their slice is discussed. Creating an issue does not approve its implementation.

## Use the tracker

Use the milestone's open and closed issue views and the tracker checklist. Each issue records its decisions and approval status.

There is no GitHub Projects board because the CLI login lacks Projects access. A board can later use these same issues.

The original app remains a read-only reference. Do not deploy, change DNS, or provision paid infrastructure without approval. Deployment instructions and local restore tests do not approve hosted infrastructure work.
