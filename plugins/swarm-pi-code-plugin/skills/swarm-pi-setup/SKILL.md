---
name: swarm-pi-setup
description: Configure project-local dependencies, build, test, lint, and development tooling through Pi's supervised environment-engineer role from Codex or Claude Code. Do not use for global provisioning or deployment.
---

# Configure A Development Environment With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

Setup may ask the Host to find local files or current SDK/API documentation through scoped assistance. Preserve the returned provenance and keep setup changes reproducible and verifiable; do not grant a connector or side effect implicitly.

1. Write the exact project-local setup request, allowed package manager, lifecycle-script policy, verification, prohibited global actions, and resource-aware execution plan to a temporary prompt file. Inspect indirect scripts and keep installation, build, and test stages sequential with only verified low-concurrency options.
2. Run `$RUNNER setup --host "$HOST" --role environment-engineer --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --workspace-strategy auto --json`. With `--approval-mode wait`, the managed relay returns within 15 seconds; retain the Job ID and continue with bounded `jobs wait` calls on approval or timeout.
3. For exit code `5`, present the required choice between isolated HEAD, isolated snapshot, scaffold, or adoption inspection. Do not commit, stash, delete, or hide existing files.
4. Require a complete WorkerAssessment for lifecycle scripts, native builds, and unknown network sources. The active Host may issue one exact lease only for a fully reversible, project-local action already authorized by the setup intent, with exact targets, rollback, and verification. Ask the user for unknown scripts, partially reversible changes, uncertain network targets, or insufficient confidence. Keep global installs, host provisioning, deployment, and Git delivery denied.
5. Inspect all changes and fresh verification, then run host verification.
