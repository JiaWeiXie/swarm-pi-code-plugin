# Skill Control Loop

Use this compact protocol for every public Pi skill. It is intentionally the
default skill context budget: route one bounded request, preserve its immutable
job policy, and only load an addendum when the request needs that domain.

1. Use the user's expressed goal as the brief. Add only missing scope,
   acceptance criteria, protected boundaries, and an unresolved decision; do
   not first read the whole repository or rewrite an exhaustive postcard.
2. Select exactly one public skill and invoke the matching runner command.
   A plan is a user-facing deliverable, not a context-cost optimisation step.
   With explicit mutation intent, `implement --implementation-profile prewalk`
   is available as an opt-in alternative to plan then implement.
3. Preserve user changes, leases, policy, approval ceilings, and delivery
   authority. A result never authorises a broader action.
4. For a non-terminal result, inspect the typed status. Resolve only an
   in-scope, reversible Host action already allowed by the snapshotted policy;
   otherwise return the decision to the user.
5. Verify the actual result and report unknowns. Never infer commit, push,
   materialization, destructive cleanup, or external delivery authority.

Load addenda only when needed:

- `host-protocol.md` for approval, Host Assistance, durable jobs, artifacts,
  or delivery controls.
- `host-protocol-discovery.md` for experiments and Human Decision gates.
- `host-protocol-configuration.md` for configuration or credentials.
