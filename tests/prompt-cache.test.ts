import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { createPiEnvironment } from "../src/pi/environment.js";
import { buildWorkerPrompt, WORKER_PROMPT_VERSION } from "../src/runner/prompts.js";
import { getProviderDefinition } from "../src/providers/capabilities.js";
import { parseModelConfiguration } from "../src/state/model-config.js";

test("prompt cache capability metadata reflects pinned provider behavior", () => {
  const openai = getProviderDefinition("openai")!;
  const anthropic = getProviderDefinition("anthropic")!;
  const google = getProviderDefinition("google")!;
  const codex = getProviderDefinition("openai-codex")!;
  const vertex = getProviderDefinition("google-vertex")!;
  const custom = getProviderDefinition("custom")!;

  assert.deepEqual(openai.promptCaching, {
    support: "native-automatic",
    defaultRetention: "short",
    extendedRetention: { value: "long", duration: "24h", authMethods: ["api-key"] },
  });
  assert.equal(anthropic.promptCaching?.support, "native-explicit");
  assert.equal(google.promptCaching?.support, "implicit-only");
  assert.equal(vertex.promptCaching?.support, "implicit-only");
  assert.equal(custom.promptCaching?.support, "protocol-dependent");
  assert.equal(codex.promptCaching?.extendedRetention, undefined);
  assert.equal(
    codex.fields.some((field) => field.id === "promptCacheRetention"),
    false,
  );
  assert.equal(
    google.fields.some((field) => field.id === "promptCacheRetention"),
    false,
  );
  assert.equal(
    anthropic.fields.find((field) => field.id === "promptCacheRetention")?.visibleWhen?.equals,
    "api-key",
  );
});

test("long prompt cache retention is provider-scoped and does not mutate process.env", async () => {
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
        settings: { promptCacheRetention: "long" },
        headers: [],
      },
    ],
    updatedAt: null,
  });
  const before = process.env.PI_CACHE_RETENTION;
  const storage = new InMemoryCredentialStore();
  await storage.modify("openai", async () => ({ type: "api_key", key: "secret" }));
  const environment = await createPiEnvironment(configuration, {}, { credentials: storage });
  const credential = await environment.credentials.read("openai");
  assert.equal(
    credential?.type === "api_key" ? credential.env?.PI_CACHE_RETENTION : undefined,
    "long",
  );
  assert.equal(process.env.PI_CACHE_RETENTION, before);
  assert.equal(await environment.credentials.read("anthropic"), undefined);
});

test("extended retention is rejected for OAuth profiles", () => {
  assert.throws(
    () =>
      parseModelConfiguration({
        version: 1,
        primary: null,
        fallbacks: [],
        customProviders: [],
        providerProfiles: [
          {
            id: "anthropic",
            provider: "anthropic",
            name: "Anthropic",
            connectionKind: "builtin",
            auth: { method: "oauth", secretRef: "auth:anthropic" },
            protocol: "anthropic-messages",
            runtimeApi: "anthropic-messages",
            readiness: "configured",
            settings: { promptCacheRetention: "long" },
            headers: [],
          },
        ],
        updatedAt: null,
      }),
    /unavailable/,
  );
});

test("worker prompt has a versioned stable prefix and request last", () => {
  const prompt = buildWorkerPrompt({
    host: "codex",
    kind: "review",
    perspective: "security",
    projectGoal: "ship",
    renderedProjectPolicy:
      "Project policy abc123: tasks [review]; roots [read: src; search: src; write: src; shell: src]",
    prompt: "Inspect the request.",
  });
  assert.match(prompt, new RegExp(`^\\[PROMPT\\]\\nversion=${WORKER_PROMPT_VERSION}`));
  assert.ok(prompt.indexOf("[HOST]") < prompt.indexOf("[TASK]"));
  assert.ok(prompt.indexOf("[TASK]") < prompt.indexOf("[PERSPECTIVE]"));
  assert.ok(prompt.indexOf("[PERSPECTIVE]") < prompt.indexOf("[PROJECT]"));
  assert.ok(prompt.indexOf("[PROJECT]") < prompt.indexOf("[REQUEST]"));
  assert.equal(prompt.slice(prompt.indexOf("[REQUEST]")).includes("Inspect the request."), true);
  const projectSection = prompt.slice(prompt.indexOf("[PROJECT]"), prompt.indexOf("[REQUEST]"));
  assert.ok(projectSection.includes("Project goal: ship"));
  assert.ok(projectSection.includes("Project policy abc123:"));
  assert.equal(projectSection.includes("Directories in scope:"), false);
});
