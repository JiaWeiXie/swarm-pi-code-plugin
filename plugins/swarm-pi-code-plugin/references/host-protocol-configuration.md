# Configuration Addendum

Configuration may inspect and update the explicit project settings and
user-global provider connections approved by the user. Provider definitions
live in the plugin-owned global registry; credentials remain in AuthStorage.
Never infer current routing from cached available models or immutable Job
snapshots. Never expose credentials in prompts or telemetry; use the normal
provider/authentication boundary and retain typed setup results.
Legacy conflict resolution is revision-guarded. Using the global definition
revokes the provider-ID credential and requires verification; importing under a
new canonical ID rekeys non-secret metadata but never copies credential data.
