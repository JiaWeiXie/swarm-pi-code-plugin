# swarm-pi-code-plugin

[繁體中文](README.zh-TW.md)

`swarm-pi-code-plugin` connects Claude Code and Codex to a bounded Pi coding
worker for repository-grounded analysis, planning, review, and implementation.
It is designed for teams that want a second coding-agent perspective without
giving that worker unrestricted shell access or ownership of Git delivery.

The host remains in control of intent, approvals, verification, commits, and
pushes. Pi receives only the tools and worktree that the current task allows.

## Architecture

```mermaid
flowchart LR
    H[Claude Code or Codex] --> A[Host adapter]
    A --> R[Shared Pi runner]
    R --> P[Embedded Pi session]
    P --> W[Assigned Git worktree]
    R --> S[Shared state and job artifacts]
    H --> V[Host-owned review and verification]
    W --> V
```

Claude Code and Codex are host surfaces, not worker engines. Both invoke the
same runner and share model configuration, project profile, job history, and
worktree-aware state.

Delegated tasks resolve to role-specific model chains and thinking levels.
Implementation jobs add scoped mutation tools, require a clean assigned
worktree, and receive a fresh read-only verifier. Strict exposes no shell,
Adaptive authorizes bounded shell and network actions through policy and
durable approval, and Lenient retains broad outbound access inside the OS
sandbox. Git delivery remains host-owned.

Runtime configuration and jobs stay outside the checked-out worktree. Git
repositories use `.git/swarm-pi-code-plugin/` through the common Git directory;
non-Git folders use an OS user-state namespace. Credentials stay in Pi's user
credential store. Browser input becomes an opaque, session-local draft and
never enters project artifacts or localStorage.

See the [architecture reference](docs/architecture.md) and
[configuration reference](docs/configuration.md) for implementation details.
See [Host Assistance and Discovery](docs/host-assistance-discovery.md) for the
live worker-to-host context loop, schema-gated experiment micro-SDLC, Advisor
boundaries, discover-to-plan handoff, and isolated Host Actions 0.5.

## Install

### Requirements

- Node.js 22.19.0 or newer for installed plugins.
- A supported Claude Code or Codex installation.
- A Git repository for worktree-aware implementation jobs.
- macOS, or Linux with `bubblewrap`, `socat`, and `ripgrep`, to enable lenient
  sandbox mode.

### Claude Code

Add the GitHub repository as a marketplace and install the plugin:

```bash
claude plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
claude plugin install swarm-pi-code-plugin@swarm-pi-code-plugin
```

Restart Claude Code or run `/reload`. For local development:

```bash
claude --plugin-dir /absolute/path/to/swarm-pi-code-plugin/plugins/swarm-pi-code-plugin
```

### Codex

This repository contains a local marketplace:

```bash
codex plugin marketplace add /absolute/path/to/swarm-pi-code-plugin
codex plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local
```

Start a new Codex task so skills are reloaded. The available skills are:

```text
$swarm-pi-code-plugin-configure
$swarm-pi-code-plugin-project
$swarm-pi-code-plugin-ask
$swarm-pi-code-plugin-review
$swarm-pi-code-plugin-plan
$swarm-pi-code-plugin-implement
$swarm-pi-code-plugin-orchestrate
$swarm-pi-code-plugin-discover
$swarm-pi-code-plugin-scaffold
$swarm-pi-code-plugin-setup
```

## Usage

### Choose the right workflow

| Situation | Claude Code | Codex |
| --- | --- | --- |
| First provider, model, and project setup | `/swarm-pi-code-plugin:init` | `$swarm-pi-code-plugin-configure` |
| Change Provider or model priority | `/swarm-pi-code-plugin:init --reconfigure` | `$swarm-pi-code-plugin-configure` |
| Repeatedly change project goal, folders, or task types | `/swarm-pi-code-plugin:project` | `$swarm-pi-code-plugin-project` |
| Ask a repository question or request analysis | `/swarm-pi-code-plugin:ask` | `$swarm-pi-code-plugin-ask` |
| Create a read-only implementation plan | `/swarm-pi-code-plugin:plan` | `$swarm-pi-code-plugin-plan` |
| Review working-tree or branch changes | `/swarm-pi-code-plugin:review` | `$swarm-pi-code-plugin-review` |
| Make an explicit scoped code change | `/swarm-pi-code-plugin:implement` | `$swarm-pi-code-plugin-implement` |
| Run multiple read-only perspectives | `/swarm-pi-code-plugin:orchestrate` | `$swarm-pi-code-plugin-orchestrate` |
| Investigate unknown requirements with gated evidence and experiments | `/swarm-pi-code-plugin:discover` | `$swarm-pi-code-plugin-discover` |
| Design and create a new project | `/swarm-pi-code-plugin:scaffold` | `$swarm-pi-code-plugin-scaffold` |
| Configure project-local development tools | `/swarm-pi-code-plugin:setup` | `$swarm-pi-code-plugin-setup` |

Claude Code commands and Codex skills use the same runner protocol: they check
readiness and pending notifications first, preserve original requests across
configuration, default to supervised execution, and require explicit user
decisions for approvals, adoption, artifact materialization, and delivery.

### First setup

Run the host-specific setup entry point. The browser walks through six steps:

1. Connect cloud, subscription, ambient-identity, or local AI services with
   provider-specific fields.
2. Choose a project primary model and ordered fallbacks.
3. Assign model chains and thinking levels to worker roles.
4. Choose sandbox, classifier, approval, and background policies.
5. Review the detected Git, empty-folder, or adoption workspace state.
6. Test the primary and required classifier models, then save atomically.

If setup was opened by a delegated request, the Host retains that request and
resumes it after configuration. Cancellation or idle timeout does not require
the user to restate the task. Unsaved browser drafts retain only non-sensitive
role, safety, and workspace fields.

Readiness is task-specific. A workspace may be ready for research while
mutation or delivery is blocked. In particular, a Git repository without an
initial commit reports `git-unborn`; implementation fails before model startup
and returns scaffold or adoption actions plus a resumable continuation.

The connection list is intentionally empty when no usable service is detected.
Custom endpoints select their API protocol before model discovery. Provider
IDs remain internal, and model limits stay automatic when the endpoint and Pi
catalog do not establish them.

![Six-step setup with no usable connection](docs/assets/setup/01-empty-connections.png)

### Provider connections

The setup form is driven by the pinned Pi provider catalog. OpenAI uses the
Responses adapter, Anthropic uses Messages, and mixed providers retain Pi's
per-model adapter. Cloud providers show only their required project, region,
resource, account, or deployment fields.

ChatGPT Plus/Pro is a separate **ChatGPT subscription** connection backed by
Pi's `openai-codex` browser or device-code OAuth. It is not loaded through an
OpenAI API-key field. GitHub Copilot and Anthropic subscription sign-in use the
same bounded OAuth flow.

![ChatGPT Plus or Pro subscription OAuth](docs/assets/setup/02-chatgpt-subscription.png)

Custom endpoints choose one protocol: OpenAI Chat Completions, OpenAI
Responses, or Anthropic Messages. Model discovery and **Verify API** are
separate actions; loading `/models` does not prove that generation, tools, or
reasoning work. If a server has no model-list endpoint, model IDs can be entered
manually without being marked verified.

![Custom endpoint protocol and authentication](docs/assets/setup/02-endpoint-discovery.png)

After a connection is staged, configuration, credential replacement, API
verification, sign-out, and project removal remain separate actions. Leaving a
secret field blank keeps the saved credential; no existing secret is returned
to the browser.

![Provider readiness and credential actions](docs/assets/setup/03-provider-actions.png)

### Reconfigure

Provider and model settings can be reopened with `--reconfigure` or the Codex
configure skill. Project settings have a separate repeatable flow:

```text
/swarm-pi-code-plugin:project
$swarm-pi-code-plugin-project
```

The project flow reads current role, safety, and profile settings, then updates
only `state.json`. It does not
rewrite model configuration, credentials, or job history.

![Project-only role and safety configuration](docs/assets/setup/06-project-only.png)

### Execution safety and roles

Projects default to **Strict**, which keeps scoped Pi tools and exposes no
Bash. **Adaptive** adds policy-classified Bash and network access with bounded
capability leases and optional supervisor approval. **Lenient** adds broad
outbound access through macOS Seatbelt or Linux Bubblewrap. All shell modes use
an isolated environment without model tokens, SSH sockets, or host secrets.

Adaptive classifier prompts expose only the proposed action and limited policy
context to the configured provider. Lenient source visible to the worker can be
sent to external services. Unsupported platforms and missing dependencies fail
closed and never fall back to an unsandboxed shell.

Role routing keeps each responsibility's primary model, Thinking level, retry
limit, and supported execution modes visible. Adaptive mode separately selects
the classifier chain and approval fallback inside the sandbox capability
ceiling.

![Per-role model and Thinking configuration](docs/assets/setup/04-role-routing.png)

![Adaptive sandbox and classifier configuration](docs/assets/setup/05-execution-safety.png)

### Workspace and review

Workspace setup records the product goal, allowed folder scope, and delegated
task kinds after reporting Git readiness. Review then shows the effective
provider protocol, authentication source, model source, verification state,
role routing, and safety policy before the transaction is committed.

![Workspace goal, scope, and delegated task kinds](docs/assets/setup/03-project-setup.png)

![Provider, model, project, and safety review](docs/assets/setup/04-review.png)

Successful save replaces credentials and configuration transactionally, clears
the in-memory drafts, and closes the temporary local server. These screenshots
use an isolated demo workspace and contain no real credentials.

![Configuration saved](docs/assets/setup/05-saved.png)

### Enforced project policy

Configured allowed task kinds are an admission gate: a disallowed kind is rejected
before the job runs, rather than being a prompt suggestion. Configured allowed
folders constrain the scoped filesystem tools, and implementation writes are
enforced at three layers: the tool boundary, the sandbox write allowlist in
adaptive and lenient Bash modes, and a postflight changed-path check. Omitting
these restrictions preserves whole-workspace behavior for backward
compatibility. Reads and writes differ: while the scoped Pi filesystem tools
enforce read scope and the three layers above enforce implementation writes,
raw Bash reads in adaptive and lenient modes are not folder-scoped and can read
within the workspace subject to the sensitive deny paths; use Strict mode when
folder-level read confidentiality is required. See [Enforced Project Policy](docs/orchestration-and-policy.md#enforced-project-policy)
for the technical contract.

### Non-interactive runner

The shared runner is useful for automation and host integration:

```bash
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs providers --json
node scripts/pi-runner.mjs configure --host codex --section project --no-open
node scripts/pi-runner.mjs init --json
node scripts/pi-runner.mjs status --json
node scripts/pi-runner.mjs doctor --smoke-test --json
node scripts/pi-runner.mjs ask --host codex --prompt-file /path/to/question.md --json
node scripts/pi-runner.mjs review --host codex --scope working-tree --json
node scripts/pi-runner.mjs plan --host codex --prompt-file /path/to/plan.md --json
node scripts/pi-runner.mjs implement --host codex --prompt-file /path/to/task.md --json
node scripts/pi-runner.mjs orchestrate --host codex --prompt-file /path/to/task.md --json
node scripts/pi-runner.mjs scaffold --host codex --spec-file /path/to/scaffold.json --target /path/to/new-project --json
node scripts/pi-runner.mjs setup --host codex --prompt-file /path/to/setup.md --json
node scripts/pi-runner.mjs roles list --json
```

`implement` is guarded by a clean-worktree preflight and an exclusive worktree
lease. The host must inspect the result and run verification before delivery.
Timeouts, cancellation, and failures may leave partial changes; they are
reported and are never silently rolled back.

Delegated commands default to supervised execution. With
`--approval-mode wait`, the managed host relay starts a durable worker and
returns within 15 seconds with a terminal result, `approval-required`, or
`wait-timed-out`; the Host then keeps control with bounded `jobs wait` calls.
This keeps approval decisions visible instead of leaving one blocked shell
command. Read-only commands also accept durable background execution:

```bash
node scripts/pi-runner.mjs ask --host codex --prompt-file /path/to/question.md \
  --execution-mode background --json
node scripts/pi-runner.mjs jobs wait --job <job-id> --wait-timeout-ms 15000 --json
```

The host relay uses bounded waits and reports the durable job phase, elapsed
time, and cancel action. A detached host shell is not the same as Pi background
execution.

Background mode is supported by scout, planner, reviewer, and analyst roles.
Mechanical implementation may run in background only when explicitly enabled;
the control plane creates a job-owned branch and worktree. Executor and
security-executor implementation remain supervised.

Each new durable job stores a non-secret provider/model snapshot and integrity
hash, along with the effective project policy and project goal. Later profile
edits apply only to newly submitted jobs; queued, running, and resumed jobs
keep their original snapshot. Credentials are resolved at execution time, so
sign-out or rotation still takes effect for queued work.

Worker commands use a 30-minute default timeout for `ask`, `plan`, and `review`,
and a 60-minute default for `orchestrate` and `implement`. Override the job
deadline with `--timeout-ms` from 1000 through 86400000 milliseconds.

Durable job inspection and control are available through:

```bash
node scripts/pi-runner.mjs jobs list --json
node scripts/pi-runner.mjs jobs list --pending-notifications --json
node scripts/pi-runner.mjs jobs status --job <job-id> --json
node scripts/pi-runner.mjs jobs wait --job <job-id> --wait-timeout-ms 15000 --json
node scripts/pi-runner.mjs jobs watch --emit ndjson --once
node scripts/pi-runner.mjs jobs watch --emit ndjson --job <job-id>
node scripts/pi-runner.mjs jobs cancel --job <job-id> --json
node scripts/pi-runner.mjs jobs acknowledge --job <job-id> --json
node scripts/pi-runner.mjs jobs approvals --job <job-id> --json
node scripts/pi-runner.mjs jobs approve --job <job-id> --approval <approval-id> --json
node scripts/pi-runner.mjs jobs deny --job <job-id> --approval <approval-id> --json
node scripts/pi-runner.mjs jobs cleanup --job <job-id> [--discard] --json
node scripts/pi-runner.mjs jobs materialize --job <job-id> --target /path/to/new-project --json
```

For a verified isolated implementation artifact, omit `--target` to apply its
patch to the original workspace. Materialization validates the original HEAD
and preserved paths, does not create a commit, and rolls back a failed apply.

Job status and `jobs wait` exit codes describe different things. Status is the
durable job lifecycle; an exit code may instead tell the Host that user action
is required while the job remains live.

| Job status | Terminal | Meaning | Host action |
| --- | --- | --- | --- |
| `queued` | No | The job is durably recorded and waiting for a worker. | Continue bounded polling. |
| `running` | No | The worker is active. Inspect `phase` and progress timestamps. | Continue bounded polling; offer cancellation for long-running work. |
| `awaiting-approval` | No | The worker is paused on a policy approval request. | Present the approval and obtain an explicit approve or deny decision. |
| `succeeded` | Yes | Execution completed successfully. | Inspect verification and any deliverable artifact. |
| `failed` | Yes | Execution or verification failed. | Read `errorCode`, `error`, and verification details. |
| `cancelled` | Yes | Cancellation completed. | Preserve any reported side effects or recovery instructions. |
| `timed-out` | Yes | The worker deadline expired. | Inspect the result; submit a new job only if retry is appropriate. |
| `orphaned` | Yes | The worker or its lease disappeared before completion. | Inspect heartbeat and lease diagnostics; do not reuse stale approvals. |

| Exit code | Result/event | Meaning |
| --- | --- | --- |
| `0` | Successful command/result | The command completed successfully. |
| `1` | Result with `success: false` | The job or requested operation reached a real failure result. |
| `2` | `system-error` or argument error | The CLI could not execute the request. |
| `3` | `wait-timed-out` | Only this bounded wait ended; the worker deadline and job are unchanged. |
| `4` | `approval-required` | Not a terminal failure. The live worker is waiting for explicit approval or denial. |
| `5` | `setup-required` or `workspace-action-required` | Setup or a workspace decision is required before execution can continue. |

Approval and terminal notifications are acknowledged independently. A lease is
bound to the job generation, policy hash, action fingerprint, and expiry. The
policy hash includes the project scope, so changing allowed folders prevents an
old lease from being reused. An approve or deny operation atomically resolves
that approval and acknowledges only its matching approval notification. Terminal
notifications remain pending until the Host has shown and explicitly
acknowledged the terminal result.

`jobs watch --emit ndjson` polls canonical state and replays pending events so a
Host can recover after a restart. Events are allowlisted and exclude worker
tokens, provider credentials, raw prompts, complete agent output, and logs.
`--once` is used by the optional SessionStart recovery hook; it does not make
approval decisions or acknowledge notifications. Hosts must deduplicate replayed
events by `eventId` and must never auto-approve because a timeout, hook, or
replay occurred.

### New projects and development setup

New-project requests first use the read-only `project-architect` role to create
a reviewed scaffold specification. `scaffolder` writes a job-owned staging Git
repository, and `environment-engineer` handles supervised project-local
dependencies and tooling. Verified scaffold jobs produce a deliverable artifact
but do not touch the target until `jobs materialize` is explicitly approved.

Package lifecycle scripts and native builds require adaptive approval. Global
package installation, host provisioning, deployment, merge, and push remain
immutable denials.

## Troubleshooting

### The command or skill is not visible

Restart the host or run `/reload` in Claude Code. In Codex, start a new task so
the installed skill cache is refreshed. For local plugin development, use the
`--plugin-dir` path for Claude Code or reinstall the local Codex marketplace
plugin after changing the manifest or skills.

### The browser does not open

The runner prints a one-time loopback URL. Open that URL manually, or run the
runner with `--no-open` when launching it from a terminal.

### No provider is detected

Pi only displays services that it can use. Check Pi's credential store or the
documented provider environment variables, then reopen setup. For local AI
applications, use **Find local AI apps**. The plugin does not scan `.env` files
or copy private Claude Code or Codex credentials.

### Endpoint discovery fails

Confirm the URL is an HTTP(S) API root, not a browser dashboard or full
generation URL. Confirm the selected protocol and credential, then use
**Load models** again. The
server reports whether the failure is authentication, timeout, unreachable
server, malformed response, redirect, or unsupported endpoint.

### A selected model is unavailable

Reopen Provider and model setup and choose a model that Pi currently reports as
available. Keep a fallback model configured when the primary provider may be
temporarily unavailable.

### Setup was canceled or timed out

No changes are saved. Non-sensitive role, safety, and workspace draft fields
are restored when setup is reopened, and a delegated continuation remains
available for 24 hours. Credentials are never stored in the browser draft.

### Implementation is rejected because the worktree is dirty

Runtime state, untracked `.DS_Store`, `__pycache__`, `.pyc`, and `.pyo` artifacts
are preserved as safe-dirty and do not block implementation. Mutation runs in
an isolated HEAD worktree so those files are not exposed to the worker; a
verified artifact requires explicit materialization. Tracked, staged,
conflicted, secret-like, or unknown files require an explicit isolated HEAD or
isolated snapshot strategy. Swarm Pi never deletes, stashes, hides, or commits
the user's existing changes.

### A job failed with `project-scope-violation`

The job changed or tried to touch a path outside the configured allowed folders.
Review the project's configured allowed folders. A postflight scope violation
prevents checkpointing, verification, and delivery, so nothing is applied. To
widen the scope, edit the profile and submit a **new** job; a queued, running,
or resumed job keeps its original snapshot and will not adopt the edit. Policy
decisions and scoped-tool denials appear in the job audit trail.

### Git is initialized but has no commit

Research remains available, but implementation and delivery are blocked before
a model starts. Use scaffold for an empty project or inspect/adopt for existing
content, then run `resume --continuation <id>` to continue the preserved task.

### A delegated job stopped without a notification

Run `jobs watch --emit ndjson --once` (or
`jobs list --pending-notifications --json`). Terminal results are durable and
remain pending until acknowledged. A stale job whose process disappeared is
reconciled to `orphaned`; a worker stopped after cancellation is reconciled to
`cancelled`. Host adapters check this pending queue before starting another
delegation. A recovered approval still requires the user to see the risk and
choose approve or deny; replay is never consent.

### A linked worktree cannot see the configuration

State is stored inside Git's common directory, so linked worktrees normally
share `swarm-pi-code-plugin/`. Check that the worktree belongs to the expected
repository and that `SWARM_PI_CODE_PLUGIN_DATA_DIR` is not pointing elsewhere.

### Configuration could not be recovered

Run `doctor --json`. A failed multi-store save restores credentials, model
configuration, and project state. If rollback itself fails, a redacted recovery
journal blocks delegation until the conflicting state is inspected; it never
contains API keys.

## Development

The repository uses mise to provide the pinned Node.js environment:

```bash
mise install
mise run install
mise run check
```

Development uses Node.js `24.15.0` from mise. Installed plugin packages support
Node.js `22.19.0` or newer to match the Pi SDK engine requirement.

Useful individual checks are:

```bash
mise run typecheck
mise run test
mise run build
```

Follow the [documentation update SOP](docs/documentation-sop.md) when changing
user-facing guides, technical references, or committed screenshots. It defines
the product-evidence, screenshot-safety, cross-link, and validation steps for
documentation work.

`npm test` runs the built Node test suite, including mocked Pi sessions,
state migration, manifest validation, endpoint discovery, and loopback web
server tests. `npm run build` compiles the source and copies the production
runtime into the self-contained plugin package. Local host testing uses:

```bash
claude --plugin-dir /absolute/path/to/swarm-pi-code-plugin/plugins/swarm-pi-code-plugin
codex plugin marketplace add /absolute/path/to/swarm-pi-code-plugin
codex plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local
```

Validate packaged JavaScript with `node --check` on the two plugin scripts and
validate the Codex manifest and skills with the Codex plugin validation tool
when it is available in the local development environment.

After changing Codex skills or the plugin manifest, update the Codex plugin
cachebuster and start a new task. Keep runtime changes in `src/` and rebuild
before validating the packaged plugin.

## Built With and References

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Codex](https://developers.openai.com/codex/)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi), pinned at `0.80.6`
- [Node.js](https://nodejs.org/)
- [TypeScript](https://www.typescriptlang.org/)
- [mise](https://mise.jdx.dev/)
- [Git worktrees](https://git-scm.com/docs/git-worktree)

The original plugin concept and host workflow were informed by
[apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin).
That project is a reference for architecture and delegation ideas; this
repository is an independent rewrite and does not reuse its source code.

The role orchestration and execution-safety design also draws on the following
open-source projects and documentation:

- [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) informed the
  Machine, Role, and Policy separation used for role-specific model routing.
- [Pi containerization guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
  informed the isolation boundaries and the future whole-process `isolated`
  mode direction.
- [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox) informed the
  macOS Seatbelt and Linux Bubblewrap approach used by sandboxed shell tools.
- [r4vi/pi-auto-mode](https://github.com/r4vi/pi-auto-mode) and
  [czottmann/pi-automode](https://github.com/czottmann/pi-automode) informed
  the adaptive permission classifier, policy decisions, and approval flow.
- [farion1231/cc-switch](https://github.com/farion1231/cc-switch) informed the
  provider-form and protocol-selection research. This plugin uses Pi's native
  adapters rather than CC-Switch's protocol translation proxy.

These projects are design references. The plugin implements its own trusted,
non-interactive policy and enforcement runtime and does not load their complete
extensions or copy their source code.

## License

This project is released under the [MIT License](LICENSE). Copyright (c) 2026
Jason Hsieh.
