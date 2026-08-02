---
name: muvluvgg-implement-issue
description: Select and implement GitHub Issues for the muvluvgg_battle_simulator repository from scope discovery through a pull request. Use when Codex must inspect an Issue and its dependencies, route rule and question IDs to the DDD specifications, define implementation scope, work test-first, run formatting and quality gates, commit, push, and create a PR.
---

# Implement an Issue

Complete one reviewable Issue without absorbing unrelated work.

## Read the repository

1. Confirm `gh auth status`, the repository remote, branch, and `git status --short --branch`.
2. Preserve existing user changes. Stop before branching or editing when they overlap the selected Issue.
3. Read [references/spec-routing.md](references/spec-routing.md). Load only the specifications relevant to the Issue, but read every relevant section completely.

## Select and understand the Issue

1. Use an explicitly requested Issue when provided.
2. Otherwise list open Issues and reject Issues whose stated dependencies are still open.
3. Prefer the lowest implementation milestone, then the lowest Issue number. Present the selected Issue before mutating the repository.
4. Read the complete Issue body, labels, comments, and linked dependencies.
5. Extract the objective, rule IDs, question IDs, deliverables, tests, acceptance criteria, and documentation impact.
6. Search rule and question IDs with `rg`; do not infer unresolved behavior.

## Fix the scope

State a compact scope contract before editing:

- In scope
- Out of scope
- Specifications and rule IDs
- Expected files or layers
- Tests to add or change
- Observable acceptance criteria

Ask only when ambiguity would materially change behavior. Treat `Q-*` items marked pending as unsupported capabilities, not implementation invitations.

## Prepare the branch

1. Fetch the base branch after confirming the worktree is safe.
2. Create `.claude/issue-<number>-<short-slug>` from the intended base.
3. Never discard, reset, or overwrite user changes.

## Implement test-first (TDD Red → Green)

Work in a strict Red → Green loop for every behavior slice. Never write production code before a failing test demands it, and never move to the next slice while the suite is red.

1. **Red**: Add the smallest test at the lowest appropriate level, for the one behavior you are about to implement.
2. Include stable test and rule IDs where the test strategy requires them.
3. **Red**: Run the focused test and confirm it fails for the expected behavioral reason — not a typo, import error, or unrelated crash. A failure for the wrong reason means the test itself is broken; fix the test before writing any implementation.
4. **Green**: Add the minimum production code that makes the failing test pass. Do not implement behavior the current test does not require.
5. **Green**: Run the focused test again and confirm it passes.
6. Refactor while green (tests stay passing throughout).
7. Repeat the Red → Green cycle to add boundary, negative, ordering, or property cases required by the rule, one case at a time.

Do not mock Domain entities or reproduce production algorithms as test expectations. Control random values, time, and generated IDs. Update events, state deltas, API mappings, worker integration, and traceability in the same vertical slice when the Issue requires them.

## Verify

1. Run focused and affected scenario tests while iterating.
2. Inspect the complete diff for unrelated changes and accidental generated output.
3. Run `scripts/run-quality-gates.sh` from the repository root.
4. Recheck every acceptance criterion and document any intentionally unverified item.
5. Do not claim success when a command did not run. Record environment warnings separately from failures.

## Deliver the pull request

1. Read [references/pr-template.md](references/pr-template.md).
2. Commit only the reviewed files with an outcome-oriented message.
3. Push the branch and create a PR against the intended base.
4. Include `Closes #<number>`, rule IDs, scope, test evidence, documentation impact, and risks.
5. Return the commit, PR URL, quality results, and any residual concern.
