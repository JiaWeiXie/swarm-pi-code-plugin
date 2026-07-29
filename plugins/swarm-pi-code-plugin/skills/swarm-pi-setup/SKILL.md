---
name: swarm-pi-setup
description: Set up reproducible project-local dependencies, build, test, lint, and development tooling with Pi's supervised environment engineer. Use for repository tooling changes; route product code to implement and new projects to scaffold. Global provisioning and deployment stay out of scope.
---

# Configure A Development Environment With Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md). Load
[Resource-Aware Execution](../../references/resource-aware-execution.md) before
install, build, test, or recursive tooling commands.

1. Write the exact project-local request, allowed package manager,
   lifecycle-script policy, Host-only boundaries, and sequential verification
   plan to the temporary prompt.
2. Run `$RUNNER setup --host "$HOST" --role environment-engineer --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --workspace-strategy auto --json`.
3. Continue every non-terminal result through the control loop.
4. Exit code `5` presents isolated HEAD, isolated snapshot, scaffold, or adoption
   inspection as a user decision, with existing files and Git state preserved.
5. Eligible automatic action is exact, project-local, fully reversible, already
   covered by setup intent, and paired with rollback and verification. Unknown
   lifecycle scripts, uncertain network targets, native builds, or partial
   reversibility return to the user. Global installs, Host provisioning,
   deployment, and Git delivery remain outside the role ceiling.
6. Complete only when every changed file is accounted for, fresh worker evidence
   is inspected, and targeted Host-owned verification passes.
