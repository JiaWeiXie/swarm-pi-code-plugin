export function renderConfigurationPage(view, nonce, mode = "full") {
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
      <button type="button" data-step="3"><span>3</span>Project setup</button>
      <div class="step-line"></div>
      <button type="button" data-step="4"><span>4</span>Review</button>
    </nav>
    <nav id="project-steps" class="steps project-steps" aria-label="Project setup progress" hidden>
      <button type="button" data-step="3"><span>1</span>Project setup</button>
      <div class="step-line"></div>
      <button type="button" data-step="4"><span>2</span>Review</button>
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

      <section id="project-screen" class="screen" hidden>
        <div class="screen-heading"><div><h1>Project setup</h1><p>Tell Pi what this project is for and where it may help.</p></div></div>
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
        <div class="review-section"><h2>Project goal</h2><div id="review-goal" class="review-value review-text"></div></div>
        <div class="review-section"><h2>Working area</h2><div id="review-directories" class="review-list"></div></div>
        <div class="review-section"><h2>Delegated work</h2><div id="review-tasks" class="review-list"></div></div>
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
        <button id="cloud-tab" type="button" role="tab">Cloud API key</button>
        <button id="custom-tab" type="button" role="tab">Custom or local endpoint</button>
      </div>

      <div id="cloud-panel" class="dialog-panel">
        <label for="cloud-provider">AI service</label>
        <select id="cloud-provider"></select>
        <label for="cloud-key">API key</label>
        <input id="cloud-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Enter API key">
        <p class="field-hint">Existing Pi subscription sign-ins and environment credentials are detected automatically.</p>
        <button id="connect-cloud" class="primary-button wide-button" type="button">Connect</button>
      </div>

      <div id="custom-panel" class="dialog-panel" hidden>
        <label for="endpoint-url">Server URL</label>
        <input id="endpoint-url" type="url" spellcheck="false" placeholder="http://127.0.0.1:11434">
        <label for="endpoint-key">API key <span class="optional">optional</span></label>
        <input id="endpoint-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Leave blank for local servers">
        <button id="test-endpoint" class="primary-button wide-button" type="button">Test and find models</button>
        <div id="discovery-result" class="discovery-result" hidden></div>
        <details id="advanced-connection" class="advanced" hidden>
          <summary>Advanced connection and model settings</summary>
          <div class="advanced-body">
            <label for="endpoint-name">Connection name</label>
            <input id="endpoint-name">
            <div class="advanced-grid">
              <div><label for="endpoint-canonical-url">API base URL</label><input id="endpoint-canonical-url" type="url" spellcheck="false"></div>
              <div><label for="endpoint-api">API protocol</label><select id="endpoint-api"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></div>
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
const styles = String.raw `
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
.steps { display: grid; grid-template-columns: auto minmax(28px, 110px) auto minmax(28px, 110px) auto minmax(28px, 110px) auto; align-items: center; justify-content: center; gap: 14px; padding: 0 24px; border-bottom: 1px solid var(--border); background: #fbfcfb; }
.project-steps { grid-template-columns: auto minmax(40px, 150px) auto; gap: 18px; }
.steps button { display: flex; align-items: center; gap: 9px; padding: 8px 0; border: 0; background: transparent; color: #7a8481; font-weight: 650; }
.steps button span { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #e7eae8; color: #68716f; }
.steps button.active { color: var(--teal); }
.steps button.active span { color: #fff; background: var(--teal); }
.steps button.complete { color: #38534f; }
.steps button.complete span { color: #fff; background: #315f58; }
.step-line { height: 1px; background: #cdd3d0; }
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
.row-actions { display: flex; gap: 6px; }
.row-actions button { min-height: 34px; padding: 0 11px; }
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
.optional { color: var(--muted); font-weight: 500; }
.wide-button { width: 100%; margin-top: 18px; }
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
  .steps { grid-template-columns: auto 22px auto 22px auto 22px auto; gap: 6px; padding: 0 12px; }
  .project-steps { grid-template-columns: auto 36px auto; gap: 8px; }
  .steps button { gap: 0; font-size: 0; }
  .project-steps button { gap: 7px; font-size: 12px; }
  .steps button span { width: 26px; height: 26px; }
  .workspace { width: min(100% - 28px, 1040px); padding-top: 24px; }
  .screen-heading { align-items: stretch; flex-direction: column; }
  .screen-heading .primary-button { width: 100%; }
  .connection-row { grid-template-columns: 40px minmax(0, 1fr); }
  .status-pill, .row-actions { grid-column: 2; }
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
}
`;
const clientScript = String.raw `
(() => {
  const boot = window.__SWARM_CONFIG__;
  const token = new URLSearchParams(location.search).get("token") || "";
  const taskTypes = [
    {value:"implementation",label:"Implementation",description:"Edit code and complete approved changes."},
    {value:"planning",label:"Planning",description:"Explore approaches and prepare implementation plans."},
    {value:"code-review",label:"Code review",description:"Inspect changes for bugs, risks, and missing tests."},
    {value:"analysis",label:"Analysis",description:"Investigate behavior, architecture, and technical questions."},
  ];
  const setupMode = boot.setupMode === "project" ? "project" : "full";
  const initialPhase = setupMode === "project" ? 3 : 1;
  const savedProfile = boot.profile || null;
  const knownTasks = new Set(taskTypes.map(item => item.value));
  const savedTasks = savedProfile?.tasks || [];
  function canonicalTask(value) {
    const normalized = String(value).trim().toLowerCase().replace(/[ _]+/g, "-");
    return ({implement:"implementation",implementation:"implementation",coding:"implementation",plan:"planning",planning:"planning",review:"code-review","code-review":"code-review",analysis:"analysis",analyze:"analysis"})[normalized] || null;
  }
  const savedKnownTasks = savedTasks.map(canonicalTask).filter(Boolean);
  const state = {
    phase: initialPhase,
    setupMode,
    connections: structuredClone(boot.providers),
    providerCatalog: boot.providerCatalog,
    models: structuredClone(boot.models),
    customProviders: structuredClone(boot.configuration.customProviders),
    credentials: {},
    primary: boot.configuration.primary || "",
    fallbacks: [...boot.configuration.fallbacks],
    customDraft: null,
    editingCustomIndex: -1,
    dialogMode: "cloud",
    closed: false,
    profile: {
      goal: savedProfile?.goal || "",
      scope: savedProfile?.dirs?.length ? "selected" : "all",
      dirs: [...(savedProfile?.dirs || [])],
      tasks: savedProfile ? [...new Set(savedKnownTasks.filter(task => knownTasks.has(task)))] : taskTypes.map(item => item.value),
      customTasks: savedTasks.filter(task => !canonicalTask(task)),
    },
  };
  const $ = id => document.getElementById(id);

  function initials(name) {
    return String(name || "AI").split(/[\s._-]+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2) || "AI";
  }
  function connection(id) { return state.connections.find(item => item.id === id); }
  function customProvider(id) { return state.customProviders.find(item => item.id === id); }
  function endpointKey(provider) {
    try { return new URL(provider.baseUrl).toString().replace(/\/$/, "") + "|" + provider.api; }
    catch { return String(provider.baseUrl).replace(/\/$/, "") + "|" + provider.api; }
  }
  function modelById(id) { return state.models.find(item => item.id === id); }
  function providerName(id) { return connection(id)?.name || state.providerCatalog.find(item => item.id === id)?.name || id; }
  function modelLabel(model) { return model.name === model.model ? model.model : model.name + " - " + model.model; }
  function sourceLabel(source) {
    return ({"endpoint":"Endpoint", "pi-catalog":"Pi catalog", "models-dev":"models.dev", "compatibility-default":"Compatibility default", "user":"Custom"})[source] || "Automatic";
  }
  function usableModels() {
    const ready = new Set(state.connections.filter(item => item.ready).map(item => item.id));
    return state.models.filter(item => item.available || ready.has(item.provider) || state.credentials[item.provider]);
  }
  function normalizeSelection() {
    const usable = usableModels();
    if (!usable.some(item => item.id === state.primary)) state.primary = usable[0]?.id || "";
    state.fallbacks = state.fallbacks.filter((value, index, values) =>
      value !== state.primary && values.indexOf(value) === index && usable.some(item => item.id === value),
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
  function availableProviderId(base) {
    const used = new Set([
      ...state.providerCatalog.map(item => item.id),
      ...state.connections.map(item => item.id),
      ...state.customProviders.map(item => item.id),
    ]);
    if (!used.has(base)) return base;
    let number = 2;
    while (true) {
      const suffix = "-" + number;
      const candidate = base.slice(0, 64 - suffix.length) + suffix;
      if (!used.has(candidate)) return candidate;
      number++;
    }
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
      const row = document.createElement("div");
      row.className = "connection-row";
      row.innerHTML = '<div class="connection-mark"></div><div><span class="connection-name"></span><span class="connection-meta"></span></div><span class="status-pill"></span><div class="row-actions"></div>';
      row.querySelector(".connection-mark").textContent = initials(item.name);
      row.querySelector(".connection-name").textContent = item.name;
      row.querySelector(".connection-meta").textContent = item.availableModelCount + " models available" + (item.auth?.label ? " - " + item.auth.label : "");
      row.querySelector(".status-pill").textContent = item.ready ? "Ready" : "Needs attention";
      const actions = row.querySelector(".row-actions");
      if (item.custom) {
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-button"; edit.textContent = "Edit"; edit.addEventListener("click", () => openCustomEditor(item.id));
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Remove"; remove.addEventListener("click", () => removeCustom(item.id));
        actions.append(edit, remove);
      }
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
        group.append(new Option(modelLabel(item), item.id, false, item.id === state.primary));
      }
      select.append(group);
    }
    select.disabled = usableModels().length === 0;
    select.value = state.primary;
    renderModelDetails();
  }
  function renderModelDetails() {
    const target = $("model-details"); target.replaceChildren();
    const selected = modelById(state.primary);
    if (!selected) { target.textContent = "Connect an AI service before choosing a model."; return; }
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
        select.add(new Option(providerName(item.provider) + " / " + modelLabel(item), item.id, false, item.id === value));
      }
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
      dirs: state.profile.scope === "selected" ? [...state.profile.dirs] : [],
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
    state.connections.filter(item => item.ready).forEach(item => { const row = document.createElement("div"); row.className = "review-item"; row.textContent = item.name + " - " + item.availableModelCount + " models"; connections.append(row); });
    $("review-title").textContent = setupMode === "project" ? "Review project setup" : "Review setup";
    document.querySelectorAll(".full-only").forEach(element => element.hidden = setupMode === "project");
    const profile = projectProfile(); $("review-goal").textContent = profile.goal;
    const directories = $("review-directories"); directories.replaceChildren();
    if (profile.dirs.length === 0) directories.textContent = "Whole project";
    profile.dirs.forEach(value => { const row = document.createElement("div"); row.className = "review-item"; row.textContent = value; directories.append(row); });
    const tasks = $("review-tasks"); tasks.replaceChildren();
    profile.tasks.forEach(value => { const known = taskTypes.find(item => item.value === value), row = document.createElement("div"); row.className = "review-item"; row.textContent = known?.label || value; tasks.append(row); });
  }
  function render() {
    $("full-steps").hidden = setupMode !== "full"; $("project-steps").hidden = setupMode !== "project";
    renderSteps(); renderConnections(); renderPrimary(); renderFallbacks(); renderProject(); renderReview();
    $("connections-screen").hidden = state.phase !== 1; $("models-screen").hidden = state.phase !== 2; $("project-screen").hidden = state.phase !== 3; $("review-screen").hidden = state.phase !== 4;
    $("cancel-button").hidden = state.phase !== initialPhase; $("back-button").hidden = state.phase === initialPhase; $("next-button").hidden = state.phase === 4; $("save-button").hidden = state.phase !== 4;
    $("next-button").textContent = state.phase === 1 ? "Choose models" : state.phase === 2 ? "Project setup" : "Review";
    $("next-button").disabled = setupMode === "full" && (usableModels().length === 0 || (state.phase === 2 && !state.primary));
    $("save-button").textContent = setupMode === "project" ? "Save project setup" : "Save configuration";
    const warning = $("registry-warning"); warning.hidden = !boot.registryError; warning.textContent = boot.registryError ? "Pi model registry: " + boot.registryError : "";
  }
  function setPhase(phase) { if (setupMode === "full" && phase > 1 && usableModels().length === 0) return; state.phase = phase; render(); window.scrollTo({top: 0, behavior: "smooth"}); }

  function populateProviderCatalog() {
    const select = $("cloud-provider"), preferred = ["openai", "anthropic", "google", "openrouter", "deepseek", "mistral", "groq", "xai"];
    select.replaceChildren();
    const common = document.createElement("optgroup"); common.label = "Common services";
    preferred.map(id => state.providerCatalog.find(item => item.id === id)).filter(Boolean).forEach(item => common.append(new Option(item.name, item.id)));
    const more = document.createElement("optgroup"); more.label = "More services";
    state.providerCatalog.filter(item => !preferred.includes(item.id)).forEach(item => more.append(new Option(item.name, item.id)));
    select.append(common, more);
  }
  function openDialog(mode) {
    state.dialogMode = mode; state.customDraft = null; state.editingCustomIndex = -1;
    $("dialog-title").textContent = "Add a connection"; $("cloud-key").value = ""; $("endpoint-key").value = ""; $("endpoint-url").value = ""; $("dialog-status").textContent = "";
    renderDialog(); $("connection-dialog").showModal();
  }
  function openCustomEditor(id) {
    const index = state.customProviders.findIndex(item => item.id === id); if (index < 0) return;
    state.dialogMode = "custom"; state.editingCustomIndex = index; state.customDraft = structuredClone(state.customProviders[index]);
    $("dialog-title").textContent = "Edit connection"; $("endpoint-url").value = state.customDraft.baseUrl; $("endpoint-key").value = ""; $("dialog-status").textContent = "";
    renderDialog(); $("connection-dialog").showModal();
  }
  function renderDialog() {
    const cloud = state.dialogMode === "cloud";
    $("cloud-panel").hidden = !cloud; $("custom-panel").hidden = cloud; $("cloud-tab").className = cloud ? "active" : ""; $("custom-tab").className = cloud ? "" : "active";
    $("cloud-tab").setAttribute("aria-selected", String(cloud)); $("custom-tab").setAttribute("aria-selected", String(!cloud));
    renderCustomDraft();
  }
  function renderCustomDraft() {
    const draft = state.customDraft, result = $("discovery-result"), advanced = $("advanced-connection"), accept = $("accept-endpoint");
    result.hidden = !draft; advanced.hidden = !draft; accept.hidden = !draft;
    if (!draft) return;
    result.replaceChildren(); const title = document.createElement("strong"); title.textContent = "Connected to " + draft.name; const detail = document.createElement("span"); detail.textContent = draft.models.length + " models found"; result.append(title, detail);
    $("endpoint-name").value = draft.name; $("endpoint-canonical-url").value = draft.baseUrl; $("endpoint-api").value = draft.api;
    accept.textContent = state.editingCustomIndex >= 0 ? "Save connection" : "Add connection";
    const models = $("advanced-models"); models.replaceChildren();
    draft.models.forEach((item, index) => {
      const details = document.createElement("details"); details.className = "model-editor";
      const summary = document.createElement("summary"); summary.textContent = item.name || item.id;
      const body = document.createElement("div"); body.className = "model-editor-body";
      const id = document.createElement("div"); id.className = "model-id"; id.textContent = item.id;
      body.append(id, draftLimitInput(item, index, "contextWindow", "Context window"), draftLimitInput(item, index, "maxTokens", "Max output")); details.append(summary, body); models.append(details);
    });
  }
  function draftLimitInput(item, index, field, label) {
    const wrap = document.createElement("div"), lab = document.createElement("label"), input = document.createElement("input"), note = document.createElement("span");
    input.id = "draft-limit-" + index + "-" + field; lab.htmlFor = input.id; lab.textContent = label; input.type = "number"; input.placeholder = "Automatic"; input.value = item[field] || ""; note.className = "source-note"; note.textContent = "Source: " + sourceLabel(item.metadata?.[field]);
    input.addEventListener("change", () => { const current = state.customDraft.models[index], value = input.value ? Number(input.value) : null; current.metadata = current.metadata || {}; if (value && Number.isInteger(value) && value > 0) { current[field] = value; current.metadata[field] = "user"; } else { delete current[field]; delete current.metadata[field]; } renderCustomDraft(); });
    wrap.append(lab, input, note); return wrap;
  }
  function syncDraftFields() {
    if (!state.customDraft) return;
    state.customDraft.name = $("endpoint-name").value.trim() || state.customDraft.name;
    state.customDraft.baseUrl = $("endpoint-canonical-url").value.trim();
    state.customDraft.api = $("endpoint-api").value;
  }
  function acceptCustom(provider, apiKey) {
    const matchingIndex = state.editingCustomIndex >= 0
      ? state.editingCustomIndex
      : state.customProviders.findIndex(item => endpointKey(item) === endpointKey(provider));
    const oldId = matchingIndex >= 0 ? state.customProviders[matchingIndex].id : null;
    provider.id = oldId || availableProviderId(provider.id);
    if (matchingIndex >= 0) state.customProviders[matchingIndex] = provider; else state.customProviders.push(provider);
    if (oldId) state.models = state.models.filter(item => item.provider !== oldId);
    upsertModels(browserModels(provider));
    if (apiKey) state.credentials[provider.id] = apiKey;
    upsertConnection({id:provider.id,name:provider.name,ready:true,modelCount:provider.models.length,availableModelCount:provider.models.length,auth:{source:apiKey?"runtime":provider.requiresApiKey?"stored":"local",label:apiKey?"API key entered in this setup session":provider.requiresApiKey?"Pi credential store":"No API key required"},selection:null,custom:true});
    normalizeSelection();
    if ($("connection-dialog").open) $("connection-dialog").close();
    render();
    if (matchingIndex >= 0 && state.editingCustomIndex < 0) $("connection-status").textContent = "Existing connection refreshed.";
  }
  function removeCustom(id) {
    const provider = customProvider(id); if (!provider || !confirm("Remove " + provider.name + " from this project?")) return;
    state.customProviders = state.customProviders.filter(item => item.id !== id); state.connections = state.connections.filter(item => item.id !== id); state.models = state.models.filter(item => item.provider !== id); delete state.credentials[id];
    if (state.primary.startsWith(id + "/")) state.primary = ""; state.fallbacks = state.fallbacks.filter(item => !item.startsWith(id + "/")); render();
  }

  async function post(path, body) {
    const response = await fetch(path, {method:"POST",headers:{"content-type":"application/json","x-swarm-token":token},body:JSON.stringify(body || {})});
    const payload = await response.json(); if (!response.ok) { const error = new Error(payload.error || "Request failed"); error.code = payload.code; throw error; } return payload;
  }
  function setBusy(button, busy, label) { button.disabled = busy; if (label) button.textContent = busy ? label : button.dataset.defaultLabel || button.textContent; }
  async function findLocal() {
    const status = $("connection-status"); status.className = "inline-status"; status.textContent = "Looking for local AI apps...";
    try {
      const payload = await post("/api/discover-local", {});
      if (!payload.connections.length) { status.textContent = "No supported local AI app is currently running."; return; }
      payload.connections.forEach(result => acceptCustom(result.provider, ""));
      status.textContent = payload.connections.length + " local connection" + (payload.connections.length === 1 ? "" : "s") + " added.";
    } catch (error) { status.className = "inline-status error"; status.textContent = error.message; }
  }

  $("open-connection").addEventListener("click", () => openDialog("cloud"));
  $("empty-connect").addEventListener("click", () => openDialog("cloud"));
  $("find-local").addEventListener("click", findLocal); $("empty-local").addEventListener("click", findLocal);
  $("cloud-tab").addEventListener("click", () => { state.dialogMode = "cloud"; renderDialog(); });
  $("custom-tab").addEventListener("click", () => { state.dialogMode = "custom"; renderDialog(); });
  $("close-dialog").addEventListener("click", () => $("connection-dialog").close());
  $("connect-cloud").dataset.defaultLabel = "Connect";
  $("connect-cloud").addEventListener("click", async () => {
    const button = $("connect-cloud"), provider = $("cloud-provider").value, apiKey = $("cloud-key").value, status = $("dialog-status"); status.className = "dialog-status"; status.textContent = "Checking connection..."; setBusy(button,true,"Connecting...");
    try { const preview = await post("/api/connect-provider", {provider,apiKey}); state.credentials[provider] = apiKey; upsertConnection(preview.provider); upsertModels(preview.models); normalizeSelection(); $("connection-dialog").close(); render(); }
    catch (error) { status.className = "dialog-status error"; status.textContent = error.message; }
    finally { setBusy(button,false); button.textContent = "Connect"; }
  });
  $("test-endpoint").dataset.defaultLabel = "Test and find models";
  $("test-endpoint").addEventListener("click", async () => {
    const button = $("test-endpoint"), status = $("dialog-status"); status.className = "dialog-status"; status.textContent = "Testing connection and loading models..."; setBusy(button,true,"Testing...");
    try {
      const reservedProviderIds = state.customProviders.filter((_, index) => index !== state.editingCustomIndex).map(item => item.id);
      const result = await post("/api/discover", {baseUrl:$("endpoint-url").value,apiKey:$("endpoint-key").value,reservedProviderIds});
      if (state.editingCustomIndex >= 0) result.provider.id = state.customProviders[state.editingCustomIndex].id;
      state.customDraft = result.provider; status.textContent = "Connection test passed."; renderCustomDraft();
    } catch (error) { status.className = "dialog-status error"; status.textContent = error.message; }
    finally { setBusy(button,false); button.textContent = "Test and find models"; }
  });
  $("accept-endpoint").addEventListener("click", () => { syncDraftFields(); if (state.customDraft) acceptCustom(structuredClone(state.customDraft), $("endpoint-key").value); });
  ["endpoint-name","endpoint-canonical-url","endpoint-api"].forEach(id => $(id).addEventListener("change", syncDraftFields));
  $("primary-model").addEventListener("change", () => { state.primary = $("primary-model").value; renderModelDetails(); renderFallbacks(); });
  $("add-fallback").addEventListener("click", () => { const next = usableModels().find(item => item.id !== state.primary && !state.fallbacks.includes(item.id)); if (next) { state.fallbacks.push(next.id); renderFallbacks(); } });
  $("project-goal").addEventListener("input", () => { state.profile.goal = $("project-goal").value; clearProfileError(); });
  $("scope-all").addEventListener("click", () => { state.profile.scope = "all"; clearProfileError(); renderProject(); });
  $("scope-selected").addEventListener("click", () => { state.profile.scope = "selected"; clearProfileError(); renderProject(); });
  $("custom-tasks").addEventListener("input", () => {
    state.profile.customTasks = $("custom-tasks").value.split(",").map(value => value.trim()).filter(Boolean);
    clearProfileError();
  });
  $("next-button").addEventListener("click", () => { if (state.phase === 3 && !validateProject()) return; setPhase(Math.min(4, state.phase + 1)); });
  $("back-button").addEventListener("click", () => setPhase(Math.max(initialPhase, state.phase - 1)));
  document.querySelectorAll("[data-step]").forEach(button => button.addEventListener("click", () => { const step = Number(button.dataset.step); if (step >= initialPhase && step <= state.phase) setPhase(step); }));
  $("save-button").addEventListener("click", async () => {
    const status = $("save-status"), button = $("save-button"); status.className = "save-status"; status.textContent = "Saving configuration..."; button.disabled = true;
    try {
      const profile = projectProfile();
      if (setupMode === "project") await post("/api/save-profile", {profile});
      else await post("/api/save", {primary:state.primary||null,fallbacks:state.fallbacks,customProviders:state.customProviders,credentials:Object.entries(state.credentials).map(([provider,apiKey])=>({provider,apiKey})),profile});
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
    $("connections-screen").hidden = true; $("models-screen").hidden = true; $("project-screen").hidden = true; $("review-screen").hidden = true; $("closed-screen").hidden = false;
    $("completion-mark").textContent = saved ? "✓" : "–"; $("completion-mark").className = saved ? "completion-mark" : "completion-mark neutral";
    $("completion-title").textContent = title; $("completion-message").textContent = message;
    $("action-buttons").hidden = true; $("save-status").className = saved ? "save-status success" : "save-status"; $("save-status").textContent = saved ? "Saved successfully." : "Closed without saving.";
    document.querySelectorAll("[data-step]").forEach(button => button.disabled = true);
  }

  populateProviderCatalog(); render();
})();
`;
