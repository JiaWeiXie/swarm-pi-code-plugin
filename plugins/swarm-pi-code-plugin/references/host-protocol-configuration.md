# Configuration Addendum

Configuration may update only the project settings and user-global provider
connections selected in the setup UI.

- Provider definitions and profiles live in the plugin-owned global registry;
  credentials live in AuthStorage.
- Current routing comes from project routing plus the global registry. Cached
  model inventory and immutable Job snapshots are historical evidence only.
- Secrets enter the setup server's in-memory vault and reach AuthStorage only
  after verification. Prompts, telemetry, `model.json`, and runtime state contain
  no credentials.
- A loaded model list proves discovery, while **Verify API** proves the
  connection.
- Final Save commits the provider-registry diff with project routing. Deleting a
  custom provider also deletes its CredentialStore entry.
- Legacy conflicts are revision-guarded. Selecting the global definition revokes
  the provider-ID credential and requires verification; canonical import rekeys
  non-secret metadata without copying credentials.
- New configuration defaults are Adaptive, Host-first, Reversible, and Discovery
  gate review. `full-access` and Autopilot remain explicit opt-ins. Existing
  Sandbox modes persist, and legacy Host Assistance remains User-only until the
  user saves it again.

Configuration changes affect future Jobs; active Jobs keep their immutable
snapshots.
