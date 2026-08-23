---
name: swarm-pi-scaffold
description: Scaffold a new project through a reviewed Pi ScaffoldSpec, isolated staging, verification, and explicit materialization. Use for empty or explicitly adopted non-Git targets; route existing repositories to implement and tooling-only changes to setup.
compatibility: Requires Node.js 22.19+, local shell command execution, and first-run npm registry access with a writable plugin directory; mutation workflows also require Git.
---

# Scaffold A Project With Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md). Load
[Resource-Aware Execution](../../references/resource-aware-execution.md) before
expensive or recursive scaffold commands.

1. Run `$RUNNER plan --host "$HOST" --role project-architect --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json` to draft a version 1 `ScaffoldSpec`. Use the control loop for every non-terminal result.
2. Require request, project name, target mode, runtime, package manager,
   structure, dependencies, lifecycle-script policy, observable completion
   criteria, and sequential verification. Present the complete spec before
   mutation.
3. After explicit approval, run `$RUNNER scaffold --host "$HOST" --role scaffolder --spec-file "$SPEC_FILE" --target "$TARGET" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
4. Eligible staging is exact, in-scope, fully reversible, and paired with
   rollback and verification. Adoption and materialization remain user
   decisions.
5. Add `--adopt-existing` only after the user approves the target inventory and `targetMode: adopt`.
6. Complete only when provenance, changed files, and fresh verification satisfy
   the approved spec. After explicit approval, materialize only a
   `deliverable: true` artifact through
   `$RUNNER jobs materialize --job <id> --target "$TARGET" --json`.

The trusted control plane owns target fencing, staging metadata, the initial
artifact commit, and materialization; Pi produces the staged artifact.
