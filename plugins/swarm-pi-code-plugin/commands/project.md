---
description: Reopen guided Swarm Pi roles, scope, sandbox, Host Assistance, decision, Advisor, and action settings
argument-hint: '[--no-open]'
allowed-tools: Bash(node:*)
---

# swarm-pi-code-plugin project setup

Raw arguments: `$ARGUMENTS`

1. Use the bundled `swarm-pi-code-plugin-project` skill. Pass `--no-open` only when the user supplied that exact flag.
2. Stop when the browser result is cancelled or timed out. Never ask for an API key or repeat the project setup questions in this conversation.

This command is safe to run repeatedly. It updates role policy, execution safety, and project profile in shared runtime state; it does not change provider connections, credentials, or job history.
