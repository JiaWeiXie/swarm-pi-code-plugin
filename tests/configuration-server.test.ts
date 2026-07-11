import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";

import { AuthStorage } from "@earendil-works/pi-coding-agent";

import { getProviderDefinition } from "../src/providers/capabilities.js";
import { CredentialDraftVault } from "../src/providers/credentials.js";
import { loadState, resolveStateFile } from "../src/state/state.js";
import { defaultModelConfiguration, resolveModelConfigurationFile, saveModelConfiguration } from "../src/state/model-config.js";
import {
  configureBuiltInProvider,
  loadConfigurationView,
  saveConfigurationSubmission,
  saveProjectProfileSubmission,
  signOutProvider,
  verifyProviderConnection,
} from "../src/web/configuration-service.js";
import { startConfigurationServer } from "../src/web/configuration-server.js";
import { renderConfigurationPage } from "../src/web/ui.js";

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-web-config-"));
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-web-auth-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_AUTH_FILE: path.join(privateDir, "auth.json"),
    SWARM_PI_CODE_PLUGIN_MODELS_FILE: path.join(privateDir, "models.json"),
    SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST: "1",
  };
  const customProviders = [
    {
      id: "local-test",
      name: "Local Test",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions" as const,
      authHeader: false,
      requiresApiKey: true,
      models: [
        {
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text" as const],
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    },
  ];
  return { workspace, privateDir, env, customProviders };
}

test("configuration page starts from connections and uses the original Swarm Pi mark", () => {
  const html = renderConfigurationPage({
    configuration: defaultModelConfiguration(),
    profile: null,
    directoryOptions: [],
    providers: [],
    providerCatalog: ["openai", "openai-codex"].map((id) => ({
      ...getProviderDefinition(id)!,
      auth: { configured: false, source: null, label: null },
    })),
    models: [],
    registryError: null,
    sandboxMode: "strict",
    sandboxAvailability: {
      available: true,
      backend: "macos-seatbelt",
      label: "macOS Seatbelt",
      reason: null,
      warnings: [],
    },
  }, "test-nonce");

  assert.match(html, /Connect an AI service/);
  assert.match(html, /Worker roles/);
  assert.match(html, /Execution &amp; safety/);
  assert.match(html, /sandbox-adaptive/);
  assert.match(html, /classifier-models/);
  assert.match(html, /class="brand-logo"/);
  assert.match(html, />Close setup</);
  assert.match(html, /id="closed-screen"/);
  assert.doesNotMatch(html, />Cancel</);
  assert.doesNotMatch(html, /Show all \d+ providers/);
  assert.doesNotMatch(html, /Raspberry|raspberry/i);
  assert.doesNotMatch(html, /Provider ID/);
  assert.match(html, /ChatGPT Plus\/Pro/);
  assert.match(html, /Provider catalog/);
  assert.match(html, /Use signed-in account/);
  assert.match(html, /Replace credential/);
  assert.doesNotMatch(html, /Cloud API key/);
  assert.match(html, /OpenAI Chat Completions/);
  assert.match(html, /OpenAI Responses/);
  assert.match(html, /Anthropic Messages/);
  assert.match(html, /id="provider-fields"/);
  assert.doesNotMatch(html, /id="cloud-key"/);

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.doesNotThrow(() => new Function(scripts.at(-1)?.[1] ?? ""));
});

test("project-only page starts from the guided project setup", () => {
  const html = renderConfigurationPage({
    configuration: defaultModelConfiguration(),
    profile: { goal: "Maintain the product", dirs: ["src"], tasks: ["implementation"] },
    directoryOptions: ["docs", "src"],
    providers: [],
    providerCatalog: [],
    models: [],
    registryError: null,
    sandboxMode: "lenient",
    sandboxAvailability: {
      available: true,
      backend: "macos-seatbelt",
      label: "macOS Seatbelt",
      reason: null,
      warnings: [],
    },
  }, "test-nonce", "project");

  assert.match(html, /"setupMode":"project"/);
  assert.match(html, /What should this project accomplish/);
  assert.match(html, /Selected folders/);
  assert.match(html, /Delegated work/);
  assert.match(html, /Execution safety/);
  assert.match(html, /data-step="3"/);
  assert.match(html, /data-step="6"/);
  assert.match(html, /sandboxed shell and outbound network enabled/);
  assert.match(html, /\/api\/save-profile/);
});

test("project profile save validates scope and does not create model configuration", async () => {
  const { workspace } = fixture();
  fs.mkdirSync(path.join(workspace, "src"));
  const profile = await saveProjectProfileSubmission(workspace, {
    profile: {
      goal: "Ship a dependable project setup flow",
      dirs: ["src"],
      tasks: ["implementation", "code-review"],
    },
    sandboxMode: "strict",
  });

  assert.equal(profile.goal, "Ship a dependable project setup flow");
  assert.deepEqual(profile.dirs, ["src"]);
  assert.deepEqual(profile.tasks, ["implementation", "code-review"]);
  assert.equal((await loadState(workspace)).config.sandboxMode, "strict");
  assert.equal(fs.existsSync(await resolveModelConfigurationFile(workspace)), false);
  await assert.rejects(
    () => saveProjectProfileSubmission(workspace, { goal: "Invalid", dirs: ["../outside"], tasks: ["analysis"] }),
    /outside/,
  );
  await assert.rejects(
    () => saveProjectProfileSubmission(workspace, { goal: "Invalid", dirs: [], tasks: [" "] }),
    /at least one delegated task type/,
  );
});

test("built-in provider forms stage credentials and return protocol-specific profiles", async () => {
  const { workspace, env } = fixture();
  const vault = new CredentialDraftVault();
  const secret = "openai-draft-secret";
  const preview = await configureBuiltInProvider(workspace, {
    provider: "openai",
    authMethod: "api-key",
    fields: {
      apiKey: secret,
      organization: "org_example",
      project: "proj_example",
    },
  }, vault, env);

  assert.equal(preview.profile.protocol, "openai-responses");
  assert.equal(preview.profile.runtimeApi, "openai-responses");
  assert.deepEqual(preview.profile.settings, {
    organization: "org_example",
    project: "proj_example",
  });
  assert.equal(preview.credentialDraft?.masked, true);
  assert.equal(preview.models.every((model) => model.provider === "openai"), true);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(secret));
});

test("configuration service stores credentials outside model and state files", async () => {
  const { workspace, privateDir, env, customProviders } = fixture();
  fs.mkdirSync(path.join(workspace, "src"));
  const secret = "test-secret-that-must-not-leak";
  const credentialVault = new CredentialDraftVault();
  const credentialDraft = credentialVault.stageApiKey("local-test", secret);
  const view = await saveConfigurationSubmission(
    workspace,
    {
      primary: "local-test/test-model",
      fallbacks: [],
      customProviders,
      credentialDrafts: [{ provider: "local-test", draftId: credentialDraft.id }],
      profile: {
        goal: "Maintain a guided setup experience",
        dirs: ["src"],
        tasks: ["implementation", "code-review"],
      },
    },
    env,
    { credentialVault },
  );
  const modelFile = await resolveModelConfigurationFile(workspace);
  const stateFile = await resolveStateFile(workspace);
  const authFile = path.join(privateDir, "auth.json");

  assert.equal(view.configuration.primary, "local-test/test-model");
  assert.equal(view.models.find((model) => model.id === "local-test/test-model")?.available, true);
  assert.match(fs.readFileSync(authFile, "utf8"), new RegExp(secret));
  assert.doesNotMatch(fs.readFileSync(modelFile, "utf8"), new RegExp(secret));
  assert.doesNotMatch(fs.readFileSync(stateFile, "utf8"), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(view), new RegExp(secret));
  assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
  assert.deepEqual((await loadState(workspace)).config.modelPriority, ["local-test/test-model"]);
  assert.equal((await loadState(workspace)).config.profile?.goal, "Maintain a guided setup experience");
  assert.deepEqual(view.directoryOptions, ["src"]);
});

test("sign out removes credentials for built-in and configured custom providers only", async () => {
  const { workspace, env, customProviders } = fixture();
  await saveModelConfiguration(workspace, {
    primary: "local-test/test-model",
    fallbacks: [],
    customProviders,
    providerProfiles: [],
  });
  const auth = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  auth.set("local-test", { type: "api_key", key: "custom-secret" });
  auth.set("openai", { type: "api_key", key: "openai-secret" });

  await signOutProvider(workspace, "local-test", env);
  await signOutProvider(workspace, "openai", env);

  const reloadedAuth = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  assert.equal(reloadedAuth.hasAuth("local-test"), false);
  assert.equal(reloadedAuth.hasAuth("openai"), false);
  await assert.rejects(() => signOutProvider(workspace, "unknown-provider", env), /Unknown provider/);
});

test("configuration save smoke-tests the selected model before persistence", async () => {
  const { workspace, env } = fixture();
  const { SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST: _skip, ...smokeEnv } = env;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const common = { id: "chatcmpl-ready", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "ready-model" };
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "READY" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const view = await saveConfigurationSubmission(workspace, {
      primary: "ready/ready-model",
      fallbacks: [],
      customProviders: [{
        id: "ready", name: "Ready", baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions", authHeader: false, requiresApiKey: false,
        models: [{ id: "ready-model", name: "Ready", reasoning: false, input: ["text"] }],
      }],
    }, smokeEnv);
    assert.equal(view.configuration.primary, "ready/ready-model");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("explicit API verification promotes only the selected connection", async () => {
  const { workspace, env } = fixture();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const common = { id: "chatcmpl-verify", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "verify-model" };
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "READY" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = "verify-local";
  const customProvider = {
    id: provider,
    name: "Verify Local",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: "openai-completions" as const,
    wireProtocol: "openai-chat-completions" as const,
    authHeader: false,
    requiresApiKey: false,
    auth: { method: "none" as const },
    models: [{ id: "verify-model", name: "Verify", reasoning: false, input: ["text" as const] }],
  };
  try {
    const result = await verifyProviderConnection(workspace, {
      model: `${provider}/verify-model`,
      customProviders: [customProvider],
      providerProfiles: [{
        id: provider,
        provider,
        name: "Verify Local",
        connectionKind: "custom",
        auth: { method: "none" },
        protocol: "openai-chat-completions",
        runtimeApi: "openai-completions",
        readiness: "configured",
        settings: {},
        headers: [],
      }],
    }, new CredentialDraftVault(), env);
    assert.equal(result.profile.readiness, "verified");
    assert.equal(result.profile.verifiedModel, `${provider}/verify-model`);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("custom models keep unknown limits automatic in the browser view", async () => {
  const { workspace, env } = fixture();
  const view = await saveConfigurationSubmission(
    workspace,
    {
      primary: null,
      fallbacks: [],
      customProviders: [
        {
          id: "automatic-limits",
          name: "Automatic Limits",
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          authHeader: false,
          requiresApiKey: false,
          models: [
            {
              id: "unknown-model",
              name: "Unknown Model",
              reasoning: false,
              input: ["text"],
            },
          ],
        },
      ],
    },
    env,
  );
  const model = view.models.find((entry) => entry.id === "automatic-limits/unknown-model");

  assert.equal(model?.contextWindow, null);
  assert.equal(model?.maxTokens, null);
  assert.deepEqual(model?.metadata, { contextWindow: null, maxTokens: null });
});

test("configuration service validates every fallback and credential payload", async () => {
  const { workspace, env, customProviders } = fixture();
  const credentialVault = new CredentialDraftVault();
  const credentialDraft = credentialVault.stageApiKey("local-test", "valid-test-key");
  const lockedProvider = {
    ...customProviders[0]!,
    id: "locked-test",
    name: "Locked Test",
    models: [{ ...customProviders[0]!.models[0]!, id: "locked-model" }],
  };

  await assert.rejects(
    () => saveConfigurationSubmission(
      workspace,
      {
        primary: "local-test/test-model",
        fallbacks: ["locked-test/locked-model"],
        customProviders: [...customProviders, lockedProvider],
        credentialDrafts: [{ provider: "local-test", draftId: credentialDraft.id }],
      },
      env,
      { credentialVault },
    ),
    /Selected models are not authenticated/,
  );
  await assert.rejects(
    () => saveConfigurationSubmission(
      workspace,
      {
        primary: "local-test/test-model",
        fallbacks: [],
        customProviders,
        credentialDrafts: [{ provider: 42, draftId: [] }] as never,
      },
      env,
      { credentialVault },
    ),
    /Credential draft references require provider and draftId strings/,
  );
});

test("local configuration server requires its token and closes after save", async () => {
  const { workspace, privateDir, env, customProviders } = fixture();
  const secret = "browser-secret-that-must-not-leak";
  const server = await startConfigurationServer(workspace, {
    env,
    openBrowser: false,
    timeoutMs: 10_000,
  });
  const setupUrl = new URL(server.url);
  const token = setupUrl.searchParams.get("token")!;
  const documentResponse = await fetch(server.url);
  const html = await documentResponse.text();

  assert.equal(documentResponse.status, 200);
  assert.match(documentResponse.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(html, /AI connections/);
  assert.doesNotMatch(html, new RegExp(secret));

  const forbidden = await fetch(`${setupUrl.origin}/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: setupUrl.origin },
    body: "{}",
  });
  assert.equal(forbidden.status, 403);

  const legacyEndpoint = await fetch(`${setupUrl.origin}/api/connect-provider`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": token,
      origin: setupUrl.origin,
    },
    body: JSON.stringify({ provider: "openai", apiKey: secret }),
  });
  assert.equal(legacyEndpoint.status, 404);
  assert.doesNotMatch(await legacyEndpoint.text(), new RegExp(secret));

  const rawCredential = await fetch(`${setupUrl.origin}/api/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": token,
      origin: setupUrl.origin,
    },
    body: JSON.stringify({ primary: null, fallbacks: [], customProviders: [], credential: { provider: "openai", apiKey: secret } }),
  });
  assert.equal(rawCredential.status, 400);
  assert.doesNotMatch(await rawCredential.text(), new RegExp(secret));

  const credentialResponse = await fetch(`${setupUrl.origin}/api/providers/custom/credential`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": token,
      origin: setupUrl.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      baseUrl: customProviders[0]!.baseUrl,
      protocol: "openai-chat-completions",
      authMethod: "api-key",
      secret,
    }),
  });
  const credentialBody = await credentialResponse.json() as {
    provider: string;
    credentialDraft: { id: string };
  };
  assert.equal(credentialResponse.status, 200);
  assert.doesNotMatch(JSON.stringify(credentialBody), new RegExp(secret));
  const stagedProvider = {
    ...customProviders[0]!,
    id: credentialBody.provider,
    wireProtocol: "openai-chat-completions" as const,
  };
  const response = await fetch(`${setupUrl.origin}/api/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": token,
      origin: setupUrl.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      primary: `${credentialBody.provider}/test-model`,
      fallbacks: [],
      customProviders: [stagedProvider],
      credentialDrafts: [{ provider: credentialBody.provider, draftId: credentialBody.credentialDraft.id }],
    }),
  });
  const body = await response.text();
  const completion = await server.completion;

  assert.equal(response.status, 200);
  assert.equal(completion.status, "saved");
  assert.equal(completion.saved, true);
  assert.doesNotMatch(body, new RegExp(secret));
  assert.match(fs.readFileSync(path.join(privateDir, "auth.json"), "utf8"), new RegExp(secret));
  await assert.rejects(() => fetch(server.url));

  const reconfigured = await loadConfigurationView(workspace, env);
  assert.equal(reconfigured.configuration.primary, `${credentialBody.provider}/test-model`);
  assert.equal(reconfigured.configuration.customProviders[0]?.baseUrl, "http://127.0.0.1:11434/v1");
});

test("cancel closes the setup session without creating model.json", async () => {
  const { workspace, env } = fixture();
  const server = await startConfigurationServer(workspace, { env, openBrowser: false, timeoutMs: 10_000 });
  const url = new URL(server.url);
  const response = await fetch(`${url.origin}/api/cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": url.searchParams.get("token")!,
      origin: url.origin,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await server.completion).status, "cancelled");
  assert.equal(fs.existsSync(await resolveModelConfigurationFile(workspace)), false);
});

test("project-only server saves profile without changing model configuration", async () => {
  const { workspace, env } = fixture();
  fs.mkdirSync(path.join(workspace, "src"));
  const server = await startConfigurationServer(workspace, {
    env,
    mode: "project",
    openBrowser: false,
    timeoutMs: 10_000,
  });
  const url = new URL(server.url);
  const documentResponse = await fetch(server.url);
  assert.match(await documentResponse.text(), /"setupMode":"project"/);

  const response = await fetch(`${url.origin}/api/save-profile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": url.searchParams.get("token")!,
      origin: url.origin,
    },
    body: JSON.stringify({
      profile: { goal: "Guide repeated setup", dirs: ["src"], tasks: ["planning", "analysis"] },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await server.completion).status, "saved");
  assert.deepEqual((await loadState(workspace)).config.profile?.tasks, ["planning", "analysis"]);
  assert.equal(fs.existsSync(await resolveModelConfigurationFile(workspace)), false);
});
