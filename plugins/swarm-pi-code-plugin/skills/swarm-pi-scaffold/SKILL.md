---
name: swarm-pi-scaffold
description: Design and create a new project through a reviewed Pi scaffold specification, isolated staging, verification, and explicit materialization from Codex or Claude Code. Use for new-project intent, especially in an empty non-Git folder.
---

# Scaffold A Project With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

Scaffold decisions can use Host-provided evidence bundles, but assurance remains recommended rather than a bypass: record reproducibility, testability, and evidence expectations, and keep materialization behind the existing explicit gate.

1. Use `$RUNNER plan --host "$HOST" --role project-architect --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json` to draft a version 1 `ScaffoldSpec`. With `supervised + wait`, the managed relay returns within 15 seconds; retain the Job ID and continue with bounded `jobs wait` calls if it reports approval or timeout.
2. Require the spec to include request, project name, target mode, runtime, package manager, structure, dependencies, verification commands, lifecycle-script policy, done criteria, and a resource-aware execution plan. Verification commands must name a bounded target, run expensive stages sequentially, and use concurrency controls only when their syntax is verified. Present the spec before mutation.
3. After explicit approval of the ScaffoldSpec, run `$RUNNER scaffold --host "$HOST" --role scaffolder --spec-file "$SPEC_FILE" --target "$TARGET" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`. Require a complete WorkerAssessment for each gated action. The active Host may issue one exact lease only for a fully reversible in-scope staging change with rollback and verification; otherwise ask the user. Adoption and materialization remain explicit user decisions.
4. Add `--adopt-existing` only for an approved `targetMode: adopt` after the user reviews the inventory.
5. Inspect provenance and verification. Only materialize a `deliverable: true` artifact through `$RUNNER jobs materialize --job <id> --target "$TARGET" --json` after explicit approval.

Pi never delivers directly. The trusted control plane owns staging metadata, target fencing, initial artifact commit, and materialization.
