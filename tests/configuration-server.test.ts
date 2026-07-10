import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadState } from "../src/state/state.js";
import {
  loadConfigurationView,
  saveConfigurationSubmission,
} from "../src/web/configuration-service.js";
import { startConfigurationServer } from "../src/web/configuration-server.js";

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

test("configuration service stores credentials outside model and state files", async () => {
  const { workspace, privateDir, env, customProviders } = fixture();
  const secret = "test-secret-that-must-not-leak";
  const view = await saveConfigurationSubmission(
    workspace,
    {
      primary: "local-test/test-model",
      fallbacks: [],
      customProviders,
      credential: { provider: "local-test", apiKey: secret },
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
});

test("configuration service validates every fallback and credential payload", async () => {
  const { workspace, env, customProviders } = fixture();
  const inventory = await loadConfigurationView(workspace, env);
  const unavailableFallback = inventory.models.find((model) => !model.available)?.id;
  assert.ok(unavailableFallback);

  await assert.rejects(
    () => saveConfigurationSubmission(
      workspace,
      {
        primary: "local-test/test-model",
        fallbacks: [unavailableFallback],
        customProviders,
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
  assert.match(html, /Model setup/);
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
