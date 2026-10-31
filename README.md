# swarm-pi-code-plugin

[繁體中文](README.zh-TW.md)

Swarm Pi is a portable [Agent Plugins 1.0](https://agent-plugins.org/specification)
package with native Claude Code and Codex adapters. Its ten Agent Skills connect
a compatible client to a bounded Pi worker for grounded repository questions,
plans, reviews, discovery, setup, scaffolding, and authorized implementation.
The Host retains intent, approval, verification, and delivery. Pi never owns
commit, merge, push, deployment, messaging, or transactions.

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

For any other
[Agent Plugins-compatible client](https://agent-plugins.org/compatible-clients),
point its local-package flow at the package root `plugins/swarm-pi-code-plugin/`.
The client reads `plugin.json` and discovers each skill at
`skills/<name>/SKILL.md`; a generic client exposes the ten skills by their
frontmatter `name`. Install, enable, permissions, the outer sandbox, and the
user interface stay under client control.

The native live-sandbox CI matrix runs on Linux x64/arm64 and macOS Intel/arm64, with sandbox availability required. A controlled local UDP DNS fixture checks resolved-address filtering without public DNS or destination connections.

Version 0.27.1 requires the Linux sandbox runtime's Unix-socket filter helper:
when the runtime reports it unavailable, OS-sandboxed workers refuse to start
with a dependency reason. Restore a supported runtime installation before using
those workers. Read and network policy are unchanged.

Version 0.27.0 uses `@anthropic-ai/sandbox-runtime` `0.0.81` in place of `@carderne/sandbox-runtime` `0.0.49`. Worker end-to-end verification with a real model and update behavior on existing installations remain untested.

Development checks use the locked oxfmt 0.75.0, oxlint 1.90.0 and Playwright 1.64.1 versions from `package-lock.json` to match CI formatting and browser checks.

For local development:

```bash
mise run build
mise exec -- node scripts/pi-runner.mjs status --json
mise exec -- node scripts/pi-runner.mjs configure --host codex
```

Packaged runtime requirements: Node.js 22.19+, local shell command execution,
first-run npm registry access, and a writable plugin directory for the exact
pinned dependencies installed on first run. Mutation workflows additionally
require Git for worktree-aware changes; a read-only package directory is not
supported and fails with the existing bootstrap error. Repository development
requires Node.js 24.15.0+. Credentials remain in Pi-compatible user storage,
never in repository state. Credential reads and writes are cancellable; a
cancelled write commits nothing and leaves no partial file behind.

The pinned Pi 1.2.0 catalog exposes `deepseek-flash` with image input through
the existing DeepSeek connection. OpenAI and Meta chat models can use an API key
or Pi OAuth. Azure OpenAI now uses the `azure` provider ID; saved connections, model
references, and credentials using `azure-openai-responses` remain usable.
Azure Foundry Chat Completions models are handled per model alongside Responses.
TypeSafe's decision models are not offered as worker chat models.

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
the matching Claude command. Any other Agent Plugins-compatible client exposes
the same ten skills under their frontmatter names, `swarm-pi-configure` through
`swarm-pi-scaffold`. The runner CLI remains available for Host adapters and
diagnostics.

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

Use `strict` for sensitive work: it exposes scoped filesystem tools without a
Bash runner. It limits shell exposure but cannot make sensitive workspace
content safe to share with a model.

Strict exposes scoped tools without Bash. Adaptive, Lenient and Autopilot use
OS-sandboxed shells. Full-access mutation workers run without the plugin's OS
sandbox; read-only workers retain lenient OS isolation. The mutation-shell
command checks are guardrails, so use it only where that exposure is acceptable
(see the [threat model](docs/threat-model.md#full-access-mode)). Scoped tools
enforce assigned roots; shell reads use explicit denies/exceptions and include
intentional system/runtime reads outside the workspace. The shell runner defaults
to Lenient when no mode is passed; new project state defaults to Adaptive.
Lenient/Autopilot outbound policy does not add Adaptive's private-range denies.
Host Assistance remains bounded, correlated, and consume-once; it
does not add authority. In Adaptive mode the sandbox runtime resolves each permitted host
name once and dials the address it checked; a name that resolves to a loopback, link-local,
cloud-metadata, private-use (RFC 1918), carrier-grade NAT (100.64.0.0/10), or
IPv6 unique-local (fc00::/7) address is refused. The runtime's seccomp helper directory
is granted literal read access. A `wait-timed-out` response means only that the bounded
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

- [Agent Plugins Specification 1.0.0](https://agent-plugins.org/specification)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Claude Code current documentation](https://code.claude.com/docs/en/overview)
- [OpenAI Codex](https://developers.openai.com/codex/)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi), pinned at `1.2.0`
- [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime), pinned at `0.0.81`
- [Node.js](https://nodejs.org/), `22.19+` for the packaged runtime and `24.15.0+` for repository development
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
