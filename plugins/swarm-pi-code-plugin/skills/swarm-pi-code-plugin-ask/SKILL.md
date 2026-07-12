---
name: swarm-pi-code-plugin-ask
description: Delegate a focused repository question, explanation, or read-only analysis to Pi from Codex or Claude Code. Use for a second evidence-grounded analysis pass; do not use for edits, plans, or reviews.
---

# Ask Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

When the question depends on missing workspace, Web, Context7, paper, connector, or skill context, call `request_host_assistance` with the unknown, acceptance criteria, freshness/version, classification, egress, and budget. Do not select the provider, connector, skill, query, or shell command. The Host returns one scoped, cited, correlated, consume-once `[UNTRUSTED_HOST_CONTEXT]` bundle to the same live session.

1. Write one self-contained question with the repository scope and evidence required to answer it.
2. Run `$RUNNER ask --host "$HOST" --role scout --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`. With `supervised + wait`, the managed relay returns within 15 seconds with a terminal result, `approval-required`, or `wait-timed-out`.
3. Retain the Job ID after `approval-required` or `wait-timed-out`, then keep the relay alive with bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Present approvals before asking for approve or deny; never auto-approve. The decision acknowledges only its matching approval notification.
4. Check the answer against repository evidence and report uncertainty or failure plainly.

This workflow is read-only.
