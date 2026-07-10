import type { ConfigurationView } from "./configuration-service.js";

export function renderConfigurationPage(
  view: ConfigurationView,
  nonce: string,
): string {
  const bootstrap = JSON.stringify(view)
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
  <title>Swarm Pi - Model setup</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand-mark" aria-hidden="true">SP</div>
      <strong>Swarm Pi</strong>
      <div class="local-status"><span></span>Local configuration</div>
    </header>
    <aside class="provider-rail">
      <h2>Providers</h2>
      <div id="provider-list" class="provider-list"></div>
    </aside>
    <main class="workspace">
      <div class="title-row">
        <div>
          <h1>Model setup</h1>
          <p>Choose the models used for delegated work in this repository.</p>
        </div>
        <div id="registry-warning" class="warning" hidden></div>
      </div>
      <form id="configuration-form" novalidate>
        <section class="settings-section">
          <div class="section-label"><h2>Provider</h2><p>Primary connection</p></div>
          <div class="section-content">
            <label for="provider-select">Provider</label>
            <select id="provider-select"></select>
            <p class="hint">Select the provider for your primary model.</p>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-label"><h2>Authentication</h2><p>Private credential</p></div>
          <div class="section-content">
            <div id="auth-status" class="auth-status"></div>
            <label for="api-key">API key <span class="optional">optional</span></label>
            <input id="api-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Enter or replace API key">
            <p class="hint">Saved in Pi's user credential store. It is never written to model.json or shown again.</p>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-label"><h2>Primary model</h2><p>Default worker</p></div>
          <div class="section-content">
            <label for="primary-model">Model</label>
            <select id="primary-model"></select>
            <p class="hint">Only models available for the selected provider can be saved.</p>
          </div>
        </section>

        <section class="settings-section">
          <div class="section-label"><h2>Fallback models</h2><p>Ordered recovery</p></div>
          <div class="section-content">
            <div id="fallback-list" class="fallback-list"></div>
            <button id="add-fallback" class="secondary-button" type="button">Add fallback model</button>
            <p class="hint inline-hint">Read-only jobs try these models in order when the primary fails.</p>
          </div>
        </section>

        <section class="settings-section custom-section">
          <div class="section-label"><h2>Custom endpoint</h2><p>OpenAI-compatible and more</p></div>
          <div class="section-content">
            <div class="custom-toolbar">
              <select id="custom-provider-select" aria-label="Custom provider"></select>
              <button id="add-custom-provider" class="secondary-button" type="button">Add custom provider</button>
              <button id="remove-custom-provider" class="danger-button" type="button">Remove</button>
            </div>
            <div id="custom-editor" class="custom-editor" hidden>
              <div class="field-grid">
                <div><label for="custom-id">Provider ID</label><input id="custom-id" spellcheck="false"></div>
                <div><label for="custom-name">Display name</label><input id="custom-name"></div>
                <div class="wide"><label for="custom-url">Base URL</label><input id="custom-url" type="url" spellcheck="false" placeholder="http://127.0.0.1:11434/v1"></div>
                <div><label for="custom-api">API type</label><select id="custom-api"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></div>
                <label class="checkbox-field"><input id="custom-auth-header" type="checkbox"> Add Authorization bearer header</label>
              </div>
              <div class="subsection-title"><div><h3>Models</h3><p>Model IDs exposed by this endpoint.</p></div><button id="add-custom-model" class="secondary-button" type="button">Add model</button></div>
              <div id="custom-model-list" class="custom-model-list"></div>
            </div>
            <div id="custom-empty" class="empty-state">Add a custom provider for Ollama, LM Studio, vLLM, or a private gateway.</div>
          </div>
        </section>
      </form>
    </main>
    <footer class="actionbar">
      <div id="save-status" class="save-status" role="status" aria-live="polite"></div>
      <div class="actions">
        <button id="cancel-button" class="secondary-button" type="button">Cancel</button>
        <button id="save-button" class="primary-button" type="submit" form="configuration-form">Save configuration</button>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">window.__SWARM_CONFIG__=${bootstrap};</script>
  <script nonce="${nonce}">${clientScript}</script>
</body>
</html>`;
}

const styles = String.raw`
:root{color-scheme:light;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.45;color:#18201f;background:#f5f7f6;letter-spacing:0;--teal:#087f78;--teal-dark:#076a65;--teal-soft:#eaf7f5;--coral:#c4493d;--amber:#a76800;--green:#168a58;--border:#d9dfdc;--muted:#65716d;--surface:#fff;--rail:#f8faf9}*{box-sizing:border-box}body{margin:0;min-width:320px;background:#f5f7f6}button,input,select{font:inherit;letter-spacing:0}.app-shell{height:100vh;overflow:hidden;display:grid;grid-template-columns:280px minmax(0,1fr);grid-template-rows:64px minmax(0,1fr) 76px;grid-template-areas:"top top" "rail main" "rail actions"}.topbar{grid-area:top;display:flex;align-items:center;gap:12px;padding:0 24px;border-bottom:1px solid var(--border);background:#fff;font-size:18px}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:#102b29;color:#fff;font-size:12px;font-weight:800}.local-status{margin-left:auto;display:flex;align-items:center;gap:8px;color:#3d4946;font-size:14px}.local-status span{width:9px;height:9px;border-radius:50%;background:var(--green)}.provider-rail{grid-area:rail;min-height:0;overflow-y:auto;background:var(--rail);border-right:1px solid var(--border);padding:25px 16px 32px}.provider-rail h2{font-size:13px;text-transform:uppercase;color:var(--muted);margin:0 10px 14px;font-weight:700}.provider-list{display:grid;gap:4px}.provider-item{width:100%;display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px;padding:10px;border:1px solid transparent;border-radius:7px;background:transparent;text-align:left;color:inherit;cursor:pointer}.provider-item:hover{background:#fff;border-color:#e2e7e5}.provider-item.active{background:#fff;border-color:#a9cbc6;box-shadow:0 1px 2px rgba(20,49,46,.05)}.provider-swatch{display:grid;place-items:center;width:38px;height:38px;border-radius:6px;background:#dfeae7;color:#24403c;font-size:12px;font-weight:800;text-transform:uppercase}.provider-copy{min-width:0}.provider-name{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:650}.provider-state{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:12px;color:var(--muted)}.provider-state::before{content:"";width:7px;height:7px;border-radius:50%;background:#a5afac}.provider-state.ready{color:var(--green)}.provider-state.ready::before{background:var(--green)}.provider-state.missing{color:var(--amber)}.provider-state.missing::before{background:#e3a21a}.provider-arrow{color:#7a8582}.show-all-providers{width:100%;margin-top:10px}.workspace{grid-area:main;min-height:0;overflow:auto;padding:34px clamp(28px,5vw,72px) 40px;background:#fff}.title-row{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:22px;border-bottom:1px solid var(--border)}h1{font-size:29px;line-height:1.15;margin:0 0 7px;font-weight:720}.title-row p{margin:0;color:var(--muted)}.warning{max-width:420px;padding:9px 12px;border:1px solid #e7c27a;border-radius:6px;background:#fff8e8;color:#73500d;font-size:13px}.settings-section{display:grid;grid-template-columns:minmax(150px,210px) minmax(0,1fr);gap:36px;padding:24px 0;border-bottom:1px solid #e5e9e7}.section-label h2{font-size:16px;margin:0 0 4px}.section-label p,.subsection-title p{margin:0;color:var(--muted);font-size:13px}.section-content>label,.field-grid label,.custom-model-row label{display:block;margin-bottom:7px;font-size:13px;font-weight:650;color:#34413e}.optional{color:var(--muted);font-weight:500}input,select{width:100%;height:42px;padding:0 12px;border:1px solid #cbd3d0;border-radius:6px;background:#fff;color:#18201f;outline:none}input:focus,select:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(8,127,120,.12)}input:disabled,select:disabled{background:#f2f4f3;color:#89928f}.hint{margin:7px 0 0;color:var(--muted);font-size:12px}.auth-status{display:flex;align-items:flex-start;gap:10px;margin-bottom:15px;padding:12px;border:1px solid #dfe5e2;border-radius:6px;background:#f8faf9}.auth-dot{width:10px;height:10px;margin-top:5px;border-radius:50%;background:#dfa21f;flex:none}.auth-status.ready{border-color:#a8d3c0;background:#f1fbf6}.auth-status.ready .auth-dot{background:var(--green)}.auth-title{font-weight:680}.auth-detail{display:block;color:var(--muted);font-size:12px;margin-top:1px}.fallback-list{display:grid;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:10px}.fallback-list:empty{display:none}.fallback-row{display:grid;grid-template-columns:28px minmax(0,1fr) 38px;align-items:center;border-bottom:1px solid var(--border)}.fallback-row:last-child{border-bottom:0}.fallback-row select{border:0;border-radius:0;box-shadow:none}.drag-handle{color:#8d9794;text-align:center;font-size:18px}.icon-button{width:38px;height:38px;border:0;background:transparent;color:#67716f;cursor:pointer;font-size:20px}.icon-button:hover{color:var(--coral);background:#fff2f0}.secondary-button,.primary-button,.danger-button{height:40px;padding:0 15px;border-radius:6px;cursor:pointer;font-weight:650}.secondary-button{border:1px solid #cbd3d0;background:#fff;color:#26312f}.secondary-button:hover{background:#f5f7f6}.primary-button{border:1px solid var(--teal);background:var(--teal);color:#fff}.primary-button:hover{background:var(--teal-dark)}.primary-button:disabled{opacity:.55;cursor:wait}.danger-button{border:1px solid #e6b7b1;background:#fff;color:var(--coral)}.inline-hint{display:inline;margin-left:12px}.custom-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto auto;gap:8px}.custom-editor{margin-top:18px;padding-top:18px;border-top:1px solid var(--border)}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.field-grid .wide{grid-column:1/-1}.checkbox-field{display:flex!important;align-items:center;gap:9px;margin:24px 0 0!important;font-weight:500!important}.checkbox-field input{width:17px;height:17px;margin:0}.subsection-title{display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px}.subsection-title h3{font-size:14px;margin:0 0 2px}.custom-model-list{display:grid;gap:8px}.custom-model-row{display:grid;grid-template-columns:1.2fr 1.2fr 110px 110px 38px;gap:8px;align-items:end}.custom-model-row .icon-button{border:1px solid var(--border);border-radius:6px}.custom-model-row label{font-size:11px;margin-bottom:4px}.empty-state{margin-top:14px;padding:22px;border:1px dashed #cbd3d0;border-radius:6px;text-align:center;color:var(--muted);font-size:13px}.actionbar{grid-area:actions;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px clamp(28px,5vw,72px);border-top:1px solid var(--border);background:rgba(255,255,255,.97)}.actions{display:flex;gap:10px;margin-left:auto}.save-status{font-size:13px}.save-status.success{color:var(--green);font-weight:650}.save-status.error{color:var(--coral);font-weight:650}@media(max-width:860px){.app-shell{grid-template-columns:1fr;grid-template-rows:58px minmax(0,1fr) 72px;grid-template-areas:"top" "main" "actions"}.provider-rail{display:none}.topbar{padding:0 16px}.workspace{padding:24px 18px 30px}.settings-section{grid-template-columns:1fr;gap:14px;padding:22px 0}.section-label p{display:none}.title-row{display:block}.warning{margin-top:14px}.actionbar{padding:12px 18px}.custom-toolbar{grid-template-columns:1fr 1fr}.custom-toolbar select{grid-column:1/-1}.custom-model-row{grid-template-columns:1fr 1fr 38px}.custom-model-row>div:nth-child(3),.custom-model-row>div:nth-child(4){display:none}.inline-hint{display:block;margin:8px 0 0}}@media(max-width:480px){.local-status{font-size:12px}.brand-mark{width:30px;height:30px}.topbar strong{font-size:16px}h1{font-size:25px}.field-grid{grid-template-columns:1fr}.field-grid .wide{grid-column:auto}.custom-toolbar{grid-template-columns:1fr}.custom-toolbar select{grid-column:auto}.custom-model-row{grid-template-columns:1fr 38px}.custom-model-row>div:nth-child(2){display:none}.actionbar{align-items:stretch}.save-status{position:absolute;bottom:74px;left:18px;right:18px;background:#fff}.actions{width:100%}.actions button{flex:1}}
`;

const clientScript = String.raw`
(() => {
  const boot = window.__SWARM_CONFIG__;
  const token = new URLSearchParams(location.search).get("token") || "";
  const state = {
    providers: boot.providers,
    models: boot.models,
    customProviders: structuredClone(boot.configuration.customProviders),
    provider: boot.configuration.primary?.split("/")[0] || boot.providers.find(p => p.ready)?.id || ["anthropic","openai","google","openrouter"].find(id => boot.providers.some(provider => provider.id === id)) || boot.providers[0]?.id || "",
    primary: boot.configuration.primary || "",
    fallbacks: [...boot.configuration.fallbacks],
    customIndex: boot.configuration.customProviders.findIndex(provider => provider.id === boot.configuration.primary?.split("/")[0]),
    showAllProviders: false,
  };
  const $ = id => document.getElementById(id);
  const providerList = $("provider-list"), providerSelect = $("provider-select"), primarySelect = $("primary-model"), fallbackList = $("fallback-list"), status = $("save-status"), saveButton = $("save-button");

  function escapeText(value) { return String(value ?? ""); }
  function initials(name) { return name.split(/[\s._-]+/).map(part => part[0]).join("").slice(0, 2) || "AI"; }
  function customProviderById(id) { return state.customProviders.find(provider => provider.id === id); }
  function mergedProviders() {
    const providers = [...state.providers];
    for (const custom of state.customProviders) if (!providers.some(provider => provider.id === custom.id)) providers.push({id:custom.id,name:custom.name || custom.id,ready:false,modelCount:custom.models.length,availableModelCount:0,auth:{source:null,label:null},selection:null,custom:true});
    const recommended = ["anthropic", "openai", "google", "openrouter"];
    return providers.sort((left, right) => {
      if (left.id === state.provider) return -1;
      if (right.id === state.provider) return 1;
      if (left.ready !== right.ready) return left.ready ? -1 : 1;
      const leftRank = recommended.indexOf(left.id), rightRank = recommended.indexOf(right.id);
      if (leftRank !== rightRank) return (leftRank < 0 ? 999 : leftRank) - (rightRank < 0 ? 999 : rightRank);
      return left.name.localeCompare(right.name);
    });
  }
  function providerById(id) { return mergedProviders().find(provider => provider.id === id); }
  function modelLabel(model) { return model.name === model.model ? model.model : model.name + " — " + model.model; }
  function allModels() {
    const models = [...state.models];
    for (const provider of state.customProviders) for (const model of provider.models) {
      const id = provider.id + "/" + model.id;
      const existing = models.find(entry => entry.id === id);
      if (existing) { existing.name = model.name; existing.model = model.id; }
      else models.push({id,provider:provider.id,model:model.id,name:model.name || model.id,available:false});
    }
    return models;
  }
  function selectableModels(provider) {
    const credentialProvider = $("api-key")?.value ? state.provider : null;
    return allModels().filter(model => (model.available || model.provider === credentialProvider) && (!provider || model.provider === provider));
  }

  function renderProviders() {
    providerList.replaceChildren();
    providerSelect.replaceChildren();
    const providers = mergedProviders();
    for (const provider of providers) providerSelect.add(new Option(provider.name, provider.id, false, provider.id === state.provider));
    const common = new Set(["anthropic", "openai", "google", "openrouter"]);
    const visible = state.showAllProviders ? providers : providers.filter(provider => provider.ready || provider.custom || provider.id === state.provider || common.has(provider.id));
    for (const provider of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-item" + (provider.id === state.provider ? " active" : "");
      button.innerHTML = '<span class="provider-swatch"></span><span class="provider-copy"><span class="provider-name"></span><span class="provider-state"></span></span><span class="provider-arrow">›</span>';
      button.querySelector(".provider-swatch").textContent = initials(provider.name);
      button.querySelector(".provider-name").textContent = provider.name;
      const providerState = button.querySelector(".provider-state");
      providerState.className = "provider-state " + (provider.ready ? "ready" : "missing");
      providerState.textContent = provider.ready ? provider.availableModelCount + " models ready" : "Missing authentication";
      button.addEventListener("click", () => selectProvider(provider.id));
      providerList.append(button);
    }
    if (!state.showAllProviders && visible.length < providers.length) {
      const showAll = document.createElement("button"); showAll.type = "button"; showAll.className = "secondary-button show-all-providers"; showAll.textContent = "Show all " + providers.length + " providers"; showAll.addEventListener("click", () => { state.showAllProviders = true; renderProviders(); }); providerList.append(showAll);
    }
  }

  function selectProvider(id) {
    state.provider = id;
    if (!state.primary.startsWith(id + "/") || !state.models.some(model => model.id === state.primary && model.available)) {
      state.primary = (allModels().find(model => model.provider === id && model.available) || allModels().find(model => model.provider === id))?.id || "";
    }
    render();
  }

  function renderAuth() {
    const provider = providerById(state.provider);
    const box = $("auth-status");
    box.className = "auth-status" + (provider?.ready ? " ready" : "");
    box.replaceChildren();
    const dot = document.createElement("span"); dot.className = "auth-dot";
    const copy = document.createElement("div");
    const title = document.createElement("span"); title.className = "auth-title"; title.textContent = provider?.ready ? "Connected" : "Authentication required";
    const detail = document.createElement("span"); detail.className = "auth-detail";
    detail.textContent = provider?.ready ? "Source: " + (provider.auth.label || provider.auth.source || "Pi credential store") : "Enter an API key below, or configure Pi authentication outside this session.";
    copy.append(title, detail); box.append(dot, copy);
  }

  function renderPrimary() {
    primarySelect.replaceChildren();
    const models = allModels().filter(model => model.provider === state.provider);
    if (models.length === 0) {
      primarySelect.add(new Option("Authenticate this provider to choose a model", ""));
      primarySelect.disabled = true;
      state.primary = "";
      return;
    }
    primarySelect.disabled = false;
    for (const model of models) primarySelect.add(new Option(modelLabel(model), model.id, false, model.id === state.primary));
    if (!models.some(model => model.id === state.primary)) state.primary = models[0].id;
    primarySelect.value = state.primary;
  }

  function renderFallbacks() {
    fallbackList.replaceChildren();
    state.fallbacks = state.fallbacks.filter((value, index, values) => value !== state.primary && values.indexOf(value) === index && allModels().some(model => model.id === value));
    state.fallbacks.forEach((value, index) => {
      const row = document.createElement("div"); row.className = "fallback-row";
      const handle = document.createElement("span"); handle.className = "drag-handle"; handle.textContent = "⋮";
      const select = document.createElement("select"); select.setAttribute("aria-label", "Fallback model " + (index + 1));
      const choices = allModels().filter(model => model.id !== state.primary && (model.id === value || (model.available && !state.fallbacks.includes(model.id)) || (model.provider === state.provider && $("api-key").value && !state.fallbacks.includes(model.id))));
      for (const model of choices) select.add(new Option(model.provider + " / " + modelLabel(model) + (model.available || model.id !== value ? "" : " (authentication required)"), model.id, false, model.id === value));
      select.value = value; select.addEventListener("change", () => { state.fallbacks[index] = select.value; renderFallbacks(); });
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button"; remove.title = "Remove fallback"; remove.setAttribute("aria-label", "Remove fallback"); remove.textContent = "×"; remove.addEventListener("click", () => { state.fallbacks.splice(index, 1); renderFallbacks(); });
      row.append(handle, select, remove); fallbackList.append(row);
    });
    $("add-fallback").disabled = selectableModels().filter(model => model.id !== state.primary && !state.fallbacks.includes(model.id)).length === 0;
  }

  function syncCustomEditor() {
    if (state.customIndex < 0) return;
    const provider = state.customProviders[state.customIndex];
    const previousId = provider.id;
    provider.id = $("custom-id").value.trim(); provider.name = $("custom-name").value.trim(); provider.baseUrl = $("custom-url").value.trim(); provider.api = $("custom-api").value; provider.authHeader = $("custom-auth-header").checked;
    if (previousId && provider.id && previousId !== provider.id) {
      if (state.provider === previousId) state.provider = provider.id;
      if (state.primary.startsWith(previousId + "/")) state.primary = provider.id + state.primary.slice(previousId.length);
      state.fallbacks = state.fallbacks.map(value => value.startsWith(previousId + "/") ? provider.id + value.slice(previousId.length) : value);
    }
    document.querySelectorAll(".custom-model-row").forEach((row, index) => {
      const model = provider.models[index]; if (!model) return;
      const previousModelId = model.id;
      model.id = row.querySelector('[data-field="id"]').value.trim(); model.name = row.querySelector('[data-field="name"]').value.trim(); model.contextWindow = Number(row.querySelector('[data-field="contextWindow"]').value); model.maxTokens = Number(row.querySelector('[data-field="maxTokens"]').value);
      if (previousModelId && model.id && previousModelId !== model.id) {
        const previousReference = provider.id + "/" + previousModelId, nextReference = provider.id + "/" + model.id;
        if (state.primary === previousReference) state.primary = nextReference;
        state.fallbacks = state.fallbacks.map(value => value === previousReference ? nextReference : value);
      }
    });
  }

  function renderCustom() {
    const select = $("custom-provider-select"); select.replaceChildren(); select.add(new Option("Select a custom provider", "-1"));
    state.customProviders.forEach((provider, index) => select.add(new Option(provider.name || provider.id || "New provider", String(index), false, index === state.customIndex)));
    select.value = String(state.customIndex);
    const active = state.customIndex >= 0 && state.customProviders[state.customIndex];
    $("custom-editor").hidden = !active; $("custom-empty").hidden = Boolean(active); $("remove-custom-provider").disabled = !active;
    if (!active) return;
    $("custom-id").value = active.id; $("custom-name").value = active.name; $("custom-url").value = active.baseUrl; $("custom-api").value = active.api; $("custom-auth-header").checked = active.authHeader;
    const list = $("custom-model-list"); list.replaceChildren();
    active.models.forEach((model, index) => {
      const row = document.createElement("div"); row.className = "custom-model-row";
      const fields = [["id","Model ID",model.id,"text"],["name","Display name",model.name,"text"],["contextWindow","Context",model.contextWindow,"number"],["maxTokens","Max output",model.maxTokens,"number"]];
      for (const [field,label,value,type] of fields) { const wrap = document.createElement("div"), lab = document.createElement("label"), input = document.createElement("input"); lab.textContent = label; input.type = type; input.value = value; input.dataset.field = field; input.addEventListener("input", syncCustomEditor); wrap.append(lab,input); row.append(wrap); }
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-button"; remove.title = "Remove model"; remove.setAttribute("aria-label", "Remove custom model"); remove.textContent = "×"; remove.addEventListener("click", () => { syncCustomEditor(); active.models.splice(index,1); renderCustom(); }); row.append(remove); list.append(row);
    });
  }

  function render() {
    renderProviders(); providerSelect.value = state.provider; renderAuth(); renderPrimary(); renderFallbacks(); renderCustom();
    const warning = $("registry-warning"); warning.hidden = !boot.registryError; warning.textContent = boot.registryError ? "Pi model registry: " + boot.registryError : "";
  }

  providerSelect.addEventListener("change", () => selectProvider(providerSelect.value));
  primarySelect.addEventListener("change", () => { state.primary = primarySelect.value; renderFallbacks(); });
  $("add-fallback").addEventListener("click", () => { const next = selectableModels().find(model => model.id !== state.primary && !state.fallbacks.includes(model.id)); if (next) { state.fallbacks.push(next.id); renderFallbacks(); } });
  $("custom-provider-select").addEventListener("change", () => { syncCustomEditor(); state.customIndex = Number($("custom-provider-select").value); renderCustom(); });
  $("add-custom-provider").addEventListener("click", () => { syncCustomEditor(); let suffix = 1, id = "custom-provider"; while (state.customProviders.some(provider => provider.id === id)) id = "custom-provider-" + (++suffix); state.customProviders.push({id,name:"Custom provider",baseUrl:"http://127.0.0.1:11434/v1",api:"openai-completions",authHeader:false,models:[{id:"model-name",name:"Model name",reasoning:false,input:["text"],contextWindow:128000,maxTokens:16384}]}); state.customIndex = state.customProviders.length - 1; state.provider = id; state.primary = id + "/model-name"; render(); });
  $("remove-custom-provider").addEventListener("click", () => { if (state.customIndex < 0) return; const removed = state.customProviders[state.customIndex]; if (!confirm("Remove " + (removed.name || removed.id) + " from this project configuration?")) return; state.customProviders.splice(state.customIndex,1); state.customIndex = -1; renderCustom(); });
  $("add-custom-model").addEventListener("click", () => { syncCustomEditor(); const provider = state.customProviders[state.customIndex]; if (!provider) return; provider.models.push({id:"model-name",name:"Model name",reasoning:false,input:["text"],contextWindow:128000,maxTokens:16384}); renderCustom(); });
  ["custom-id","custom-name","custom-url","custom-api","custom-auth-header"].forEach(id => $(id).addEventListener("input", syncCustomEditor));
  $("api-key").addEventListener("input", () => { renderPrimary(); renderFallbacks(); });

  async function post(path, body) {
    const response = await fetch(path, { method:"POST", headers:{"content-type":"application/json","x-swarm-token":token}, body:JSON.stringify(body ?? {}) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Unable to save configuration"); return payload;
  }
  $("configuration-form").addEventListener("submit", async event => {
    event.preventDefault(); syncCustomEditor(); status.className = "save-status"; status.textContent = "Saving configuration…"; saveButton.disabled = true;
    try {
      const key = $("api-key").value;
      await post("/api/save", { primary: state.primary || null, fallbacks: state.fallbacks, customProviders: state.customProviders, ...(key ? {credential:{provider:state.provider,apiKey:key}} : {}) });
      $("api-key").value = ""; status.className = "save-status success"; status.textContent = "Configuration saved. This local setup session is now closed.";
      document.querySelectorAll("input,select,button").forEach(control => control.disabled = true);
    } catch (error) { status.className = "save-status error"; status.textContent = error.message; saveButton.disabled = false; }
  });
  $("cancel-button").addEventListener("click", async () => { try { await post("/api/cancel", {}); status.textContent = "Configuration closed without saving."; document.querySelectorAll("input,select,button").forEach(control => control.disabled = true); } catch (error) { status.className = "save-status error"; status.textContent = error.message; } });
  render();
})();
`;
