import assert from "node:assert/strict";
import test from "node:test";

import { AuthStorage } from "@earendil-works/pi-coding-agent";

import {
  createPiEnvironment,
  customProviderHeaderVariable,
} from "../src/pi/environment.js";
import { parseModelConfiguration, providerHeaderSecretRef } from "../src/state/model-config.js";

test("provider profiles overlay adapter environment without mutating process.env", () => {
  const configuration = parseModelConfiguration({
    version: 1,
    primary: null,
    fallbacks: [],
    customProviders: [],
    providerProfiles: [{
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
    }],
    updatedAt: null,
  });
  const storage = AuthStorage.inMemory({
    "azure-openai-responses": { type: "api_key", key: "secret", env: { EXISTING: "preserved" } },
  });
  const before = process.env.AZURE_OPENAI_RESOURCE_NAME;
  const environment = createPiEnvironment(configuration, {}, { authStorage: storage });

  assert.deepEqual(environment.authStorage.getProviderEnv("azure-openai-responses"), {
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
    providerProfiles: [{
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
    }],
    updatedAt: null,
  });
  const environment = createPiEnvironment(configuration, {}, {
    authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "secret" } }),
  });
  const model = environment.modelRegistry.getAll().find((candidate) => candidate.provider === "openai")!;
  const requestAuth = await environment.modelRegistry.getApiKeyAndHeaders(model);

  assert.equal(requestAuth.ok, true);
  if (requestAuth.ok) {
    assert.equal(requestAuth.headers?.["OpenAI-Organization"], "org_example");
    assert.equal(requestAuth.headers?.["OpenAI-Project"], "proj_example");
  }
});

test("custom secret headers resolve only through provider-scoped AuthStorage env", async () => {
  const provider = "custom-header-test";
  const variable = customProviderHeaderVariable(provider, "x-api-key");
  const configuration = parseModelConfiguration({
    version: 1,
    primary: `${provider}/model`,
    fallbacks: [],
    customProviders: [{
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
      headers: [{
        name: "x-api-key",
        secretRef: providerHeaderSecretRef(provider, "x-api-key"),
      }],
      models: [{ id: "model" }],
    }],
    providerProfiles: [{
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
      headers: [{
        name: "x-api-key",
        secretRef: providerHeaderSecretRef(provider, "x-api-key"),
      }],
    }],
    updatedAt: null,
  });
  const environment = createPiEnvironment(configuration, {}, {
    authStorage: AuthStorage.inMemory({
      [provider]: { type: "api_key", key: "local-no-auth", env: { [variable]: "header-secret" } },
    }),
  });
  const model = environment.modelRegistry.find(provider, "model")!;
  const requestAuth = await environment.modelRegistry.getApiKeyAndHeaders(model);

  assert.equal(requestAuth.ok, true);
  if (requestAuth.ok) {
    assert.equal(requestAuth.headers?.["X-Api-Key"], "header-secret");
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
    providerProfiles: [{
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
    }],
    updatedAt: null,
  });
  const environment = createPiEnvironment(configuration, {}, {
    authStorage: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "secret" } }),
  });
  const model = environment.modelRegistry.getAll().find((candidate) => candidate.provider === "openrouter")!;
  const requestAuth = await environment.modelRegistry.getApiKeyAndHeaders(model);

  assert.equal(requestAuth.ok, true);
  if (requestAuth.ok) {
    assert.equal(requestAuth.headers?.["X-Title"], "!printf unsafe");
    assert.equal(requestAuth.headers?.["Anthropic-Beta"], "$SWARM_HEADER_MUST_NOT_EXPAND");
  }
  delete process.env.SWARM_HEADER_MUST_NOT_EXPAND;
});
