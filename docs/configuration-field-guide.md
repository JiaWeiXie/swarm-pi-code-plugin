# Configuration field guide

This guide explains what the less obvious setup fields do, when to leave them
alone, and how they affect delegated work. The setup page keeps the shortest
advice beside each control and places additional guidance in native **Tips**
disclosures. This document is the detailed reference.

Unless a section says otherwise:

- settings are captured when a Job starts;
- changing setup affects future Jobs, not a Job that already has a snapshot;
- blank secret fields keep an existing credential, while blank non-secret
  optional fields mean “not configured”;
- blank numeric fields are invalid and are not silently treated as zero or a
  default;
- examples are display-only and never contain usable credentials.

See the [Configuration Reference](configuration.md) for storage, transaction,
provider protocol, and server-lifecycle details.

Quick navigation: [operating model](#mental-model) · [safe defaults](#safe-defaults) ·
[Providers](#provider-fields) · [Models/Roles](#model-role-keywords) ·
[Adaptive rules](#adaptive-policy) · [Decision/Background](#workflow-keywords) ·
[Host Assistance](#host-assistance) · [Advisor](#advisor) ·
[Host Actions](#host-actions) · [Project goal](#project-goal) ·
[Working area](#working-area) · [Delegated work](#delegated-work)

<a id="mental-model"></a>
## Start with the operating model

This page configures a bounded delegation pipeline, not one all-powerful chatbot:

```text
Your request
  ↓
Host (the active Codex or Claude conversation) retains final judgment
  ↓
Job (one delegated assignment with a purpose and boundaries)
  ↓
Worker (a restricted Pi model session that researches or changes files)
  ↓
Sandbox + Policy check tools, paths, processes, and network actions
  ↓
The result returns to the Host for verification and delivery
```

The terms used throughout setup mean:

| Keyword | Plain meaning | Concrete example |
| --- | --- | --- |
| **Host** | The Codex or Claude model currently talking to you and making the final decision. A background hook is not an active Host. | The Host decides whether a Worker really needs public SDK documentation. |
| **Worker** | A delegated Pi model session with a particular responsibility and limited tools. | A reviewer Worker inspects a diff; an executor Worker may edit allowed files. |
| **Job** | One durable assignment with its own request, settings, status, and result. | “Review this branch” and “fix the confirmed findings” are separate Jobs. |
| **Snapshot** | An immutable copy of the relevant settings taken when a Job starts. | Changing Adaptive to Strict later does not rewrite a running Job. |
| **Policy** | Rules answering who may do what, where, and under which conditions. | An executor may write `src/`, while a repository deny rule blocks one domain. |
| **Sandbox** | The operating-system boundary restricting writes, deletion, processes, and network access. | A bad command cannot freely write outside the workspace. |
| **Capability** | One category of permission, not a model or command. | `network.connect` permits a network connection category. |
| **Scope / roots** | Where a capability may operate. | Write capability with only a `docs/` root does not permit edits in `src/`. |
| **Gate** | A mandatory workflow checkpoint. | Discovery must pass the research gate before an experiment starts. |
| **Approval** | A decision about one currently blocked, exact action. | Approving `npm run test:build` once does not approve every shell command. |
| **Fingerprint** | The identity derived from command, path, destination, and policy. Any material change creates a different action. | Approval for `git status` cannot be reused for `git push`. |
| **Lease** | A temporary permission ticket bound to a fingerprint, scope, use count, and expiry. | One reversible edit may receive a one-use lease; it is not permanent elevation. |
| **Fallback** | The next configured choice tried when an earlier choice fails. | If the primary model is unavailable, the next configured model is tried. |
| **Delivery** | Making a local result official or causing an external effect | Commit, push, publish, deploy, message, and transaction are delivery actions. |
| **Materialization** | Applying an isolated staging/worktree artifact to the real target project | A scaffold preview does not automatically appear in the current workspace. |
| **Canonical** | Stable standard name understood by runtime | UI alias `planning` maps to canonical Job kind `plan`. |
| **Legacy** | Older saved data that must remain readable | Old Host Assistance records remain User-only until resaved. |
| **Redacted** | Sensitive values removed/replaced while retaining an investigation summary | Classifier diagnostics must not contain an API key. |
| **Hook / watcher / replay** | Background notification or recovery-display mechanisms, not the active Host | They may show a pending approval but cannot approve it. |

### One end-to-end example

Suppose you ask: “Update the configuration guide under `docs/`, but do not commit.”

1. The Host creates a Job with explicit documentation-mutation intent.
2. Its snapshot freezes the Sandbox mode, admitted task types, and write roots.
3. The Worker reads files using `filesystem.read-workspace`.
4. If it needs current public API docs, it asks through Host Assistance.
5. The Worker edits `docs/`; both policy and Sandbox verify the write root.
6. A `git commit` attempt remains blocked by the delivery gate and your original request.
7. The Host checks the diff and verification before reporting the result.

This is why “the model can reason about an action” does not mean “the model has authority to
perform it.” Capability, scope, original intent, and gates must all permit the action.

<a id="safe-defaults"></a>
## Safe starting values when you are unsure

| Section | Start with | Why |
| --- | --- | --- |
| Provider optional fields | Leave blank unless the service owner gives an exact value | A guessed ID or region normally routes to the wrong resource. |
| Custom endpoint | Configure only for a self-hosted, local, or compatible service | Normal OpenAI or Anthropic accounts should use built-in connections. |
| Sandbox | **Adaptive** | Necessary tools remain available while uncertain actions stop for a decision. |
| Structured policy rules | Leave empty initially | Roots, role ceilings, and existing denials already provide boundaries. |
| Host Assistance | On / Host model first / Bounded reversible changes | The Host handles safe bounded requests first and asks you when uncertain. |
| Context allowance / requests / fan-out | Standard / `4` / `2` | Up to 32,768 context characters, with bounded request count and concurrency. |
| Private connectors | Ask each time | A model should not automatically release private data. |
| Advisor | Off | Enable only when a complex plan, review, or discovery benefits from extra viewpoints. |
| Host Actions 0.5 | Off | This advanced broker is not required for ordinary delegated work. |
| Project goal | Describe the durable product outcome | Future Jobs share direction without inheriting today’s ticket. |
| Delegated work | Select only work you actually want to delegate | An unselected type is rejected before the model starts. |

These are conservative working defaults, not a performance formula. When a real Job is blocked,
change only the setting that explains that specific block.

<a id="provider-fields"></a>
## Provider additional and advanced fields

Provider fields are generated from the provider capability registry. A field’s
inline guidance is metadata, not a provider-specific UI exception. Optional
fields should normally stay blank unless the provider account, resource owner,
or official setup instructions require explicit routing.

### Understand the provider chain first

```text
Connection → Adapter → Protocol → Endpoint → one Model at the Provider
```

- A **Provider** is the service supplying models, such as OpenAI, Anthropic, Azure
  OpenAI, or a local Ollama server.
- A **Connection** is this project’s configured route to one Provider, including
  authentication and routing. One Provider may have multiple connections.
- A **Model** is the specific model ID that generates a response. The Provider is
  the service; the Model is one choice within it.
- An **Adapter** is plugin code translating common model operations into the
  Provider’s API. Built-in connections choose it for you.
- A **Protocol** is the request/response language, such as OpenAI Responses or
  Anthropic Messages. Similar JSON does not imply compatible tool-call semantics.
- An **Endpoint / base URL** is the network address that receives requests. It is
  not a model name and must not contain credentials.
- **Authentication / credential** is how access is proven: API key, OAuth, or an
  ambient cloud identity.

Built-in Providers normally require only authentication and model selection.
Protocol and endpoint choices matter mainly for self-hosted, local, or third-party
compatible services.

Authentication choices also describe different account boundaries:

- An **API key** is a Provider-issued secret, normally tied to API usage/billing.
  It belongs in Credential, never a URL, literal header, goal, or document.
- **OAuth / subscription sign-in** obtains a bounded token through browser or
  device-code login. ChatGPT subscription is not an OpenAI API key and does not
  automatically grant API billing access.
- **Ambient identity** uses an existing local cloud CLI/profile login without
  copying its secret into the form.
- **No authentication** is only for an intentionally unauthenticated loopback
  service, not a workaround when you do not know where the credential belongs.

### Common cloud-routing terms

| Keyword | Plain meaning | Typical symptom when wrong |
| --- | --- | --- |
| **Organization / Account** | Top-level account container | The credential works, but the expected project is unavailable. |
| **Project** | A billing, access, or resource boundary inside an account | Requests are rejected or attributed to the wrong project. |
| **Resource** | The actual cloud service resource, commonly in Azure | The endpoint or deployment cannot be found. |
| **Region / Location** | Physical cloud region containing the resource | The model is unavailable or uses the wrong data boundary. |
| **Deployment** | The callable name assigned to a model inside a cloud resource | The model exists, but the API reports “deployment not found.” |
| **Profile** | A local selector naming an existing credential configuration | The wrong account is selected or ambient credentials are missing. |
| **Header** | Extra name/value metadata sent with an HTTP request | Routing or attribution fails; putting a secret here may leak it. |
| **Controlled header** | An explicitly allowlisted, non-secret literal header | It cannot inject arbitrary Authorization or raw JSON. |
| **Ambient identity** | Runtime uses an already signed-in AWS/Google identity instead of a pasted key | Future Jobs fail explicitly when that local sign-in expires. |

### Configured, discovered, verified, and blocked

- **Configured** means the fields are structurally usable; the server has not
  necessarily generated anything.
- **Discovered** means a model-list endpoint returned model IDs. It proves only
  that inventory was readable.
- **Verified** means the selected model completed a minimal generation request.
- **Blocked** means credentials, adapter support, or verification currently prevents use.

A local `/models` endpoint can succeed while `/responses` is unimplemented. That
connection is Discovered, not Verified.

Configuration structure, catalog/auth availability, and live health are separate
states. A saved model can remain structurally valid while its provider is offline
or no longer lists it. The setup page keeps that reference visible for repair but
does not offer it as a new selection; saving unrelated settings reports degraded
health instead of corrupting or rejecting the saved configuration. New or changed
routes still require availability and any required verification.

| Field | Default or blank behavior | Fill it when | Avoid |
| --- | --- | --- | --- |
| Organization/project IDs | Provider or credential default | One credential can address multiple scopes and an explicit ID is required | API keys, display names where an ID is required |
| Region/location | Ambient or provider default when optional | Models live in a specific cloud region | Guessing a region or copying a secret |
| Deployment mapping | Model and deployment names are assumed to match | Azure deployment names differ from model IDs | JSON, spaces, or entries without `model=deployment` |
| Attribution headers | Not sent | Provider policy asks for application attribution | Credentials or user-specific private data |
| Cache retention | Automatic short/provider-managed behavior | The retention tradeoff is intentional and supported by this auth method | Treating retention as a quality or context-window control |

Provider settings affect later Jobs after a successful transactional save. They
do not rewrite a running Job’s model snapshot.

<a id="openai-organization"></a>
### OpenAI Organization ID

- **Purpose:** optionally scopes OpenAI requests to an organization.
- **Blank:** sends no explicit organization setting.
- **Recommended:** leave blank unless the API account requires a specific
  organization.
- **Safe example:** `org_example`.
- **Trap:** this field is not an API key and should not contain a credential.

<a id="openai-project"></a>
### OpenAI Project ID

- **Purpose:** selects an OpenAI project when a credential can address more
  than one.
- **Blank:** uses the credential’s default project.
- **Safe example:** `proj_example`.
- **Trap:** use the actual project ID, not a display label.

<a id="prompt-cache-retention"></a>
### Prompt cache retention

A **prompt cache** lets a Provider temporarily reuse an identical input prefix to
reduce repeated processing latency or cost. It is not chat memory, permanent Job
storage, or a larger context window. **Retention** is how long that reusable cache
may remain at the Provider.

- **Automatic** is the default and uses the adapter’s short or provider-managed
  behavior.
- **Extended** is available only where the direct API and authentication method
  support it. The current OpenAI option is 24 hours and Anthropic is 1 hour.
- Extended retention can change privacy, latency, and provider-side retention
  tradeoffs. It does not increase model intelligence or the context window.
- OAuth or an unsupported adapter may hide or reject the extended option.

<a id="anthropic-beta"></a>
### Anthropic beta features

- **Blank:** no `Anthropic-Beta` literal is sent.
- Fill this only when provider documentation gives an exact feature value.
- **Safe pattern:** `feature-name-YYYY-MM-DD`.
- Do not enter raw header JSON or an authorization value.

<a id="openrouter-attribution"></a>
### OpenRouter Application URL and title

These optional values become the controlled literal headers `HTTP-Referer` and
`X-Title`. Leave both blank unless attribution is required. Use a non-secret
HTTPS project URL and a general application name; never put credentials or
private user data in either field.

<a id="azure-openai-routing"></a>
### Azure OpenAI routing

| Field | Guidance |
| --- | --- |
| Azure endpoint | Use the resource root such as `https://resource-name.openai.azure.com`, not a `/responses` URL. |
| Resource name | Alternative to endpoint; enter the resource identifier. At least endpoint or resource name is required. |
| API version | Leave blank for the adapter default unless the resource owner requires an explicit version. |
| Deployment mapping | Optional comma-separated `model=deployment` entries. Leave blank when names match. |

The pinned runtime uses an API key for this adapter. A displayed Microsoft Entra
capability notice does not mean this plugin can execute Entra authentication.

<a id="cloudflare-routing"></a>
### Cloudflare account and gateway IDs

The Account ID and Gateway ID are non-secret routing identifiers copied from
the relevant Cloudflare dashboard. They are required for their respective
connections. Do not paste an API token into an ID field.

<a id="bedrock-identity"></a>
### Amazon Bedrock profile and region

- **AWS profile blank:** use the default ambient AWS identity.
- **AWS region blank:** use the ambient/default region.
- Set a named local profile or region only when the intended models require it.
- A profile name such as `development` is a selector, not the credential itself.
- Region example: `us-east-1`.

Ambient identity is resolved when future Jobs execute, so later credential
revocation still fails explicitly.

<a id="vertex-routing"></a>
### Google Vertex project and location

Both fields route requests to the intended Google Cloud project and region.
Use a project identifier such as `example-project` and a location such as
`us-central1`. Do not enter service-account JSON or another secret in either
field. Authentication remains in the selected API-key or ambient boundary.

<a id="custom-endpoints"></a>
## Custom and local endpoints

Custom connections separate protocol selection, endpoint identity,
authentication, inventory discovery, verification, and model overrides. Model
discovery is not proof that generation works.

<a id="custom-protocol"></a>
### API protocol

Choose exactly one protocol documented by the server:

- OpenAI Chat Completions;
- OpenAI Responses;
- Anthropic Messages.

The plugin does not try all protocols and guess. Changing protocol changes
request semantics and endpoint identity.

<a id="custom-server-url"></a>
### Server URL

- Enter a service/API root, not `/chat/completions`, `/responses`, or
  `/v1/messages`.
- HTTP is permitted only for loopback endpoints; use HTTPS elsewhere.
- Safe local example: `http://127.0.0.1:11434`.
- URLs with `user:password@`, secret query parameters, redirects to another
  origin, or cloud metadata destinations are rejected.

<a id="custom-authentication"></a>
### Authentication and secret header

| Choice | Use it when |
| --- | --- |
| API key | The selected protocol uses its standard credential header. |
| No authentication | The loopback/local service is intentionally unauthenticated. |
| API key + secret header | The server requires one of the supported secret-header names in addition to native adapter authentication. |

When editing, a blank Credential field keeps the saved credential. Secret
values stay in the session-local draft vault and are never returned to the
browser, docs, state, or model configuration.

<a id="custom-models-endpoint"></a>
### Models endpoint

This optional field overrides only the inventory URL. Leave it blank for the
protocol default. It must share the Server URL origin. Loading model IDs from it
changes readiness to discovered; a real minimal generation request is still
required for verified status.

<a id="custom-controlled-headers"></a>
### Controlled literal headers

The advanced `HTTP-Referer`, `X-Title`, and `Anthropic-Beta` fields are
allowlisted non-secret literals. They cannot contain raw header JSON, shell
commands, environment expansion, or authorization values. Leave them blank
unless the server/provider explicitly requires them.

<a id="custom-manual-models"></a>
### Manual model IDs

Use exact documented IDs, one per line, when inventory discovery is unavailable.
Manual IDs are configured, not verified. Select and verify a model before
depending on it for a Job.

<a id="custom-advanced-settings"></a>
### Advanced connection and model settings

- **Connection name** is a local display label.
- **API base URL** shows the canonical saved root; changing it changes future
  request routing.
- **Runtime adapter** is read-only and derived from protocol.
- **Context window / max output** should stay blank to use provider metadata.
  Overrides must be positive integers and do not prove the server supports the
  declared capacity.

The **context window** is the total token capacity for input plus generated output
in one model request. **Max output** is the portion that may be used for the answer.
Tokens are not characters, and the conversion varies by language and content.
Declaring numbers larger than the server really supports does not upgrade the
model; it makes long Jobs fail at the API. Keep Automatic unless the server owner
or authoritative metadata provides exact values.

<a id="model-role-keywords"></a>
## Model selection and role-routing keywords

| Keyword | Plain meaning | How to use it |
| --- | --- | --- |
| **Primary model** | Default model tried first for general project work | Choose a verified model matching the main quality/cost need. |
| **Fallback order** | Ordered models tried after the primary fails | It is sequential failover, not parallel voting. |
| **Role** | Worker responsibility plus its capability ceiling | Reviewer is read-oriented; Executor handles authorized mutation. |
| **Role routing** | Models preferred for one role | Review and planning can use different model chains. |
| **Model chain** | One role’s ordered primary and fallbacks | The next model is tried after provider/session failure. |
| **Thinking level** | Requested reasoning effort, not a security level | Higher is normally slower and uses more model capacity; runtime lowers unsupported levels. |
| **Max attempts** | Bound on role attempts/candidates for one Job | It is not permission to retry uncertain external effects. |
| **Classifier model** | Model used only to assess Adaptive action risk | It is not the Worker model and does not write code. |

For reviewer chain `[Model A, Model B]`, the Job tries A first and B only after A
cannot complete. This is not two Advisor perspectives and not a parallel review.

<a id="adaptive-policy"></a>
## Adaptive authorization — Structured policy rules

Structured rules refine Adaptive decisions. They never expand Strict mode,
workspace roots, role capabilities, user intent, or explicit delivery gates.
Deny has priority over ask and allow.

### Sandbox mode versus authorization

- **Strict** exposes only scoped tools and no arbitrary Bash.
- **Adaptive** may propose shell or network actions, but hard policy, structured
  rules, and a classifier evaluate them first. Uncertainty denies or waits for a
  supervisor according to configuration.
- **Lenient** provides broader shell/network behavior while retaining the OS
  Sandbox. It is not unsandboxed, but more Worker-visible data may reach services.
- **Autopilot** keeps Lenient's OS-Sandbox isolation (it needs the same sandbox
  backend) but auto-runs routine shell unattended, without stopping for a
  supervisor; that routine-shell autonomy is intrinsic to the mode, and git and
  deploy still stay behind a mandatory human approval gate.
- **Full-access** removes the plugin's own OS Sandbox and runs the Worker's Bash
  un-wrapped, so unlike Lenient it *is* unsandboxed by this plugin; the Worker's
  reach then depends entirely on the host's own sandbox. It needs no sandbox
  backend, so it is always selectable.
- **Authorization** decides whether one proposed action is allowed, must ask, or
  is denied. Sandbox is the outer operating-system boundary; authorization is the
  checkpoint inside it.
- A **classifier** is a model that evaluates the proposed action and limited
  policy context. It is not the Worker and cannot raise a role ceiling.
- **Supervisor fallback** controls uncertainty: Deny stops, while Wait for
  supervisor asks the Host or user for a decision.

### What every rule keyword controls

| Keyword | What it controls | Example |
| --- | --- | --- |
| **Rule** | A conditional decision: deny, ask, or bounded-allow one capability when its selectors match | Allow a reviewer to connect to a documentation domain. |
| **id** | Audit and editing identity; it grants nothing by itself | `ask-package-install` |
| **effect** | Result when matched. Deny always rejects; ask pauses; allow remains inside all higher ceilings | An allow cannot add Bash to Strict. |
| **capability** | Category of permission, not the exact command | `shell.execute` covers many distinct commands. |
| **roles** | Match only listed Worker responsibilities; omitted means all | Apply to `reviewer`, not `executor`. |
| **taskKinds** | Match only listed Job kinds; omitted means all | Apply only during `discover`. |
| **pathPrefix** | Narrow a workspace read/write rule to one relative folder | `docs/reference`, never `/Users/.../docs` |
| **domain** | Narrow a network rule to an exact host or subdomain wildcard | `docs.example.com` or `*.example.com`, not a URL |
| **Trusted domain** | Hostname the Adaptive classifier may treat as pre-trusted; role, roots, and secret gates remain | `registry.npmjs.org` |
| **Diagnostics** | Store a redacted classifier decision summary for investigation | Credentials and complete secrets are excluded. |

### The six capabilities in plain language

| Capability | Permits | Does not imply |
| --- | --- | --- |
| `filesystem.read-workspace` | Read inside allowed roots | Reading outside the workspace or writing files |
| `filesystem.write-workspace` | Add or edit inside write roots | `.git`, commit, push, or arbitrary deletion |
| `filesystem.write-temp` | Write to Job temporary space | Materializing the result into the project |
| `git.read` | Inspect status, diff, and history | Commit, merge, checkout, or push |
| `shell.execute` | Propose one exact shell command | Every command is safe; each fingerprint is separate |
| `network.connect` | Connect to a policy-allowed hostname | Sending secrets, private connectors, or arbitrary IP access |

If you cannot name the role, task, path/domain, and reason for an allow, leave the
rule empty and use Adaptive with Wait for supervisor. That is usually easier to
audit than a speculative allow rule.

### Rule shape

```json
{
  "id": "allow-docs",
  "effect": "allow",
  "capability": "network.connect",
  "roles": ["scout"],
  "taskKinds": ["ask"],
  "domain": "*.example.test"
}
```

| Property | Accepted values |
| --- | --- |
| `id` | Unique, 1–64 characters, lowercase letters/digits plus `.`, `_`, `-` |
| `effect` | `deny`, `ask`, `allow` |
| `capability` | `filesystem.read-workspace`, `filesystem.write-workspace`, `filesystem.write-temp`, `git.read`, `shell.execute`, `network.connect` |
| `roles` | Optional non-empty, duplicate-free canonical Role IDs; internal roles are advanced but valid |
| `taskKinds` | Optional non-empty, duplicate-free canonical Job kinds |
| `pathPrefix` | Only with workspace read/write; canonical relative POSIX path such as `docs/reference` |
| `domain` | Only with `network.connect`; exact lowercase host or `*.` wildcard |

Unknown properties are rejected. `pathPrefix` rejects absolute paths,
backslashes, `.`/`..`, traversal, empty segments, and trailing slash. `domain`
rejects URLs, ports, credentials, localhost, and IP addresses. A rule cannot
combine path and domain selectors. The form accepts at most 128 rules and
reports the failing rule number/ID.

Legacy malformed rules are omitted during tolerant load so they cannot grant a
capability. Newly saved configuration and newly created Job snapshots use the
strict validator.

<a id="workflow-keywords"></a>
## Decision mode and Background implementation

### Decision mode

Decision mode controls base read-only `orchestrate` depth. It is not Sandbox mode
or an auto-approval level:

- **Cost:** one base perspective; faster and lower model usage.
- **Balance:** two base perspectives; the normal default.
- **Power:** three base perspectives; broader coverage with more latency/usage.

It does not rewrite Host Assistance limits, Advisor quotas, roots, or safety gates.
**Question → Delete → Simplify** is currently snapshotted preference metadata; the
checkbox does not start an automatic deletion or simplification pass.

### Background implementation

- A **mechanical executor** is a constrained Worker role for explicit mechanical
  edits, not unknown requirements or high-judgment changes.
- A **Job-owned worktree** is an isolated Git working directory for that Job, so
  Worker edits do not directly mix into the Host’s current worktree.
- **Background** means a durable worker may execute the Job. It does not let the
  Host forget it; approvals, progress, terminal notifications, and verification
  still need handling.

Leave this off if the project does not need long-running mechanical edits. Turning
it on does not authorize commit, push, or materialization.

<a id="host-assistance"></a>
## Host Assistance

Host Assistance is the Worker-to-Host request channel. It is not Host Actions
and does not itself grant execution permission. A Worker submits the purpose,
targets, minimum access, side effects, exposure, failure modes, reversibility,
rollback, verification, proposed risk, and fallback. The active Host treats
that assessment as untrusted and checks original intent, policy, roots, role
ceiling, and the exact action fingerprint.

### It resolves missing context or a blocked decision, not permanent authority

Example: a reviewer Worker encounters an unfamiliar SDK.

1. It submits a Host Assistance request naming the API, version, evidence, and risk.
2. The Host checks whether the original task needs that information and whether
   public official docs are sufficient.
3. Within the Host-first ceiling, the Host returns cited context to the same
   Worker; otherwise it asks the user.
4. The Worker resumes review. It did not receive a permanent Web permission.

A production deployment recommendation is different: it creates an external
effect and remains a user decision. Host Assistance cannot relabel delivery as
harmless context.

### Host Assistance keywords

| Keyword | Plain meaning | How to reason about it |
| --- | --- | --- |
| **Request** | One structured Worker escalation with purpose, exact target, risk, and fallback | It is not every tool call. |
| **Context** | Information returned for reasoning, not execution authority | An SDK summary is context; `network.connect` is a capability. |
| **Context class** | Preselected source category the Worker may request | Do not select connector if the project needs no private source. |
| **Workspace** | Content under current project-policy roots | It does not mean arbitrary paths outside the workspace. |
| **Public Web** | Content available without private sign-in | It excludes intranet and private account pages. |
| **SDK/API docs** | Technical documentation context | It does not execute an API operation. |
| **Papers** | Research papers or technical evidence | Useful for methods, not necessarily current product status. |
| **Private connector** | A signed-in connector that may expose non-public data | Keep Ask each time; a Host model cannot auto-approve it. |
| **Installed skill** | A Host-installed specialist workflow | It remains inside original intent and policy. |
| **Context allowance** | Named limit on the text returned by one Host context request | Standard permits up to 32,768 characters; it grants no tool capability. |
| **Requests per Job** | Total Host Assistance requests allowed in one Job | Four requests are not four Workers. |
| **Fan-out** | Maximum unfinished requests at the same time | Requests 4 / fan-out 2 means four total, two concurrent. |
| **Review path** | Who examines the request first | Host-first uses the active Host model; User-only asks you directly. |
| **Auto-approval ceiling** | Highest category a Host may auto-resolve, never a promise to approve | Reversible still needs exact targets, rollback, and intent match. |
| **Discovery gate review** | Lets the active Host review complete bounded Discovery checkpoints | Missing evidence or scope expansion still asks the user. |
| **WorkerAssessment** | Worker’s self-reported need, risk, reversibility, and fallback | It is untrusted advice that the Host verifies independently. |
| **HostAdjudicationReceipt** | Audit record of the Host decision, constraints, fingerprint, and policy hash | It is evidence, not an open-ended permission. |

### The three automatic ceilings

- **Context only** may return permitted public/read-only context; it does not
  approve tool capabilities or changes.
- **Read-only capabilities** may also approve one exact read-only inspection.
- **Bounded reversible changes** may additionally approve an exact change when
  the original Job already has mutation intent, the target is inside write roots,
  and rollback plus verification are credible. Commit, push, deploy, messages,
  transactions, and irreversible actions remain outside it.

Ceiling means maximum authority, not “everything below this automatically passes.”
Low confidence always falls back to the user.

| Field | Meaning | Default / zero behavior |
| --- | --- | --- |
| Default | Project setting is explicitly On or Off | New project: On; project UI does not offer `inherit` |
| Review path | Host-first or always ask user | New project: Host-first; legacy missing field remains User-only until resave |
| Auto-approval ceiling | Context-only, Read-only, or Reversible | New project: Reversible; never expands Strict or protected gates |
| Discovery gate review | Let active Host review complete bounded gates | New project: on |
| Allowed context classes | Workspace, Web, docs, paper, connector, skill | Select the smallest needed set |
| Context allowance | Off, Compact, Standard, Extended | Default Standard; limits are 0, 8,192, 32,768, and 64,000 returned characters |
| Requests per Job | `0–6` | Default 4; 0 permits no requests |
| Concurrent fan-out | `0–3`, and not above requests | Default 2; 0 forces sequential/no concurrent fan-out |
| Private connectors | Deny or ask each time | Default ask; never Host-auto-approved |

Host-first can auto-resolve only an exact read-only or reversible action already
within user intent and the configured ceiling. Secrets, protected `.git`,
outside-workspace resources, delivery, commit/push/merge, publishing,
deployment, messages, transactions, irreversible work, unclear live-service
recovery, or low confidence still go to the user. Hooks, replay, watchers,
timeouts, and background recovery can notify only.

CLI Job overrides may still use `inherit`; durable project setup must choose On
or Off. Legacy stored `inherit` is shown as its effective explicit value without
mutating storage merely by opening setup.

<a id="advisor"></a>
## Advisor

Advisor adds bounded read-only perspectives to selected Job kinds. It is not a
dynamic coordinator, cannot mutate files, and cannot recursively invoke itself.

### Consultation versus perspective

- A **consultation** is one point when a Job asks Advisor for input, such as
  checking migration risk after a plan draft.
- A **perspective** is one independent viewpoint within that consultation, such
  as security, maintainability, or migration.
- A **target** is a Job kind allowed to use Advisor. Omitting `implement` means an
  implementation Job cannot consult Advisor; it does not disable implementation.

Consultations=2 and Perspectives=3 therefore means a targeted Job may consult at
two points, with up to three independent views each time. It does not promise six
model calls; runtime may use fewer but cannot exceed the bounds.

Keep Advisor off for ordinary implementation. Consider it for cross-module plans,
risk reviews, architecture orchestration, or discovery. Advisor gives opinions;
it cannot edit files or approve actions.

| Field | Range | Default | Guidance |
| --- | --- | --- | --- |
| Enable Advisor | on/off | off | Keep off unless independent perspectives justify added latency/model usage |
| Advisor targets | canonical Job kinds | review, plan, orchestrate, discover | Select only tasks that benefit |
| Consultations per Job | `0–3` | 2 | How many Advisor consultation events a Job may request |
| Maximum Advisor perspectives | `0–4` | 3 | Maximum independent views per consultation |

Zero values are valid only while Advisor is off. When enabled, at least one
target, one consultation, and one perspective are required.

<a id="host-actions"></a>
## Host Actions 0.5

Host Actions execute an explicitly recorded recommendation in an isolated child
Job. A recommendation remains inert until the Host deliberately starts an
eligible child.

Enabling Host Actions does not ask a Worker to create recommendations and does
not start anything automatically. The path exists only when an `implement` or
`setup` Worker submits a structured `action-recommendation` Host Assistance
request, the Host records it, the parent succeeds, and the user explicitly
confirms `jobs action-start`. A recommendation written only in ordinary Worker
prose is not actionable. This makes the current trigger deliberately narrow
and uncommon.

`0.5` is the feature’s current maturity/protocol label. It is not a price, model
version, or permission level.

### Host Action keywords

| Keyword | Plain meaning | Example / limit |
| --- | --- | --- |
| **Recommendation** | A concrete proposed follow-up, initially only an inert record | “Update a local config and verify it”; recording does not execute it. |
| **Inert** | Stored without causing any side effect | An active Host must start it; hooks and watchers cannot. |
| **Child Job** | A new isolated Job created for the action | It does not secretly resume an unfinished Worker call stack. |
| **Action class** | Side-effect category used by policy | `local-mutation` and `deploy` carry different risks. |
| **Local mutation** | Change allowed local files or state | It still excludes arbitrary `.git` and outside-workspace writes. |
| **Draft** | Produce content that has not been sent externally | Release-note draft is not publication. |
| **Remote write** | Modify data in a remote service | Updating an issue requires the remote toggle and normally user confirmation. |
| **Message** | Send communication to a person or group | Email or Slack is an external effect, not a draft. |
| **Deploy** | Change an executable environment or live service | Requires known health checks, rollback, and interruption risk. |
| **Transaction** | Create a payment, purchase, asset, or material transaction | A Host model cannot auto-approve it. |
| **Lease** | Temporary ticket bound to action family, scope, uses, and expiry | A changed command/target has a new fingerprint and invalidates it. |
| **TTL** | Time To Live in minutes before the lease expires | `30` means unused authority expires after 30 minutes. |
| **Maximum uses** | Consumption count for the action-family lease | Start at 1; it is not the Worker retry count. |
| **Recommendation cost value** | Non-negative metadata copied into the lease | It is not currency, a bill, or an enforced budget. |
| **Remote toggle** | Second master switch for remote effects | Selecting deploy without this switch still cannot deploy. |

### Host Assistance versus Host Actions

| | Host Assistance | Host Actions |
| --- | --- | --- |
| Purpose | Obtain context or a Host decision | Execute one recorded follow-up recommendation |
| Result | Context, decision, or bounded approval | Result of a new isolated child Job |
| Direct side effect | The request itself causes none | Child execution may, so controls are stricter |
| Normal starting choice | Host-first on | Off unless an action-broker workflow is needed |

| Field | Meaning |
| --- | --- |
| Enable | Allows eligible isolated child Jobs; does not auto-start them |
| Allowed action classes | Local mutation, draft, remote write, message, deploy, transaction |
| Remote toggle | Required in addition to at least one remote class |
| Maximum uses | `1–100` executions for the action-family lease |
| Recommendation cost value | Non-negative opaque metadata copied to the lease; not currency, billing, or an enforced spend cap |
| Lease TTL | `1–1440` minutes |

Prefer local mutation/draft, one use, and a short TTL. Remote classes do not
remove user confirmation for protected delivery, messaging, deployment, or
transactions.

<a id="project-goal"></a>
## Project goal

The goal is durable project context for planning and review, not today’s ticket,
a shell command, or a promise of automatic completion.

Here **durable** means reused by future Jobs, not impossible to edit. A useful
goal answers:

1. **Outcome:** what should improve?
2. **Audience:** who uses or is affected by it?
3. **Constraints:** which quality, safety, or technical limits remain important?

Template:

> Build [product or capability] for [audience], so they can [outcome], while
> preserving [important constraints].

Example: “Build an auditable case-management tool for internal support, so the
team can track resolution state while preventing unauthorized access to customer
data.” Put today’s button fix, exact command, or deadline in the Job request.

- Maximum length: 4,000 characters; blank is invalid.
- Include intended outcome, audience, and important constraints.
- Good: “Build a reliable internal support tool with auditable access.”
- Avoid: “Run this command now,” credentials, tokens, or a one-off bug trace.
- A successful save affects future Jobs and does not rewrite prior snapshots.

<a id="working-area"></a>
## Working area

Working area determines folder roots in project policy:

- **Whole project** uses workspace root `.` while still protecting `.git`, runtime
  state, credentials, and other protected paths.
- **Selected folders** puts only checked folders into roots, useful for a monorepo
  or a `docs/`-only delegation boundary.
- **Read root** and **write root** are distinct concepts. A workflow may inspect a
  wider area while mutation stays inside explicit write roots.
- **Workspace** means the configured project root, not the whole computer or home
  directory.

Selecting a folder does not copy its content elsewhere or grant shell access. It
only narrows the paths later policy checks may accept.

<a id="delegated-work"></a>
## Delegated work — supported task types

Selected categories are admission gates. They are not prompt labels and there
is no free-form task-plugin field.

An **admission gate** is a qualification check before a Job starts. Selecting a
type lets the Host delegate that type to Pi. If it is unselected, runtime rejects
the Job before model startup; this is not merely advice in a prompt. Selecting
implementation still does not authorize commit, deployment, or writes outside
roots—capabilities, scope, and delivery gates remain separate.

### What each task type actually means

| UI type | Canonical Job kind | Good fit | Does not automatically include |
| --- | --- | --- | --- |
| Implementation | `implement` | Explicit feature, bug fix, or refactor | Unknown-requirement research, commit, push, deploy |
| Planning | `plan` | Implementation steps, migration order, acceptance plan | File modification |
| Code review | `review` | Bugs, security, regressions, and missing tests in a tree/branch | Fixing the findings |
| Analysis | `ask`, `orchestrate` | Repository question or several read-only architecture/risk views | Mutation or delivery |
| Scaffolding | `scaffold` | Design a new project in isolated staging | Overwriting an existing project or automatic materialization |
| Development setup | `setup` | Project-local build, test, lint, dependency tooling | Global provisioning or production deployment |
| Discovery | `discover` | Unknown requirements, research, reproducible experiment, convergence | Turning experiment artifacts directly into product code |

An **alias** is the friendly UI name, such as `planning`; the **canonical Job
kind** is the stable runtime name, such as `plan`. They are a naming map, not two
different permission systems.

| UI alias | Canonical Job kind(s) |
| --- | --- |
| `implementation` | `implement` |
| `planning` | `plan` |
| `code-review` | `review` |
| `analysis` | `ask`, `orchestrate` |
| `scaffolding` | `scaffold` |
| `development-setup` | `setup` |
| `discovery` | `discover` |

Canonical Job kinds are also accepted by the service. Input is trimmed,
lowercased, and spaces/underscores become hyphens. Every unknown token is
reported deterministically, even when valid tokens are also present. An empty
selection is invalid in setup and admits no work at policy level.

Legacy unknown labels remain visible as unsupported and grant no capability.
They are omitted from durable state only after a successful resave; opening or
failing to save setup does not rewrite the existing profile.
