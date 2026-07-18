import assert from "node:assert/strict";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  CUSTOM_ENDPOINT_GUIDANCE,
  getProviderDefinition,
  listProviderDefinitions,
  providerDefinitionIds,
  unknownProviderIds,
} from "../src/providers/capabilities.js";
import {
  normalizeModelsEndpoint,
  normalizeProtocolRoot,
  protocolModelsUrl,
  stableCustomProviderId,
} from "../src/providers/endpoints.js";
import { parseModelConfiguration } from "../src/state/model-config.js";

test("provider capability registry covers every provider in the pinned Pi catalog", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const piProviders = runtime
    .getProviders()
    .map((provider) => provider.id)
    .sort();

  assert.deepEqual(unknownProviderIds(piProviders), []);
  assert.deepEqual(providerDefinitionIds(), piProviders);
});

test("subscription providers use OAuth and keep ChatGPT separate from OpenAI API keys", () => {
  const openAi = getProviderDefinition("openai")!;
  const chatGpt = getProviderDefinition("openai-codex")!;

  assert.deepEqual(openAi.authMethods, ["api-key"]);
  assert.equal(openAi.wireProtocol, "openai-responses");
  assert.deepEqual(chatGpt.authMethods, ["oauth"]);
  assert.deepEqual(chatGpt.runtimeApis, ["openai-codex-responses"]);
  assert.equal(chatGpt.oauthProvider, "openai-codex");
  assert.equal(chatGpt.fields.length, 0);
});

test("provider optional fields and custom endpoint controls carry safe structured guidance", () => {
  const guidedFields = listProviderDefinitions()
    .flatMap((provider) => provider.fields)
    .filter((field) => !field.secret && (field.advanced || !field.required));
  assert.ok(guidedFields.length > 0);
  for (const field of guidedFields) {
    assert.ok(field.guidance?.hint, `${field.id} should explain when to use the field`);
    assert.match(field.guidance?.guideAnchor ?? "", /^[a-z0-9][a-z0-9-]*$/);
    if (field.guidance?.example && field.type === "url") {
      const url = new URL(field.guidance.example);
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.equal(url.search, "");
    }
    assert.doesNotMatch(field.guidance?.example ?? "", /bearer|api[_-]?key|token|password/i);
  }

  const expectedCustomControls = [
    "endpoint-protocol",
    "endpoint-url",
    "endpoint-auth-method",
    "endpoint-header",
    "endpoint-key",
    "models-endpoint",
    "custom-http-referer",
    "custom-app-title",
    "custom-anthropic-beta",
    "manual-model-ids",
    "endpoint-name",
    "endpoint-canonical-url",
    "endpoint-api",
    "advanced-model-limits",
  ];
  assert.deepEqual(Object.keys(CUSTOM_ENDPOINT_GUIDANCE).sort(), expectedCustomControls.sort());
  for (const [id, guidance] of Object.entries(CUSTOM_ENDPOINT_GUIDANCE)) {
    assert.ok(guidance.hint, id);
    assert.match(guidance.guideAnchor, /^[a-z0-9][a-z0-9-]*$/);
    assert.doesNotMatch(guidance.example ?? "", /bearer|api[_-]?key|token|password/i);
  }
});

test("protocol URL policy distinguishes OpenAI roots from Anthropic service roots", () => {
  assert.equal(
    normalizeProtocolRoot("https://api.example.test", "openai-chat-completions"),
    "https://api.example.test/v1",
  );
  assert.equal(
    normalizeProtocolRoot("https://api.anthropic.com/v1", "anthropic-messages"),
    "https://api.anthropic.com",
  );
  assert.equal(
    protocolModelsUrl("https://api.anthropic.com", "anthropic-messages").toString(),
    "https://api.anthropic.com/v1/models",
  );
  assert.throws(
    () =>
      normalizeProtocolRoot(
        "https://api.example.test/v1/chat/completions",
        "openai-chat-completions",
      ),
    /API root/,
  );
  assert.throws(
    () =>
      normalizeModelsEndpoint("https://other.example.test/models", "https://api.example.test/v1"),
    /same origin/,
  );
});

test("custom provider identifiers are stable across workspaces and protocol-specific", () => {
  const first = stableCustomProviderId("https://models.example.test/v1", "openai-responses");
  const second = stableCustomProviderId("https://models.example.test/v1/", "openai-responses");
  const chat = stableCustomProviderId("https://models.example.test/v1", "openai-chat-completions");

  assert.equal(first, second);
  assert.notEqual(first, chat);
  assert.match(first, /^custom-models\.example\.test-[a-f0-9]{10}$/);
});

test("legacy custom providers migrate in memory without persisting secrets", () => {
  const configuration = parseModelConfiguration({
    version: 1,
    primary: "legacy/model",
    fallbacks: [],
    customProviders: [
      {
        id: "legacy",
        name: "Legacy Anthropic",
        baseUrl: "https://anthropic.example.test/v1",
        api: "anthropic-messages",
        authHeader: false,
        requiresApiKey: true,
        models: [{ id: "model" }],
      },
    ],
    updatedAt: null,
  });

  const provider = configuration.customProviders[0]!;
  assert.equal(provider.baseUrl, "https://anthropic.example.test");
  assert.equal(provider.wireProtocol, "anthropic-messages");
  assert.deepEqual(provider.auth, { method: "api-key", secretRef: "auth:legacy" });
  assert.deepEqual(configuration.providerProfiles, []);
  assert.doesNotMatch(JSON.stringify(configuration), /sk-|apiKey/);

  const noAuth = parseModelConfiguration({
    ...configuration,
    primary: "local/model",
    customProviders: [
      {
        id: "local",
        name: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        authHeader: false,
        requiresApiKey: false,
        models: [{ id: "model" }],
      },
    ],
  });
  assert.deepEqual(noAuth.customProviders[0]?.auth, { method: "none" });
});

test("provider profiles accept controlled references and reject secret material", () => {
  const valid = parseModelConfiguration({
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
        readiness: "verified",
        settings: { organization: "org_example" },
        headers: [],
        verifiedAt: "2026-07-11T00:00:00.000Z",
        verifiedModel: "openai/gpt-test",
      },
    ],
    updatedAt: null,
  });
  assert.equal(valid.providerProfiles[0]?.readiness, "verified");

  assert.throws(
    () =>
      parseModelConfiguration({
        ...valid,
        providerProfiles: [
          {
            ...valid.providerProfiles[0],
            settings: { apiKey: "must-not-be-stored" },
          },
        ],
      }),
    /may not contain secrets/,
  );
  assert.throws(
    () =>
      parseModelConfiguration({
        ...valid,
        providerProfiles: [
          {
            ...valid.providerProfiles[0],
            headers: [{ name: "authorization", value: "Bearer secret" }],
          },
        ],
      }),
    /must use secretRef/,
  );
  assert.throws(
    () =>
      parseModelConfiguration({
        ...valid,
        providerProfiles: [
          valid.providerProfiles[0],
          { ...valid.providerProfiles[0], id: "openai-secondary" },
        ],
      }),
    /only one provider profile/,
  );
});
