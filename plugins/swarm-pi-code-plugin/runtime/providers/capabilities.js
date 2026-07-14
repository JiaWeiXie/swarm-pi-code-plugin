export const WIRE_PROTOCOLS = [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
];
export const CUSTOM_ENDPOINT_GUIDANCE = Object.freeze({
    "endpoint-protocol": {
        hint: "Choose the one wire protocol documented by the server; discovery does not safely guess between protocols.",
        guideAnchor: "custom-protocol",
    },
    "endpoint-url": {
        hint: "Use a service root, not a generation URL. Keep credentials and query secrets out of the URL.",
        example: "http://127.0.0.1:11434",
        guideAnchor: "custom-server-url",
    },
    "endpoint-auth-method": {
        hint: "Use no authentication only for an intentionally unauthenticated local service.",
        guideAnchor: "custom-authentication",
    },
    "endpoint-header": {
        hint: "Select the server's documented secret-header name; the secret value stays in the credential boundary.",
        guideAnchor: "custom-authentication",
    },
    "endpoint-key": {
        hint: "Leave blank while editing to keep the saved credential. Never place this value in URLs or controlled headers.",
        guideAnchor: "custom-authentication",
    },
    "models-endpoint": {
        hint: "Optional same-origin model inventory endpoint. Leave blank for the protocol default.",
        example: "/v1/models",
        guideAnchor: "custom-models-endpoint",
    },
    "custom-http-referer": {
        hint: "Optional non-secret attribution URL. It is not an authentication field.",
        example: "https://app.example.test",
        guideAnchor: "custom-controlled-headers",
    },
    "custom-app-title": {
        hint: "Optional non-secret application title sent as X-Title.",
        example: "Internal support tool",
        guideAnchor: "custom-controlled-headers",
    },
    "custom-anthropic-beta": {
        hint: "Optional literal feature header; set it only when the server documents an exact beta value.",
        example: "feature-name-YYYY-MM-DD",
        guideAnchor: "custom-controlled-headers",
    },
    "manual-model-ids": {
        hint: "Use exact documented IDs, one per line. Manual entries are configured, not verified.",
        example: "model-id-from-server-docs",
        guideAnchor: "custom-manual-models",
    },
    "endpoint-name": {
        hint: "A local display label only; it does not change provider identity or routing.",
        example: "Local development model",
        guideAnchor: "custom-advanced-settings",
    },
    "endpoint-canonical-url": {
        hint: "Review the normalized API root before saving; changing it changes where future requests are sent.",
        guideAnchor: "custom-advanced-settings",
    },
    "endpoint-api": {
        hint: "Read-only runtime adapter selected from the chosen protocol.",
        guideAnchor: "custom-advanced-settings",
    },
    "advanced-model-limits": {
        hint: "Leave limits blank for provider metadata. Overrides must be positive integers and do not verify server capacity.",
        guideAnchor: "custom-advanced-settings",
    },
});
const API_KEY_FIELD = {
    id: "apiKey",
    label: "API key",
    type: "secret",
    required: true,
    secret: true,
    placeholder: "Enter API key",
    destination: { kind: "credential-key" },
};
function apiKeyProvider(id, name, runtimeApi, options = {}) {
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
const DEFINITIONS = [
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
                guidance: {
                    hint: "Leave blank unless the API account requires explicit organization scoping.",
                    example: "org_example",
                    guideAnchor: "openai-organization",
                },
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
                guidance: {
                    hint: "Leave blank to use the credential's default project; enter an ID only when explicit project routing is required.",
                    example: "proj_example",
                    guideAnchor: "openai-project",
                },
                destination: { kind: "profile", key: "OPENAI_PROJECT" },
            },
            {
                id: "promptCacheRetention",
                label: "Prompt cache retention",
                type: "select",
                required: false,
                secret: false,
                advanced: true,
                guidance: {
                    hint: "Automatic uses short retention. Extended keeps supported direct API prompts cached for 24 hours.",
                    guideAnchor: "prompt-cache-retention",
                },
                options: [
                    { value: "", label: "Automatic (short)" },
                    { value: "long", label: "Extended (24 hours)" },
                ],
                visibleWhen: { field: "authMethod", equals: "api-key" },
                destination: { kind: "profile", key: "PI_CACHE_RETENTION" },
            },
        ],
        promptCaching: {
            support: "native-automatic",
            defaultRetention: "short",
            extendedRetention: { value: "long", duration: "24h", authMethods: ["api-key"] },
        },
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
                guidance: {
                    hint: "Leave blank unless Anthropic documents an exact beta feature value for the request.",
                    example: "feature-name-YYYY-MM-DD",
                    guideAnchor: "anthropic-beta",
                },
                destination: { kind: "header-literal", key: "Anthropic-Beta" },
            },
            {
                id: "promptCacheRetention",
                label: "Prompt cache retention",
                type: "select",
                required: false,
                secret: false,
                advanced: true,
                guidance: {
                    hint: "Automatic uses short retention. Extended keeps supported direct API prompts cached for 1 hour.",
                    guideAnchor: "prompt-cache-retention",
                },
                options: [
                    { value: "", label: "Automatic (short)" },
                    { value: "long", label: "Extended (1 hour)" },
                ],
                visibleWhen: { field: "authMethod", equals: "api-key" },
                destination: { kind: "profile", key: "PI_CACHE_RETENTION" },
            },
        ],
        promptCaching: {
            support: "native-explicit",
            defaultRetention: "short",
            extendedRetention: { value: "long", duration: "1h", authMethods: ["api-key"] },
        },
        modelSource: "pi-catalog",
        configurable: true,
        oauthProvider: "anthropic",
    },
    {
        ...apiKeyProvider("google", "Google Gemini", "google-generative-ai"),
        promptCaching: { support: "implicit-only", defaultRetention: "provider-managed" },
    },
    {
        ...apiKeyProvider("openrouter", "OpenRouter", "openai-completions", {
            wireProtocol: "openai-chat-completions",
        }),
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
                guidance: {
                    hint: "Optional non-secret attribution URL. Leave blank unless OpenRouter asks for application attribution.",
                    example: "https://app.example.test",
                    guideAnchor: "openrouter-attribution",
                },
                destination: { kind: "header-literal", key: "HTTP-Referer" },
            },
            {
                id: "appTitle",
                label: "Application title",
                type: "text",
                required: false,
                secret: false,
                advanced: true,
                guidance: {
                    hint: "Optional non-secret attribution title sent as X-Title.",
                    example: "Internal support tool",
                    guideAnchor: "openrouter-attribution",
                },
                destination: { kind: "header-literal", key: "X-Title" },
            },
        ],
    },
    apiKeyProvider("deepseek", "DeepSeek", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("groq", "Groq", "openai-completions", { wireProtocol: "openai-chat-completions" }),
    apiKeyProvider("xai", "xAI", "openai-completions", { wireProtocol: "openai-chat-completions" }),
    apiKeyProvider("cerebras", "Cerebras", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("nvidia", "NVIDIA NIM", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("ant-ling", "Ant Ling", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("huggingface", "Hugging Face", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("together", "Together AI", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("moonshotai", "Moonshot AI", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("moonshotai-cn", "Moonshot AI China", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("zai", "ZAI Coding Plan", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("zai-coding-cn", "ZAI Coding Plan China", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("xiaomi", "Xiaomi MiMo", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("xiaomi-token-plan-cn", "Xiaomi Token Plan China", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("xiaomi-token-plan-ams", "Xiaomi Token Plan Amsterdam", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("xiaomi-token-plan-sgp", "Xiaomi Token Plan Singapore", "openai-completions", {
        wireProtocol: "openai-chat-completions",
    }),
    apiKeyProvider("kimi-coding", "Kimi For Coding", "anthropic-messages", {
        wireProtocol: "anthropic-messages",
    }),
    apiKeyProvider("minimax", "MiniMax", "anthropic-messages", {
        wireProtocol: "anthropic-messages",
    }),
    apiKeyProvider("minimax-cn", "MiniMax China", "anthropic-messages", {
        wireProtocol: "anthropic-messages",
    }),
    apiKeyProvider("vercel-ai-gateway", "Vercel AI Gateway", "anthropic-messages", {
        wireProtocol: "anthropic-messages",
    }),
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
        promptCaching: { support: "native-automatic", defaultRetention: "short" },
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
            {
                id: "baseUrl",
                label: "Azure endpoint",
                type: "url",
                required: false,
                secret: false,
                placeholder: "https://resource.openai.azure.com",
                guidance: {
                    hint: "Use the Azure resource root, not a /responses generation URL. Leave blank when using Resource name.",
                    example: "https://resource-name.openai.azure.com",
                    guideAnchor: "azure-openai-routing",
                },
                destination: { kind: "profile", key: "AZURE_OPENAI_BASE_URL" },
            },
            {
                id: "resourceName",
                label: "Resource name",
                type: "text",
                required: false,
                secret: false,
                guidance: {
                    hint: "Alternative to Azure endpoint. Enter the resource identifier, not its display label or API key.",
                    example: "resource-name",
                    guideAnchor: "azure-openai-routing",
                },
                destination: { kind: "profile", key: "AZURE_OPENAI_RESOURCE_NAME" },
            },
            {
                id: "apiVersion",
                label: "API version",
                type: "text",
                required: false,
                secret: false,
                advanced: true,
                placeholder: "v1",
                guidance: {
                    hint: "Leave blank for the adapter default unless the Azure resource owner requires an explicit API version.",
                    example: "v1",
                    guideAnchor: "azure-openai-routing",
                },
                destination: { kind: "profile", key: "AZURE_OPENAI_API_VERSION" },
            },
            {
                id: "deploymentNameMap",
                label: "Deployment mapping",
                type: "text",
                required: false,
                secret: false,
                advanced: true,
                placeholder: "model=deployment",
                guidance: {
                    hint: "Optional comma-separated model=deployment mappings. Leave blank when model and deployment names match.",
                    example: "model-id=deployment-name",
                    guideAnchor: "azure-openai-routing",
                },
                destination: { kind: "profile", key: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP" },
            },
        ],
        modelSource: "pi-catalog",
        configurable: true,
        notes: [
            "Microsoft Entra identity is detectable but is not executable by the pinned Pi runtime; use an API key.",
        ],
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
            {
                id: "accountId",
                label: "Account ID",
                type: "text",
                required: true,
                secret: false,
                guidance: {
                    hint: "Cloudflare routing identifier. It is not the API token.",
                    example: "account-id-from-dashboard",
                    guideAnchor: "cloudflare-routing",
                },
                destination: { kind: "credential-env", key: "CLOUDFLARE_ACCOUNT_ID" },
            },
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
            {
                id: "accountId",
                label: "Account ID",
                type: "text",
                required: true,
                secret: false,
                guidance: {
                    hint: "Cloudflare routing identifier. It is not the API token.",
                    example: "account-id-from-dashboard",
                    guideAnchor: "cloudflare-routing",
                },
                destination: { kind: "credential-env", key: "CLOUDFLARE_ACCOUNT_ID" },
            },
            {
                id: "gatewayId",
                label: "Gateway ID",
                type: "text",
                required: true,
                secret: false,
                guidance: {
                    hint: "Gateway routing identifier from the selected Cloudflare account.",
                    example: "gateway-id-from-dashboard",
                    guideAnchor: "cloudflare-routing",
                },
                destination: { kind: "credential-env", key: "CLOUDFLARE_GATEWAY_ID" },
            },
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
            {
                id: "profile",
                label: "AWS profile",
                type: "text",
                required: false,
                secret: false,
                guidance: {
                    hint: "Leave blank for the default ambient AWS profile; the profile name is not a credential value.",
                    example: "development",
                    guideAnchor: "bedrock-identity",
                },
                destination: { kind: "profile", key: "AWS_PROFILE" },
            },
            {
                id: "region",
                label: "AWS region",
                type: "text",
                required: false,
                secret: false,
                placeholder: "us-east-1",
                guidance: {
                    hint: "Leave blank for the ambient default, or choose the region that hosts the intended Bedrock models.",
                    example: "us-east-1",
                    guideAnchor: "bedrock-identity",
                },
                destination: { kind: "profile", key: "AWS_REGION" },
            },
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
            {
                ...API_KEY_FIELD,
                required: false,
                visibleWhen: { field: "authMethod", equals: "api-key" },
            },
            {
                id: "project",
                label: "Google Cloud project",
                type: "text",
                required: true,
                secret: false,
                guidance: {
                    hint: "Google Cloud project used for Vertex routing; do not enter a service-account secret here.",
                    example: "example-project",
                    guideAnchor: "vertex-routing",
                },
                destination: { kind: "profile", key: "GOOGLE_CLOUD_PROJECT" },
            },
            {
                id: "location",
                label: "Google Cloud location",
                type: "text",
                required: true,
                secret: false,
                placeholder: "us-central1",
                guidance: {
                    hint: "Vertex region for the selected models and project.",
                    example: "us-central1",
                    guideAnchor: "vertex-routing",
                },
                destination: { kind: "profile", key: "GOOGLE_CLOUD_LOCATION" },
            },
        ],
        modelSource: "pi-catalog",
        configurable: true,
        promptCaching: { support: "implicit-only", defaultRetention: "provider-managed" },
    },
    ...["fireworks", "opencode", "opencode-go"].map((id) => ({
        ...apiKeyProvider(id, id === "fireworks" ? "Fireworks AI" : id === "opencode" ? "OpenCode Zen" : "OpenCode Go", "openai-completions"),
        protocolMode: "managed-per-model",
        runtimeApis: id === "opencode"
            ? ["openai-completions", "anthropic-messages", "google-generative-ai", "openai-responses"]
            : ["openai-completions", "anthropic-messages"],
    })),
];
const CUSTOM_DEFINITION = {
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
    promptCaching: { support: "protocol-dependent", defaultRetention: "provider-managed" },
};
const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));
export function listProviderDefinitions() {
    return [...DEFINITIONS, CUSTOM_DEFINITION].map((definition) => structuredClone(definition));
}
export function getProviderDefinition(id) {
    const definition = id === "custom" ? CUSTOM_DEFINITION : BY_ID.get(id);
    return definition ? structuredClone(definition) : undefined;
}
export function unknownProviderIds(providerIds) {
    return [...new Set(providerIds)].filter((id) => !BY_ID.has(id)).sort();
}
export function providerDefinitionIds() {
    return [...BY_ID.keys()].sort();
}
