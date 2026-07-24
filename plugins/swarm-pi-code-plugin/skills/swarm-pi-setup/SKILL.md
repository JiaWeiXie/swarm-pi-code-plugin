---
name: swarm-pi-setup
description: Configure project-local dependencies, build, test, lint, and development tooling through Pi's supervised environment-engineer role from Codex or Claude Code. Use for reproducible repository tooling changes; use implement for product code, scaffold for new projects, and never perform global provisioning or deployment.
---

# Configure A Development Environment With Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Write the exact project-local setup request, allowed package manager, lifecycle-script policy, prohibited global actions, and a resource-aware verification plan to a temporary prompt file. Inspect indirect scripts and keep install, build, test, and verification stages sequential.
2. Run `$RUNNER setup --host "$HOST" --role environment-engineer --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --workspace-strategy auto --json`.
3. For every non-terminal result, use the control loop.
4. For exit code `5`, present isolated HEAD, isolated snapshot, scaffold, or adoption inspection without choosing, committing, stashing, deleting, or hiding files.
5. Allow only an exact, project-local, fully reversible action already covered by setup intent, with exact targets, rollback, and verification. Ask the user about unknown lifecycle scripts, uncertain network targets, native builds, or partially reversible changes. Keep global installs, host provisioning, deployment, and Git delivery denied.
6. Inspect all changes and fresh worker evidence, then run targeted host-owned verification.
