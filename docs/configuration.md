# Configuration Reference

This reference describes the temporary browser setup shared by Claude Code and
Codex. For installation and common workflows, start with the
[README](../README.md). Runtime boundaries are documented in
[architecture.md](architecture.md), and immutable security constraints are in
[threat-model.md](threat-model.md). The Host Assistance and Discovery contract
is in [host-assistance-discovery.md](host-assistance-discovery.md).

## Product Model

The setup flow creates executable Pi connections, not generic provider cards.
Every connection must map to a Pi runtime adapter, a supported authentication
method, a model source, and a verification state.

The six full-setup steps are:

1. Connect a built-in provider, subscription, cloud identity, or custom endpoint.
2. Choose the primary model and ordered fallbacks.
3. Assign model chains and thinking levels to worker roles.
4. Configure sandbox, classifier, approval, background behavior, Decision Mode,
   Host Assistance, Advisor, doctrine, and isolated Host Actions.
5. Review the workspace and project delegation profile.
6. Review, smoke-test required models, and save transactionally.

Project-only setup retains Roles, Execution & Safety, Workspace, and Review. It
does not rewrite provider credentials or model configuration.

Workspace defaults use Balance Decision Mode, Host Assistance on, Advisor off,
and doctrine off. Cost mode reduces review and context budgets; Power mode
increases bounded review depth. None of these modes can lower safety gates,
private-data approval, experiment assurance, or deterministic verification.
The same screen configures Host context classes, request/fan-out limits,
private-connector policy, Advisor targets/limits, and Host Action classes,
cost/use/expiry bounds. Remote Host Actions are off by default.

## Provider Capability Registry

`ProviderCapabilityRegistry` is the single source for:

- provider name and Common, Subscription, Cloud, Local, or Custom category;
- fixed, managed-per-model, or selectable protocol behavior;
- supported authentication methods;
- required, optional, advanced, and conditional form fields;
- field destinations in AuthStorage, provider-scoped environment, controlled
  headers, or non-secret profiles;
- model source and runtime adapter support.

Coverage tests compare the Registry with every provider exposed by the pinned
Pi model catalog. A newly added Pi provider fails CI until it is classified; the
UI never guesses that an unknown provider uses a simple API-key form.

Built-in examples include:

| Connection | Protocol/runtime | Authentication | Additional fields |
| --- | --- | --- | --- |
| OpenAI API | OpenAI Responses | API key | organization and project IDs |
| ChatGPT Plus/Pro | OpenAI Codex Responses | Pi device/browser OAuth | none |
| Anthropic | Anthropic Messages | API key or Pi OAuth | optional beta header |
| GitHub Copilot | managed per model | Pi OAuth | none |
| Azure OpenAI | Azure Responses | API key | endpoint/resource, API version, deployment map |
| Amazon Bedrock | Bedrock Converse | ambient identity | AWS profile and region |
| Google Vertex AI | Vertex runtime | ambient identity or API key | project and location |
| Cloudflare | managed or Chat-compatible | API key | account and optional gateway IDs |

Azure Microsoft Entra identity is shown only as a capability notice because the
pinned Pi runtime cannot execute it. It is never marked ready.

## Wire Protocols

Custom connections select exactly one upstream protocol before discovery:

- `openai-chat-completions`
- `openai-responses`
- `anthropic-messages`

One connection cannot change protocol per model. OpenAI Chat and Responses have
different request, tool-call, and state semantics, so the runtime does not
probe both and guess. Pi-specific APIs such as Google, Azure, Bedrock, Vertex,
Mistral, and OpenAI Codex remain fixed runtime adapters and are not presented in
the generic three-way selector.

OpenAI-compatible roots are stored as versioned API roots, normally ending in
`/v1`. Anthropic stores a service root; Pi appends `/v1/messages`. A legacy
Anthropic root ending in one `/v1` is normalized in memory and written back only
after a successful save.

Full generation URLs such as `/chat/completions`, `/responses`, or
`/v1/messages` are rejected. A non-standard model-list URL is stored separately
as `modelsEndpoint` and must use the same origin as the generation root.

## Configuration Ownership

Git workspaces store shared state in the Git common directory. Non-Git folders
use a user-state namespace keyed by canonical workspace path. The relevant
files are:

```text
swarm-pi-code-plugin/
├── model.json
├── state.json
└── jobs/<job-id>/request.json
```

`model.json.version` remains `1`. Additive optional fields preserve old files:

```json
{
  "version": 1,
  "primary": "openai/gpt-5.4",
  "fallbacks": ["anthropic/claude-sonnet-4-5"],
  "customProviders": [],
  "providerProfiles": [
    {
      "id": "openai",
      "provider": "openai",
      "name": "OpenAI",
      "connectionKind": "builtin",
      "auth": { "method": "api-key", "secretRef": "auth:openai" },
      "protocol": "openai-responses",
      "runtimeApi": "openai-responses",
      "readiness": "verified",
      "settings": {},
      "headers": [],
      "verifiedModel": "openai/gpt-5.4",
      "verifiedAt": "2026-07-11T00:00:00.000Z"
    }
  ],
  "updatedAt": "2026-07-11T00:00:00.000Z"
}
```

Profiles contain only non-secret settings, controlled literal headers, and
opaque `secretRef` values. Custom definitions contain protocol roots, model
metadata, structured auth policy, and optional controlled headers. They reject
embedded API keys, OAuth tokens, raw header JSON, command-backed values, and
credential-bearing URLs.

New custom provider IDs are a stable hash of canonical endpoint and protocol.
Existing IDs remain unchanged when their endpoint and protocol match exactly.

## Credential Boundary

Secrets remain in Pi `AuthStorage`. A browser secret first enters the
session-local `CredentialDraftVault`; the response contains only an opaque draft
ID, provider, auth method, masked flag, and expiry. Draft IDs are bound to the
loopback setup session and are removed after save, cancel, timeout, or expiry.

Secrets never enter:

- `model.json`, `state.json`, or job artifacts;
- browser localStorage or returned HTML;
- model discovery, verification, or save payloads after draft creation;
- stdout, worker logs, URLs, stack traces, or recovery journals.

Blank secret fields retain an existing credential. **Replace credential**,
**Sign out**, and **Remove from project** are distinct operations.

ChatGPT Plus/Pro is the `openai-codex` subscription connection. It is not an
OpenAI API-key option. The browser drives Pi's browser or device-code OAuth with
bounded long polling, explicit prompt responses, cancellation, and timeout.
Anthropic and GitHub Copilot use the same generic OAuth session machinery.
OAuth completes in an in-memory AuthStorage and becomes a credential draft;
the real AuthStorage changes only during final save.

AWS and Google ambient identities are detected without importing host secret
files. Project, region, and location values are non-secret profile data passed
as a provider-scoped environment overlay. The plugin never mutates
`process.env`.

## Controlled Headers

Raw header JSON is not accepted. Literal headers use a fixed allowlist such as
`HTTP-Referer`, `X-Title`, and `Anthropic-Beta`. Secret headers use `secretRef`
and provider-scoped AuthStorage environment values.

Pi configuration values interpret `$ENV` and `!command`. The runtime escapes
all literal header values before registering them, so a literal cannot read an
environment variable or execute a command. Secret references are the only
values intentionally passed as Pi environment templates.

Custom `API key + secret header` authentication uses the same secret for the
protocol-standard credential and the selected additional controlled header.
This keeps the native Pi adapter executable without a translation proxy.

## Discovery and Verification

Model discovery and API verification are separate states:

- `configured`: schema and authentication settings are valid;
- `discovered`: a protocol-specific model endpoint returned a valid inventory;
- `verified`: a selected model completed a minimal generation request;
- `blocked`: the connection cannot currently execute.

Custom discovery performs one request determined by the selected protocol.
OpenAI Chat and Responses use `<root>/models`; Anthropic uses
`<service-root>/v1/models`. Ollama and LM Studio are recognized only when the
user explicitly runs **Find local AI apps**. When a model endpoint is missing,
the user can enter model IDs manually; this remains `configured`, not
`verified`.

**Verify API** is explicit and warns through its action text that it sends a
minimal request. Final save always verifies the primary model and every
required Adaptive classifier. Fallbacks may remain discovered, and Review shows
their actual readiness.

Endpoint requests use bounded timeouts and response sizes, reject redirects,
URL credentials, cloud metadata addresses, and cross-origin model endpoints.
Credentials may use HTTP only for loopback endpoints.

## Transaction and Background Jobs

Save builds a candidate Pi environment from the proposed profiles and an
in-memory clone of AuthStorage. It validates every selected model, runs required
smoke tests, then commits credentials, `model.json`, and `state.json`. A failure
restores prior values. An incomplete rollback writes a redacted recovery journal
and returns `configuration-recovery-required`.

New durable jobs use `requestVersion: 5`. `request.json` contains the complete
non-secret `ModelConfiguration` snapshot, its SHA-256 integrity hash, and the
version-3 enforced project-policy snapshot, Decision Mode, Host Assistance, and
Advisor controls. A background worker uses those
submitted snapshots even if the settings page changes later, while resolving
current credentials at execution time. Credential revocation therefore fails
explicitly instead of falling back to unauthenticated execution.

Requests v1–v3 remain readable for recovery with their legacy execution
semantics. Version 4 preserves its submitted v2 enforced-policy snapshot;
version 5 adds the v3 decision, Host Assistance, Advisor, doctrine, context
budget, and Host Action policy controls.

## Server Lifecycle

The setup server binds to `127.0.0.1` on an ephemeral port, requires a random
session token, rejects cross-origin writes, limits request sizes, sends a
restrictive CSP and `no-store`, and closes after save, cancel, or idle timeout.
OAuth sessions and credential drafts are aborted and cleared with the server.

The server is not a daemon, does not support CORS, and has no network-listen
mode. If browser launch fails, it stays active and returns the one-time URL.

## Compatibility

- Missing `providerProfiles` load as an empty list.
- Legacy custom providers infer auth and wire protocol from existing fields.
- Existing custom IDs are not rewritten.
- Legacy jobs with request versions 1–3 retain their original semantics and
  are not retroactively given a provider or enforced project-policy snapshot.
  Version 3 jobs continue to use their submitted provider snapshot; version 4
  jobs additionally use their submitted project-policy snapshot.
- `init --set-model-priority[-file]`, `models --json`, and `providers --json`
  remain available for automation.

## Acceptance Criteria

- Every pinned Pi provider is explicitly classified by the Registry.
- ChatGPT subscription and OpenAI API-key connections remain separate.
- Browser responses, localStorage, state, model config, and jobs contain no
  credential values.
- Discovery never guesses among Chat, Responses, and Anthropic protocols.
- `discovered` never implies `verified`.
- Unsupported model-list endpoints permit manual IDs without claiming an API
  verification.
- Runtime and browser use the same provider definitions and policy validation.
- Background jobs use the submitted non-secret snapshot and current credential.
- Desktop and mobile setup remain usable without clipped or overlapping fields.
