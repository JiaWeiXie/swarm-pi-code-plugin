# swarm-pi-code-plugin

[繁體中文](README.zh-TW.md)

Swarm Pi connects Claude Code and Codex to a bounded Pi worker for grounded
repository questions, plans, reviews, discovery, setup, scaffolding, and
authorized implementation. The Host retains intent, approval, verification,
and delivery. Pi never owns commit, merge, push, deployment, messaging, or
transactions.

## Quick start

Install from the shared marketplace, then open Configuration from Claude Code
or Codex. Connect a provider, select a primary model and fallback, configure
roles and project scope, then save.

```bash
claude plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
claude plugin install swarm-pi-code-plugin@swarm-pi-code-plugin
```

For Codex:

```bash
codex plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
codex plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local
```

For local development:

```bash
mise run build
mise exec -- node scripts/pi-runner.mjs status --json
mise exec -- node scripts/pi-runner.mjs configure --host codex
```

Requirements: Node.js 24.15.0+, a supported Claude Code or Codex host, and a
Git repository for worktree-aware mutation. Credentials remain in Pi-compatible
user storage, never in repository state. Credential reads and writes are
cancellable; a cancelled write commits nothing and leaves no partial file
behind.

## Skills

Each entry is usable alone and is also an internal Workflow node. A Host may
compose `discover → plan → implement → review → fix/verify`; a clear one-step
request stays a one-step Skill. The plugin does not accept user-authored graph
YAML or JSON.

| Skill | Use it for |
| --- | --- |
| `configure` | Provider connections, models, and all setup defaults |
| `project` | Scope, routing, safety, timing, and testing policy |
| `ask` | One focused, read-only repository question |
| `discover` | Unknown requirements, research, bounded experiments |
| `plan` | A decision-ready implementation plan |
| `orchestrate` | Bounded independent architecture perspectives |
| `review` | Read-only review from a fixed comparison point |
| `implement` | Explicitly authorized change, fix, or refactor |
| `setup` | Project-local dependencies and development tooling |
| `scaffold` | A reviewed new-project scaffold |

Use the corresponding `swarm-pi-code-plugin:swarm-pi-*` command in Codex or
the matching Claude command. The runner CLI remains available for Host adapters
and diagnostics.

## Configuration

The browser setup is organized as Providers & Models, Project & Scope,
Execution Defaults, Review & Testing, Safety & Host Assistance, Timing &
Recovery, and Summary & Migration. Invocation choices override per-task
Configuration, which overrides built-in defaults.

Implement testing defaults to **write tests**. It does not force TDD: tests may
be written before, during, or after implementation. When a choice is needed,
the Host offers relevant methods—such as unit, integration, contract,
regression, E2E, property tests—and **no new tests**. The latter still requires
existing relevant checks, typecheck, lint, build, and documentation checks.

## Timing and recovery

New jobs default to 1 hour for ask/plan/review, 4 hours for
implement/setup/scaffold, and 8 hours for discover/orchestrate. Configuration
offers 1, 4, 8, and 12 hours. These are product policy choices informed by
published observations, not provider SLAs.

`--hard-run-limit-ms` is the canonical active-work cap. `--timeout-ms` remains
a deprecated 0.23 compatibility alias. `--wait-timeout-ms` limits only a Host
wait and never terminates a Job.

After idle time, a liveness probe checks the existing session, transport, tool,
process group, and provider status where supported; it never sends a second LLM
prompt. Trusted stream/tool/retry/compaction progress resets the probe. Three
failed probes and a recovery grace end with `unresponsive-timeout`; the
independent hard cap ends with `hard-limit-exceeded`. Explicit approval, Host,
and human-decision waits pause the active-time budget.

See [Execution Time and Recovery](docs/execution-time-policy.md).

## Safety and compatibility

Strict, Adaptive, Lenient, Autopilot, and Full-access preserve their existing
boundaries. Host Assistance remains bounded, correlated, and consume-once; it
does not add authority. A `wait-timed-out` response means only that the bounded
Host wait ended—retain the Job ID and inspect it again.

Host Actions 0.5 has been removed. Old `hostActions` configuration is retained
only as an inert disabled tombstone. Old `jobs action-start` calls return
`host-actions-removed`; pending legacy records remain audit evidence and never
execute or auto-approve.

## Troubleshooting

```bash
mise exec -- node scripts/pi-runner.mjs doctor --smoke-test --json
mise exec -- node scripts/pi-runner.mjs jobs list --pending-notifications --json
mise exec -- node scripts/pi-runner.mjs jobs wait --job <job-id> --wait-timeout-ms 15000 --json
```

If configuration reports `EPERM` below Application Support or the Job state
directory, preserve the form and existing configuration. The outer Host sandbox
blocked local state writes; retry the same local command outside it only with
the user’s approval. Do not manually create runner state files.

## Documentation

- [Configuration reference](docs/configuration.md)
- [Configuration field guide](docs/configuration-field-guide.md)
- [Execution time and recovery](docs/execution-time-policy.md)
- [Architecture](docs/architecture.md)
- [Host Assistance and Discovery](docs/host-assistance-discovery.md)
- [Telemetry](docs/telemetry.md)
- [Threat model](docs/threat-model.md)

Traditional Chinese focused references are paired where available.

## Built With and References

- [Claude Code current documentation](https://code.claude.com/docs/en/overview)
- [OpenAI Codex](https://developers.openai.com/codex/)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi), pinned at `0.84.2`
- [`@carderne/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), pinned at `0.0.49`
- [Node.js](https://nodejs.org/), `24.15.0+`
- [TypeScript](https://www.typescriptlang.org/)
- [mise](https://mise.jdx.dev/)
- [Playwright](https://playwright.dev/), pinned at `1.61.0`
- [Git worktrees](https://git-scm.com/docs/git-worktree)

The original plugin concept and Host workflow were informed by
[apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin). That
project is a reference for architecture and delegation ideas; this repository
is an independent rewrite and does not reuse its source code.

The role orchestration and execution-safety design also draws on the following
open-source projects and documentation:

- [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) informed the
  Machine, Role, and Policy separation used for role-specific model routing.
- [Pi containerization guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
  informed the isolation boundaries and the future whole-process `isolated`
  mode direction, while [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox)
  informed the macOS Seatbelt and Linux Bubblewrap approach used by sandboxed
  shell tools.
- [r4vi/pi-auto-mode](https://github.com/r4vi/pi-auto-mode) and
  [czottmann/pi-automode](https://github.com/czottmann/pi-automode) informed the
  adaptive permission classifier, policy decisions, and approval flow.
- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) informed the
  provider-form and protocol-selection research. This plugin uses Pi's native
  adapters rather than CC-Switch's protocol translation proxy.
- [mattpocock/skills](https://github.com/mattpocock/skills) informed Skill
  triggers, anti-triggers, evidence, stopping conditions, and focused
  references.

These projects and documents are design references. This repository is an
independent implementation: it does not load complete third-party extensions,
copy third-party source code, or copy third-party prompts.

## License

This project is released under the [MIT License](LICENSE). Copyright (c) 2026
Jason Hsieh.
