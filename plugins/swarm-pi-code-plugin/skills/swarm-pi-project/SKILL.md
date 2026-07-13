---
name: swarm-pi-project
description: Reopen guided Pi role routing, execution safety, project scope, Host Assistance, decision, Advisor, and Host Action settings without changing provider credentials or connections.
---

# Configure Swarm Pi Project Setup

Read the [cross-host control protocol](../../references/host-protocol.md).

1. Run `$RUNNER configure --host "$HOST" --section project` and keep the command active while the user completes the local browser form.
2. Relay its loopback URL when the browser does not open. Stop cleanly on cancellation or timeout; never request an API key in chat.
3. After save, run `$RUNNER roles list --json` and `$RUNNER status --json`; report routing, classifier policy, Decision Mode, Host Assistance, Advisor/doctrine status, Host Action policy, workspace classification, task types, and sandbox mode. Clarify that doctrine is metadata only in 0.5.0.

This workflow is repeatable. It changes only role overrides, execution safety, and project profile; immutable job snapshots keep active jobs unchanged.
