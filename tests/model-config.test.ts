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
  resolveModelConfigurationFile,
  saveModelConfiguration,
} from "../src/state/model-config.js";

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
  const saved = await saveModelConfiguration(workspace, {
    primary: "local-openai/org/model-name",
    fallbacks: ["openai/fallback", "openai/fallback"],
    customProviders: [customProvider],
  });
  const file = await resolveModelConfigurationFile(workspace);
  const raw = fs.readFileSync(file, "utf8");

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(modelPriority(saved), ["local-openai/org/model-name", "openai/fallback"]);
  assert.deepEqual(await loadModelConfiguration(workspace), saved);
  assert.doesNotMatch(raw, /"apiKey"\s*:/i);

  await clearModelConfiguration(workspace);
  assert.equal(fs.existsSync(file), false);
});

test("model config falls back to legacy state priority until the first save", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-model-migrate-"));
  const loaded = await loadModelConfiguration(workspace, ["anthropic/primary", "openai/fallback"]);
  assert.equal(loaded.updatedAt, null);
  assert.deepEqual(modelPriority(loaded), ["anthropic/primary", "openai/fallback"]);
  assert.equal(fs.existsSync(await resolveModelConfigurationFile(workspace)), false);
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
