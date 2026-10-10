# Damadama backlog

Use the [GitHub backlog](https://github.com/ShiosOS/Damadama/issues/9) to track work. The [milestone](https://github.com/ShiosOS/Damadama/milestone/1) groups the same issues.

## Working on a story

- BDD starts with a user story and Given/When/Then examples agreed before coding.
- DDD uses the glossary's habit, schedule, and daily entry language. Put business rules in the domain model.
- TDD implements one example at a time. Write a failing behavior test, add enough code to pass, and keep tests green during refactoring at review.

Agree the slice's design and test boundaries before implementation. Coding still requires approval. Use domain tests, real PostgreSQL integration tests, and browser tests where the story needs them. Show test results and runtime evidence, then stop for review.

## Documents

- [Requirements](requirements.md) describes the product rules and constraints.
- [System design](design.md) describes the proposed implementation and open questions.
- [Domain glossary](CONTEXT.md) defines the terms used in both documents.
