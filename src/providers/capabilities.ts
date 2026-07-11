export const WIRE_PROTOCOLS = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export type WireProtocol = (typeof WIRE_PROTOCOLS)[number];

export type ProviderRuntimeApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | "google-vertex"
  | "mistral-conversations"
  | "openai-codex-responses";

export type ProviderAuthMethod = "api-key" | "oauth" | "ambient" | "none" | "custom-header";
export type ProviderCategory = "common" | "subscription" | "cloud" | "local" | "custom";
export type ProviderProtocolMode = "fixed" | "managed-per-model" | "selectable";
export type ConnectionReadiness = "configured" | "discovered" | "verified" | "blocked";

export interface ProviderFieldCondition {
  field: string;
  equals: string;
}

export interface ProviderFieldOption {
  value: string;
  label: string;
}

export interface ProviderFieldDefinition {
  id: string;
  label: string;
  type: "text" | "secret" | "url" | "select";
  required: boolean;
  secret: boolean;
  advanced?: boolean;
  placeholder?: string;
  help?: string;
  options?: ProviderFieldOption[];
  visibleWhen?: ProviderFieldCondition;
  destination?: { kind: "credential-key" | "credential-env" | "profile" | "header-literal"; key?: string };
}

export interface ProviderDefinition {
  id: string;
  name: string;
  category: ProviderCategory;
  protocolMode: ProviderProtocolMode;
  wireProtocol?: WireProtocol;
  runtimeApis: ProviderRuntimeApi[];
  authMethods: ProviderAuthMethod[];
  defaultAuthMethod: ProviderAuthMethod;
  fields: ProviderFieldDefinition[];
  modelSource: "pi-catalog" | "openai-models" | "anthropic-models" | "google-models" | "manual";
  configurable: boolean;
  oauthProvider?: string;
  notes?: string[];
}

export interface ProviderIssue {
  stage: "schema" | "authentication" | "endpoint" | "model-discovery" | "protocol" | "oauth" | "save";
  code: string;
  fieldId?: string;
  retryable: boolean;
  message: string;
  nextActions: string[];
}

const API_KEY_FIELD: ProviderFieldDefinition = {
  id: "apiKey",
  label: "API key",
  type: "secret",
  required: true,
  secret: true,
  placeholder: "Enter API key",
  destination: { kind: "credential-key" },
};

function apiKeyProvider(
  id: string,
  name: string,
  runtimeApi: ProviderRuntimeApi,
  options: Partial<Pick<ProviderDefinition, "category" | "wireProtocol" | "modelSource">> = {},
): ProviderDefinition {
  return {
    id,
    name,
    category: options.category ?? "common",
    protocolMode: "fixed",
    ...(options.wireProtocol ? { wireProtocol: options.wireProtocol } : {}),
    runtimeApis: [runtimeApi],
    authMethods: ["api-key"],
    defaultAuthMethod: "api-key",
    fields: [API_KEY_FIELD],
    modelSource: options.modelSource ?? "pi-catalog",
    configurable: true,
  };
}

const DEFINITIONS: ProviderDefinition[] = [
  {
    ...apiKeyProvider("openai", "OpenAI", "openai-responses", {
      wireProtocol: "openai-responses",
    }),
    fields: [
      API_KEY_FIELD,
      {
        id: "organization",
        label: "Organization ID",
        type: "text",
        required: false,
        secret: false,
        advanced: true,
        placeholder: "org_...",
        destination: { kind: "profile", key: "OPENAI_ORGANIZATION" },
      },
      {
        id: "project",
        label: "Project ID",
        type: "text",
        required: false,
        secret: false,
        advanced: true,
        placeholder: "proj_...",
        destination: { kind: "profile", key: "OPENAI_PROJECT" },
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    category: "common",
    protocolMode: "fixed",
    wireProtocol: "anthropic-messages",
    runtimeApis: ["anthropic-messages"],
    authMethods: ["api-key", "oauth"],
    defaultAuthMethod: "api-key",
    fields: [
      API_KEY_FIELD,
      {
        id: "anthropicBeta",
        label: "Anthropic beta features",
        type: "text",
        required: false,
        secret: false,
        advanced: true,
        placeholder: "feature-name-YYYY-MM-DD",
        destination: { kind: "header-literal", key: "Anthropic-Beta" },
      },
    ],
    modelSource: "pi-catalog",
    configurable: true,
    oauthProvider: "anthropic",
  },
  apiKeyProvider("google", "Google Gemini", "google-generative-ai"),
  {
    ...apiKeyProvider("openrouter", "OpenRouter", "openai-completions", { wireProtocol: "openai-chat-completions" }),
    fields: [
      API_KEY_FIELD,
      {
        id: "httpReferer",
        label: "Application URL",
        type: "url",
        required: false,
        secret: false,
        advanced: true,
        placeholder: "https://example.com",
        destination: { kind: "header-literal", key: "HTTP-Referer" },
      },
      {
        id: "appTitle",
        label: "Application title",
        type: "text",
        required: false,
        secret: false,
        advanced: true,
        destination: { kind: "header-literal", key: "X-Title" },
      },
    ],
  },
  apiKeyProvider("deepseek", "DeepSeek", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("groq", "Groq", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("xai", "xAI", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("cerebras", "Cerebras", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("nvidia", "NVIDIA NIM", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("ant-ling", "Ant Ling", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("huggingface", "Hugging Face", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("together", "Together AI", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("moonshotai", "Moonshot AI", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("moonshotai-cn", "Moonshot AI China", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("zai", "ZAI Coding Plan", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("zai-coding-cn", "ZAI Coding Plan China", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("xiaomi", "Xiaomi MiMo", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("xiaomi-token-plan-cn", "Xiaomi Token Plan China", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("xiaomi-token-plan-ams", "Xiaomi Token Plan Amsterdam", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("xiaomi-token-plan-sgp", "Xiaomi Token Plan Singapore", "openai-completions", { wireProtocol: "openai-chat-completions" }),
  apiKeyProvider("kimi-coding", "Kimi For Coding", "anthropic-messages", { wireProtocol: "anthropic-messages" }),
  apiKeyProvider("minimax", "MiniMax", "anthropic-messages", { wireProtocol: "anthropic-messages" }),
  apiKeyProvider("minimax-cn", "MiniMax China", "anthropic-messages", { wireProtocol: "anthropic-messages" }),
  apiKeyProvider("vercel-ai-gateway", "Vercel AI Gateway", "anthropic-messages", { wireProtocol: "anthropic-messages" }),
  apiKeyProvider("mistral", "Mistral", "mistral-conversations"),
  {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro",
    category: "subscription",
    protocolMode: "fixed",
    runtimeApis: ["openai-codex-responses"],
    authMethods: ["oauth"],
    defaultAuthMethod: "oauth",
    fields: [],
    modelSource: "pi-catalog",
    configurable: true,
    oauthProvider: "openai-codex",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    category: "subscription",
    protocolMode: "managed-per-model",
    runtimeApis: ["openai-completions", "anthropic-messages", "openai-responses"],
    authMethods: ["oauth"],
    defaultAuthMethod: "oauth",
    fields: [],
    modelSource: "pi-catalog",
    configurable: true,
    oauthProvider: "github-copilot",
  },
  {
    id: "azure-openai-responses",
    name: "Azure OpenAI",
    category: "cloud",
    protocolMode: "fixed",
    runtimeApis: ["azure-openai-responses"],
    authMethods: ["api-key"],
    defaultAuthMethod: "api-key",
    fields: [
      { ...API_KEY_FIELD, destination: { kind: "credential-key" } },
      { id: "baseUrl", label: "Azure endpoint", type: "url", required: false, secret: false, placeholder: "https://resource.openai.azure.com", destination: { kind: "profile", key: "AZURE_OPENAI_BASE_URL" } },
      { id: "resourceName", label: "Resource name", type: "text", required: false, secret: false, destination: { kind: "profile", key: "AZURE_OPENAI_RESOURCE_NAME" } },
      { id: "apiVersion", label: "API version", type: "text", required: false, secret: false, advanced: true, placeholder: "v1", destination: { kind: "profile", key: "AZURE_OPENAI_API_VERSION" } },
      { id: "deploymentNameMap", label: "Deployment mapping", type: "text", required: false, secret: false, advanced: true, placeholder: "model=deployment", destination: { kind: "profile", key: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP" } },
    ],
    modelSource: "pi-catalog",
    configurable: true,
    notes: ["Microsoft Entra identity is detectable but is not executable by the pinned Pi runtime; use an API key."],
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    category: "cloud",
    protocolMode: "fixed",
    runtimeApis: ["openai-completions"],
    authMethods: ["api-key"],
    defaultAuthMethod: "api-key",
    fields: [
      API_KEY_FIELD,
      { id: "accountId", label: "Account ID", type: "text", required: true, secret: false, destination: { kind: "credential-env", key: "CLOUDFLARE_ACCOUNT_ID" } },
    ],
    modelSource: "pi-catalog",
    configurable: true,
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    category: "cloud",
    protocolMode: "managed-per-model",
    runtimeApis: ["openai-completions", "openai-responses", "anthropic-messages"],
    authMethods: ["api-key"],
    defaultAuthMethod: "api-key",
    fields: [
      API_KEY_FIELD,
      { id: "accountId", label: "Account ID", type: "text", required: true, secret: false, destination: { kind: "credential-env", key: "CLOUDFLARE_ACCOUNT_ID" } },
      { id: "gatewayId", label: "Gateway ID", type: "text", required: true, secret: false, destination: { kind: "credential-env", key: "CLOUDFLARE_GATEWAY_ID" } },
    ],
    modelSource: "pi-catalog",
    configurable: true,
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    category: "cloud",
    protocolMode: "fixed",
    runtimeApis: ["bedrock-converse-stream"],
    authMethods: ["ambient"],
    defaultAuthMethod: "ambient",
    fields: [
      { id: "profile", label: "AWS profile", type: "text", required: false, secret: false, destination: { kind: "profile", key: "AWS_PROFILE" } },
      { id: "region", label: "AWS region", type: "text", required: false, secret: false, placeholder: "us-east-1", destination: { kind: "profile", key: "AWS_REGION" } },
    ],
    modelSource: "pi-catalog",
    configurable: true,
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    category: "cloud",
    protocolMode: "fixed",
    runtimeApis: ["google-vertex"],
    authMethods: ["api-key", "ambient"],
    defaultAuthMethod: "ambient",
    fields: [
      { ...API_KEY_FIELD, required: false, visibleWhen: { field: "authMethod", equals: "api-key" } },
      { id: "project", label: "Google Cloud project", type: "text", required: true, secret: false, destination: { kind: "profile", key: "GOOGLE_CLOUD_PROJECT" } },
      { id: "location", label: "Google Cloud location", type: "text", required: true, secret: false, placeholder: "us-central1", destination: { kind: "profile", key: "GOOGLE_CLOUD_LOCATION" } },
    ],
    modelSource: "pi-catalog",
    configurable: true,
  },
  ...["fireworks", "opencode", "opencode-go"].map((id): ProviderDefinition => ({
    ...apiKeyProvider(id, id === "fireworks" ? "Fireworks AI" : id === "opencode" ? "OpenCode Zen" : "OpenCode Go", "openai-completions"),
    protocolMode: "managed-per-model",
    runtimeApis: id === "opencode"
      ? ["openai-completions", "anthropic-messages", "google-generative-ai", "openai-responses"]
      : ["openai-completions", "anthropic-messages"],
  })),
];

const CUSTOM_DEFINITION: ProviderDefinition = {
  id: "custom",
  name: "Custom endpoint",
  category: "custom",
  protocolMode: "selectable",
  runtimeApis: ["openai-completions", "openai-responses", "anthropic-messages"],
  authMethods: ["api-key", "none", "custom-header"],
  defaultAuthMethod: "api-key",
  fields: [],
  modelSource: "manual",
  configurable: true,
};

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function listProviderDefinitions(): ProviderDefinition[] {
  return [...DEFINITIONS, CUSTOM_DEFINITION].map((definition) => structuredClone(definition));
}

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  const definition = id === "custom" ? CUSTOM_DEFINITION : BY_ID.get(id);
  return definition ? structuredClone(definition) : undefined;
}

export function unknownProviderIds(providerIds: Iterable<string>): string[] {
  return [...new Set(providerIds)].filter((id) => !BY_ID.has(id)).sort();
}

export function providerDefinitionIds(): string[] {
  return [...BY_ID.keys()].sort();
}
