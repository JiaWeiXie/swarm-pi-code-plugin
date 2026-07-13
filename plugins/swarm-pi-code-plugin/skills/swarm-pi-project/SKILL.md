---
name: swarm-pi-project
description: Reopen guided Pi role routing, execution safety, project scope, Host Assistance, decision, Advisor, and Host Action settings without changing provider credentials or connections.
---

# Configure Swarm Pi Project Setup

Read the [cross-host control protocol](../../references/host-protocol.md).

1. Run `$RUNNER configure --host "$HOST" --section project` and keep the command active while the user completes the local browser form.
2. Relay its loopback URL when the browser does not open. Stop cleanly on cancellation or timeout; never request an API key in chat.
3. After save, run `$RUNNER roles list --json` and `$RUNNER status --json`; report routing, classifier policy, Decision Mode, Host Assistance review mode and automatic scope, Discovery gate review, Advisor/doctrine status, Host Action policy, workspace classification, task types, and Sandbox mode. Clarify that doctrine is currently metadata only.

This workflow is repeatable. New projects use Adaptive, Host-first, Reversible, and Discovery gate review; legacy projects keep their stored Sandbox mode and missing Host-first fields normalize to User-only until resaved. It changes only role overrides, execution safety, and project profile; immutable Job snapshots keep active Jobs unchanged.
