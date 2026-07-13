import { createHash } from "node:crypto";

import type { SupportedProviderApi } from "../state/model-config.js";
import type { WireProtocol } from "./capabilities.js";

const GENERATION_SUFFIXES = ["/chat/completions", "/responses", "/v1/messages", "/messages"];

export function runtimeApiForWireProtocol(protocol: WireProtocol): SupportedProviderApi {
  switch (protocol) {
    case "openai-chat-completions":
      return "openai-completions";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
  }
}

export function wireProtocolForRuntimeApi(api: SupportedProviderApi): WireProtocol | undefined {
  switch (api) {
    case "openai-completions":
      return "openai-chat-completions";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
    case "google-generative-ai":
      return undefined;
  }
}

export function normalizeProtocolRoot(value: string, protocol: WireProtocol): string {
  const url = safeHttpUrl(value, "endpoint");
  const path = url.pathname.replace(/\/+$/, "");
  if (GENERATION_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) {
    throw new Error("Enter the API root, not a full generation endpoint");
  }
  if (protocol === "anthropic-messages") {
    url.pathname = path.replace(/\/v1$/i, "") || "/";
  } else {
    url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  }
  return url.toString().replace(/\/$/, "");
}

export function protocolModelsUrl(root: string, protocol: WireProtocol): URL {
  const url = safeHttpUrl(root, "endpoint");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname =
    protocol === "anthropic-messages"
      ? `${path}/v1/models`.replace(/\/+/g, "/")
      : `${path}/models`.replace(/\/+/g, "/");
  return url;
}

export function normalizeModelsEndpoint(value: string, generationRoot: string): string {
  const url = safeHttpUrl(value, "models endpoint");
  const root = safeHttpUrl(generationRoot, "endpoint");
  if (url.origin !== root.origin) {
    throw new Error("Models endpoint must use the same origin as the generation endpoint");
  }
  return url.toString();
}

export function stableCustomProviderId(root: string, protocol: WireProtocol): string {
  const url = safeHttpUrl(root, "endpoint");
  const slug =
    `${url.hostname}${url.port ? `-${url.port}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "endpoint";
  const hash = createHash("sha256")
    .update(`${url.toString().replace(/\/$/, "")}|${protocol}`)
    .digest("hex")
    .slice(0, 10);
  return `custom-${slug}-${hash}`.slice(0, 64);
}

export function safeHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Enter a valid ${label} URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} URL may not contain credentials`);
  }
  url.hash = "";
  url.search = "";
  return url;
}
