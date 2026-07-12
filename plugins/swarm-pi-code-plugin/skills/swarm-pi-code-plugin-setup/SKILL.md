---
name: swarm-pi-code-plugin-setup
description: Configure project-local dependencies, build, test, lint, and development tooling through Pi's supervised environment-engineer role from Codex or Claude Code. Do not use for global provisioning or deployment.
---

# Configure A Development Environment With Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Write the exact project-local setup request, allowed package manager, lifecycle-script policy, verification, and prohibited global actions to a temporary prompt file.
2. Run `$RUNNER setup --host "$HOST" --role environment-engineer --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --workspace-strategy auto --json`. With `--approval-mode wait`, the managed relay returns within 15 seconds; retain the Job ID and continue with bounded `jobs wait` calls on approval or timeout.
3. For exit code `5`, present the required choice between isolated HEAD, isolated snapshot, scaffold, or adoption inspection. Do not commit, stash, delete, or hide existing files.
4. Require explicit approval for lifecycle scripts, native builds, and unknown network sources. Present the tool, action, risk, capabilities, reason, and expiry before asking for approve or deny; never auto-approve. Each decision acknowledges only its matching notification. Keep global installs, host provisioning, deployment, and Git delivery denied.
5. Inspect all changes and fresh verification, then run host verification.
