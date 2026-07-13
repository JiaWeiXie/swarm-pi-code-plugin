import assert from "node:assert/strict";
import test from "node:test";

import type { PiModel } from "../src/pi/models.js";
import {
  discoverEndpoint,
  discoverLocalEndpoints,
  EndpointDiscoveryError,
} from "../src/web/model-discovery.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockedFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: URL | RequestInfo, init: RequestInit = {}) =>
    handler(
      new URL(input instanceof Request ? input.url : input.toString()),
      init,
    )) as typeof fetch;
}

const catalogModel = {
  id: "gpt-test",
  name: "GPT Test",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 24_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as PiModel;

test("OpenAI-compatible discovery finds models and enriches missing limits from Pi", async () => {
  const fetchImpl = mockedFetch((url) => {
    if (url.pathname.endsWith("/v1/models")) return json({ data: [{ id: "gpt-test" }] });
    return json({ error: "not found" }, 404);
  });
  const result = await discoverEndpoint(
    {
      baseUrl: "https://models.example.test",
      protocol: "openai-chat-completions",
      apiKey: "secret",
    },
    [catalogModel],
    { fetchImpl },
  );

  assert.equal(result.adapter, "openai-chat-completions");
  assert.match(result.provider.id, /^custom-models\.example\.test-/);
  assert.equal(result.provider.authHeader, true);
  assert.equal(result.provider.requiresApiKey, true);
  assert.equal(result.provider.wireProtocol, "openai-chat-completions");
  assert.deepEqual(result.provider.models[0], {
    id: "gpt-test",
    name: "GPT Test",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 24_000,
    metadata: { contextWindow: "pi-catalog", maxTokens: "pi-catalog" },
  });
});

test("endpoint discovery derives a stable protocol-specific provider identifier", async () => {
  const fetchImpl = mockedFetch((url) => {
    if (url.pathname.endsWith("/v1/models")) return json({ data: [{ id: "local-model" }] });
    return json({ error: "not found" }, 404);
  });
  const result = await discoverEndpoint(
    { baseUrl: "http://127.0.0.1:1234", protocol: "openai-responses" },
    [],
    { fetchImpl, reservedProviderIds: ["custom-ignored"] },
  );

  assert.match(result.provider.id, /^custom-127\.0\.0\.1-1234-/);
  assert.equal(result.provider.api, "openai-responses");
});

test("Anthropic discovery keeps endpoint-reported capabilities and limits", async () => {
  const fetchImpl = mockedFetch((url, init) => {
    if (url.pathname === "/v1/models") {
      assert.equal(new Headers(init.headers).get("x-api-key"), "anthropic-key");
      return json({
        data: [
          {
            id: "claude-test",
            display_name: "Claude Test",
            max_input_tokens: 180_000,
            max_tokens: 12_000,
            capabilities: {
              thinking: { supported: true },
              image_input: { supported: true },
            },
          },
        ],
      });
    }
    return json({}, 404);
  });
  const result = await discoverEndpoint(
    {
      baseUrl: "https://api.anthropic.com/v1",
      protocol: "anthropic-messages",
      apiKey: "anthropic-key",
    },
    [],
    { fetchImpl },
  );

  assert.equal(result.adapter, "anthropic-messages");
  assert.equal(result.provider.api, "anthropic-messages");
  assert.equal(result.provider.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(result.provider.models[0]?.metadata, {
    contextWindow: "endpoint",
    maxTokens: "endpoint",
  });
  assert.deepEqual(result.provider.models[0]?.input, ["text", "image"]);
  assert.equal(result.provider.models[0]?.reasoning, true);
});

test("Ollama discovery uses native model details without requiring an API key", async () => {
  const fetchImpl = mockedFetch((url, init) => {
    if (url.pathname === "/api/v1/models") return json({}, 404);
    if (url.pathname === "/api/tags") return json({ models: [{ model: "qwen:latest" }] });
    if (url.pathname === "/api/show") {
      assert.equal(init.method, "POST");
      return json({
        capabilities: ["completion", "vision"],
        model_info: { "qwen.context_length": 131_072 },
      });
    }
    return json({}, 404);
  });
  const results = await discoverLocalEndpoints([], { fetchImpl });
  const result = results.find((entry) => entry.adapter === "ollama")!;

  assert.equal(result.adapter, "ollama");
  assert.equal(result.provider.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(result.provider.requiresApiKey, false);
  assert.equal(result.provider.models[0]?.contextWindow, 131_072);
  assert.equal(result.provider.models[0]?.maxTokens, undefined);
});

test("endpoint discovery reports actionable security and connection failures", async () => {
  await assert.rejects(
    () =>
      discoverEndpoint({
        baseUrl: "http://169.254.169.254/latest",
        protocol: "openai-chat-completions",
      }),
    (error: unknown) => error instanceof EndpointDiscoveryError && error.code === "invalid-url",
  );

  const unauthorized = mockedFetch(() => json({ error: "invalid key" }, 401));
  await assert.rejects(
    () =>
      discoverEndpoint(
        {
          baseUrl: "https://models.example.test",
          protocol: "openai-chat-completions",
          apiKey: "wrong",
        },
        [],
        { fetchImpl: unauthorized },
      ),
    (error: unknown) => error instanceof EndpointDiscoveryError && error.code === "authentication",
  );

  const malformed = mockedFetch(() => new Response("not-json", { status: 200 }));
  await assert.rejects(
    () =>
      discoverEndpoint(
        { baseUrl: "https://models.example.test", protocol: "openai-responses" },
        [],
        { fetchImpl: malformed },
      ),
    (error: unknown) =>
      error instanceof EndpointDiscoveryError && error.code === "malformed-response",
  );
});
