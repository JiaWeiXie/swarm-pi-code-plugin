import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { createPiEnvironment, customProviderHeaderVariable } from "../src/pi/environment.js";
import { parseModelConfiguration, providerHeaderSecretRef } from "../src/state/model-config.js";

test("provider profiles overlay adapter environment without mutating process.env", async () => {
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [],
    providerProfiles: [
      {
        id: "azure-openai-responses",
        provider: "azure-openai-responses",
        name: "Azure OpenAI",
        connectionKind: "builtin",
        auth: { method: "api-key", secretRef: "auth:azure-openai-responses" },
        runtimeApi: "azure-openai-responses",
        readiness: "configured",
        settings: {
          resourceName: "project-resource",
          apiVersion: "v1",
          deploymentNameMap: "gpt-test=worker",
        },
        headers: [],
      },
    ],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify("azure-openai-responses", async () => ({
    type: "api_key",
    key: "secret",
    env: { EXISTING: "preserved" },
  }));
  const before = process.env.AZURE_OPENAI_RESOURCE_NAME;
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });
  const credential = await environment.credentials.read("azure-openai-responses");

  assert.deepEqual(credential && credential.type === "api_key" ? credential.env : undefined, {
    EXISTING: "preserved",
    AZURE_OPENAI_RESOURCE_NAME: "project-resource",
    AZURE_OPENAI_API_VERSION: "v1",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-test=worker",
  });
  assert.equal(process.env.AZURE_OPENAI_RESOURCE_NAME, before);
});

test("OpenAI profile metadata becomes controlled headers", async () => {
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [],
    providerProfiles: [
      {
        id: "openai",
        provider: "openai",
        name: "OpenAI",
        connectionKind: "builtin",
        auth: { method: "api-key", secretRef: "auth:openai" },
        protocol: "openai-responses",
        runtimeApi: "openai-responses",
        readiness: "configured",
        settings: { organization: "org_example", project: "proj_example" },
        headers: [],
      },
    ],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify("openai", async () => ({ type: "api_key", key: "secret" }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });
  const model = [...environment.modelRuntime.getModels()].find(
    (candidate) => candidate.provider === "openai",
  )!;
  const requestAuth = await environment.modelRuntime.getAuth(model);

  assert.ok(requestAuth);
  if (requestAuth) {
    assert.equal(requestAuth.auth.headers?.["OpenAI-Organization"], "org_example");
    assert.equal(requestAuth.auth.headers?.["OpenAI-Project"], "proj_example");
  }
});

test("custom secret headers resolve only through provider-scoped CredentialStore env", async () => {
  const provider = "custom-header-test";
  const variable = customProviderHeaderVariable(provider, "x-api-key");
  const configuration = parseModelConfiguration({
    version: 1,
    primary: `${provider}/model`,
    fallbacks: [],
    customProviders: [
      {
        id: provider,
        name: "Header Test",
        baseUrl: "https://models.example.test",
        api: "anthropic-messages",
        wireProtocol: "anthropic-messages",
        authHeader: false,
        requiresApiKey: true,
        auth: {
          method: "custom-header",
          secretRef: `auth:${provider}`,
          headerName: "x-api-key",
        },
        headers: [
          {
            name: "x-api-key",
            secretRef: providerHeaderSecretRef(provider, "x-api-key"),
          },
        ],
        models: [{ id: "model" }],
      },
    ],
    providerProfiles: [
      {
        id: provider,
        provider,
        name: "Header Test",
        connectionKind: "custom",
        auth: {
          method: "custom-header",
          secretRef: `auth:${provider}`,
          headerName: "x-api-key",
        },
        protocol: "anthropic-messages",
        runtimeApi: "anthropic-messages",
        readiness: "configured",
        settings: {},
        headers: [
          {
            name: "x-api-key",
            secretRef: providerHeaderSecretRef(provider, "x-api-key"),
          },
        ],
      },
    ],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify(provider, async () => ({
    type: "api_key",
    key: "local-no-auth",
    env: { [variable]: "header-secret" },
  }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });
  const model = environment.modelRuntime.getModel(provider, "model")!;
  const requestAuth = await environment.modelRuntime.getAuth(model);

  assert.ok(requestAuth);
  if (requestAuth) {
    assert.equal(requestAuth.auth.headers?.["X-Api-Key"], "header-secret");
    assert.equal(requestAuth.env?.[variable], "header-secret");
  }
  assert.doesNotMatch(JSON.stringify(configuration), /header-secret/);
});

test("literal provider headers cannot invoke Pi config expansion", async () => {
  process.env.SWARM_HEADER_MUST_NOT_EXPAND = "expanded-secret";
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [],
    providerProfiles: [
      {
        id: "openrouter",
        provider: "openrouter",
        name: "OpenRouter",
        connectionKind: "builtin",
        auth: { method: "api-key", secretRef: "auth:openrouter" },
        protocol: "openai-chat-completions",
        runtimeApi: "openai-completions",
        readiness: "configured",
        settings: {
          appTitle: "!printf unsafe",
        },
        headers: [{ name: "anthropic-beta", value: "$SWARM_HEADER_MUST_NOT_EXPAND" }],
      },
    ],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify("openrouter", async () => ({ type: "api_key", key: "secret" }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });
  const model = [...environment.modelRuntime.getModels()].find(
    (candidate) => candidate.provider === "openrouter",
  )!;
  const requestAuth = await environment.modelRuntime.getAuth(model);

  assert.ok(requestAuth);
  if (requestAuth) {
    assert.equal(requestAuth.auth.headers?.["X-Title"], "!printf unsafe");
    assert.equal(requestAuth.auth.headers?.["Anthropic-Beta"], "$SWARM_HEADER_MUST_NOT_EXPAND");
  }
  delete process.env.SWARM_HEADER_MUST_NOT_EXPAND;
});

test("openai-family custom providers clamp reasoning effort into the OpenAI/Azure-safe set", async () => {
  const provider = "azure-responses-test";
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [
      {
        id: provider,
        name: "Azure Responses",
        baseUrl: "https://resource.services.ai.azure.com/openai/v1",
        api: "openai-responses",
        // Azure OpenAI Responses persists as the plain openai-responses wire protocol.
        wireProtocol: "openai-responses",
        authHeader: true,
        requiresApiKey: true,
        auth: { method: "api-key", secretRef: `auth:${provider}` },
        models: [
          { id: "gpt-5.6-luna", reasoning: true },
          { id: "gpt-3.5-nonreasoning", reasoning: false },
        ],
      },
    ],
    providerProfiles: [],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify(provider, async () => ({ type: "api_key", key: "secret" }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });

  const reasoning = environment.modelRuntime.getModel(provider, "gpt-5.6-luna")!;
  // "minimal" (OpenAI-only) and "off" clamp down to Azure's floor; "xhigh"/"max"
  // clamp down to "high" so nothing outside {low,medium,high} ever reaches the wire.
  assert.deepEqual(reasoning.thinkingLevelMap, {
    off: "low",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  });

  // Non-reasoning models get no map, so no reasoning.effort is emitted for them.
  const plain = environment.modelRuntime.getModel(provider, "gpt-3.5-nonreasoning")!;
  assert.equal(plain.thinkingLevelMap, undefined);
});

test("anthropic-messages custom providers are excluded from the OpenAI effort map", async () => {
  const provider = "anthropic-compat-test";
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [
      {
        id: provider,
        name: "Anthropic Compatible",
        baseUrl: "https://models.example.test",
        api: "anthropic-messages",
        wireProtocol: "anthropic-messages",
        authHeader: false,
        requiresApiKey: true,
        auth: { method: "api-key", secretRef: `auth:${provider}` },
        models: [{ id: "claude-compat", reasoning: true }],
      },
    ],
    providerProfiles: [],
    updatedAt: null,
  });
  const storage = new InMemoryCredentialStore();
  await storage.modify(provider, async () => ({ type: "api_key", key: "secret" }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });

  // Claude takes effort via output_config.effort + native thinking config, not a
  // reasoning.effort string — so a clamped map must NOT be injected here.
  const model = environment.modelRuntime.getModel(provider, "claude-compat")!;
  assert.equal(model.thinkingLevelMap, undefined);
});
