import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadState } from "../src/state/state.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";
import {
  loadConfigurationView,
  saveConfigurationSubmission,
  saveProjectProfileSubmission,
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
    providerCatalog: [{ id: "openai", name: "OpenAI" }],
    models: [],
    registryError: null,
  }, "test-nonce");

  assert.match(html, /Connect an AI service/);
  assert.match(html, /class="brand-logo"/);
  assert.match(html, />Close setup</);
  assert.match(html, /id="closed-screen"/);
  assert.doesNotMatch(html, />Cancel</);
  assert.doesNotMatch(html, /Show all \d+ providers/);
  assert.doesNotMatch(html, /Raspberry|raspberry/i);
  assert.doesNotMatch(html, /Provider ID/);
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
  }, "test-nonce", "project");

  assert.match(html, /"setupMode":"project"/);
  assert.match(html, /What should this project accomplish/);
  assert.match(html, /Selected folders/);
  assert.match(html, /Delegated work/);
  assert.match(html, /\/api\/save-profile/);
});

test("project profile save validates scope and does not create model configuration", async () => {
  const { workspace } = fixture();
  fs.mkdirSync(path.join(workspace, "src"));
  const profile = await saveProjectProfileSubmission(workspace, {
    goal: "Ship a dependable project setup flow",
    dirs: ["src"],
    tasks: ["implementation", "code-review"],
  });

  assert.equal(profile.goal, "Ship a dependable project setup flow");
  assert.deepEqual(profile.dirs, ["src"]);
  assert.deepEqual(profile.tasks, ["implementation", "code-review"]);
  assert.equal(fs.existsSync(path.join(workspace, ".swarm-pi-code-plugin", "model.json")), false);
  await assert.rejects(
    () => saveProjectProfileSubmission(workspace, { goal: "Invalid", dirs: ["../outside"], tasks: ["analysis"] }),
    /outside/,
  );
  await assert.rejects(
    () => saveProjectProfileSubmission(workspace, { goal: "Invalid", dirs: [], tasks: [" "] }),
    /at least one delegated task type/,
  );
});

test("configuration service stores credentials outside model and state files", async () => {
  const { workspace, privateDir, env, customProviders } = fixture();
  fs.mkdirSync(path.join(workspace, "src"));
  const secret = "test-secret-that-must-not-leak";
  const view = await saveConfigurationSubmission(
    workspace,
    {
      primary: "local-test/test-model",
      fallbacks: [],
      customProviders,
      credential: { provider: "local-test", apiKey: secret },
      profile: {
        goal: "Maintain a guided setup experience",
        dirs: ["src"],
        tasks: ["implementation", "code-review"],
      },
    },
    env,
  );
  const modelFile = path.join(workspace, ".swarm-pi-code-plugin", "model.json");
  const stateFile = path.join(workspace, ".swarm-pi-code-plugin", "state.json");
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
        credential: { provider: "local-test", apiKey: "valid-test-key" },
      },
      env,
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
        credential: { provider: 42, apiKey: [] } as never,
      },
      env,
    ),
    /Credential must contain a provider and API key string/,
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

  const response = await fetch(`${setupUrl.origin}/api/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swarm-token": token,
      origin: setupUrl.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      primary: "local-test/test-model",
      fallbacks: [],
      customProviders,
      credential: { provider: "local-test", apiKey: secret },
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
  assert.equal(reconfigured.configuration.primary, "local-test/test-model");
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
  assert.equal(fs.existsSync(path.join(workspace, ".swarm-pi-code-plugin", "model.json")), false);
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
  assert.equal(fs.existsSync(path.join(workspace, ".swarm-pi-code-plugin", "model.json")), false);
});
