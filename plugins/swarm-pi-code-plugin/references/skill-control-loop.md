# Skill Control Loop

Every public Pi skill follows this bounded loop. Its invariant is **one request,
one workflow, one immutable policy snapshot**.

1. **Route.** Choose the narrowest matching public skill. Use the user's goal as
   the brief; add only missing scope, observable completion criteria, protected
   boundaries, and one unresolved decision. A plan is a deliverable, not a
   mandatory prelude to implementation.
2. **Resolve.** The plugin root is two directories above `SKILL.md` in Codex and
   `${CLAUDE_PLUGIN_ROOT}` in Claude Code. Set `$HOST` to `claude` when that
   variable exists, otherwise `codex`; set `$RUNNER` to
   `mise exec -- node "$PLUGIN_ROOT/scripts/pi-runner.mjs"`.
3. **Inspect.** Run `$RUNNER status --json`, then
   `$RUNNER jobs list --pending-notifications --json`. Present every pending
   approval or terminal notification before acknowledging only the item shown.
   Readiness is capability-specific: `readonly`, `mutation`, or `delivery`.
4. **Preserve.** Put the original request and any prompt or spec in a temporary
   file outside the repository. Keep credentials, tokens, and private Host paths
   out of it. Preserve user changes, leases, approval ceilings, and delivery
   authority.
5. **Run.** Invoke exactly one matching runner command. Default to
   `--execution-mode supervised --approval-mode deny`; use `wait` or background
   only when the selected skill or user requests that branch.
6. **Continue.** A non-terminal result keeps its Job ID. Load the
   [cross-host branch protocol](host-protocol.md), inspect the complete durable
   record, and use bounded `jobs wait --wait-timeout-ms 15000` calls. Worker
   prose is advisory; trusted runtime effects and the policy snapshot control.
7. **Complete.** Completion requires a terminal result shown to the user,
   repository claims checked, the shown terminal notification acknowledged,
   temporary files removed, and remaining uncertainty stated. Mutation results
   also require inspection of the actual diff and Host-owned verification.

Load branch reference only when its pointer fires:

- [Resource-aware execution](resource-aware-execution.md) before a build, full
  test, benchmark, browser, container, service, lifecycle, or unknown recursive
  command.
- [Configuration](host-protocol-configuration.md) for provider, credential, or
  configuration storage behavior.
- [Discovery](host-protocol-discovery.md) for experiments and Human Decision
  gates.
