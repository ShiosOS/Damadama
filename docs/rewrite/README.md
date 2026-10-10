# Damadama rewrite tracking

Start with the [rewrite tracker](https://github.com/ShiosOS/Damadama/issues/9). The [Damadama rewrite milestone](https://github.com/ShiosOS/Damadama/milestone/1) groups the proposed work. Documentation and tracking are authorized; application implementation still requires approval.

## Documents

- [Requirements](requirements.md) records the user's target behavior and constraints.
- [System design](design.md) explains the current proposal, verification plan, and open decisions.
- [Domain glossary](CONTEXT.md) defines terms without implementation decisions.

The GitHub copies live under docs/rewrite on the dedicated docs/damadama-rewrite-plan review branch. The tracker links to that branch until the documentation PR is merged. The original app is a read-only reference.

## Proposed work

- [Decide the first slice and its product rules](https://github.com/ShiosOS/Damadama/issues/1).
- [Create and list account-owned habits](https://github.com/ShiosOS/Damadama/issues/2).
- [Add recurring schedules with preserved history](https://github.com/ShiosOS/Damadama/issues/3).
- [Save dated entries with atomic conflict resolution](https://github.com/ShiosOS/Damadama/issues/4).
- [Show the combined historical heatmap](https://github.com/ShiosOS/Damadama/issues/5).
- [Persist and reconcile offline entry changes](https://github.com/ShiosOS/Damadama/issues/6).
- [Refresh other devices after committed saves](https://github.com/ShiosOS/Damadama/issues/7).
- [Document reproducible hosting and verify recovery](https://github.com/ShiosOS/Damadama/issues/8).

The first issue settles the scope and product decisions. The remaining seven issues are proposed delivery slices. Their order is a planning proposal, with dependencies recorded in each issue. No dates or effort estimates are committed.

## One-slice workflow

1. Explain the slice's design and resolve its affected product decisions. Record implementation approval in the issue or linked discussion.
2. Build a small change on its own branch. Update the relevant requirements or design in the same PR when behavior or architecture changes.
3. Attach the relevant test results, real PostgreSQL evidence, and browser/runtime evidence. State what remains unverified, and stop for review.
4. Close the issue after acceptance criteria and review are complete. Update the tracker checklist from linked issue states.

Record proposals as proposals. An open issue or an unchecked acceptance criterion is not permission to implement an unresolved rule. Keep later decisions open until the affected slice is discussed.

## Tracking setup

Use the milestone's open/closed issue views and the tracker checklist. Issue bodies record pending decisions and implementation approval. The existing CLI login lacks GitHub Projects scopes, so no Projects board was created. A board can later present these same issues without duplicating the backlog.

Do not deploy, change DNS, provision paid infrastructure, or modify the original app. Deployment instructions and a local restore demonstration do not authorize hosted infrastructure work.
