---
name: swarm-pi-implement
description: Implement an explicitly authorized change, fix, or refactor in an existing repository with Pi. Use for scoped file mutation; route new projects to scaffold, project tooling to setup, and design-only work to plan. Delivery, commit, and push remain separate decisions.
---

# Implement With Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md). Load
[Resource-Aware Execution](../../references/resource-aware-execution.md) before
expensive or recursive verification.

1. Confirm explicit mutation intent and an existing Git repository. Preserve
   user changes in place; route a new non-Git project to scaffold.
2. Add only missing scope, observable acceptance criteria, protected boundaries,
   and the smallest verification plan to the temporary prompt.
3. Run `$RUNNER implement --host "$HOST" --role executor --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`; with explicit user choice, append `--implementation-profile prewalk` to preserve exploration, TODOs, and the first edit through an in-session handoff.
4. Continue every non-terminal result through the control loop. Eligible Host
   action is exact, in-scope, reversible, and already covered by mutation
   intent; deletion, Git metadata, workspace escape, and delivery return to the
   user. Background is reserved for an explicitly requested, project-enabled
   `mechanical-executor`, with the assigned worktree left exclusively to Pi.
5. Inspect the actual diff, changed files, `runtimeSideEffects`, verification,
   and artifact. Exit code `5` presents `isolated-head` and
   `isolated-snapshot` without choosing. `workspace-unborn-head` routes to
   scaffold or approved adoption before resume.
6. A safe-dirty job-owned worktree is deliverable only after the verified
   artifact diff is shown and the user approves
   `$RUNNER jobs materialize --job <id> --json`.
7. An `ActionRecommendation` starts only after user confirmation through
   `$RUNNER jobs action-start --job <parent> --request <id> --json`; an
   `unknown` external outcome remains unretried.
8. Complete only when the actual diff satisfies the request, targeted Host-owned
   verification passes, and delivery state is explicit. `deliverable: false`
   artifacts remain isolated; commit, merge, and push remain Host-owned.

Host Assistance stays correlated and consume-once. Its evidence, assessment, or
recommendation cannot expand policy or intent.
