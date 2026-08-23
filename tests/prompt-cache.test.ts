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

test("worker prompt names the active host without changing the prompt version", () => {
  const expected: Record<string, string> = {
    claude: "Delegated Pi worker under Claude Code.",
    codex: "Delegated Pi worker under Codex.",
    "agent-plugin": "Delegated Pi worker under an Agent Plugins-compatible client.",
  };
  for (const [host, context] of Object.entries(expected)) {
    const prompt = buildWorkerPrompt({
      host: host as Parameters<typeof buildWorkerPrompt>[0]["host"],
      kind: "ask",
      prompt: "Request body.",
    });
    assert.match(prompt, new RegExp(`^\\[PROMPT\\]\\nversion=${WORKER_PROMPT_VERSION}`));
    assert.ok(prompt.includes(`[HOST]\n${context}`), `missing host context: ${host}`);
  }
});

test("worker task contracts state observable completion evidence", () => {
  const expected: Record<Parameters<typeof buildWorkerPrompt>[0]["kind"], RegExp> = {
    ask: /material claim.*file and line.*unknowns/i,
    review: /impact, evidence, location.*smallest safe response/i,
    plan: /observable verification.*risk or rollback/i,
    implement: /inspected diff and targeted verification/i,
    orchestrate: /claims to evidence.*uncertainty and conflicts/i,
    scaffold: /every staged file and verification result/i,
    setup: /every change and verification result/i,
    discover: /fixed schema-gated sequence.*Human Decision gates/i,
  };
  for (const [kind, pattern] of Object.entries(expected)) {
    const prompt = buildWorkerPrompt({
      host: "codex",
      kind: kind as Parameters<typeof buildWorkerPrompt>[0]["kind"],
      prompt: "Request body.",
    });
    assert.match(prompt, pattern, `missing task contract: ${kind}`);
    assert.ok(prompt.endsWith("[REQUEST]\nRequest body."));
  }
});
