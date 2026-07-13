import type { ConfigurationView } from "./configuration-service.js";

export function renderConfigurationPage(
  view: ConfigurationView,
  nonce: string,
  mode: "full" | "project" = "full",
): string {
  const bootstrap = JSON.stringify({ ...view, setupMode: mode })
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm Pi - ${mode === "project" ? "Project setup" : "AI setup"}</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <svg class="brand-logo" viewBox="0 0 44 44" role="img" aria-label="Swarm Pi logo">
          <path class="logo-bracket" d="M10 13 4 22l6 9M34 13l6 9-6 9"/>
          <path class="logo-path" d="M16 10h9l-8 12 10 12H16"/>
          <circle class="logo-node" cx="26" cy="10" r="3.5"/>
          <circle class="logo-node" cx="17" cy="22" r="3.5"/>
          <circle class="logo-node" cx="27" cy="34" r="3.5"/>
          <path class="logo-handoff" d="M21 22h6"/>
        </svg>
        <span>Swarm Pi</span>
      </div>
      <div class="local-status"><span></span>Local setup</div>
    </header>

    <nav id="full-steps" class="steps" aria-label="Setup progress">
      <button type="button" data-step="1"><span>1</span>Connect</button>
      <div class="step-line"></div>
      <button type="button" data-step="2"><span>2</span>Choose models</button>
      <div class="step-line"></div>
      <button type="button" data-step="3"><span>3</span>Roles</button>
      <div class="step-line"></div>
      <button type="button" data-step="4"><span>4</span>Safety</button>
      <div class="step-line"></div>
      <button type="button" data-step="5"><span>5</span>Workspace</button>
      <div class="step-line"></div>
      <button type="button" data-step="6"><span>6</span>Review</button>
    </nav>
    <nav id="project-steps" class="steps project-steps" aria-label="Project setup progress" hidden>
      <button type="button" data-step="3"><span>1</span>Roles</button>
      <div class="step-line"></div>
      <button type="button" data-step="4"><span>2</span>Safety</button>
      <div class="step-line"></div>
      <button type="button" data-step="5"><span>3</span>Workspace</button>
      <div class="step-line"></div>
      <button type="button" data-step="6"><span>4</span>Review</button>
    </nav>

    <main class="workspace">
      <div id="registry-warning" class="notice warning" hidden></div>

      <section id="connections-screen" class="screen">
        <div class="screen-heading">
          <div><h1>AI connections</h1><p>Services available to this project.</p></div>
          <button id="open-connection" class="primary-button" type="button">Add connection</button>
        </div>
        <div id="connection-empty" class="hero-empty" hidden>
          <svg viewBox="0 0 72 72" aria-hidden="true">
            <path d="M21 18h17L25 36l20 18H21"/>
            <circle cx="40" cy="18" r="5"/><circle cx="25" cy="36" r="5"/><circle cx="45" cy="54" r="5"/>
          </svg>
          <h2>Connect an AI service</h2>
          <p>No usable connection was detected from Pi or this project.</p>
          <div class="empty-actions">
            <button id="empty-connect" class="primary-button" type="button">Connect a service</button>
            <button id="empty-local" class="secondary-button" type="button">Find local AI apps</button>
          </div>
        </div>
        <div id="connection-list" class="connection-list"></div>
        <div id="connection-actions" class="section-actions">
          <button id="find-local" class="secondary-button" type="button">Find local AI apps</button>
          <span id="connection-status" class="inline-status" role="status" aria-live="polite"></span>
        </div>
      </section>

      <section id="models-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1>Choose models</h1><p>Select a primary worker and optional fallbacks.</p></div></div>
        <div class="form-band">
          <div class="form-copy"><h2>Primary model</h2><p>Used for delegated work by default.</p></div>
          <div class="form-control">
            <label for="primary-model">Model</label>
            <select id="primary-model"></select>
            <div id="model-details" class="model-details"></div>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Fallback models</h2><p>Tried in this order if the primary is unavailable.</p></div>
          <div class="form-control">
            <div id="fallback-list" class="fallback-list"></div>
            <button id="add-fallback" class="secondary-button" type="button">Add fallback</button>
          </div>
        </div>
      </section>

      <section id="roles-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1>Worker roles</h1><p>Assign models and reasoning effort to each delegated responsibility.</p></div></div>
        <div id="role-policy-list" class="role-policy-list"></div>
      </section>

      <section id="safety-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1>Execution &amp; safety</h1><p>Set the enforcement policy used by new delegated jobs.</p></div></div>
        <div id="safety-error" class="notice error-notice" role="alert" hidden></div>
        <div class="form-band">
          <div class="form-copy"><h2>Sandbox mode</h2><p>Select a static or policy-controlled execution boundary.</p></div>
          <div class="form-control">
            <div class="scope-toggle three" role="radiogroup" aria-label="Sandbox execution mode">
              <button id="sandbox-strict" type="button" role="radio">Strict</button>
              <button id="sandbox-adaptive" type="button" role="radio">Adaptive</button>
              <button id="sandbox-lenient" type="button" role="radio">Lenient</button>
            </div>
            <p id="sandbox-backend" class="field-hint"></p>
            <div id="sandbox-warning" class="notice warning sandbox-warning" hidden></div>
          </div>
        </div>
        <div id="adaptive-settings" class="form-band">
          <div class="form-copy"><h2>Adaptive authorization</h2><p>Choose the classifier chain and bounded supervisor fallback.</p></div>
          <div class="form-control">
            <label>Classifier models</label>
            <div id="classifier-models" class="check-list"></div>
            <label for="classifier-thinking">Classifier thinking</label>
            <select id="classifier-thinking"><option>off</option><option>minimal</option><option>low</option><option selected>medium</option><option>high</option><option>xhigh</option><option>max</option></select>
            <span class="field-hint">The runtime reduces this value when the selected model supports a lower maximum.</span>
            <label>When classification cannot decide</label>
            <div class="scope-toggle" role="radiogroup" aria-label="Approval policy">
              <button id="approval-deny" type="button" role="radio">Deny</button>
              <button id="approval-wait" type="button" role="radio">Wait for supervisor</button>
            </div>
            <label for="trusted-domains">Trusted outbound domains <span class="optional">optional</span></label>
            <textarea id="trusted-domains" rows="3" placeholder="One domain per line, for example: registry.npmjs.org"></textarea>
            <label class="inline-check"><input id="policy-diagnostics" type="checkbox"> Store redacted classifier diagnostics</label>
            <details class="project-advanced">
              <summary>Structured policy rules</summary>
              <label for="policy-rules">Deny, ask, and bounded allow rules</label>
              <textarea id="policy-rules" rows="7" spellcheck="false"></textarea>
            </details>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Background implementation</h2><p>Isolate mechanical edits from the host worktree.</p></div>
          <div class="form-control">
            <label class="inline-check"><input id="background-mechanical" type="checkbox"> Allow mechanical executor in a job-owned worktree</label>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Decision mode</h2><p>Selects one, two, or three base orchestrate perspectives. Context and Advisor limits stay separate; safety gates are unchanged.</p></div>
          <div class="form-control">
            <label for="decision-mode">Review and decision depth</label>
            <select id="decision-mode"><option value="cost">Cost</option><option value="balance">Balance</option><option value="power">Power</option></select>
            <label class="inline-check"><input id="decision-doctrine" type="checkbox"> Record a Question → Delete → Simplify preference (not executed automatically)</label>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Host Assistance</h2><p>Let workers request bounded workspace, Web, docs, paper, connector, or installed-skill context from the Host.</p></div>
          <div class="form-control">
            <label for="host-assistance-mode">Default</label>
            <select id="host-assistance-mode"><option value="on">On</option><option value="inherit">Inherit</option><option value="off">Off</option></select>
            <label for="host-review-mode">Review path</label><select id="host-review-mode"><option value="host-first">Host model first</option><option value="user-only">Always ask the user</option></select>
            <label for="host-auto-scope">Host auto-approval ceiling</label><select id="host-auto-scope"><option value="context-only">Context only</option><option value="read-only">Read-only capabilities</option><option value="reversible">Bounded reversible changes</option></select>
            <label class="inline-check"><input id="host-auto-discovery-gates" type="checkbox"> Allow the active Host model to approve bounded Discovery gates</label>
            <span class="field-hint">Recovery hooks and replay never approve. Private connectors, delivery, deployment, messages, and irreversible actions still require the user.</span>
            <label>Allowed context classes</label><div id="host-context-classes" class="check-list"></div>
            <label for="context-budget">Context budget</label><input id="context-budget" type="number" min="0" max="64">
            <label for="host-max-requests">Requests per Job</label><input id="host-max-requests" type="number" min="0" max="6">
            <label for="host-max-fanout">Concurrent fan-out</label><input id="host-max-fanout" type="number" min="0" max="3">
            <label for="private-connector">Private connectors</label><select id="private-connector"><option value="deny">Deny</option><option value="ask">Ask each time</option></select>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Advisor</h2><p>Optional bounded read-only consultations on selected tasks; no dynamic coordinator runs.</p></div>
          <div class="form-control">
            <label class="inline-check"><input id="advisor-enabled" type="checkbox"> Enable Advisor</label>
            <label>Advisor targets</label><div id="advisor-targets" class="check-list"></div>
            <label for="advisor-max-requests">Consultations per Job</label><input id="advisor-max-requests" type="number" min="0" max="3">
            <label for="advisor-max-perspectives">Maximum Advisor perspectives</label><input id="advisor-max-perspectives" type="number" min="0" max="4">
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Host Actions 0.5</h2><p>Run explicitly recorded recommendations in isolated child Jobs. Remote effects remain disabled by default.</p></div>
          <div class="form-control">
            <label class="inline-check"><input id="host-actions-enabled" type="checkbox"> Enable isolated Host Action children</label>
            <label>Allowed action classes</label><div id="host-action-classes" class="check-list"></div>
            <label class="inline-check"><input id="host-actions-remote" type="checkbox"> Enable remote write, message, deploy, and transaction actions</label>
            <label for="host-action-max-uses">Maximum uses</label><input id="host-action-max-uses" type="number" min="1" max="100">
            <label for="host-action-max-cost">Maximum cost</label><input id="host-action-max-cost" type="number" min="0" step="0.01">
            <label for="host-action-ttl">Lease TTL (minutes)</label><input id="host-action-ttl" type="number" min="1" max="1440">
          </div>
        </div>
      </section>

      <section id="project-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1>Workspace</h1><p>Choose how Swarm Pi should work with this folder.</p></div></div>
        <div id="workspace-state" class="notice" role="status"></div>
        <div id="profile-error" class="notice error-notice" role="alert" hidden></div>
        <div class="form-band">
          <div class="form-copy"><h2>Project goal</h2><p>A short description Pi can use to understand the desired outcome.</p></div>
          <div class="form-control">
            <label for="project-goal">What should this project accomplish?</label>
            <textarea id="project-goal" rows="5" maxlength="4000" placeholder="For example: Build a reliable internal tool for managing customer support requests."></textarea>
            <span class="field-hint">Describe the product or outcome, not an individual coding task.</span>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Working area</h2><p>Limit the folders Pi should consider when work is delegated.</p></div>
          <div class="form-control">
            <div class="scope-toggle" role="radiogroup" aria-label="Project working area">
              <button id="scope-all" type="button" role="radio">Whole project</button>
              <button id="scope-selected" type="button" role="radio">Selected folders</button>
            </div>
            <div id="directory-options" class="check-list" hidden></div>
            <p id="directory-empty" class="field-hint" hidden>No top-level project folders were found.</p>
          </div>
        </div>
        <div class="form-band">
          <div class="form-copy"><h2>Delegated work</h2><p>Choose the kinds of tasks Pi may handle for this project.</p></div>
          <div class="form-control">
            <div id="task-options" class="check-list task-list"></div>
            <details class="project-advanced">
              <summary>Additional task types</summary>
              <label for="custom-tasks">Other task types <span class="optional">optional</span></label>
              <input id="custom-tasks" placeholder="Comma-separated, for example: documentation, testing">
            </details>
          </div>
        </div>
      </section>

      <section id="review-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1 id="review-title">Review setup</h1><p>Confirm what Swarm Pi will use in this project.</p></div></div>
        <div class="review-section full-only"><h2>Primary model</h2><div id="review-primary" class="review-value"></div></div>
        <div class="review-section full-only"><h2>Fallback order</h2><div id="review-fallbacks" class="review-list"></div></div>
        <div class="review-section full-only"><h2>Connections</h2><div id="review-connections" class="review-list"></div></div>
        <div class="review-section full-only"><h2>Connection test</h2><div class="review-value">The primary model and required Adaptive classifier will receive a minimal READY request before settings are saved.</div></div>
        <div class="review-section"><h2>Project goal</h2><div id="review-goal" class="review-value review-text"></div></div>
        <div class="review-section"><h2>Working area</h2><div id="review-directories" class="review-list"></div></div>
        <div class="review-section"><h2>Delegated work</h2><div id="review-tasks" class="review-list"></div></div>
        <div class="review-section"><h2>Execution safety</h2><div id="review-sandbox" class="review-value"></div></div>
        <div class="review-section"><h2>Workflow controls</h2><div id="review-workflow" class="review-list"></div></div>
        <div class="review-section"><h2>Role routing</h2><div id="review-roles" class="review-list"></div></div>
      </section>

      <section id="closed-screen" class="screen completion-screen" hidden>
        <div id="completion-mark" class="completion-mark" aria-hidden="true">✓</div>
        <h1 id="completion-title">Setup closed</h1>
        <p id="completion-message"></p>
      </section>
    </main>

    <footer class="actionbar">
      <div id="save-status" class="save-status" role="status" aria-live="polite"></div>
      <div id="action-buttons" class="actions">
        <button id="cancel-button" class="secondary-button" type="button">Close setup</button>
        <button id="back-button" class="secondary-button" type="button" hidden>Back</button>
        <button id="next-button" class="primary-button" type="button">Choose models</button>
        <button id="save-button" class="primary-button" type="button" hidden>Save configuration</button>
      </div>
    </footer>
  </div>

  <dialog id="connection-dialog">
    <div class="dialog-shell">
      <div class="dialog-heading">
        <div><h2 id="dialog-title">Add a connection</h2><p>Choose how you access the AI service.</p></div>
        <button id="close-dialog" class="icon-button" type="button" aria-label="Close" title="Close">x</button>
      </div>
      <div class="mode-tabs" role="tablist" aria-label="Connection type">
        <button id="cloud-tab" type="button" role="tab">Provider catalog</button>
        <button id="custom-tab" type="button" role="tab">Custom or local</button>
      </div>

      <div id="cloud-panel" class="dialog-panel">
        <label for="provider-search">Find a service</label>
        <input id="provider-search" type="search" placeholder="Search providers">
        <label for="cloud-provider">AI service</label>
        <select id="cloud-provider"></select>
        <div id="provider-protocol" class="protocol-summary"></div>
        <label for="provider-auth-method">Authentication</label>
        <select id="provider-auth-method"></select>
        <div id="provider-fields" class="provider-fields"></div>
        <div id="oauth-panel" class="oauth-panel" hidden>
          <label for="oauth-login-method">Sign-in method</label>
          <select id="oauth-login-method">
            <option value="browser">Browser</option>
            <option value="device_code">Device code</option>
          </select>
          <button id="start-oauth" class="primary-button wide-button" type="button">Sign in</button>
          <div id="oauth-status" class="oauth-status" role="status" aria-live="polite"></div>
          <div id="oauth-challenge" class="oauth-challenge" hidden></div>
        </div>
        <button id="connect-cloud" class="primary-button wide-button" type="button">Connect</button>
      </div>

      <div id="custom-panel" class="dialog-panel" hidden>
        <label for="endpoint-protocol">API protocol</label>
        <select id="endpoint-protocol">
          <option value="openai-chat-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <label for="endpoint-url">Server URL</label>
        <input id="endpoint-url" type="url" spellcheck="false" placeholder="http://127.0.0.1:11434">
        <label for="endpoint-auth-method">Authentication</label>
        <select id="endpoint-auth-method">
          <option value="api-key">API key</option>
          <option value="none">No authentication</option>
          <option value="custom-header">API key + secret header</option>
        </select>
        <div id="endpoint-header-wrap" hidden>
          <label for="endpoint-header">Secret header</label>
          <select id="endpoint-header">
            <option value="authorization">Authorization</option>
            <option value="x-api-key">X-API-Key</option>
            <option value="api-key">Api-Key</option>
          </select>
        </div>
        <div id="endpoint-key-wrap">
          <label for="endpoint-key">Credential</label>
          <input id="endpoint-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Enter a credential">
        </div>
        <details class="advanced">
          <summary>Advanced endpoint settings</summary>
          <div class="advanced-body">
            <label for="models-endpoint">Models endpoint <span class="optional">optional</span></label>
            <input id="models-endpoint" type="url" spellcheck="false" placeholder="Uses the protocol default">
            <label for="custom-http-referer">HTTP-Referer <span class="optional">optional</span></label>
            <input id="custom-http-referer" type="url" spellcheck="false">
            <label for="custom-app-title">X-Title <span class="optional">optional</span></label>
            <input id="custom-app-title">
            <label for="custom-anthropic-beta">Anthropic-Beta <span class="optional">optional</span></label>
            <input id="custom-anthropic-beta">
          </div>
        </details>
        <button id="test-endpoint" class="primary-button wide-button" type="button">Load models</button>
        <div id="discovery-result" class="discovery-result" hidden></div>
        <details id="manual-models" class="advanced">
          <summary>Enter model IDs manually</summary>
          <div class="advanced-body">
            <label for="manual-model-ids">Model IDs</label>
            <textarea id="manual-model-ids" rows="4" placeholder="One model ID per line"></textarea>
            <button id="use-manual-models" class="secondary-button wide-button" type="button">Use manual models</button>
          </div>
        </details>
        <details id="advanced-connection" class="advanced" hidden>
          <summary>Advanced connection and model settings</summary>
          <div class="advanced-body">
            <label for="endpoint-name">Connection name</label>
            <input id="endpoint-name">
            <div class="advanced-grid">
              <div><label for="endpoint-canonical-url">API base URL</label><input id="endpoint-canonical-url" type="url" spellcheck="false"></div>
              <div><label for="endpoint-api">Runtime adapter</label><input id="endpoint-api" readonly></div>
            </div>
            <div id="advanced-models" class="advanced-models"></div>
          </div>
        </details>
        <button id="accept-endpoint" class="primary-button wide-button" type="button" hidden>Add connection</button>
      </div>
      <div id="dialog-status" class="dialog-status" role="status" aria-live="polite"></div>
    </div>
  </dialog>

  <script nonce="${nonce}">window.__SWARM_CONFIG__=${bootstrap};</script>
  <script nonce="${nonce}">${clientScript}</script>
</body>
</html>`;
}

const styles = String.raw`
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  letter-spacing: 0;
  color: #18201f;
  background: #f4f6f5;
  --ink: #18201f;
  --muted: #66716e;
  --border: #d7ddda;
  --surface: #ffffff;
  --rail: #f6f8f7;
  --teal: #087f78;
  --teal-dark: #066b65;
  --teal-soft: #e9f6f4;
  --green: #168a58;
  --green-soft: #edf8f2;
  --coral: #c84e41;
  --amber: #99620a;
  --amber-soft: #fff8e8;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; min-width: 320px; background: #f4f6f5; }
button, input, select, textarea { font: inherit; letter-spacing: 0; }
button { cursor: pointer; }
.app-shell { min-height: 100vh; display: grid; grid-template-rows: 64px 76px minmax(0, 1fr) 76px; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 0 28px; border-bottom: 1px solid var(--border); background: var(--surface); }
.brand { display: flex; align-items: center; gap: 11px; font-size: 18px; font-weight: 730; }
.brand-logo { width: 36px; height: 36px; overflow: visible; }
.brand-logo * { vector-effect: non-scaling-stroke; }
.logo-bracket { fill: none; stroke: #1c2927; stroke-width: 3.2; stroke-linecap: square; stroke-linejoin: miter; }
.logo-path { fill: none; stroke: var(--teal); stroke-width: 3.4; stroke-linecap: square; stroke-linejoin: miter; }
.logo-node { fill: #fff; stroke: #1c2927; stroke-width: 2.8; }
.logo-handoff { stroke: var(--coral); stroke-width: 3.4; stroke-linecap: square; }
.local-status { display: flex; align-items: center; gap: 8px; color: #47524f; font-size: 13px; }
.local-status span { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
.steps { display: flex; align-items: center; justify-content: center; gap: 14px; min-width: 0; padding: 0 24px; border-bottom: 1px solid var(--border); background: #fbfcfb; }
.project-steps { gap: 18px; }
.steps button { display: flex; align-items: center; gap: 9px; padding: 8px 0; border: 0; background: transparent; color: #7a8481; font-weight: 650; }
.steps button span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #e7eae8; color: #68716f; }
.steps button.active { color: var(--teal); }
.steps button.active span { color: #fff; background: var(--teal); }
.steps button.complete { color: #38534f; }
.steps button.complete span { color: #fff; background: #315f58; }
.step-line { flex: 0 1 110px; width: 110px; min-width: 12px; height: 1px; background: #cdd3d0; }
.workspace { width: min(1040px, calc(100% - 40px)); margin: 0 auto; padding: 38px 0 48px; }
.screen-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 6px; font-size: 30px; line-height: 1.2; }
h2 { letter-spacing: 0; }
.screen-heading p, .form-copy p { margin: 0; color: var(--muted); }
.primary-button, .secondary-button, .danger-button { min-height: 40px; padding: 0 16px; border-radius: 6px; font-weight: 680; }
.primary-button { color: #fff; border: 1px solid var(--teal); background: var(--teal); }
.primary-button:hover { background: var(--teal-dark); }
.secondary-button { color: #26312f; border: 1px solid #c8d0cd; background: #fff; }
.secondary-button:hover { background: #f3f6f5; }
.danger-button { color: #a63f35; border: 1px solid #e5b8b2; background: #fff; }
.primary-button:disabled, .secondary-button:disabled { opacity: .5; cursor: not-allowed; }
.notice { margin-bottom: 20px; padding: 11px 13px; border-radius: 6px; font-size: 13px; }
.warning { color: #73500d; border: 1px solid #e3c37f; background: var(--amber-soft); }
.error-notice { margin-top: 20px; color: #913a31; border: 1px solid #e1aaa3; background: #fff3f1; }
.hero-empty { display: grid; justify-items: center; padding: 66px 24px 54px; text-align: center; }
.hero-empty svg { width: 64px; height: 64px; margin-bottom: 16px; fill: #fff; stroke: var(--teal); stroke-width: 3; }
.hero-empty h2 { margin: 0 0 7px; font-size: 24px; }
.hero-empty p { margin: 0; color: var(--muted); }
.empty-actions { display: flex; gap: 10px; margin-top: 24px; }
.connection-list { display: grid; gap: 8px; padding-top: 22px; }
.connection-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto auto; align-items: center; gap: 13px; min-height: 68px; padding: 11px 14px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
.connection-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 6px; background: #e5efed; color: #24413c; font-size: 12px; font-weight: 800; text-transform: uppercase; }
.connection-name { display: block; font-weight: 700; }
.connection-meta { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; color: var(--green); font-size: 12px; font-weight: 650; }
.status-pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
.row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.row-actions button { min-height: 34px; padding: 0 11px; }
.verify-model-select { min-height: 34px; max-width: 190px; padding: 0 8px; border: 1px solid #c8d0cd; border-radius: 6px; background: #fff; color: #26312f; font-size: 13px; }
.section-actions { display: flex; align-items: center; gap: 12px; padding-top: 18px; }
.inline-status { color: var(--muted); font-size: 13px; }
.inline-status.error, .dialog-status.error, .save-status.error { color: var(--coral); }
.form-band { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 50px; padding: 28px 0; border-bottom: 1px solid var(--border); }
.form-copy h2, .review-section h2 { margin: 0 0 4px; font-size: 16px; }
label { display: block; margin: 0 0 7px; color: #34413e; font-size: 13px; font-weight: 680; }
input, select, textarea { width: 100%; min-height: 43px; padding: 0 12px; border: 1px solid #c8d0cd; border-radius: 6px; color: var(--ink); background: #fff; outline: none; }
textarea { padding-top: 10px; padding-bottom: 10px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible, summary:focus-visible { border-color: var(--teal); box-shadow: 0 0 0 3px rgba(8,127,120,.14); outline: none; }
.model-details { margin-top: 12px; padding: 14px; border-left: 3px solid var(--teal); background: #f4f8f7; }
.model-title { font-weight: 720; }
.model-reference { margin-top: 2px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.model-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tag { padding: 3px 7px; border-radius: 4px; color: #40504d; background: #e4e9e7; font-size: 11px; }
.model-advanced { margin-top: 12px; }
.model-advanced summary, .advanced summary { color: #345b55; font-weight: 670; cursor: pointer; }
.limit-grid, .advanced-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 13px; }
.source-note { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
.fallback-list { display: grid; gap: 7px; margin-bottom: 10px; }
.fallback-row { display: grid; grid-template-columns: minmax(0, 1fr) 36px 36px 36px; align-items: center; gap: 5px; }
.fallback-row button { width: 36px; height: 36px; padding: 0; border: 1px solid var(--border); border-radius: 6px; color: #586360; background: #fff; }
.scope-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 16px; padding: 4px; border-radius: 7px; background: #e9eeec; }
.scope-toggle button { min-height: 40px; border: 0; border-radius: 5px; color: #59635f; background: transparent; font-weight: 680; }
.scope-toggle button.active { color: #183b36; background: #fff; box-shadow: 0 1px 2px rgba(21,35,32,.08); }
.check-list { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; border-top: 1px solid var(--border); }
.check-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; align-items: start; padding: 11px 0; border-bottom: 1px solid var(--border); font-weight: 650; cursor: pointer; }
.check-row input { width: 17px; min-height: 17px; height: 17px; margin: 2px 0 0; accent-color: var(--teal); }
.check-row span { display: block; }
.check-row small { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; font-weight: 400; }
.project-advanced { margin-top: 16px; }
.project-advanced summary { color: #345b55; font-weight: 670; cursor: pointer; }
.project-advanced label { margin-top: 14px; }
.review-section { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 50px; padding: 25px 0; border-bottom: 1px solid var(--border); }
.review-value { font-weight: 700; }
.review-text { white-space: pre-wrap; }
.review-list { display: grid; gap: 7px; }
.review-item { padding: 10px 12px; border-left: 3px solid #9fb7b3; background: #f5f7f6; }
.completion-screen { display: grid; justify-items: center; align-content: center; min-height: 100%; padding: 60px 20px; text-align: center; }
.completion-mark { display: grid; place-items: center; width: 52px; height: 52px; margin-bottom: 18px; border-radius: 50%; color: #fff; background: var(--green); font-size: 25px; font-weight: 800; }
.completion-mark.neutral { background: #5e6966; }
.completion-screen h1 { margin-bottom: 8px; }
.completion-screen p { max-width: 540px; margin: 0; color: var(--muted); }
.actionbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px max(24px, calc((100% - 1040px) / 2)); border-top: 1px solid var(--border); background: rgba(255,255,255,.98); }
.actions { display: flex; gap: 9px; margin-left: auto; }
.save-status { color: var(--muted); font-size: 13px; }
.save-status.success { color: var(--green); font-weight: 680; }
dialog { width: min(660px, calc(100% - 28px)); max-height: calc(100vh - 40px); padding: 0; border: 1px solid #c7cfcc; border-radius: 8px; background: #fff; box-shadow: 0 18px 60px rgba(21,35,32,.2); }
dialog::backdrop { background: rgba(23,31,29,.36); }
.dialog-shell { padding: 24px; overflow-y: auto; max-height: calc(100vh - 42px); }
.dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.dialog-heading h2 { margin: 0 0 4px; font-size: 22px; }
.dialog-heading p { margin: 0; color: var(--muted); }
.icon-button { width: 36px; height: 36px; border: 0; border-radius: 6px; color: #5d6764; background: transparent; font-weight: 800; }
.icon-button:hover { color: var(--coral); background: #fff1ef; }
.mode-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 22px 0; padding: 4px; border-radius: 7px; background: #edf1ef; }
.mode-tabs button { min-height: 38px; border: 0; border-radius: 5px; color: #59635f; background: transparent; font-weight: 670; }
.mode-tabs button.active { color: #183b36; background: #fff; box-shadow: 0 1px 2px rgba(21,35,32,.08); }
.dialog-panel label:not(:first-child) { margin-top: 16px; }
.field-hint { margin: 7px 0 0; color: var(--muted); font-size: 12px; }
.sandbox-warning { margin-top: 12px; }
.scope-toggle.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.role-policy-list { display: grid; gap: 12px; }
.role-policy-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(220px, 1.5fr) 130px 100px; gap: 14px; align-items: end; padding: 16px 0; border-bottom: 1px solid var(--border); }
.role-policy-row h2 { margin: 0; font-size: 16px; }
.role-policy-row p { margin: 3px 0 0; color: var(--muted); font-size: 13px; }
.role-policy-row label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.inline-check { display: flex !important; align-items: center; gap: 9px; color: var(--ink) !important; }
.inline-check input { width: auto; }
.optional { color: var(--muted); font-weight: 500; }
.wide-button { width: 100%; margin-top: 18px; }
.protocol-summary { display: flex; align-items: center; min-height: 38px; margin-top: 14px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; color: #31504b; background: #f7faf9; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.provider-fields { display: grid; gap: 14px; margin-top: 16px; }
.provider-field { display: grid; gap: 6px; }
.provider-field label { margin-top: 0 !important; }
.oauth-panel { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.oauth-status { margin-top: 12px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.oauth-challenge { display: grid; gap: 9px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: #f8faf9; }
.oauth-challenge a { color: var(--teal-dark); overflow-wrap: anywhere; }
.readiness-configured { color: #6b551a; background: #fff8e8; }
.readiness-discovered { color: #31504b; background: #eef6f4; }
.readiness-verified { color: #215842; background: var(--green-soft); }
.readiness-blocked { color: #913a31; background: #fff3f1; }
.discovery-result { margin-top: 16px; padding: 12px; border: 1px solid #a9d2c0; border-radius: 6px; color: #215842; background: var(--green-soft); }
.discovery-result strong { display: block; }
.advanced { margin-top: 14px; padding-top: 2px; }
.advanced-body { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.advanced-models { display: grid; gap: 7px; max-height: 320px; margin-top: 18px; overflow-y: auto; }
.model-editor { padding: 9px 11px; border: 1px solid var(--border); border-radius: 6px; }
.model-editor summary { font-weight: 650; cursor: pointer; overflow-wrap: anywhere; }
.model-editor-body { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; padding-top: 12px; }
.model-editor-body .model-id { grid-column: 1 / -1; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
.dialog-status { min-height: 20px; margin-top: 12px; color: var(--muted); font-size: 13px; }
@media (max-width: 760px) {
  .app-shell { grid-template-rows: 58px 68px minmax(0, 1fr) auto; }
  .topbar { padding: 0 16px; }
  .steps, .project-steps { gap: 6px; padding: 0 12px; }
  .steps button { gap: 0; font-size: 0; }
  .step-line { flex: 1 1 22px; width: auto; min-width: 6px; }
  .steps button span { width: 26px; height: 26px; }
  .workspace { width: min(100% - 28px, 1040px); padding-top: 24px; }
  .screen-heading { align-items: stretch; flex-direction: column; }
  .screen-heading .primary-button { width: 100%; }
  .connection-row { grid-template-columns: 40px minmax(0, 1fr); }
  .status-pill, .row-actions { grid-column: 2; }
  .row-actions { justify-content: flex-start; }
  .form-band, .review-section { grid-template-columns: 1fr; gap: 14px; }
  .check-list { grid-template-columns: 1fr; }
  .actionbar { padding: 12px 14px; flex-wrap: wrap; }
  .save-status { width: 100%; order: 2; }
  .actions { width: 100%; }
  .actions button { flex: 1; }
}
@media (max-width: 480px) {
  .local-status { font-size: 0; }
  .steps button span { font-size: 12px; }
  .empty-actions, .section-actions { align-items: stretch; flex-direction: column; width: 100%; }
  .empty-actions button { width: 100%; }
  .limit-grid, .advanced-grid, .model-editor-body { grid-template-columns: 1fr; }
  .fallback-row { grid-template-columns: minmax(0, 1fr) 34px 34px 34px; }
  .scope-toggle { grid-template-columns: 1fr; }
  .scope-toggle.three, .role-policy-row { grid-template-columns: 1fr; }
}
`;

const clientScript = String.raw`
(() => {
  const boot = window.__SWARM_CONFIG__;
  const token = new URLSearchParams(location.search).get("token") || "";
  const taskTypes = [
    {value:"implementation",label:"Implementation",description:"Edit code and complete approved changes."},
    {value:"planning",label:"Planning",description:"Explore approaches and prepare implementation plans."},
    {value:"code-review",label:"Code review",description:"Inspect changes for bugs, risks, and missing tests."},
    {value:"analysis",label:"Analysis",description:"Investigate behavior, architecture, and technical questions."},
    {value:"scaffolding",label:"Project scaffolding",description:"Create a verified new project in isolated staging."},
    {value:"development-setup",label:"Development setup",description:"Configure project-local dependencies and tools."},
    {value:"discovery",label:"Discovery",description:"Research unknowns, run reproducible experiments, and converge requirements."},
  ];
  const setupMode = boot.setupMode === "project" ? "project" : "full";
  const initialPhase = setupMode === "project" ? 3 : 1;
  const savedProfile = boot.profile || null;
  const knownTasks = new Set(taskTypes.map(item => item.value));
  const savedTasks = savedProfile?.tasks || [];
  function canonicalTask(value) {
    const normalized = String(value).trim().toLowerCase().replace(/[ _]+/g, "-");
    return ({implement:"implementation",implementation:"implementation",coding:"implementation",plan:"planning",planning:"planning",review:"code-review","code-review":"code-review",analysis:"analysis",analyze:"analysis",discover:"discovery",discovery:"discovery",scaffold:"scaffolding",scaffolding:"scaffolding",setup:"development-setup","development-setup":"development-setup"})[normalized] || null;
  }
  const savedKnownTasks = savedTasks.map(canonicalTask).filter(Boolean);
  const state = {
    phase: initialPhase,
    setupMode,
    connections: structuredClone(boot.providers),
    providerCatalog: boot.providerCatalog,
    models: structuredClone(boot.models),
    customProviders: structuredClone(boot.configuration.customProviders),
    providerProfiles: structuredClone(boot.configuration.providerProfiles || []),
    credentialDrafts: {},
    providerFieldValues: {},
    primary: boot.configuration.primary || "",
    fallbacks: [...boot.configuration.fallbacks],
    customDraft: null,
    customProfileDraft: null,
    editingCustomIndex: -1,
    dialogMode: "cloud",
    oauthSession: null,
    oauthOpenedUrl: "",
    closed: false,
    sandboxMode: ["strict","adaptive","lenient"].includes(boot.sandboxMode) ? boot.sandboxMode : "strict",
    rolePolicies: structuredClone(boot.rolePolicies || {}),
    adaptivePolicy: structuredClone(boot.adaptivePolicy || {classifierModels:[],classifierThinkingLevel:"medium",approvalPolicy:"deny",trustedDomains:[],rules:[],diagnostics:false}),
    backgroundRolePolicy: structuredClone(boot.backgroundRolePolicy || {mechanicalExecutor:false}),
    decisionMode: ["cost","balance","power"].includes(boot.decisionMode) ? boot.decisionMode : "balance",
    hostAssistance: structuredClone(boot.hostAssistance || {enabled:true,mode:"on",contextClasses:["workspace","web","docs","paper","connector","skill"],privateConnector:"ask",maxRequests:4,maxFanOut:2,reviewMode:"host-first",autoApprovalScope:"reversible",autoApproveDiscoveryGates:true}),
    contextBudget: Number.isInteger(boot.contextBudget) ? boot.contextBudget : 4,
    advisor: structuredClone(boot.advisor || {enabled:false,targets:["review","plan","orchestrate","discover"],maxRequests:2,maxPerspectives:2}),
    doctrine: boot.doctrine || null,
    hostActions: structuredClone(boot.hostActions || {enabled:true,allowedActionClasses:["local-mutation","draft"],remoteActionsEnabled:false,maxUses:1,maxCost:1,ttlMs:1800000}),
    profile: {
      goal: savedProfile?.goal || "",
      scope: savedProfile?.dirs === undefined ? "all" : "selected",
      dirs: [...(savedProfile?.dirs || [])],
      tasks: savedProfile ? [...new Set(savedKnownTasks.filter(task => knownTasks.has(task)))] : taskTypes.map(item => item.value),
      customTasks: savedTasks.filter(task => !canonicalTask(task)),
    },
  };
  state.providerProfiles.forEach(profile => {
    state.providerFieldValues[profile.provider] = structuredClone(profile.settings || {});
  });
  const draftKey = "swarm-pi-setup-draft:" + (boot.workspaceId || "default");
  const bootRevision = boot.configurationRevision || JSON.stringify({
    primary:boot.configuration.primary,fallbacks:boot.configuration.fallbacks,profile:boot.profile,
    sandboxMode:boot.sandboxMode,rolePolicies:boot.rolePolicies,adaptivePolicy:boot.adaptivePolicy,
    backgroundRolePolicy:boot.backgroundRolePolicy,decisionMode:boot.decisionMode,
    hostAssistance:boot.hostAssistance,contextBudget:boot.contextBudget,advisor:boot.advisor,
    doctrine:boot.doctrine,hostActions:boot.hostActions,
  });
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (draft && typeof draft === "object" && draft.baseRevision === bootRevision) {
      if (typeof draft.primary === "string") state.primary = draft.primary;
      if (Array.isArray(draft.fallbacks)) state.fallbacks = draft.fallbacks;
      if (draft.rolePolicies) state.rolePolicies = draft.rolePolicies;
      if (draft.adaptivePolicy) state.adaptivePolicy = draft.adaptivePolicy;
      if (draft.backgroundRolePolicy) state.backgroundRolePolicy = draft.backgroundRolePolicy;
      if (draft.decisionMode) state.decisionMode = draft.decisionMode;
      if (draft.hostAssistance) state.hostAssistance = draft.hostAssistance;
      if (Number.isInteger(draft.contextBudget)) state.contextBudget = draft.contextBudget;
      if (draft.advisor) state.advisor = draft.advisor;
      if ("doctrine" in draft) state.doctrine = draft.doctrine;
      if (draft.hostActions) state.hostActions = draft.hostActions;
      if (["strict","adaptive","lenient"].includes(draft.sandboxMode)) state.sandboxMode = draft.sandboxMode;
      if (draft.profile) state.profile = draft.profile;
    } else if (draft) localStorage.removeItem(draftKey);
  } catch {}
  const $ = id => document.getElementById(id);

  function persistDraft() {
    if (state.closed) return;
    localStorage.setItem(draftKey, JSON.stringify({
      baseRevision:bootRevision,
      primary:state.primary,fallbacks:state.fallbacks,rolePolicies:state.rolePolicies,
      adaptivePolicy:state.adaptivePolicy,backgroundRolePolicy:state.backgroundRolePolicy,
      sandboxMode:state.sandboxMode,profile:state.profile,decisionMode:state.decisionMode,
      hostAssistance:state.hostAssistance,contextBudget:state.contextBudget,advisor:state.advisor,
      doctrine:state.doctrine,hostActions:state.hostActions,
    }));
  }
  document.addEventListener("input", persistDraft);
  document.addEventListener("change", persistDraft);

  function initials(name) {
    return String(name || "AI").split(/[\s._-]+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2) || "AI";
  }
  function connection(id) { return state.connections.find(item => item.id === id); }
  function customProvider(id) { return state.customProviders.find(item => item.id === id); }
  function providerProfile(id) { return state.providerProfiles.find(item => item.provider === id); }
  function providerDefinition(id) { return state.providerCatalog.find(item => item.id === id); }
  function endpointKey(provider) {
    try { return new URL(provider.baseUrl).toString().replace(/\/$/, "") + "|" + provider.api; }
    catch { return String(provider.baseUrl).replace(/\/$/, "") + "|" + provider.api; }
  }
  function modelById(id) { return state.models.find(item => item.id === id); }
  function selectedModelIds() {
    const ids = [state.primary, ...state.fallbacks];
    for (const policy of Object.values(state.rolePolicies)) if (Array.isArray(policy.models)) ids.push(...policy.models);
    if (Array.isArray(state.adaptivePolicy.classifierModels)) ids.push(...state.adaptivePolicy.classifierModels);
    return new Set(ids.filter(Boolean));
  }
  function preferredVerifyModel(id) {
    const forProvider = state.models.filter(item => item.provider === id);
    if (!forProvider.length) return null;
    const selected = selectedModelIds();
    return (forProvider.find(item => selected.has(item.id)) || forProvider.find(item => item.available) || forProvider[0]).id;
  }
  function providerName(id) { return connection(id)?.name || state.providerCatalog.find(item => item.id === id)?.name || id; }
  function modelLabel(model) { return model.name === model.model ? model.model : model.name + " - " + model.model; }
  function modelOptionLabel(model) { return modelLabel(model) + (model.available ? "" : " (saved; currently unavailable)"); }
  function savedModelLabel(id) { return "Saved model unavailable - " + id; }
  function addSavedModelOption(select, id) {
    if (id && ![...select.options].some(option => option.value === id)) select.add(new Option(savedModelLabel(id), id));
  }
  function sourceLabel(source) {
    return ({"endpoint":"Endpoint", "pi-catalog":"Pi catalog", "models-dev":"models.dev", "compatibility-default":"Compatibility default", "user":"Custom"})[source] || "Automatic";
  }
  function usableModels() {
    const ready = new Set(state.connections.filter(item => item.ready).map(item => item.id));
    const selected = selectedModelIds();
    return state.models.filter(item => item.available || ready.has(item.provider) || state.credentialDrafts[item.provider] || selected.has(item.id));
  }
  function normalizeSelection() {
    const usable = usableModels();
    if (!state.primary) state.primary = usable[0]?.id || "";
    state.fallbacks = state.fallbacks.filter((value, index, values) =>
      Boolean(value) && value !== state.primary && values.indexOf(value) === index,
    );
  }
  function upsertConnection(value) {
    const index = state.connections.findIndex(item => item.id === value.id);
    if (index >= 0) state.connections[index] = value;
    else state.connections.push(value);
  }
  function upsertModels(models) {
    for (const model of models) {
      const index = state.models.findIndex(item => item.id === model.id);
      if (index >= 0) state.models[index] = model;
      else state.models.push(model);
    }
  }
  function upsertProviderProfile(profile) {
    state.providerProfiles = state.providerProfiles.filter(item => item.id !== profile.id);
    state.providerProfiles.push(profile);
  }
  function browserModels(provider) {
    return provider.models.map(item => ({
      id: provider.id + "/" + item.id,
      provider: provider.id,
      model: item.id,
      name: item.name || item.id,
      available: true,
      reasoning: Boolean(item.reasoning),
      input: item.input || ["text"],
      contextWindow: item.contextWindow || null,
      maxTokens: item.maxTokens || null,
      metadata: {
        contextWindow: item.metadata?.contextWindow || null,
        maxTokens: item.metadata?.maxTokens || null,
      },
    }));
  }

  function renderSteps() {
    document.querySelectorAll("[data-step]").forEach(button => {
      const step = Number(button.dataset.step);
      button.className = step === state.phase ? "active" : step < state.phase ? "complete" : "";
      button.disabled = step > state.phase || step < initialPhase || (setupMode === "full" && step > 1 && usableModels().length === 0);
    });
  }
  function renderConnections() {
    const list = $("connection-list");
    list.replaceChildren();
    const connections = [...state.connections].sort((left, right) => {
      if (left.ready !== right.ready) return left.ready ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    $("connection-empty").hidden = connections.length > 0;
    $("connection-actions").hidden = connections.length === 0;
    $("open-connection").hidden = connections.length === 0;
    for (const item of connections) {
      const profile = providerProfile(item.id);
      const customAuth = item.custom ? state.customProviders.find(provider => provider.id === item.id)?.auth?.method : undefined;
      const authMethod = profile?.auth?.method || customAuth;
      const readiness = profile?.readiness || (item.ready ? "verified" : "blocked");
      const row = document.createElement("div");
      row.className = "connection-row";
      row.innerHTML = '<div class="connection-mark"></div><div><span class="connection-name"></span><span class="connection-meta"></span></div><span class="status-pill"></span><div class="row-actions"></div>';
      row.querySelector(".connection-mark").textContent = initials(item.name);
      row.querySelector(".connection-name").textContent = item.name;
      const protocol = profile?.protocol || profile?.runtimeApi || "Pi managed";
      row.querySelector(".connection-meta").textContent = item.availableModelCount + " models available - " + protocolLabel(protocol) + (item.auth?.label ? " - " + item.auth.label : "");
      row.querySelector(".status-pill").textContent = readiness === "verified" ? "Verified" : readiness === "discovered" ? "Models loaded" : readiness === "configured" ? "Configured" : "Needs attention";
      row.querySelector(".status-pill").classList.add("readiness-" + readiness);
      const actions = row.querySelector(".row-actions");
      const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-button"; edit.textContent = "Edit"; edit.addEventListener("click", () => item.custom ? openCustomEditor(item.id) : openBuiltInEditor(item.id));
      actions.append(edit);
      if (authMethod === "api-key" || authMethod === "oauth" || authMethod === "custom-header") {
        const replace = document.createElement("button"); replace.type = "button"; replace.className = "secondary-button"; replace.textContent = "Replace credential"; replace.addEventListener("click", () => replaceConnectionCredential(item.id, item.custom, authMethod)); actions.append(replace);
      }
      if (state.models.some(model => model.provider === item.id)) {
        const picker = document.createElement("select"); picker.className = "verify-model-select"; picker.setAttribute("aria-label", "Model to verify");
        const preferred = preferredVerifyModel(item.id);
        for (const model of state.models.filter(entry => entry.provider === item.id)) {
          const option = document.createElement("option"); option.value = model.id; option.textContent = model.model; if (model.id === preferred) option.selected = true; picker.append(option);
        }
        actions.append(picker);
        const verify = document.createElement("button"); verify.type = "button"; verify.className = "secondary-button"; verify.textContent = "Verify API"; verify.addEventListener("click", () => verifyConnection(item.id, picker.value)); actions.append(verify);
      }
      if (authMethod === "api-key" || authMethod === "oauth" || authMethod === "custom-header") {
        const signout = document.createElement("button"); signout.type = "button"; signout.className = "secondary-button"; signout.textContent = "Sign out"; signout.addEventListener("click", () => signOutConnection(item.id)); actions.append(signout);
      }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Remove"; remove.addEventListener("click", () => removeConnection(item.id));
      actions.append(remove);
      list.append(row);
    }
  }
  function renderPrimary() {
    normalizeSelection();
    const select = $("primary-model");
    select.replaceChildren();
    const groups = new Map();
    for (const item of usableModels()) {
      if (!groups.has(item.provider)) groups.set(item.provider, []);
      groups.get(item.provider).push(item);
    }
    for (const [provider, models] of groups) {
      const group = document.createElement("optgroup"); group.label = providerName(provider);
      for (const item of models.sort((left, right) => left.name.localeCompare(right.name))) {
        group.append(new Option(modelOptionLabel(item), item.id, false, item.id === state.primary));
      }
      select.append(group);
    }
    addSavedModelOption(select, state.primary);
    select.disabled = usableModels().length === 0 && !state.primary;
    select.value = state.primary;
    renderModelDetails();
  }
  function renderModelDetails() {
    const target = $("model-details"); target.replaceChildren();
    const selected = modelById(state.primary);
    if (!selected) {
      target.textContent = state.primary ? savedModelLabel(state.primary) : "Connect an AI service before choosing a model.";
      return;
    }
    const title = document.createElement("div"); title.className = "model-title"; title.textContent = selected.name;
    const reference = document.createElement("div"); reference.className = "model-reference"; reference.textContent = selected.id;
    const tags = document.createElement("div"); tags.className = "model-tags";
    const values = [];
    if (selected.reasoning) values.push("Reasoning");
    if (selected.input.includes("image")) values.push("Vision");
    values.push(selected.contextWindow ? Math.round(selected.contextWindow / 1000) + "K context" : "Automatic context");
    values.push(selected.maxTokens ? Math.round(selected.maxTokens / 1000) + "K max output" : "Automatic output");
    for (const value of values) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = value; tags.append(tag); }
    target.append(title, reference, tags);
    if (customProvider(selected.provider)) target.append(createModelAdvanced(selected));
  }
  function createModelAdvanced(selected) {
    const details = document.createElement("details"); details.className = "model-advanced";
    const summary = document.createElement("summary"); summary.textContent = "Advanced model limits";
    const grid = document.createElement("div"); grid.className = "limit-grid";
    grid.append(limitInput("Context window", "contextWindow", selected), limitInput("Max output", "maxTokens", selected));
    details.append(summary, grid); return details;
  }
  function limitInput(label, field, selected) {
    const wrap = document.createElement("div"), lab = document.createElement("label"), input = document.createElement("input"), note = document.createElement("span");
    input.id = "model-limit-" + field; lab.htmlFor = input.id; lab.textContent = label; input.type = "number"; input.min = field === "contextWindow" ? "1024" : "1"; input.placeholder = "Automatic"; input.value = selected[field] || "";
    note.className = "source-note"; note.textContent = "Source: " + sourceLabel(selected.metadata?.[field]);
    input.addEventListener("change", () => updateModelLimit(selected, field, input.value));
    wrap.append(lab, input, note); return wrap;
  }
  function updateModelLimit(selected, field, value) {
    const provider = customProvider(selected.provider), configured = provider?.models.find(item => item.id === selected.model);
    if (!configured) return;
    const parsed = value ? Number(value) : null;
    if (parsed && Number.isInteger(parsed) && parsed > 0) {
      configured[field] = parsed; configured.metadata = configured.metadata || {}; configured.metadata[field] = "user";
      selected[field] = parsed; selected.metadata[field] = "user";
    } else {
      delete configured[field]; if (configured.metadata) delete configured.metadata[field]; selected[field] = null; selected.metadata[field] = null;
    }
    renderModelDetails();
  }
  function renderFallbacks() {
    normalizeSelection();
    const target = $("fallback-list"); target.replaceChildren();
    state.fallbacks.forEach((value, index) => {
      const row = document.createElement("div"); row.className = "fallback-row";
      const select = document.createElement("select"); select.setAttribute("aria-label", "Fallback model " + (index + 1));
      for (const item of usableModels().filter(model => model.id !== state.primary && (model.id === value || !state.fallbacks.includes(model.id)))) {
        select.add(new Option(providerName(item.provider) + " / " + modelOptionLabel(item), item.id, false, item.id === value));
      }
      addSavedModelOption(select, value);
      select.value = value; select.addEventListener("change", () => { state.fallbacks[index] = select.value; renderFallbacks(); });
      const up = iconButton("Up", "^", () => { if (index > 0) { [state.fallbacks[index - 1], state.fallbacks[index]] = [state.fallbacks[index], state.fallbacks[index - 1]]; renderFallbacks(); } });
      const down = iconButton("Down", "v", () => { if (index < state.fallbacks.length - 1) { [state.fallbacks[index + 1], state.fallbacks[index]] = [state.fallbacks[index], state.fallbacks[index + 1]]; renderFallbacks(); } });
      const remove = iconButton("Remove fallback", "x", () => { state.fallbacks.splice(index, 1); renderFallbacks(); });
      up.disabled = index === 0; down.disabled = index === state.fallbacks.length - 1;
      row.append(select, up, down, remove); target.append(row);
    });
    $("add-fallback").disabled = usableModels().filter(item => item.id !== state.primary && !state.fallbacks.includes(item.id)).length === 0;
  }
  function iconButton(title, text, handler) {
    const button = document.createElement("button"); button.type = "button"; button.title = title; button.setAttribute("aria-label", title); button.textContent = text; button.addEventListener("click", handler); return button;
  }
  function renderProject() {
    const workspace = boot.workspace || {git:false,disposition:"non-git-existing"};
    $("workspace-state").textContent = workspace.disposition === "git-unborn"
      ? "Git is initialized, but there is no initial commit. Research is available; implementation requires scaffold or adoption first."
      : workspace.git
      ? "Git workspace with a committed HEAD detected. Implementation can use worktree safeguards."
      : workspace.disposition === "non-git-empty"
        ? "This folder is ready for a new scaffold. Configuration does not require Git."
        : "This existing non-Git folder will require inspection and explicit adoption before file changes.";
    $("project-goal").value = state.profile.goal;
    const selectedScope = state.profile.scope === "selected";
    $("scope-all").className = selectedScope ? "" : "active";
    $("scope-selected").className = selectedScope ? "active" : "";
    $("scope-all").setAttribute("aria-checked", String(!selectedScope));
    $("scope-selected").setAttribute("aria-checked", String(selectedScope));

    const directoryOptions = [...new Set([...(boot.directoryOptions || []), ...state.profile.dirs])];
    const directories = $("directory-options"); directories.hidden = !selectedScope || directoryOptions.length === 0; directories.replaceChildren();
    $("directory-empty").hidden = !selectedScope || directoryOptions.length > 0;
    directoryOptions.forEach(value => directories.append(checkRow({
      value,
      label:value,
      checked:state.profile.dirs.includes(value),
      onChange:checked => {
        state.profile.dirs = checked ? [...new Set([...state.profile.dirs, value])] : state.profile.dirs.filter(item => item !== value);
        clearProfileError();
      },
    })));

    const tasks = $("task-options"); tasks.replaceChildren();
    taskTypes.forEach(item => tasks.append(checkRow({
      value:item.value,
      label:item.label,
      description:item.description,
      checked:state.profile.tasks.includes(item.value),
      onChange:checked => {
        state.profile.tasks = checked ? [...new Set([...state.profile.tasks, item.value])] : state.profile.tasks.filter(value => value !== item.value);
        clearProfileError();
      },
    })));
    $("custom-tasks").value = state.profile.customTasks.join(", ");
  }
  function renderRoles() {
    const target = $("role-policy-list"); target.replaceChildren();
    (boot.roles || []).filter(role => !["verifier","classifier"].includes(role.role)).forEach(role => {
      const current = state.rolePolicies[role.role] || {};
      const row = document.createElement("div"); row.className = "role-policy-row";
      const copy = document.createElement("div"), title = document.createElement("h2"), detail = document.createElement("p");
      title.textContent = role.role; detail.textContent = role.taskKinds.join(", ") + " · " + role.executionModes.join(", "); copy.append(title, detail);
      const modelField = document.createElement("label"); modelField.textContent = "Primary model";
      const model = document.createElement("select"); model.add(new Option("Inherit project model chain", ""));
      usableModels().forEach(item => model.add(new Option(providerName(item.provider) + " / " + modelOptionLabel(item), item.id)));
      const selectedRoleModel = current.models?.[0] || ""; addSavedModelOption(model, selectedRoleModel); model.value = selectedRoleModel;
      model.addEventListener("change", () => {
        state.rolePolicies[role.role] ||= {};
        if (!model.value) delete state.rolePolicies[role.role].models;
        else state.rolePolicies[role.role].models = [model.value, ...state.fallbacks.filter(item => item !== model.value)];
      }); modelField.append(model);
      const thinkingField = document.createElement("label"); thinkingField.textContent = "Thinking";
      const thinking = document.createElement("select"); ["off","minimal","low","medium","high","xhigh","max"].forEach(level => thinking.add(new Option(level, level)));
      thinking.value = current.thinkingLevel || role.thinkingLevel;
      thinking.addEventListener("change", () => { state.rolePolicies[role.role] ||= {}; state.rolePolicies[role.role].thinkingLevel = thinking.value; }); thinkingField.append(thinking);
      const attemptsField = document.createElement("label"); attemptsField.textContent = "Attempts";
      const attempts = document.createElement("select"); attempts.add(new Option("1", "1")); attempts.add(new Option("2", "2")); attempts.value = String(current.maxAttempts || role.maxAttempts || 2);
      attempts.addEventListener("change", () => { state.rolePolicies[role.role] ||= {}; state.rolePolicies[role.role].maxAttempts = Number(attempts.value); }); attemptsField.append(attempts);
      row.append(copy, modelField, thinkingField, attemptsField); target.append(row);
    });
  }
  function renderSafety() {
    ["strict","adaptive","lenient"].forEach(mode => {
      const button = $("sandbox-" + mode); button.className = state.sandboxMode === mode ? "active" : "";
      button.setAttribute("aria-checked", String(state.sandboxMode === mode)); button.disabled = mode !== "strict" && !boot.sandboxAvailability.available;
    });
    $("sandbox-backend").textContent = boot.sandboxAvailability.available ? "Available through " + boot.sandboxAvailability.label + "." : boot.sandboxAvailability.reason;
    $("adaptive-settings").hidden = state.sandboxMode !== "adaptive";
    $("sandbox-warning").hidden = state.sandboxMode === "strict";
    $("sandbox-warning").textContent = state.sandboxMode === "lenient"
      ? "Lenient permits outbound network access. Project source visible to the worker may be sent to external services."
      : "Adaptive sends limited action context to the selected classifier provider and pauses high-risk bounded actions for approval.";
    const classifier = $("classifier-models"); classifier.replaceChildren();
    usableModels().forEach(item => classifier.append(checkRow({
      value:item.id,label:providerName(item.provider) + " / " + modelOptionLabel(item),checked:state.adaptivePolicy.classifierModels.includes(item.id),
      onChange:checked => { state.adaptivePolicy.classifierModels = checked ? [...new Set([...state.adaptivePolicy.classifierModels,item.id])] : state.adaptivePolicy.classifierModels.filter(value => value !== item.id); },
    })));
    state.adaptivePolicy.classifierModels.filter(id => !modelById(id)).forEach(id => classifier.append(checkRow({
      value:id,label:savedModelLabel(id),checked:true,
      onChange:checked => { if (!checked) state.adaptivePolicy.classifierModels = state.adaptivePolicy.classifierModels.filter(value => value !== id); },
    })));
    $("classifier-thinking").value = state.adaptivePolicy.classifierThinkingLevel;
    const wait = state.adaptivePolicy.approvalPolicy === "wait";
    $("approval-deny").className = wait ? "" : "active"; $("approval-wait").className = wait ? "active" : "";
    $("approval-deny").setAttribute("aria-checked", String(!wait)); $("approval-wait").setAttribute("aria-checked", String(wait));
    $("trusted-domains").value = state.adaptivePolicy.trustedDomains.join("\n");
    $("policy-diagnostics").checked = Boolean(state.adaptivePolicy.diagnostics);
    if (document.activeElement !== $("policy-rules")) $("policy-rules").value = JSON.stringify(state.adaptivePolicy.rules || [], null, 2);
    $("background-mechanical").checked = Boolean(state.backgroundRolePolicy.mechanicalExecutor);
    $("decision-mode").value = state.decisionMode;
    $("decision-doctrine").checked = state.doctrine === "first-principles-qds-v1";
    $("host-assistance-mode").value = state.hostAssistance.mode;
    $("host-review-mode").value = state.hostAssistance.reviewMode || "user-only";
    $("host-auto-scope").value = state.hostAssistance.autoApprovalScope || "context-only";
    $("host-auto-discovery-gates").checked = state.hostAssistance.autoApproveDiscoveryGates === true;
    const hostClasses = $("host-context-classes"); hostClasses.replaceChildren();
    [["workspace","Workspace files"],["web","Public Web"],["docs","SDK/API docs"],["paper","Papers"],["connector","Private connector"],["skill","Installed skill"]].forEach(([value,label]) => hostClasses.append(checkRow({
      value,label,checked:state.hostAssistance.contextClasses.includes(value),
      onChange:checked => { state.hostAssistance.contextClasses = checked ? [...new Set([...state.hostAssistance.contextClasses,value])] : state.hostAssistance.contextClasses.filter(item => item !== value); },
    })));
    $("context-budget").value = String(state.contextBudget);
    $("host-max-requests").value = String(state.hostAssistance.maxRequests);
    $("host-max-fanout").value = String(state.hostAssistance.maxFanOut);
    $("private-connector").value = state.hostAssistance.privateConnector;
    $("advisor-enabled").checked = Boolean(state.advisor.enabled);
    const advisorTargets = $("advisor-targets"); advisorTargets.replaceChildren();
    ["ask","review","plan","implement","orchestrate","scaffold","setup","discover"].forEach(value => advisorTargets.append(checkRow({
      value,label:value,checked:state.advisor.targets.includes(value),
      onChange:checked => { state.advisor.targets = checked ? [...new Set([...state.advisor.targets,value])] : state.advisor.targets.filter(item => item !== value); },
    })));
    $("advisor-max-requests").value = String(state.advisor.maxRequests);
    $("advisor-max-perspectives").value = String(state.advisor.maxPerspectives);
    $("host-actions-enabled").checked = Boolean(state.hostActions.enabled);
    const actionClasses = $("host-action-classes"); actionClasses.replaceChildren();
    [["local-mutation","Local mutation"],["draft","Draft"],["remote-write","Remote write"],["message","Message"],["deploy","Deploy"],["transaction","Transaction"]].forEach(([value,label]) => actionClasses.append(checkRow({
      value,label,checked:state.hostActions.allowedActionClasses.includes(value),
      onChange:checked => { state.hostActions.allowedActionClasses = checked ? [...new Set([...state.hostActions.allowedActionClasses,value])] : state.hostActions.allowedActionClasses.filter(item => item !== value); },
    })));
    $("host-actions-remote").checked = Boolean(state.hostActions.remoteActionsEnabled);
    $("host-action-max-uses").value = String(state.hostActions.maxUses);
    $("host-action-max-cost").value = String(state.hostActions.maxCost);
    $("host-action-ttl").value = String(Math.round(state.hostActions.ttlMs / 60000));
  }
  function validateSafety() {
    let message = "";
    if (state.sandboxMode !== "strict" && !boot.sandboxAvailability.available) message = boot.sandboxAvailability.reason || "Sandbox backend is unavailable.";
    else if (state.sandboxMode === "adaptive" && state.adaptivePolicy.classifierModels.length === 0) message = "Choose at least one classifier model for Adaptive mode.";
    else if (state.hostAssistance.mode !== "off" && state.hostAssistance.maxFanOut > state.hostAssistance.maxRequests) message = "Host Assistance fan-out cannot exceed its request limit.";
    else if (state.advisor.enabled && (state.advisor.maxRequests < 1 || state.advisor.maxPerspectives < 1)) message = "Enabled Advisor requires at least one consultation and perspective.";
    else if (state.hostActions.remoteActionsEnabled && !state.hostActions.allowedActionClasses.some(value => ["remote-write","message","deploy","transaction"].includes(value))) message = "Remote Host Actions require at least one remote action class.";
    if (!message) {
      try {
        const rules = JSON.parse($("policy-rules").value || "[]");
        if (!Array.isArray(rules)) throw new Error();
        state.adaptivePolicy.rules = rules;
      } catch { message = "Structured policy rules must be a JSON array."; }
    }
    $("safety-error").hidden = !message; $("safety-error").textContent = message; return !message;
  }
  function checkRow({value,label,description,checked,onChange}) {
    const row = document.createElement("label"), input = document.createElement("input"), copy = document.createElement("span");
    row.className = "check-row"; input.type = "checkbox"; input.value = value; input.checked = checked;
    const title = document.createElement("span"); title.textContent = label; copy.append(title);
    if (description) { const detail = document.createElement("small"); detail.textContent = description; copy.append(detail); }
    input.addEventListener("change", () => onChange(input.checked)); row.append(input, copy); return row;
  }
  function projectProfile() {
    return {
      goal: state.profile.goal,
      ...(state.profile.scope === "selected" ? {dirs:[...state.profile.dirs]} : {}),
      tasks: [...new Set([...state.profile.tasks, ...state.profile.customTasks])],
    };
  }
  function validateProject() {
    const profile = projectProfile(), error = $("profile-error");
    let message = "";
    if (!profile.goal.trim()) message = "Add a project goal before continuing.";
    else if (state.profile.scope === "selected" && profile.dirs.length === 0) message = "Choose at least one project folder, or use Whole project.";
    else if (profile.tasks.length === 0) message = "Choose at least one type of delegated work.";
    error.hidden = !message; error.textContent = message;
    if (message) { $("project-screen").scrollIntoView({behavior:"smooth",block:"start"}); return false; }
    return true;
  }
  function clearProfileError() { $("profile-error").hidden = true; $("profile-error").textContent = ""; }
  function renderReview() {
    const primary = modelById(state.primary);
    $("review-primary").textContent = primary ? providerName(primary.provider) + " / " + modelLabel(primary) : "No primary model";
    const fallbacks = $("review-fallbacks"); fallbacks.replaceChildren();
    if (state.fallbacks.length === 0) fallbacks.textContent = "No fallback models";
    state.fallbacks.forEach((id, index) => { const item = modelById(id), row = document.createElement("div"); row.className = "review-item"; row.textContent = (index + 1) + ". " + (item ? providerName(item.provider) + " / " + modelLabel(item) : id); fallbacks.append(row); });
    const connections = $("review-connections"); connections.replaceChildren();
    state.connections.forEach(item => { const profile = providerProfile(item.id), definition = providerDefinition(item.id), row = document.createElement("div"); row.className = "review-item"; row.textContent = item.name + " - " + protocolLabel(profile?.protocol || profile?.runtimeApi) + " - " + authLabel(profile?.auth?.method) + " - " + modelSourceLabel(definition?.modelSource || (item.custom ? "manual" : "pi-catalog")) + " - " + (profile?.readiness || (item.ready ? "verified" : "blocked")); connections.append(row); });
    $("review-title").textContent = setupMode === "project" ? "Review project setup" : "Review setup";
    document.querySelectorAll(".full-only").forEach(element => element.hidden = setupMode === "project");
    const profile = projectProfile(); $("review-goal").textContent = profile.goal;
    const directories = $("review-directories"); directories.replaceChildren();
    if (profile.dirs === undefined) directories.textContent = "Whole project";
    (profile.dirs || []).forEach(value => { const row = document.createElement("div"); row.className = "review-item"; row.textContent = value; directories.append(row); });
    const tasks = $("review-tasks"); tasks.replaceChildren();
    profile.tasks.forEach(value => { const known = taskTypes.find(item => item.value === value), row = document.createElement("div"); row.className = "review-item"; row.textContent = known?.label || value; tasks.append(row); });
    $("review-sandbox").textContent = state.sandboxMode === "lenient"
      ? "Lenient - sandboxed shell and outbound network enabled"
      : state.sandboxMode === "adaptive"
        ? "Adaptive - classified capabilities with " + state.adaptivePolicy.approvalPolicy + " fallback"
        : "Strict - scoped Pi tools only";
    const workflow = $("review-workflow"); workflow.replaceChildren();
    [
      "Decision mode: " + state.decisionMode,
      "Host Assistance: " + state.hostAssistance.mode + " · " + (state.hostAssistance.reviewMode || "user-only") + " · ceiling " + (state.hostAssistance.autoApprovalScope || "context-only") + " · Discovery gates " + (state.hostAssistance.autoApproveDiscoveryGates ? "Host-review" : "user") + " · budget " + state.contextBudget + " · requests " + state.hostAssistance.maxRequests + " · fan-out " + state.hostAssistance.maxFanOut,
      "Advisor: " + (state.advisor.enabled ? "on for " + state.advisor.targets.join(", ") : "off"),
      "Doctrine: " + (state.doctrine || "off"),
      "Host Actions: " + (state.hostActions.enabled ? "isolated · " + state.hostActions.allowedActionClasses.join(", ") + (state.hostActions.remoteActionsEnabled ? " · remote enabled" : " · remote disabled") : "off"),
    ].forEach(value => { const row = document.createElement("div"); row.className = "review-item"; row.textContent = value; workflow.append(row); });
    const roleReview = $("review-roles"); roleReview.replaceChildren();
    (boot.roles || []).filter(role => !["verifier","classifier"].includes(role.role)).forEach(role => {
      const policy = state.rolePolicies[role.role] || {}, row = document.createElement("div"); row.className = "review-item";
      row.textContent = role.role + " · " + (policy.thinkingLevel || role.thinkingLevel) + " · " + (policy.models?.[0] || "project model chain"); roleReview.append(row);
    });
  }
  function render() {
    $("full-steps").hidden = setupMode !== "full"; $("project-steps").hidden = setupMode !== "project";
    renderSteps(); renderConnections(); renderPrimary(); renderFallbacks(); renderRoles(); renderSafety(); renderProject(); renderReview();
    $("connections-screen").hidden = state.phase !== 1; $("models-screen").hidden = state.phase !== 2; $("roles-screen").hidden = state.phase !== 3; $("safety-screen").hidden = state.phase !== 4; $("project-screen").hidden = state.phase !== 5; $("review-screen").hidden = state.phase !== 6;
    $("cancel-button").hidden = state.phase !== initialPhase; $("back-button").hidden = state.phase === initialPhase; $("next-button").hidden = state.phase === 6; $("save-button").hidden = state.phase !== 6;
    $("next-button").textContent = state.phase === 1 ? "Choose models" : state.phase === 2 ? "Configure roles" : state.phase === 3 ? "Execution safety" : state.phase === 4 ? "Workspace" : "Review";
    $("next-button").disabled = setupMode === "full" && ((usableModels().length === 0 && !state.primary) || (state.phase === 2 && !state.primary));
    $("save-button").textContent = setupMode === "project" ? "Save project setup" : "Save configuration";
    const warning = $("registry-warning"); warning.hidden = !boot.registryError; warning.textContent = boot.registryError ? "Pi model registry: " + boot.registryError : "";
    persistDraft();
  }
  function setPhase(phase) { if (setupMode === "full" && phase > 1 && usableModels().length === 0 && !state.primary) return; state.phase = phase; render(); window.scrollTo({top: 0, behavior: "smooth"}); }

  function protocolLabel(value) {
    return ({
      "openai-chat-completions":"OpenAI Chat Completions",
      "openai-completions":"OpenAI Chat Completions",
      "openai-responses":"OpenAI Responses",
      "openai-codex-responses":"OpenAI Responses (ChatGPT subscription)",
      "anthropic-messages":"Anthropic Messages",
      "google-generative-ai":"Google Generative AI",
      "azure-openai-responses":"Azure OpenAI Responses",
      "bedrock-converse-stream":"Amazon Bedrock Converse",
      "google-vertex":"Google Vertex AI",
      "mistral-conversations":"Mistral Conversations",
      "managed-per-model":"Managed per model",
    })[value] || value || "Pi managed adapter";
  }
  function authLabel(value) {
    return ({"api-key":"API key","oauth":"Subscription OAuth","ambient":"Ambient cloud identity","none":"No authentication","custom-header":"API key plus secret header"})[value] || value || "Pi credential";
  }
  function modelSourceLabel(value) {
    return ({"pi-catalog":"Pi model catalog","openai-models":"OpenAI model discovery","anthropic-models":"Anthropic model discovery","google-models":"Google model discovery","manual":"Manual models"})[value] || value || "Pi model catalog";
  }
  function populateProviderCatalog(filter) {
    const select = $("cloud-provider"), current = select.value, query = String(filter || "").trim().toLowerCase();
    const categories = [{id:"common",label:"Common"},{id:"subscription",label:"Subscription"},{id:"cloud",label:"Cloud"},{id:"local",label:"Local"}];
    select.replaceChildren();
    categories.forEach(category => {
      const items = state.providerCatalog.filter(item => item.id !== "custom" && item.category === category.id && (!query || item.name.toLowerCase().includes(query) || item.id.includes(query)));
      if (!items.length) return;
      const group = document.createElement("optgroup"); group.label = category.label;
      items.sort((left,right) => left.name.localeCompare(right.name)).forEach(item => group.append(new Option(item.name, item.id)));
      select.append(group);
    });
    if (select.options.length === 0) {
      const empty = new Option("No matching services", ""); empty.disabled = true; empty.selected = true; select.add(empty);
    }
    if (current && [...select.options].some(option => option.value === current)) select.value = current;
    renderProviderForm();
  }
  function openDialog(mode) {
    state.dialogMode = mode; state.customDraft = null; state.customProfileDraft = null; state.editingCustomIndex = -1; state.customPendingProvider = null; state.oauthSession = null; state.oauthOpenedUrl = "";
    $("dialog-title").textContent = "Add a connection"; $("provider-search").value = ""; $("endpoint-key").value = ""; $("endpoint-url").value = ""; $("models-endpoint").value = ""; $("custom-http-referer").value = ""; $("custom-app-title").value = ""; $("custom-anthropic-beta").value = ""; $("manual-model-ids").value = ""; $("dialog-status").textContent = "";
    renderDialog(); $("connection-dialog").showModal();
  }
  function openBuiltInEditor(id) {
    state.dialogMode = "cloud"; state.oauthSession = null; state.oauthOpenedUrl = "";
    $("dialog-title").textContent = "Edit connection"; $("provider-search").value = "";
    populateProviderCatalog(""); $("cloud-provider").value = id; renderProviderForm();
    $("dialog-status").textContent = ""; $("connection-dialog").showModal();
  }
  function openCustomEditor(id) {
    const index = state.customProviders.findIndex(item => item.id === id); if (index < 0) return;
    state.dialogMode = "custom"; state.editingCustomIndex = index; state.customDraft = structuredClone(state.customProviders[index]); state.customProfileDraft = structuredClone(providerProfile(id)); state.customPendingProvider = id;
    const auth = state.customDraft.auth || {method:state.customDraft.requiresApiKey?"api-key":"none"};
    const literalHeaders = Object.fromEntries((state.customDraft.headers || []).filter(header => header.value).map(header => [header.name,header.value]));
    $("dialog-title").textContent = "Edit connection"; $("endpoint-url").value = state.customDraft.baseUrl; $("endpoint-protocol").value = state.customDraft.wireProtocol || "openai-chat-completions"; $("endpoint-auth-method").value = auth.method; $("endpoint-header").value = auth.headerName || "authorization"; $("endpoint-key").value = ""; $("models-endpoint").value = state.customDraft.modelsEndpoint || ""; $("custom-http-referer").value = literalHeaders["http-referer"] || ""; $("custom-app-title").value = literalHeaders["x-title"] || ""; $("custom-anthropic-beta").value = literalHeaders["anthropic-beta"] || ""; $("dialog-status").textContent = "";
    renderDialog(); $("connection-dialog").showModal();
  }
  function replaceConnectionCredential(id, custom, authMethod) {
    if (custom) openCustomEditor(id); else openBuiltInEditor(id);
    const target = custom ? $("endpoint-key") : authMethod === "oauth" ? $("start-oauth") : $("provider-field-apiKey");
    if (target) target.focus();
  }
  function renderDialog() {
    const cloud = state.dialogMode === "cloud";
    $("cloud-panel").hidden = !cloud; $("custom-panel").hidden = cloud; $("cloud-tab").className = cloud ? "active" : ""; $("custom-tab").className = cloud ? "" : "active";
    $("cloud-tab").setAttribute("aria-selected", String(cloud)); $("custom-tab").setAttribute("aria-selected", String(!cloud));
    if (cloud) renderProviderForm(); else { renderCustomAuth(); renderCustomDraft(); }
  }
  function renderProviderForm() {
    const definition = providerDefinition($("cloud-provider").value);
    if (!definition) {
      $("provider-protocol").textContent = "No matching services."; $("provider-auth-method").replaceChildren(); $("provider-fields").replaceChildren(); $("oauth-panel").hidden = true; $("connect-cloud").disabled = true; return;
    }
    if ($("cloud-provider").value !== definition.id) $("cloud-provider").value = definition.id;
    const saved = providerProfile(definition.id), auth = $("provider-auth-method"), previous = auth.value;
    auth.replaceChildren(); definition.authMethods.forEach(method => auth.add(new Option(({"api-key":"API key","oauth":"Subscription OAuth","ambient":"Ambient cloud identity","none":"No authentication"})[method] || method, method)));
    auth.value = definition.authMethods.includes(previous) ? previous : saved?.auth?.method || definition.defaultAuthMethod;
    $("provider-protocol").textContent = "Protocol: " + protocolLabel(definition.wireProtocol || (definition.protocolMode === "managed-per-model" ? "managed-per-model" : definition.runtimeApis[0])) + (definition.auth?.configured ? " - Identity detected" + (definition.auth.label ? ": " + definition.auth.label : "") : "");
    const target = $("provider-fields"); target.replaceChildren(); (definition.notes || []).forEach(message => { const note = document.createElement("div"); note.className = "notice warning"; note.textContent = message; target.append(note); }); const advanced = document.createElement("details"), advancedSummary = document.createElement("summary"), advancedBody = document.createElement("div"); advanced.className = "advanced"; advancedSummary.textContent = "Advanced provider settings"; advancedBody.className = "advanced-body"; advanced.append(advancedSummary,advancedBody);
    const values = state.providerFieldValues[definition.id] || saved?.settings || {};
    definition.fields.forEach(field => {
      const visible = (!field.visibleWhen || field.visibleWhen.field !== "authMethod" || field.visibleWhen.equals === auth.value) && (!field.secret || auth.value === "api-key");
      if (!visible) return;
      const wrap = document.createElement("div"), label = document.createElement("label"), input = field.type === "select" ? document.createElement("select") : document.createElement("input");
      wrap.className = "provider-field"; input.id = "provider-field-" + field.id; label.htmlFor = input.id; label.textContent = field.label + (field.required ? "" : " (optional)");
      if (field.type === "select") (field.options || []).forEach(option => input.add(new Option(option.label, option.value)));
      else { input.type = field.type === "secret" ? "password" : field.type === "url" ? "url" : "text"; input.placeholder = field.secret && (definition.auth?.configured || saved) ? "Leave blank to keep the saved credential" : field.placeholder || ""; if (field.secret) { input.autocomplete = "new-password"; input.spellcheck = false; } }
      if (!field.secret) input.value = values[field.id] || "";
      wrap.append(label, input); if (field.help) { const help = document.createElement("span"); help.className = "field-hint"; help.textContent = field.help; wrap.append(help); } (field.advanced ? advancedBody : target).append(wrap);
    });
    if (advancedBody.children.length) target.append(advanced);
    const oauth = auth.value === "oauth"; $("oauth-panel").hidden = !oauth; $("start-oauth").textContent = definition.id === "openai-codex" ? "Sign in with ChatGPT" : "Sign in";
    renderOAuthSession();
  }
  function syncProviderConnectButton() {
    const definition = providerDefinition($("cloud-provider").value), authMethod = $("provider-auth-method").value, button = $("connect-cloud");
    if (!definition) { button.disabled = true; return; }
    const oauth = authMethod === "oauth", credentialReady = Boolean(state.credentialDrafts[definition.id] || definition.auth?.configured);
    button.textContent = oauth ? "Use signed-in account" : "Connect";
    button.disabled = oauth && !credentialReady;
    button.title = oauth && !credentialReady ? "Sign in before using this connection" : "";
  }
  function readProviderFields() {
    const definition = providerDefinition($("cloud-provider").value), values = {};
    (definition?.fields || []).forEach(field => { const input = $("provider-field-" + field.id); if (input) values[field.id] = input.value; });
    return values;
  }
  async function connectBuiltIn(closeOnSuccess) {
    const provider = $("cloud-provider").value, authMethod = $("provider-auth-method").value, status = $("dialog-status");
    const draft = state.credentialDrafts[provider]; status.className = "dialog-status"; status.textContent = "Preparing connection...";
    const preview = await post("/api/providers/connect", {provider,authMethod,fields:readProviderFields(),credentialDraftId:draft?.id});
    if (preview.credentialDraft) state.credentialDrafts[provider] = preview.credentialDraft;
    state.providerFieldValues[provider] = structuredClone(preview.profile.settings || {}); upsertProviderProfile(preview.profile); upsertConnection(preview.provider); upsertModels(preview.models); normalizeSelection();
    document.querySelectorAll('#provider-fields input[type="password"]').forEach(input => { input.value = ""; });
    if (closeOnSuccess && $("connection-dialog").open) $("connection-dialog").close();
    status.textContent = "Connection configured."; render();
  }
  async function startOAuth() {
    const provider = $("cloud-provider").value, preferredMethod = $("oauth-login-method").value, button = $("start-oauth");
    setBusy(button,true,"Starting sign-in..."); state.oauthWindow = preferredMethod === "browser" ? window.open("about:blank", "swarm-pi-oauth") : null;
    try { state.oauthSession = await post("/api/oauth/start", {provider,preferredMethod}); renderOAuthSession(); void pollOAuth(); }
    catch (error) { if (state.oauthWindow) state.oauthWindow.close(); $("oauth-status").textContent = error.message; }
    finally { setBusy(button,false); button.textContent = provider === "openai-codex" ? "Sign in with ChatGPT" : "Sign in"; }
  }
  async function pollOAuth() {
    while (state.oauthSession && ["running","awaiting-input"].includes(state.oauthSession.status)) {
      try { state.oauthSession = await post("/api/oauth/status", {sessionId:state.oauthSession.id,afterRevision:state.oauthSession.revision,waitTimeoutMs:20000}); renderOAuthSession(); }
      catch (error) { $("oauth-status").textContent = error.message; return; }
    }
  }
  function renderOAuthSession() {
    const session = state.oauthSession, status = $("oauth-status"), challenge = $("oauth-challenge"); challenge.replaceChildren(); challenge.hidden = true;
    if (!session) { status.textContent = ""; syncProviderConnectButton(); return; }
    if (session.notice?.type === "auth-url") {
      status.textContent = session.notice.instructions || "Complete sign-in in the browser.";
      const link = document.createElement("a"); link.href = session.notice.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open sign-in page"; challenge.append(link); challenge.hidden = false;
      if (state.oauthWindow && state.oauthOpenedUrl !== session.notice.url) { state.oauthWindow.location.href = session.notice.url; state.oauthOpenedUrl = session.notice.url; }
    } else if (session.notice?.type === "device-code") {
      status.textContent = "Enter code " + session.notice.userCode;
      const code = document.createElement("strong"); code.textContent = session.notice.userCode; const link = document.createElement("a"); link.href = session.notice.verificationUri; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open verification page"; challenge.append(code,link); challenge.hidden = false;
    } else if (session.notice?.type === "progress") status.textContent = session.notice.message;
    else status.textContent = session.status === "completed" ? "Sign-in complete." : session.status === "failed" ? session.error || "Sign-in failed." : session.status === "cancelled" ? "Sign-in cancelled." : "Waiting for the provider...";
    if (session.challenge) {
      challenge.hidden = false; const message = document.createElement("span"); message.textContent = session.challenge.message; let input;
      if (session.challenge.type === "select") { input = document.createElement("select"); session.challenge.options.forEach(option => input.add(new Option(option.label,option.id))); }
      else { input = document.createElement("input"); input.type = "text"; input.placeholder = session.challenge.placeholder || ""; }
      const submit = document.createElement("button"); submit.type = "button"; submit.className = "primary-button"; submit.textContent = "Continue"; submit.addEventListener("click", async () => { try { state.oauthSession = await post("/api/oauth/respond", {sessionId:session.id,challengeId:session.challenge.id,value:input.value}); renderOAuthSession(); void pollOAuth(); } catch (error) { status.textContent = error.message; } }); challenge.append(message,input,submit);
    }
    if (session.credentialDraft) state.credentialDrafts[session.provider] = session.credentialDraft;
    syncProviderConnectButton();
  }
  function renderCustomAuth() {
    const method = $("endpoint-auth-method").value; $("endpoint-header-wrap").hidden = method !== "custom-header"; $("endpoint-key-wrap").hidden = method === "none";
    $("endpoint-key").placeholder = state.editingCustomIndex >= 0 ? "Leave blank to keep the saved credential" : "Enter a credential";
  }
  async function prepareCustomCredential() {
    const baseUrl = $("endpoint-url").value, protocol = $("endpoint-protocol").value, authMethod = $("endpoint-auth-method").value, secret = $("endpoint-key").value, existingProvider = state.editingCustomIndex >= 0 ? state.customProviders[state.editingCustomIndex].id : undefined;
    if (authMethod !== "none" && !secret) {
      if (state.customPendingProvider) return {provider:state.customPendingProvider,credentialDraft:state.credentialDrafts[state.customPendingProvider]};
      if (existingProvider) return {provider:existingProvider,credentialDraft:state.credentialDrafts[existingProvider]};
      throw new Error("Enter the credential before loading models.");
    }
    const staged = await post("/api/providers/custom/credential", {baseUrl,protocol,authMethod,secret,headerName:$("endpoint-header").value,existingProvider});
    state.customPendingProvider = staged.provider; if (staged.credentialDraft) state.credentialDrafts[staged.provider] = staged.credentialDraft; $("endpoint-key").value = ""; return staged;
  }
  async function loadCustomModels(manual) {
    const status = $("dialog-status"), protocol = $("endpoint-protocol").value, authMethod = $("endpoint-auth-method").value; status.className = "dialog-status"; status.textContent = manual ? "Preparing manual models..." : "Loading models...";
    const staged = await prepareCustomCredential();
    const common = {baseUrl:$("endpoint-url").value,protocol,modelsEndpoint:$("models-endpoint").value,authMethod,headerName:$("endpoint-header").value,existingProvider:state.editingCustomIndex >= 0 ? state.customProviders[state.editingCustomIndex].id : undefined};
    const result = manual
      ? await post("/api/providers/custom/manual", {...common,name:$("endpoint-name").value,modelIds:$("manual-model-ids").value.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean)})
      : await post("/api/providers/discover", {...common,provider:staged.provider,credentialDraftId:staged.credentialDraft?.id,reservedProviderIds:state.customProviders.filter((_,index) => index !== state.editingCustomIndex).map(item => item.id)});
    const literals = customLiteralHeaders(), secretHeaders = (result.provider.headers || []).filter(header => header.secretRef);
    result.provider.headers = [...secretHeaders,...literals]; result.profile.headers = structuredClone(result.provider.headers);
    state.customDraft = result.provider; state.customProfileDraft = result.profile; status.textContent = manual ? "Manual models are ready." : "Models loaded. Verify API separately when ready."; renderCustomDraft();
  }
  function customLiteralHeaders() {
    return [
      {name:"http-referer",value:$("custom-http-referer").value.trim()},
      {name:"x-title",value:$("custom-app-title").value.trim()},
      {name:"anthropic-beta",value:$("custom-anthropic-beta").value.trim()},
    ].filter(header => header.value);
  }
  function renderCustomDraft() {
    const draft = state.customDraft, result = $("discovery-result"), advanced = $("advanced-connection"), accept = $("accept-endpoint");
    result.hidden = !draft; advanced.hidden = !draft; accept.hidden = !draft;
    if (!draft) return;
    result.replaceChildren(); const title = document.createElement("strong"); title.textContent = draft.name; const detail = document.createElement("span"); detail.textContent = draft.models.length + " models - " + (state.customProfileDraft?.readiness || "configured"); result.append(title, detail);
    $("endpoint-name").value = draft.name; $("endpoint-canonical-url").value = draft.baseUrl; $("endpoint-api").value = draft.api;
    accept.textContent = state.editingCustomIndex >= 0 ? "Save connection" : "Add connection";
    const models = $("advanced-models"); models.replaceChildren();
    draft.models.forEach((item, index) => {
      const details = document.createElement("details"); details.className = "model-editor"; const summary = document.createElement("summary"); summary.textContent = item.name || item.id; const body = document.createElement("div"); body.className = "model-editor-body"; const id = document.createElement("div"); id.className = "model-id"; id.textContent = item.id;
      body.append(id, draftLimitInput(item,index,"contextWindow","Context window"), draftLimitInput(item,index,"maxTokens","Max output")); details.append(summary,body); models.append(details);
    });
  }
  function draftLimitInput(item, index, field, label) {
    const wrap = document.createElement("div"), lab = document.createElement("label"), input = document.createElement("input"), note = document.createElement("span"); input.id = "draft-limit-" + index + "-" + field; lab.htmlFor = input.id; lab.textContent = label; input.type = "number"; input.placeholder = "Automatic"; input.value = item[field] || ""; note.className = "source-note"; note.textContent = "Source: " + sourceLabel(item.metadata?.[field]);
    input.addEventListener("change", () => { const current = state.customDraft.models[index], value = input.value ? Number(input.value) : null; current.metadata = current.metadata || {}; if (value && Number.isInteger(value) && value > 0) { current[field] = value; current.metadata[field] = "user"; } else { delete current[field]; delete current.metadata[field]; } renderCustomDraft(); }); wrap.append(lab,input,note); return wrap;
  }
  function syncDraftFields() { if (!state.customDraft) return; state.customDraft.name = $("endpoint-name").value.trim() || state.customDraft.name; state.customDraft.baseUrl = $("endpoint-canonical-url").value.trim(); if (state.customProfileDraft) state.customProfileDraft.name = state.customDraft.name; }
  function acceptCustom(provider, profile) {
    const matchingIndex = state.editingCustomIndex >= 0 ? state.editingCustomIndex : state.customProviders.findIndex(item => endpointKey(item) === endpointKey(provider)); const oldId = matchingIndex >= 0 ? state.customProviders[matchingIndex].id : null;
    if (matchingIndex >= 0) state.customProviders[matchingIndex] = provider; else state.customProviders.push(provider); if (oldId && oldId !== provider.id) { state.models = state.models.filter(item => item.provider !== oldId); state.providerProfiles = state.providerProfiles.filter(item => item.provider !== oldId); delete state.credentialDrafts[oldId]; }
    upsertProviderProfile(profile); upsertModels(browserModels(provider)); upsertConnection({id:provider.id,name:provider.name,ready:true,modelCount:provider.models.length,availableModelCount:provider.models.length,auth:{source:state.credentialDrafts[provider.id]?"runtime":provider.requiresApiKey?"stored":"local",label:state.credentialDrafts[provider.id]?"Credential pending save":provider.requiresApiKey?"Pi credential store":"No credential"},selection:null,custom:true}); normalizeSelection(); if ($("connection-dialog").open) $("connection-dialog").close(); render();
  }
  function removeConnection(id) {
    const item = connection(id); if (!item || !confirm("Remove " + item.name + " from this project?")) return; state.customProviders = state.customProviders.filter(provider => provider.id !== id); state.providerProfiles = state.providerProfiles.filter(profile => profile.provider !== id); state.connections = state.connections.filter(connection => connection.id !== id); state.models = state.models.filter(model => model.provider !== id); delete state.credentialDrafts[id]; if (state.primary.startsWith(id + "/")) state.primary = ""; state.fallbacks = state.fallbacks.filter(model => !model.startsWith(id + "/")); render();
  }
  async function verifyConnection(id, chosenModelId) {
    const status = $("connection-status"); const targetId = chosenModelId || preferredVerifyModel(id); const model = targetId ? modelById(targetId) : null; if (!model) { status.textContent = "No model is available to verify."; return; }
    status.className = "inline-status";
    status.textContent = "Verifying " + model.id + " with a minimal request...";
    try { const result = await post("/api/providers/verify", {model:model.id,customProviders:state.customProviders,providerProfiles:state.providerProfiles,credentialDrafts:Object.values(state.credentialDrafts).map(draft => ({provider:draft.provider,draftId:draft.id}))}); upsertProviderProfile(result.profile); const item = connection(id); if (item) item.ready = true; status.textContent = "API verified for " + model.id + "."; render(); }
    catch (error) { status.className = "inline-status error"; status.textContent = error.message; }
  }
  async function signOutConnection(id) {
    const item = connection(id); if (!item || !confirm("Sign out of " + item.name + "?")) return;
    try { await post("/api/providers/sign-out", {provider:id}); delete state.credentialDrafts[id]; const profile = providerProfile(id); if (profile) profile.readiness = "blocked"; item.ready = false; state.models.filter(model => model.provider === id).forEach(model => { model.available = false; }); $("connection-status").textContent = "Signed out of " + item.name + "."; render(); }
    catch (error) { $("connection-status").className = "inline-status error"; $("connection-status").textContent = error.message; }
  }

  async function post(path, body) {
    const response = await fetch(path, {method:"POST",headers:{"content-type":"application/json","x-swarm-token":token},body:JSON.stringify(body || {})});
    const payload = await response.json(); if (!response.ok) { const error = new Error(payload.error || "Request failed"); error.code = payload.code; error.stage = payload.stage; error.nextActions = payload.nextActions; throw error; } return payload;
  }
  function setBusy(button, busy, label) { button.disabled = busy; if (label) button.textContent = busy ? label : button.dataset.defaultLabel || button.textContent; }
  async function findLocal() {
    const status = $("connection-status"); status.className = "inline-status"; status.textContent = "Looking for local AI apps...";
    try {
      const payload = await post("/api/providers/local", {});
      if (!payload.connections.length) { status.textContent = "No supported local AI app is currently running."; return; }
      payload.connections.forEach(result => acceptCustom(result.provider, {id:result.provider.id,provider:result.provider.id,name:result.provider.name,connectionKind:"custom",auth:result.provider.auth || {method:"none"},protocol:result.provider.wireProtocol,runtimeApi:result.provider.api,readiness:"discovered",settings:{},headers:result.provider.headers || [],discoveredAt:new Date().toISOString()}));
      status.textContent = payload.connections.length + " local connection" + (payload.connections.length === 1 ? "" : "s") + " added.";
    } catch (error) { status.className = "inline-status error"; status.textContent = error.message; }
  }

  $("open-connection").addEventListener("click", () => openDialog("cloud"));
  $("empty-connect").addEventListener("click", () => openDialog("cloud"));
  $("find-local").addEventListener("click", findLocal); $("empty-local").addEventListener("click", findLocal);
  $("cloud-tab").addEventListener("click", () => { state.dialogMode = "cloud"; renderDialog(); });
  $("custom-tab").addEventListener("click", () => { state.dialogMode = "custom"; renderDialog(); });
  $("close-dialog").addEventListener("click", () => { if (state.oauthSession && ["running","awaiting-input"].includes(state.oauthSession.status)) void post("/api/oauth/cancel", {sessionId:state.oauthSession.id}).catch(() => {}); $("connection-dialog").close(); });
  $("provider-search").addEventListener("input", () => populateProviderCatalog($("provider-search").value));
  $("cloud-provider").addEventListener("change", () => { state.oauthSession = null; renderProviderForm(); });
  $("provider-auth-method").addEventListener("change", renderProviderForm);
  $("start-oauth").addEventListener("click", startOAuth);
  $("connect-cloud").dataset.defaultLabel = "Connect";
  $("connect-cloud").addEventListener("click", async () => {
    const button = $("connect-cloud"), status = $("dialog-status"); status.className = "dialog-status"; setBusy(button,true,"Connecting...");
    try { await connectBuiltIn(true); }
    catch (error) { status.className = "dialog-status error"; status.textContent = error.message; }
    finally { setBusy(button,false); syncProviderConnectButton(); }
  });
  $("endpoint-auth-method").addEventListener("change", renderCustomAuth);
  $("endpoint-protocol").addEventListener("change", () => { state.customDraft = null; state.customProfileDraft = null; state.customPendingProvider = null; renderCustomDraft(); });
  $("test-endpoint").dataset.defaultLabel = "Load models";
  $("test-endpoint").addEventListener("click", async () => {
    const button = $("test-endpoint"), status = $("dialog-status"); setBusy(button,true,"Loading...");
    try { await loadCustomModels(false); } catch (error) { status.className = "dialog-status error"; status.textContent = error.message + (error.code === "unsupported" ? " Enter model IDs manually." : ""); }
    finally { setBusy(button,false); button.textContent = "Load models"; }
  });
  $("use-manual-models").addEventListener("click", async () => { const status = $("dialog-status"); try { await loadCustomModels(true); } catch (error) { status.className = "dialog-status error"; status.textContent = error.message; } });
  $("accept-endpoint").addEventListener("click", () => { syncDraftFields(); if (state.customDraft && state.customProfileDraft) acceptCustom(structuredClone(state.customDraft), structuredClone(state.customProfileDraft)); });
  ["endpoint-name","endpoint-canonical-url"].forEach(id => $(id).addEventListener("change", syncDraftFields));
  $("primary-model").addEventListener("change", () => { state.primary = $("primary-model").value; renderModelDetails(); renderFallbacks(); });
  $("add-fallback").addEventListener("click", () => { const next = usableModels().find(item => item.id !== state.primary && !state.fallbacks.includes(item.id)); if (next) { state.fallbacks.push(next.id); renderFallbacks(); } });
  $("project-goal").addEventListener("input", () => { state.profile.goal = $("project-goal").value; clearProfileError(); });
  $("scope-all").addEventListener("click", () => { state.profile.scope = "all"; clearProfileError(); renderProject(); });
  $("scope-selected").addEventListener("click", () => { state.profile.scope = "selected"; clearProfileError(); renderProject(); });
  $("custom-tasks").addEventListener("input", () => {
    state.profile.customTasks = $("custom-tasks").value.split(",").map(value => value.trim()).filter(Boolean);
    clearProfileError();
  });
  $("sandbox-strict").addEventListener("click", () => { state.sandboxMode = "strict"; renderSafety(); });
  $("sandbox-adaptive").addEventListener("click", () => {
    if (!boot.sandboxAvailability.available) return;
    state.sandboxMode = "adaptive"; renderSafety();
  });
  $("sandbox-lenient").addEventListener("click", () => {
    if (!boot.sandboxAvailability.available) return;
    state.sandboxMode = "lenient";
    renderSafety();
  });
  $("approval-deny").addEventListener("click", () => { state.adaptivePolicy.approvalPolicy = "deny"; renderSafety(); });
  $("approval-wait").addEventListener("click", () => { state.adaptivePolicy.approvalPolicy = "wait"; renderSafety(); });
  $("classifier-thinking").addEventListener("change", () => { state.adaptivePolicy.classifierThinkingLevel = $("classifier-thinking").value; });
  $("trusted-domains").addEventListener("input", () => { state.adaptivePolicy.trustedDomains = $("trusted-domains").value.split(/\s+/).map(value => value.trim().toLowerCase()).filter(Boolean); });
  $("policy-diagnostics").addEventListener("change", () => { state.adaptivePolicy.diagnostics = $("policy-diagnostics").checked; });
  $("policy-rules").addEventListener("change", () => { validateSafety(); });
  $("background-mechanical").addEventListener("change", () => { state.backgroundRolePolicy.mechanicalExecutor = $("background-mechanical").checked; });
  $("decision-mode").addEventListener("change", () => { state.decisionMode = $("decision-mode").value; });
  $("decision-doctrine").addEventListener("change", () => { state.doctrine = $("decision-doctrine").checked ? "first-principles-qds-v1" : null; });
  $("host-assistance-mode").addEventListener("change", () => { state.hostAssistance.mode = $("host-assistance-mode").value; state.hostAssistance.enabled = state.hostAssistance.mode !== "off"; });
  $("host-review-mode").addEventListener("change", () => { state.hostAssistance.reviewMode = $("host-review-mode").value; });
  $("host-auto-scope").addEventListener("change", () => { state.hostAssistance.autoApprovalScope = $("host-auto-scope").value; });
  $("host-auto-discovery-gates").addEventListener("change", () => { state.hostAssistance.autoApproveDiscoveryGates = $("host-auto-discovery-gates").checked; });
  $("context-budget").addEventListener("input", () => { state.contextBudget = Math.max(0, Math.min(64, Number($("context-budget").value) || 0)); });
  $("host-max-requests").addEventListener("input", () => { state.hostAssistance.maxRequests = Math.max(0, Math.min(6, Number($("host-max-requests").value) || 0)); });
  $("host-max-fanout").addEventListener("input", () => { state.hostAssistance.maxFanOut = Math.max(0, Math.min(3, Number($("host-max-fanout").value) || 0)); });
  $("private-connector").addEventListener("change", () => { state.hostAssistance.privateConnector = $("private-connector").value; });
  $("advisor-enabled").addEventListener("change", () => { state.advisor.enabled = $("advisor-enabled").checked; });
  $("advisor-max-requests").addEventListener("input", () => { state.advisor.maxRequests = Math.max(0, Math.min(3, Number($("advisor-max-requests").value) || 0)); });
  $("advisor-max-perspectives").addEventListener("input", () => { state.advisor.maxPerspectives = Math.max(0, Math.min(4, Number($("advisor-max-perspectives").value) || 0)); });
  $("host-actions-enabled").addEventListener("change", () => { state.hostActions.enabled = $("host-actions-enabled").checked; });
  $("host-actions-remote").addEventListener("change", () => { state.hostActions.remoteActionsEnabled = $("host-actions-remote").checked; });
  $("host-action-max-uses").addEventListener("input", () => { state.hostActions.maxUses = Math.max(1, Math.min(100, Number($("host-action-max-uses").value) || 1)); });
  $("host-action-max-cost").addEventListener("input", () => { state.hostActions.maxCost = Math.max(0, Number($("host-action-max-cost").value) || 0); });
  $("host-action-ttl").addEventListener("input", () => { state.hostActions.ttlMs = Math.max(1, Math.min(1440, Number($("host-action-ttl").value) || 1)) * 60000; });
  $("next-button").addEventListener("click", () => {
    if (state.phase === 4 && !validateSafety()) return;
    if (state.phase === 5 && !validateProject()) return;
    setPhase(Math.min(6, state.phase + 1));
  });
  $("back-button").addEventListener("click", () => setPhase(Math.max(initialPhase, state.phase - 1)));
  document.querySelectorAll("[data-step]").forEach(button => button.addEventListener("click", () => { const step = Number(button.dataset.step); if (step >= initialPhase && step <= state.phase) setPhase(step); }));
  $("save-button").addEventListener("click", async () => {
    const status = $("save-status"), button = $("save-button"); status.className = "save-status"; status.textContent = "Testing selected models and saving configuration..."; button.disabled = true;
    try {
      const profile = projectProfile();
      const execution = {
        rolePolicies:state.rolePolicies,adaptivePolicy:state.adaptivePolicy,backgroundRolePolicy:state.backgroundRolePolicy,
        decisionMode:state.decisionMode,hostAssistance:state.hostAssistance,contextBudget:state.contextBudget,
        advisor:state.advisor,doctrine:state.doctrine,hostActions:state.hostActions,
      };
      if (setupMode === "project") await post("/api/save-profile", {profile,sandboxMode:state.sandboxMode,...execution});
      else await post("/api/save", {primary:state.primary||null,fallbacks:state.fallbacks,customProviders:state.customProviders,providerProfiles:state.providerProfiles,credentialDrafts:Object.values(state.credentialDrafts).map(draft => ({provider:draft.provider,draftId:draft.id})),profile,sandboxMode:state.sandboxMode,...execution});
      showCompletion(setupMode === "project" ? "Project setup saved" : "Configuration saved", "Swarm Pi will use these project settings for delegated work. You can close this tab.", true);
    } catch (error) { status.className = "save-status error"; status.textContent = error.message; button.disabled = false; }
  });
  $("cancel-button").addEventListener("click", async () => {
    if (!confirm("Close setup without saving your changes?")) return;
    try {
      await post("/api/cancel", {});
      showCompletion("Setup closed", "No changes were saved. You can close this tab and run configure again whenever you are ready.", false);
    } catch (error) { $("save-status").className = "save-status error"; $("save-status").textContent = error.message; }
  });

  function showCompletion(title, message, saved) {
    state.closed = true;
    localStorage.removeItem(draftKey);
    $("connections-screen").hidden = true; $("models-screen").hidden = true; $("roles-screen").hidden = true; $("safety-screen").hidden = true; $("project-screen").hidden = true; $("review-screen").hidden = true; $("closed-screen").hidden = false;
    $("completion-mark").textContent = saved ? "✓" : "–"; $("completion-mark").className = saved ? "completion-mark" : "completion-mark neutral";
    $("completion-title").textContent = title; $("completion-message").textContent = message;
    $("action-buttons").hidden = true; $("save-status").className = saved ? "save-status success" : "save-status"; $("save-status").textContent = saved ? "Saved successfully." : "Closed without saving.";
    document.querySelectorAll("[data-step]").forEach(button => button.disabled = true);
  }

  populateProviderCatalog(); render();
})();
`;
