---
name: swarm-pi-scaffold
description: Design and create a new project through a reviewed Pi ScaffoldSpec, isolated staging, verification, and explicit materialization from Codex or Claude Code. Use for empty or explicitly adopted non-Git targets; use implement for an existing repository and setup for tooling-only changes.
---

# Scaffold A Project With Pi

Read and follow the [cross-host control protocol](../../references/host-protocol.md), including pending-notification review, temporary spec handling, bounded waits, adjudication, terminal acknowledgement, and cleanup.

1. Run `$RUNNER plan --host "$HOST" --role project-architect --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json` to draft a version 1 `ScaffoldSpec`. Retain the Job ID and use bounded `jobs wait` calls after approval, Host Assistance, or timeout.
2. Require request, project name, target mode, runtime, package manager, structure, dependencies, lifecycle-script policy, done criteria, and a resource-aware verification plan. Inspect indirect commands, keep expensive stages sequential, and present the complete spec before mutation.
3. After explicit approval, run `$RUNNER scaffold --host "$HOST" --role scaffolder --spec-file "$SPEC_FILE" --target "$TARGET" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
4. Inspect every complete WorkerAssessment and adjudication context. Allow only an exact, in-scope, fully reversible staging action with rollback and verification; keep adoption and materialization as explicit user decisions.
5. Add `--adopt-existing` only after the user approves the target inventory and `targetMode: adopt`.
6. Inspect provenance, changed files, and fresh verification. Materialize only a `deliverable: true` artifact through `$RUNNER jobs materialize --job <id> --target "$TARGET" --json` after explicit approval.

Pi never delivers directly. The trusted control plane owns target fencing, staging metadata, the initial artifact commit, and materialization.
