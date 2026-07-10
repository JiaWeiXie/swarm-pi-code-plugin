# Provider and Model Web Configuration

## Decision

`swarm-pi-code-plugin` will provide a temporary local web application for
provider and model setup. Claude Code and Codex both launch the same shared
configuration server during first-run setup and reconfiguration.

Users are not expected to edit configuration JSON by hand.

## Configuration Ownership

The shared workspace data directory contains two files with distinct roles:

- `model.json` is the canonical provider and model configuration. It contains
  the primary model, ordered fallbacks, and non-secret custom provider
  definitions.
- `state.json` contains the project profile, job index, migration metadata, and
  a compatibility mirror of model priority for older plugin releases.

Linked Git worktrees resolve the same shared data directory and therefore read
the same `model.json`.

The provider identifier is encoded by every model reference as
`provider/model`. A separate selected-provider field is not persisted because
it could disagree with the primary model.

## File Format

```json
{
  "version": 1,
  "primary": "anthropic/claude-sonnet-4-5",
  "fallbacks": ["openai/gpt-5.2"],
  "customProviders": [],
  "updatedAt": "2026-07-10T00:00:00.000Z"
}
```

Custom provider definitions contain endpoint and model metadata only. They may
not contain API keys, bearer tokens, cookies, secret headers, shell commands,
or command-backed Pi configuration values.

When `model.json` does not exist, the loader reads the existing
`state.config.modelPriority` value. The next successful configuration write
creates `model.json` without deleting state or job history.

## Credential Boundary

Provider credentials remain user-scoped and use Pi `AuthStorage`, which
defaults to `~/.pi/agent/auth.json`. The web form accepts an optional API key,
but the server sends it directly to `AuthStorage` and never writes it to:

- `model.json`
- `state.json`
- job prompts or output
- stdout, stderr, logs, URLs, or error messages
- HTML returned after the form submission

An existing key or OAuth token is never returned to the browser. Reconfigure
shows only a readiness state and a non-secret source label. A blank API-key
field preserves the current credential. Project reset does not remove global
Pi credentials.

## Server Lifecycle and Security

The configuration server:

1. listens on `127.0.0.1` with an ephemeral port by default;
2. creates a cryptographically random, single-session URL token;
3. requires that token on document and API requests;
4. rejects non-loopback host headers, cross-origin requests, unsupported
   methods, oversized request bodies, and unexpected content types;
5. sets a restrictive Content Security Policy and no-store cache headers;
6. opens the system browser when permitted and always prints the local URL as a
   fallback;
7. shuts down after save, cancel, or a ten-minute idle timeout.

There is no CORS support and no network-listen option. The server is a bounded
setup session, not a daemon.

## User Flow

1. The host starts `pi-runner.mjs configure --host <host>`.
2. The browser displays all Pi registry providers, including providers without
   credentials and custom providers from the current `model.json`.
3. The user chooses a provider, optionally enters or replaces its API key, and
   chooses a primary model plus ordered fallbacks.
4. A custom endpoint form supports the Pi API types explicitly allowed by the
   runtime and supplies conservative defaults for optional model metadata.
5. The server validates provider identifiers, URLs, API types, model metadata,
   referenced models, and authentication readiness.
6. It writes `model.json` atomically, updates the compatibility priority mirror,
   reports success, and exits.

`/swarm-pi-code-plugin:init --reconfigure` and
`$swarm-pi-code-plugin-configure` always load the current `model.json`, so users
edit rather than recreate their setup.

## Compatibility

The existing non-interactive `init --set-model-priority[-file]` contract stays
available for automation. It writes the canonical `model.json` and the legacy
state mirror through the same validation path.

`models --json` and worker execution load custom provider definitions before
model discovery. Discovery and execution must use the same Pi environment so a
provider visible in setup cannot disappear when a job starts.

## Acceptance Criteria

- First-run and reconfigure work without hand-editing JSON.
- Reconfigure pre-populates provider, primary model, fallbacks, and custom
  endpoint fields from `model.json`.
- A submitted API key is usable but absent from every project artifact and
  response body.
- Built-in and custom providers can execute through the same model registry.
- Desktop and mobile layouts expose the complete setup flow without overlap or
  clipped controls.
- Claude Code and Codex invoke the same implementation.
