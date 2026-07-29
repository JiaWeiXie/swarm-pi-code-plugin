import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearModelConfiguration,
  loadModelConfiguration,
  modelPriority,
  parseModelConfiguration,
  prepareProviderRegistryForConfiguration,
  resolveProviderRegistryMigrationConflict,
  resolveModelConfigurationFile,
  saveModelConfiguration,
  saveModelPriority,
} from "../src/state/model-config.js";
import {
  loadProviderRegistry,
  ProviderRegistryConflictError,
  ProviderRegistryRevisionConflictError,
  resolveProviderRegistryFile,
  saveProviderRegistry,
  withProviderRegistryTransaction,
} from "../src/state/provider-registry.js";
import { stableCustomProviderId } from "../src/providers/endpoints.js";

const customProvider = {
  id: "local-openai",
  name: "Local OpenAI",
  baseUrl: "http://127.0.0.1:11434/v1",
  api: "openai-completions" as const,
  authHeader: false,
  requiresApiKey: true,
  models: [
    {
      id: "org/model-name",
      name: "Model name",
      reasoning: false,
      input: ["text" as const],
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  ],
};

test("model.json is canonical, normalized, and written with private permissions", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-config-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-registry-"),
    ),
  };
  const saved = await saveModelConfiguration(
    workspace,
    {
      primary: "local-openai/org/model-name",
      fallbacks: ["openai/fallback", "openai/fallback"],
      customProviders: [customProvider],
    },
    env,
  );
  const file = await resolveModelConfigurationFile(workspace, env);
  const raw = fs.readFileSync(file, "utf8");

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(modelPriority(saved), ["local-openai/org/model-name", "openai/fallback"]);
  assert.deepEqual(await loadModelConfiguration(workspace, [], env), saved);
  assert.equal(JSON.parse(raw).version, 2);
  assert.equal(JSON.parse(raw).customProviders, undefined);
  const registryFile = resolveProviderRegistryFile(env);
  assert.equal(fs.statSync(registryFile).mode & 0o777, 0o600);
  assert.equal((await loadProviderRegistry(env)).customProviders[0]?.id, "local-openai");
  assert.doesNotMatch(raw, /"apiKey"\s*:/i);

  await clearModelConfiguration(workspace, env);
  assert.equal(fs.existsSync(file), false);
});

test("model config falls back to legacy state priority until the first save", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-migrate-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-registry-"),
    ),
  };
  const loaded = await loadModelConfiguration(
    workspace,
    ["anthropic/primary", "openai/fallback"],
    env,
  );
  assert.equal(loaded.updatedAt, null);
  assert.deepEqual(modelPriority(loaded), ["anthropic/primary", "openai/fallback"]);
  assert.equal(fs.existsSync(await resolveModelConfigurationFile(workspace, env)), false);
});

test("Configuration migrates only legacy model providers into the global registry", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-legacy-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-registry-"),
    ),
  };
  const file = await resolveModelConfigurationFile(workspace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      primary: "local-openai/org/model-name",
      fallbacks: [],
      customProviders: [customProvider],
      providerProfiles: [],
      updatedAt: "2026-07-28T00:00:00.000Z",
    })}\n`,
  );

  const migrated = await prepareProviderRegistryForConfiguration(workspace, [], env);

  assert.equal(migrated.customProviders[0]?.id, "local-openai");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
  assert.equal((await loadProviderRegistry(env)).customProviders[0]?.id, "local-openai");
});

test("legacy migration accepts matching provider connections with different verification state", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-profile-state-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-profile-state-"),
    ),
  };
  const connection = {
    id: "openai-codex",
    provider: "openai-codex",
    name: "ChatGPT Plus/Pro",
    connectionKind: "builtin" as const,
    auth: {
      method: "oauth" as const,
      secretRef: "auth:openai-codex",
    },
    runtimeApi: "openai-codex-responses" as const,
    readiness: "verified" as const,
    settings: {},
    headers: [],
  };
  const globalProfile = {
    ...connection,
    verifiedAt: "2026-07-29T03:30:30.286Z",
    verifiedModel: "openai-codex/gpt-5.6-terra",
  };
  await saveProviderRegistry(
    {
      customProviders: [],
      providerProfiles: [globalProfile],
    },
    env,
  );
  const file = await resolveModelConfigurationFile(workspace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      primary: "openai-codex/gpt-5.4",
      fallbacks: [],
      customProviders: [],
      providerProfiles: [
        {
          ...connection,
          name: "OpenAI Codex",
          verifiedAt: "2026-07-11T14:24:13.016Z",
          verifiedModel: "openai-codex/gpt-5.4-mini",
        },
      ],
      updatedAt: null,
    })}\n`,
  );

  const migrated = await prepareProviderRegistryForConfiguration(workspace, [], env);

  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
  assert.equal(migrated.primary, "openai-codex/gpt-5.4");
  assert.deepEqual((await loadProviderRegistry(env)).providerProfiles, [globalProfile]);
});

test("legacy migration rejects different provider profile connection settings", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-profile-conflict-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-profile-conflict-"),
    ),
  };
  const profile = {
    id: customProvider.id,
    provider: customProvider.id,
    name: customProvider.name,
    connectionKind: "custom" as const,
    auth: {
      method: "api-key" as const,
      secretRef: `auth:${customProvider.id}`,
    },
    runtimeApi: "openai-completions" as const,
    readiness: "configured" as const,
    settings: { region: "global" },
    headers: [],
  };
  await saveProviderRegistry(
    {
      customProviders: [customProvider],
      providerProfiles: [profile],
    },
    env,
  );
  const file = await resolveModelConfigurationFile(workspace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      primary: "local-openai/org/model-name",
      fallbacks: [],
      customProviders: [customProvider],
      providerProfiles: [{ ...profile, settings: { region: "legacy" } }],
      updatedAt: null,
    })}\n`,
  );

  await assert.rejects(
    () => prepareProviderRegistryForConfiguration(workspace, [], env),
    ProviderRegistryConflictError,
  );
});

test("legacy migration and stale saves never overwrite global provider conflicts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-conflict-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-registry-"),
    ),
  };
  const first = await saveProviderRegistry(
    { customProviders: [customProvider], providerProfiles: [] },
    env,
  );
  const file = await resolveModelConfigurationFile(workspace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      primary: "local-openai/org/model-name",
      fallbacks: [],
      customProviders: [{ ...customProvider, baseUrl: "http://127.0.0.1:1337/v1" }],
      providerProfiles: [],
      updatedAt: null,
    })}\n`,
  );
  await assert.rejects(
    () => prepareProviderRegistryForConfiguration(workspace, [], env),
    ProviderRegistryConflictError,
  );
  await saveProviderRegistry({ customProviders: [], providerProfiles: [] }, env, first.revision);
  await assert.rejects(
    () =>
      saveProviderRegistry(
        { customProviders: [customProvider], providerProfiles: [] },
        env,
        first.revision,
      ),
    ProviderRegistryRevisionConflictError,
  );
});

test("provider registry rejects content whose integrity revision was altered", async () => {
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-integrity-"),
    ),
  };
  await saveProviderRegistry({ customProviders: [customProvider], providerProfiles: [] }, env);
  const file = resolveProviderRegistryFile(env);
  const altered = JSON.parse(fs.readFileSync(file, "utf8"));
  altered.customProviders[0].baseUrl = "http://127.0.0.1:1337/v1";
  fs.writeFileSync(file, `${JSON.stringify(altered)}\n`);

  await assert.rejects(() => loadProviderRegistry(env), /revision does not match its contents/);
});

test("provider registry transactions serialize cross-session commits", async () => {
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-transaction-"),
    ),
  };
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withProviderRegistryTransaction(async () => {
    events.push("first-start");
    await firstMayFinish;
    events.push("first-end");
  }, env);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = withProviderRegistryTransaction(async () => {
    events.push("second-start");
  }, env);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("saving project model priority cannot overwrite a newer global registry", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-priority-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-priority-"),
    ),
  };
  const stale = await saveModelConfiguration(
    workspace,
    {
      primary: "local-openai/org/model-name",
      fallbacks: [],
      customProviders: [customProvider],
      providerProfiles: [],
    },
    env,
  );
  const secondProvider = {
    ...customProvider,
    id: "second-provider",
    name: "Second provider",
  };
  await saveProviderRegistry(
    {
      customProviders: [customProvider, secondProvider],
      providerProfiles: [],
    },
    env,
    (await loadProviderRegistry(env)).revision,
  );

  await saveModelPriority(workspace, stale, ["local-openai/org/model-name"], env);

  assert.deepEqual(
    (await loadProviderRegistry(env)).customProviders.map((provider) => provider.id),
    ["local-openai", "second-provider"],
  );
});

test("canonical-ID conflict migration creates a distinct provider without credential reuse", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-canonical-conflict-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: fs.mkdtempSync(
      path.join(os.tmpdir(), "swarm-pi-provider-canonical-conflict-"),
    ),
  };
  const providerId = stableCustomProviderId(customProvider.baseUrl, "openai-chat-completions");
  const legacyProvider = {
    ...customProvider,
    id: providerId,
    wireProtocol: "openai-chat-completions" as const,
    auth: {
      method: "api-key" as const,
      secretRef: `auth:${providerId}`,
    },
  };
  await saveProviderRegistry(
    {
      customProviders: [{ ...legacyProvider, name: "Global version" }],
      providerProfiles: [],
    },
    env,
  );
  const file = await resolveModelConfigurationFile(workspace, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      primary: `${providerId}/org/model-name`,
      fallbacks: [],
      customProviders: [legacyProvider],
      providerProfiles: [],
      updatedAt: null,
    })}\n`,
  );

  const migrated = await resolveProviderRegistryMigrationConflict(
    workspace,
    providerId,
    "import-new",
    env,
  );
  const registry = await loadProviderRegistry(env);

  assert.notEqual(migrated.providerId, providerId);
  const imported = registry.customProviders.find((provider) => provider.id === migrated.providerId);
  assert.equal(imported?.auth?.secretRef, `auth:${migrated.providerId}`);
  assert.equal(registry.customProviders.length, 2);
  assert.equal(
    (await loadModelConfiguration(workspace, [], env)).primary,
    `${migrated.providerId}/org/model-name`,
  );
});

test("custom provider config rejects embedded secrets and invalid model references", () => {
  assert.throws(
    () =>
      parseModelConfiguration({
        version: 1,
        primary: "secret/model",
        fallbacks: [],
        updatedAt: null,
        customProviders: [{ ...customProvider, apiKey: "must-not-be-here" }],
      }),
    /may not contain apiKey/,
  );
  assert.throws(
    () =>
      parseModelConfiguration({
        version: 1,
        primary: "missing-separator",
        fallbacks: [],
        customProviders: [],
        updatedAt: null,
      }),
    /provider\/model/,
  );
});

test("custom model limits can remain automatic and retain metadata provenance", () => {
  const configuration = parseModelConfiguration({
    version: 1,
    primary: "local-auto/model-a",
    fallbacks: [],
    updatedAt: null,
    customProviders: [
      {
        id: "local-auto",
        name: "Local Auto",
        baseUrl: "http://127.0.0.1:1234/v1",
        api: "openai-completions",
        authHeader: false,
        requiresApiKey: false,
        models: [{ id: "model-a" }],
      },
    ],
  });
  const model = configuration.customProviders[0]?.models[0];
  assert.equal(model?.contextWindow, undefined);
  assert.equal(model?.maxTokens, undefined);
  assert.equal(configuration.customProviders[0]?.requiresApiKey, false);

  const withMetadata = parseModelConfiguration({
    ...configuration,
    customProviders: [
      {
        ...configuration.customProviders[0],
        models: [
          {
            id: "model-a",
            contextWindow: 131_072,
            metadata: { contextWindow: "endpoint" },
          },
        ],
      },
    ],
  });
  assert.equal(withMetadata.customProviders[0]?.models[0]?.metadata?.contextWindow, "endpoint");
});
