---
name: swarm-pi-implement
description: Delegate an explicit scoped file change, fix, or refactor to Pi from Codex or Claude Code. Use only for approved mutation intent; route new projects to scaffold and project-local tooling to setup.
---

# Implement With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

During implementation, the worker may call `request_host_assistance` for bounded workspace, Web, docs, paper, connector, or installed-skill context. The Host chooses the capability and returns a correlated, consume-once `[UNTRUSTED_HOST_CONTEXT]` bundle. Never bypass scoped tools. An action recommendation remains inert until the Host explicitly records it and starts `jobs action-start`; that creates an isolated `host-broker` child and never transfers the parent writer lease.

1. Confirm explicit mutation intent. Do not hide, stash, discard, or commit user changes; route non-Git new-project work to scaffold.
2. Write task, scope, acceptance criteria, prohibited actions, and a resource-aware verification plan to a temporary prompt file. Prefer targeted checks and require expensive build or test commands to run sequentially with only verified low-concurrency options.
3. Run `$RUNNER implement --host "$HOST" --role executor --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`. With `--approval-mode wait`, the managed relay returns within 15 seconds instead of blocking the Host shell.
4. Retain the Job ID after `approval-required` or `wait-timed-out`, then poll with `jobs wait --wait-timeout-ms 15000 --job <job-id> --json` until terminal. Present the exact tool, action, risk, capabilities, reason, and expiry before asking for approve or deny. Never auto-approve; each decision acknowledges only its matching approval notification.
5. Use background only for an explicitly requested, project-enabled `mechanical-executor`; all other implementation stays supervised. Do not mutate the same worktree while Pi runs.
6. Inspect the actual diff, changed files, `runtimeSideEffects`, verification, and artifact before delivery. Safe-dirty generated files do not block. For exit code `5`, present `isolated-head` and `isolated-snapshot`: HEAD omits local changes; snapshot delivery remains isolated.
7. A `workspace-unborn-head` response is fail-fast: no model ran. Preserve its continuation, route an empty workspace to scaffold or existing content to adoption, then resume after the user-approved repair.
8. Safe-dirty `auto` execution uses a job-owned worktree. After verification, show the artifact diff and request explicit delivery approval before `$RUNNER jobs materialize --job <id> --json`; materialization applies changes without committing them.
9. For `host-assistance-required` or `human-decision-required`, inspect `$RUNNER jobs host-requests --job <id> --json`, obtain the bounded Host result or human decision, write only the structured response to a temporary file, then use `jobs host-respond`/`jobs decide`. Match Job, generation, session, attempt, perspective, and request ID exactly. Never synthesize a human decision.
10. A recorded local `ActionRecommendation` may be started only after explicit user confirmation with `$RUNNER jobs action-start --job <parent> --request <request-id> --json`. Remote write, message, deploy, and transaction remain workspace-disabled by default. Treat `unknown` external outcomes as terminal and never retry automatically.

Run host-owned verification targeted-first and avoid needlessly repeating a complete suite already supported by fresh worker evidence. Never commit, merge, push, or integrate an artifact marked `deliverable: false`.
