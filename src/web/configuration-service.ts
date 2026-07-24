import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { Credential } from "@earendil-works/pi-ai";

import type {
  AdaptivePolicyConfig,
  AvailableModel,
  BackgroundRolePolicy,
  ProviderSummary,
  SandboxMode,
  WorkspaceAssessment,
  DecisionMode,
  HostAssistancePolicy,
  AdvisorPolicy,
  HostActionPolicy,
  DoctrineId,
} from "../core/contracts.js";
import {
  DEFAULT_ADAPTIVE_POLICY,
  DEFAULT_BACKGROUND_ROLE_POLICY,
  isThinkingLevel,
  isWorkerRole,
  normalizeAdaptivePolicy,
  normalizeAdaptivePolicyStrict,
  listDefaultRoles,
  defaultHostAssistancePolicy,
  defaultAdvisorPolicy,
  WORKFLOW_BOUNDS,
  type RolePolicyOverrides,
} from "../orchestration/roles.js";
import { createPiEnvironment, customProviderHeaderVariable } from "../pi/environment.js";
import { cloneCredentialStore, createFileCredentialStore } from "../pi/credentials.js";
import { executeSession } from "../pi/execute.js";
import { createWorkerSession } from "../pi/runtime.js";
import { createModelCatalog, describeProviders, modelId, type PiModel } from "../pi/models.js";
import {
  getProviderDefinition,
  listProviderDefinitions,
  unknownProviderIds,
  type ProviderAuthMethod,
  type ProviderDefinition,
  type WireProtocol,
} from "../providers/capabilities.js";
import { CredentialDraftVault, type CredentialDraftSummary } from "../providers/credentials.js";
import {
  normalizeModelsEndpoint,
  normalizeProtocolRoot,
  stableCustomProviderId,
} from "../providers/endpoints.js";
import { detectSandboxAvailability, type SandboxAvailability } from "../sandbox/availability.js";
import { assessWorkspace } from "../git/worktree.js";
import { normalizeDelegatedTaskSelections } from "../policy/project-policy.js";
import {
  loadModelConfiguration,
  modelPriority,
  parseModelConfiguration,
  saveModelConfiguration,
  resolveModelConfigurationFile,
  providerHeaderSecretRef,
  providerSecretRef,
  type CustomProviderConfiguration,
  type ModelConfiguration,
  type ProviderProfile,
} from "../state/model-config.js";
import {
  loadState,
  resolveStateDir,
  resolveStateFile,
  resolveWorkspaceRoot,
  saveProjectSettings,
  saveExecutionSettings,
  setModelPriority,
  type SwarmProfile,
  defaultHostActionPolicy,
} from "../state/state.js";
import {
  discoverEndpoint,
  discoverLocalEndpoints,
  type EndpointDiscoveryRequest,
  type EndpointDiscoveryResult,
} from "./model-discovery.js";
import {
  modelReferences,
  providerForModelReference,
  reconcileRemovedModelReferences,
  removedCustomModelReferences,
  removedCustomProviderIds,
  type ConfigurationReferenceChange,
} from "./configuration-references.js";

export interface BrowserModel extends AvailableModel {
  available: boolean;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number | null;
  maxTokens: number | null;
  metadata: {
    contextWindow:
      | "pi-catalog"
      | "endpoint"
      | "models-dev"
      | "compatibility-default"
      | "user"
      | null;
    maxTokens: "pi-catalog" | "endpoint" | "models-dev" | "compatibility-default" | "user" | null;
  };
}

export interface ProviderCatalogEntry extends ProviderDefinition {
  auth: {
    configured: boolean;
    source: string | null;
    label: string | null;
  };
}

export interface ConfigurationView {
  configuration: ModelConfiguration;
  profile: SwarmProfile | null;
  directoryOptions: string[];
  providers: ProviderSummary[];
  providerCatalog: ProviderCatalogEntry[];
  models: BrowserModel[];
  registryError: string | null;
  sandboxMode: SandboxMode;
  sandboxAvailability: SandboxAvailability;
  rolePolicies?: RolePolicyOverrides;
  adaptivePolicy?: AdaptivePolicyConfig;
  backgroundRolePolicy?: BackgroundRolePolicy;
  roles?: ReturnType<typeof listDefaultRoles>;
  workspace?: WorkspaceAssessment;
  workspaceId?: string;
  configurationRevision?: string;
  decisionMode: DecisionMode;
  hostAssistance: HostAssistancePolicy;
  contextBudget: number;
  advisor: AdvisorPolicy;
  doctrine: DoctrineId | null;
  hostActions: HostActionPolicy;
  workflowBounds: typeof WORKFLOW_BOUNDS;
  issues?: ConfigurationIssue[];
  health?: ConfigurationHealth;
  reconciledChanges?: ConfigurationReferenceChange[];
}

export type ConfigurationIssue = {
  code: "model-health-check-failed";
  severity: "warning" | "error";
  blocking: boolean;
  path: string;
  modelId: string;
  providerId: string;
  message: string;
};

export type ConfigurationHealth = {
  status: "ready" | "degraded";
  checkedAt: string;
};

export class ConfigurationSaveError extends Error {
  constructor(
    readonly code:
      | "configuration-reference-conflict"
      | "configuration-revision-conflict"
      | "model-health-check-failed"
      | "primary-selection-required",
    message: string,
    readonly options: {
      status?: number;
      path?: string;
      issues?: ConfigurationIssue[];
    } = {},
  ) {
    super(message);
  }
}

export interface ConfigurationSubmission {
  baseRevision?: string | undefined;
  primary: string | null;
  fallbacks: string[];
  customProviders: CustomProviderConfiguration[];
  providerProfiles?: ProviderProfile[] | undefined;
  credentialDrafts?:
    | Array<{
        provider: string;
        draftId: string;
      }>
    | undefined;
  profile?: ProjectProfileSubmission | undefined;
  sandboxMode?: SandboxMode | undefined;
  rolePolicies?: RolePolicyOverrides | undefined;
  adaptivePolicy?: AdaptivePolicyConfig | undefined;
  backgroundRolePolicy?: BackgroundRolePolicy | undefined;
  decisionMode?: DecisionMode | undefined;
  hostAssistance?: HostAssistancePolicy | undefined;
  contextBudget?: number | undefined;
  advisor?: AdvisorPolicy | undefined;
  doctrine?: DoctrineId | null | undefined;
  hostActions?: HostActionPolicy | undefined;
}

export interface ProjectProfileSubmission {
  goal: string;
  dirs?: string[] | undefined;
  tasks: string[];
}

export interface ProjectSettingsSubmission {
  profile: ProjectProfileSubmission;
  sandboxMode?: SandboxMode | undefined;
  rolePolicies?: RolePolicyOverrides | undefined;
  adaptivePolicy?: AdaptivePolicyConfig | undefined;
  backgroundRolePolicy?: BackgroundRolePolicy | undefined;
  decisionMode?: DecisionMode | undefined;
  hostAssistance?: HostAssistancePolicy | undefined;
  contextBudget?: number | undefined;
  advisor?: AdvisorPolicy | undefined;
  doctrine?: DoctrineId | null | undefined;
  hostActions?: HostActionPolicy | undefined;
}

export interface ProviderConnectionPreview {
  provider: ProviderSummary;
  models: BrowserModel[];
  profile: ProviderProfile;
  credentialDraft?: CredentialDraftSummary | undefined;
}

export interface BuiltInProviderConnectionRequest {
  provider: string;
  authMethod: ProviderAuthMethod;
  fields: Record<string, string>;
  credentialDraftId?: string | undefined;
}

export async function configureBuiltInProvider(
  cwd: string,
  request: BuiltInProviderConnectionRequest,
  credentialVault: CredentialDraftVault,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConnectionPreview> {
  const definition = getProviderDefinition(request.provider);
  if (!definition || definition.id === "custom" || !definition.configurable) {
    throw new Error(`Unknown configurable provider: ${request.provider}`);
  }
  if (!definition.authMethods.includes(request.authMethod)) {
    throw new Error(`${definition.name} does not support ${request.authMethod} authentication`);
  }
  const persistentCredentials = createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  const { settings, secret } = normalizeProviderFields(
    definition,
    request.authMethod,
    request.fields,
  );
  let credentialDraft: CredentialDraftSummary | undefined;
  if (request.authMethod === "api-key" && secret) {
    credentialDraft = credentialVault.stageApiKey(definition.id, secret);
  } else if (request.credentialDraftId) {
    credentialDraft = credentialVault.summary(definition.id, request.credentialDraftId);
    if (credentialDraft.authMethod !== request.authMethod) {
      throw new Error("Credential draft does not match the selected authentication method");
    }
  }
  if (
    (request.authMethod === "api-key" || request.authMethod === "oauth") &&
    !credentialDraft &&
    !(await persistentCredentials.read(definition.id))
  ) {
    throw new Error(`${definition.name} requires a credential`);
  }
  const profile = providerProfile(definition, request.authMethod, settings, "configured");
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const candidate = parseModelConfiguration({
    ...configuration,
    providerProfiles: upsertProviderProfile(configuration.providerProfiles, profile),
  });
  const stagingCredentials = await cloneCredentialStore(persistentCredentials);
  if (credentialDraft) {
    await stagingCredentials.modify(definition.id, async () =>
      credentialVault.resolve(definition.id, credentialDraft.id),
    );
  }
  const pi = await createPiEnvironment(candidate, env, { credentials: stagingCredentials });
  const all = [...pi.modelRuntime.getModels()];
  const providerModels = all.filter((model) => model.provider === definition.id);
  if (providerModels.length === 0) throw new Error(`Pi has no models for ${definition.name}`);
  const available = new Set(pi.modelRuntime.getAvailableSnapshot().map(modelId));
  const models = providerModels.map((model) =>
    browserModel(model, available.has(modelId(model)), candidate),
  );
  const authStatus = pi.modelRuntime.getProviderAuthStatus(definition.id);
  return {
    provider: {
      id: definition.id,
      name: definition.name,
      ready: models.some((model) => model.available),
      modelCount: models.length,
      availableModelCount: models.filter((model) => model.available).length,
      auth: {
        source: credentialDraft ? "runtime" : (authStatus.source ?? request.authMethod),
        label: credentialDraft
          ? request.authMethod === "oauth"
            ? "Subscription sign-in pending save"
            : "Credential pending save"
          : (authStatus.label ?? authMethodLabel(request.authMethod)),
      },
      selection: null,
      custom: false,
    },
    models,
    profile,
    ...(credentialDraft ? { credentialDraft } : {}),
  };
}

export async function discoverConfigurationEndpoint(
  cwd: string,
  request: Omit<EndpointDiscoveryRequest, "apiKey"> & {
    provider: string;
    credentialDraftId?: string | undefined;
  },
  credentialVault: CredentialDraftVault,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndpointDiscoveryResult & { profile: ProviderProfile }> {
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const catalog = await createModelCatalog(configuration, env);
  const all = catalog.all?.() ?? catalog.available();
  const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
  const expectedProvider = stableCustomProviderId(root, request.protocol);
  const existingProvider = configuration.customProviders.find(
    (provider) =>
      provider.id === request.provider &&
      provider.wireProtocol === request.protocol &&
      normalizeProtocolRoot(provider.baseUrl, request.protocol) === root,
  );
  if (request.provider !== expectedProvider && !existingProvider) {
    throw new Error("Custom provider identifier does not match its endpoint policy");
  }
  const authMethod = request.authMethod ?? "none";
  const credential = request.credentialDraftId
    ? credentialVault.resolve(request.provider, request.credentialDraftId)
    : await createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE).read(request.provider);
  const apiKey = credentialSecret(credential, request.provider, authMethod, request.headerName);
  if (authMethod !== "none" && !apiKey) throw new Error("Credential draft is missing or expired");
  const result = await discoverEndpoint(
    {
      ...request,
      ...(apiKey ? { apiKey } : {}),
    },
    all,
    {
      reservedProviderIds: [
        ...all.map((model) => model.provider),
        ...(request.reservedProviderIds ?? []),
      ],
    },
  );
  if (existingProvider && result.provider.id !== request.provider) {
    result.provider.id = request.provider;
    if (result.provider.auth && result.provider.auth.method !== "none") {
      result.provider.auth.secretRef = providerSecretRef(request.provider);
    }
    for (const header of result.provider.headers ?? []) {
      if (header.secretRef)
        header.secretRef = providerHeaderSecretRef(request.provider, header.name);
    }
  }
  const now = new Date().toISOString();
  const profile: ProviderProfile = {
    id: result.provider.id,
    provider: result.provider.id,
    name: result.provider.name,
    connectionKind: "custom",
    auth: result.provider.auth ?? { method: authMethod },
    protocol: request.protocol,
    runtimeApi: result.provider.api,
    readiness: "discovered",
    settings: {},
    headers: result.provider.headers ?? [],
    ...(result.provider.modelsEndpoint ? { modelsEndpoint: result.provider.modelsEndpoint } : {}),
    discoveredAt: now,
  };
  return { ...result, profile };
}

export async function stageCustomProviderCredential(
  cwd: string,
  credentialVault: CredentialDraftVault,
  request: {
    baseUrl: string;
    protocol: WireProtocol;
    authMethod: "api-key" | "none" | "custom-header";
    secret?: string | undefined;
    headerName?: "authorization" | "x-api-key" | "api-key" | undefined;
    existingProvider?: string | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ provider: string; credentialDraft?: CredentialDraftSummary | undefined }> {
  const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
  let provider = stableCustomProviderId(root, request.protocol);
  if (request.existingProvider) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const existing = configuration.customProviders.find(
      (candidate) =>
        candidate.id === request.existingProvider &&
        candidate.wireProtocol === request.protocol &&
        normalizeProtocolRoot(candidate.baseUrl, request.protocol) === root,
    );
    if (!existing)
      throw new Error("Existing custom provider does not match this endpoint and protocol");
    provider = existing.id;
  }
  if (request.authMethod === "none") return { provider };
  if (!request.secret) throw new Error("Credential is required");
  const credentialDraft =
    request.authMethod === "custom-header"
      ? credentialVault.stageCustomHeader(
          provider,
          requireSecretHeader(request.headerName),
          request.secret,
        )
      : credentialVault.stageApiKey(provider, request.secret);
  return { provider, credentialDraft };
}

async function assertExistingCustomProvider(
  cwd: string,
  providerId: string,
  root: string,
  protocol: WireProtocol,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CustomProviderConfiguration> {
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const existing = configuration.customProviders.find(
    (candidate) =>
      candidate.id === providerId &&
      candidate.wireProtocol === protocol &&
      normalizeProtocolRoot(candidate.baseUrl, protocol) === root,
  );
  if (!existing)
    throw new Error("Existing custom provider does not match this endpoint and protocol");
  return existing;
}

export async function createManualCustomProvider(
  cwd: string,
  request: {
    baseUrl: string;
    protocol: WireProtocol;
    modelsEndpoint?: string | undefined;
    authMethod: "api-key" | "none" | "custom-header";
    headerName?: "authorization" | "x-api-key" | "api-key" | undefined;
    name?: string | undefined;
    modelIds: string[];
    existingProvider?: string | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndpointDiscoveryResult & { profile: ProviderProfile }> {
  const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
  const provider = request.existingProvider
    ? (
        await assertExistingCustomProvider(
          cwd,
          request.existingProvider,
          root,
          request.protocol,
          env,
        )
      ).id
    : stableCustomProviderId(root, request.protocol);
  const modelsEndpoint = request.modelsEndpoint
    ? normalizeModelsEndpoint(request.modelsEndpoint, root)
    : undefined;
  const modelIds = [...new Set(request.modelIds.map((model) => model.trim()).filter(Boolean))];
  if (modelIds.length === 0 || modelIds.length > 500)
    throw new Error("Enter between 1 and 500 model identifiers");
  // oxlint-disable-next-line no-control-regex -- intentionally rejects ASCII control characters in model ids
  if (modelIds.some((model) => model.length > 512 || /[\u0000-\u001f\u007f]/.test(model))) {
    throw new Error("Manual model identifiers contain unsupported characters");
  }
  const auth = {
    method: request.authMethod,
    ...(request.authMethod === "none" ? {} : { secretRef: providerSecretRef(provider) }),
    ...(request.headerName ? { headerName: request.headerName } : {}),
  } as const;
  const headers =
    request.authMethod === "custom-header"
      ? [
          {
            name: requireSecretHeader(request.headerName),
            secretRef: providerHeaderSecretRef(provider, requireSecretHeader(request.headerName)),
          },
        ]
      : [];
  const customProvider: CustomProviderConfiguration = {
    id: provider,
    name: request.name?.trim() || new URL(root).hostname,
    baseUrl: root,
    api:
      request.protocol === "openai-chat-completions"
        ? "openai-completions"
        : request.protocol === "openai-responses"
          ? "openai-responses"
          : "anthropic-messages",
    wireProtocol: request.protocol,
    authHeader: request.authMethod === "api-key" && request.protocol !== "anthropic-messages",
    requiresApiKey: request.authMethod !== "none",
    auth,
    ...(modelsEndpoint ? { modelsEndpoint } : {}),
    ...(headers.length ? { headers } : {}),
    models: modelIds.map((id) => ({ id, name: id, reasoning: false, input: ["text"] })),
  };
  const profile: ProviderProfile = {
    id: provider,
    provider,
    name: customProvider.name,
    connectionKind: "custom",
    auth,
    protocol: request.protocol,
    runtimeApi: customProvider.api,
    readiness: "configured",
    settings: {},
    headers,
    ...(modelsEndpoint ? { modelsEndpoint } : {}),
  };
  return { adapter: request.protocol, provider: customProvider, profile };
}

export async function verifyProviderConnection(
  cwd: string,
  request: {
    model: string;
    customProviders: CustomProviderConfiguration[];
    providerProfiles: ProviderProfile[];
    credentialDrafts?: Array<{ provider: string; draftId: string }> | undefined;
  },
  credentialVault: CredentialDraftVault,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: ProviderProfile; verifiedAt: string; model: string }> {
  const state = await loadState(cwd, { env });
  const current = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const candidate = parseModelConfiguration({
    ...current,
    customProviders: request.customProviders,
    providerProfiles: request.providerProfiles,
  });
  assertProviderProfilePolicies(candidate);
  const drafts = normalizeCredentialDrafts(request.credentialDrafts, credentialVault);
  const persistentCredentials = createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  const stagingCredentials = await cloneCredentialStore(persistentCredentials);
  for (const draft of drafts) {
    await stagingCredentials.modify(draft.provider, async () =>
      credentialVault.resolve(draft.provider, draft.draftId),
    );
  }
  const pi = await createPiEnvironment(candidate, env, { credentials: stagingCredentials });
  const model = [...pi.modelRuntime.getModels()].find((entry) => modelId(entry) === request.model);
  if (!model) throw new Error(`Unknown model selection: ${request.model}`);
  if (!pi.modelRuntime.getAvailableSnapshot().some((entry) => modelId(entry) === request.model)) {
    throw new Error(`Model is not authenticated: ${request.model}`);
  }
  const { session } = await createWorkerSession({
    cwd,
    mode: "readonly",
    model,
    modelConfiguration: candidate,
    modelRuntime: pi.modelRuntime,
    // Lowest reasoning effort accepted by both OpenAI and Azure responses models.
    // "minimal" is OpenAI-only; Azure gpt-5.x rejects it, and map-less custom
    // providers pass the level through verbatim, so use the safe intersection.
    thinkingLevel: "low",
  });
  const result = await executeSession({
    kind: "ask",
    model: request.model,
    prompt: "Reply with exactly READY.",
    session,
    timeoutMs: 15_000,
  });
  if (!result.success) throw new Error(`API verification failed: ${result.error ?? result.output}`);
  const provider = request.model.slice(0, request.model.indexOf("/"));
  const profile = candidate.providerProfiles.find((entry) => entry.provider === provider);
  if (!profile) throw new Error(`Provider profile is missing for ${provider}`);
  const verifiedAt = new Date().toISOString();
  return {
    profile: {
      ...profile,
      readiness: "verified",
      verifiedAt,
      verifiedModel: request.model,
    },
    verifiedAt,
    model: request.model,
  };
}

export async function signOutProvider(
  cwd: string,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  if (
    !getProviderDefinition(provider) &&
    !configuration.customProviders.some((candidate) => candidate.id === provider)
  ) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  await createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE).delete(provider);
}

export async function discoverLocalConfigurationEndpoints(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndpointDiscoveryResult[]> {
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const catalog = await createModelCatalog(configuration, env);
  const all = catalog.all?.() ?? catalog.available();
  return discoverLocalEndpoints(all, {
    reservedProviderIds: all.map((model) => model.provider),
  });
}

export async function loadConfigurationView(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigurationView> {
  const state = await loadState(cwd, { env });
  const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
  const catalog = await createModelCatalog(configuration, env);
  const all = catalog.all?.() ?? catalog.available();
  const availableModels = catalog.available();
  const available = new Set(availableModels.map(modelId));
  const rolePolicies = structuredClone(state.config.rolePolicies ?? {});
  const adaptivePolicy = normalizeAdaptivePolicy(state.config.adaptivePolicy);
  const backgroundRolePolicy = structuredClone(
    state.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY,
  );
  const storedHostAssistance = structuredClone(
    state.config.hostAssistance ?? defaultHostAssistancePolicy(),
  );
  const hostAssistance: HostAssistancePolicy = {
    ...storedHostAssistance,
    mode: storedHostAssistance.enabled === false ? "off" : "on",
    enabled: storedHostAssistance.enabled !== false,
  };
  const selected = new Set([
    ...modelPriority(configuration),
    ...Object.values(rolePolicies).flatMap((policy) => policy.models ?? []),
    ...adaptivePolicy.classifierModels,
  ]);
  const custom = new Set(configuration.customProviders.map((provider) => provider.id));
  const relevant = all.filter(
    (model) =>
      available.has(modelId(model)) || selected.has(modelId(model)) || custom.has(model.provider),
  );
  const providerIds = [...new Set(all.map((model) => model.provider))];
  const unknownProviders = unknownProviderIds(providerIds.filter((id) => !custom.has(id)));
  const registryProblems = [
    catalog.error?.(),
    unknownProviders.length
      ? `Pinned Pi exposes providers missing from ProviderCapabilityRegistry: ${unknownProviders.join(", ")}`
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return {
    configuration,
    profile: state.config.profile ?? null,
    directoryOptions: await projectDirectoryOptions(cwd, state.config.profile?.dirs ?? []),
    providers: describeProviders(catalog, configuration),
    providerCatalog: listProviderDefinitions().map((definition) => {
      const status =
        definition.id === "custom"
          ? { configured: false }
          : (catalog.authStatus?.(definition.id) ?? { configured: false });
      return {
        ...definition,
        auth: {
          configured: status.configured,
          source: status.source ?? null,
          label: status.label ?? null,
        },
      };
    }),
    models: relevant.map((model) =>
      browserModel(model, available.has(modelId(model)), configuration),
    ),
    registryError: registryProblems.length ? registryProblems.join("\n") : null,
    sandboxMode: state.config.sandboxMode ?? "strict",
    sandboxAvailability: detectSandboxAvailability(),
    rolePolicies,
    adaptivePolicy,
    backgroundRolePolicy,
    roles: listDefaultRoles(),
    workspace: await assessWorkspace(cwd),
    workspaceId: createHash("sha256")
      .update(await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd)))
      .digest("hex")
      .slice(0, 24),
    configurationRevision: createHash("sha256")
      .update(
        JSON.stringify({
          primary: configuration.primary,
          fallbacks: configuration.fallbacks,
          customProviders: configuration.customProviders,
          providerProfiles: configuration.providerProfiles,
          profile: state.config.profile ?? null,
          sandboxMode: state.config.sandboxMode ?? "strict",
          rolePolicies,
          adaptivePolicy,
          backgroundRolePolicy,
          decisionMode: state.config.decisionMode ?? "balance",
          hostAssistance,
          contextBudget: state.config.contextBudget ?? WORKFLOW_BOUNDS.contextBudget.default,
          advisor: state.config.advisor ?? defaultAdvisorPolicy(),
          doctrine: state.config.doctrine ?? null,
          hostActions: state.config.hostActions ?? defaultHostActionPolicy(),
        }),
      )
      .digest("hex")
      .slice(0, 24),
    decisionMode: state.config.decisionMode ?? "balance",
    hostAssistance,
    contextBudget: state.config.contextBudget ?? WORKFLOW_BOUNDS.contextBudget.default,
    advisor: structuredClone(state.config.advisor ?? defaultAdvisorPolicy()),
    doctrine: state.config.doctrine ?? null,
    hostActions: structuredClone(state.config.hostActions ?? defaultHostActionPolicy()),
    workflowBounds: structuredClone(WORKFLOW_BOUNDS),
  };
}

function browserModel(
  model: PiModel,
  available: boolean,
  configuration: ModelConfiguration,
): BrowserModel {
  const configured = configuration.customProviders
    .find((provider) => provider.id === model.provider)
    ?.models.find((entry) => entry.id === model.id);
  const isCustomModel = configured !== undefined;
  return {
    id: modelId(model),
    provider: model.provider,
    model: model.id,
    name: model.name,
    available,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: isCustomModel
      ? (configured.contextWindow ?? null)
      : (model.contextWindow ?? null),
    maxTokens: isCustomModel ? (configured.maxTokens ?? null) : (model.maxTokens ?? null),
    metadata: {
      contextWindow: isCustomModel
        ? (configured.metadata?.contextWindow ?? null)
        : model.contextWindow
          ? "pi-catalog"
          : null,
      maxTokens: isCustomModel
        ? (configured.metadata?.maxTokens ?? null)
        : model.maxTokens
          ? "pi-catalog"
          : null,
    },
  };
}

export async function saveConfigurationSubmission(
  cwd: string,
  submission: ConfigurationSubmission,
  env: NodeJS.ProcessEnv = process.env,
  options: { credentialVault?: CredentialDraftVault | undefined } = {},
): Promise<ConfigurationView> {
  const current = await loadConfigurationView(cwd, env);
  if (
    submission.baseRevision !== undefined &&
    submission.baseRevision !== current.configurationRevision
  ) {
    throw new ConfigurationSaveError(
      "configuration-revision-conflict",
      "Configuration changed in another setup session. Reload before saving.",
      { status: 409, path: "configurationRevision" },
    );
  }
  const profile = submission.profile
    ? await normalizeProjectProfile(cwd, submission.profile)
    : undefined;
  const sandboxMode = normalizeSandboxMode(submission.sandboxMode, current.sandboxMode);
  const execution = normalizeExecutionSettings(submission, current);
  assertSandboxModeAvailable(sandboxMode);
  const submittedProviderIds = new Set(
    Array.isArray(submission.customProviders)
      ? submission.customProviders
          .filter((provider) => typeof provider.id === "string")
          .map((provider) => provider.id)
      : [],
  );
  const removedProviderIds = new Set(
    current.configuration.customProviders
      .map((provider) => provider.id)
      .filter((provider) => !submittedProviderIds.has(provider)),
  );
  const submittedProfiles = submission.providerProfiles ?? current.configuration.providerProfiles;
  let candidate = parseModelConfiguration({
    version: 1,
    primary: submission.primary,
    fallbacks: submission.fallbacks,
    customProviders: submission.customProviders,
    providerProfiles: submittedProfiles.filter(
      (profile) => !removedProviderIds.has(profile.provider),
    ),
    updatedAt: null,
  });
  assertNoBuiltInProviderOverride(current, candidate);
  assertProviderProfilePolicies(candidate);
  const removedReferences = removedCustomModelReferences(current.configuration, candidate);
  const reconciled = reconcileRemovedModelReferences(
    candidate,
    execution.rolePolicies,
    execution.adaptivePolicy,
    removedReferences,
    removedCustomProviderIds(current.configuration, candidate),
  );
  candidate = reconciled.configuration;
  execution.rolePolicies = reconciled.rolePolicies;
  execution.adaptivePolicy = reconciled.adaptivePolicy;
  if (
    current.configuration.primary &&
    removedReferences.has(current.configuration.primary) &&
    !candidate.primary
  ) {
    throw new ConfigurationSaveError(
      "primary-selection-required",
      "Choose a replacement primary model before removing the active provider or model.",
      { status: 400, path: "primary" },
    );
  }

  const persistentCredentials = createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  const credentialDrafts = normalizeCredentialDrafts(
    submission.credentialDrafts,
    options.credentialVault,
  );
  const credentials = credentialDrafts.map((draft) => ({
    provider: draft.provider,
    draftId: draft.draftId,
    credential: options.credentialVault!.resolve(draft.provider, draft.draftId),
  }));
  const stagingCredentials = await cloneCredentialStore(persistentCredentials);
  for (const credential of credentials) {
    await stagingCredentials.modify(credential.provider, async () => credential.credential);
  }
  const pi = await createPiEnvironment(candidate, env, { credentials: stagingCredentials });

  const all = new Map([...pi.modelRuntime.getModels()].map((model) => [modelId(model), model]));
  for (const credential of credentials) {
    if (![...all.values()].some((model) => model.provider === credential.provider)) {
      throw new Error(`Unknown credential provider: ${credential.provider}`);
    }
  }
  const available = new Set(pi.modelRuntime.getAvailableSnapshot().map(modelId));
  const requireAdaptiveClassifier =
    sandboxMode === "adaptive" &&
    (sandboxMode !== current.sandboxMode ||
      candidate.primary !== current.configuration.primary ||
      !sameStrings(
        current.adaptivePolicy?.classifierModels ?? [],
        execution.adaptivePolicy.classifierModels,
      ));
  if (requireAdaptiveClassifier) {
    applyAdaptiveClassifierDefault(execution, sandboxMode, candidate.primary);
  }
  const requiredReferences = requiredModelReferences(
    current,
    candidate,
    execution,
    credentials.map((credential) => credential.provider),
  );
  const issues = validateModelReferences(candidate, execution, all, available, requiredReferences);
  assertExecutionModels(
    execution,
    all,
    available,
    sandboxMode,
    requireAdaptiveClassifier,
    requiredReferences,
  );

  if (env.SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST !== "1") {
    const smokeModels = [
      ...new Set([
        ...(candidate.primary && requiredReferences.has(candidate.primary)
          ? [candidate.primary]
          : []),
        ...(sandboxMode === "adaptive"
          ? execution.adaptivePolicy.classifierModels.filter((model) =>
              requiredReferences.has(model),
            )
          : []),
      ]),
    ];
    for (const reference of smokeModels) {
      const model = all.get(reference)!;
      const { session } = await createWorkerSession({
        cwd,
        mode: "readonly",
        model,
        modelConfiguration: candidate,
        modelRuntime: pi.modelRuntime,
        // See verifyProviderConnection: "low" is the OpenAI/Azure-safe floor.
        thinkingLevel: "low",
      });
      const smoke = await executeSession({
        kind: "ask",
        model: reference,
        prompt: "Reply with exactly READY.",
        session,
        timeoutMs: 15_000,
      });
      if (!smoke.success) {
        throw new ConfigurationSaveError(
          "model-health-check-failed",
          `Model smoke test failed for ${reference}: ${smoke.error ?? smoke.output}`,
          { status: 400, path: modelReferencePath(candidate, execution, reference) },
        );
      }
      const provider = reference.slice(0, reference.indexOf("/"));
      const profile = candidate.providerProfiles.find((entry) => entry.provider === provider);
      if (profile) {
        profile.readiness = "verified";
        profile.verifiedAt = new Date().toISOString();
        profile.verifiedModel = reference;
      }
    }
  }

  for (const credential of credentials) {
    const refreshed = await stagingCredentials.read(credential.provider);
    if (refreshed) credential.credential = refreshed;
  }

  const modelFile = await resolveModelConfigurationFile(cwd, env);
  const stateFile = await resolveStateFile(cwd, env);
  const fileSnapshots = await Promise.all([snapshotFile(modelFile), snapshotFile(stateFile)]);
  const credentialSnapshots = await Promise.all(
    credentials.map(async (credential) => ({
      provider: credential.provider,
      value: await persistentCredentials.read(credential.provider),
    })),
  );
  try {
    for (const credential of credentials) {
      await persistentCredentials.modify(credential.provider, async () => credential.credential);
    }
    const saved = await saveModelConfiguration(cwd, candidate, env);
    await setModelPriority(cwd, modelPriority(saved), env);
    if (profile) await saveProjectSettings(cwd, profile, sandboxMode, execution, env);
    else await saveExecutionSettings(cwd, sandboxMode, execution, env);
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of credentialSnapshots) {
      try {
        if (snapshot.value) {
          await persistentCredentials.modify(snapshot.provider, async () => snapshot.value);
        } else {
          await persistentCredentials.delete(snapshot.provider);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `credential:${snapshot.provider}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    for (const snapshot of fileSnapshots) {
      try {
        await restoreFile(snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(
          `file:${snapshot.file}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackErrors.length > 0) {
      await writeRecoveryJournal(cwd, rollbackErrors, env);
      throw new Error(
        "Configuration failed and could not be fully rolled back; run doctor (configuration-recovery-required)",
      );
    }
    throw error;
  }
  for (const credential of credentials) options.credentialVault?.remove(credential.draftId);
  const view = await loadConfigurationView(cwd, env);
  return {
    ...view,
    issues,
    health: {
      status: issues.length > 0 ? "degraded" : "ready",
      checkedAt: new Date().toISOString(),
    },
    reconciledChanges: reconciled.changes,
  };
}

interface FileSnapshot {
  file: string;
  contents?: Buffer;
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  const contents = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return { file, ...(contents ? { contents } : {}) };
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.contents) {
    await fs.rm(snapshot.file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(snapshot.file), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.file}.${process.pid}.rollback`;
  await fs.writeFile(temporary, snapshot.contents, { mode: 0o600 });
  await fs.rename(temporary, snapshot.file);
}

async function writeRecoveryJournal(
  cwd: string,
  errors: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = path.join(await resolveStateDir(cwd, env), "recovery");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, "configuration.json"),
    `${JSON.stringify(
      {
        code: "configuration-recovery-required",
        createdAt: new Date().toISOString(),
        errors: errors.map((error) => error.replace(/(?:sk-|key=)[^\s:]+/gi, "[redacted]")),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export async function saveProjectProfileSubmission(
  cwd: string,
  submission: ProjectSettingsSubmission | ProjectProfileSubmission,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmProfile> {
  const current = await loadState(cwd, { env });
  const settings = "profile" in submission ? submission : { profile: submission };
  const profile = await normalizeProjectProfile(cwd, settings.profile);
  const sandboxMode = normalizeSandboxMode(
    settings.sandboxMode,
    current.config.sandboxMode ?? "strict",
  );
  const execution = normalizeExecutionSettings(settings, {
    rolePolicies: current.config.rolePolicies ?? {},
    adaptivePolicy: normalizeAdaptivePolicy(current.config.adaptivePolicy),
    backgroundRolePolicy: current.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY,
    decisionMode: current.config.decisionMode ?? "balance",
    hostAssistance: current.config.hostAssistance ?? defaultHostAssistancePolicy(),
    contextBudget: current.config.contextBudget ?? 4,
    advisor: current.config.advisor ?? defaultAdvisorPolicy(),
    doctrine: current.config.doctrine ?? null,
    hostActions: current.config.hostActions ?? defaultHostActionPolicy(),
  });
  assertSandboxModeAvailable(sandboxMode);
  const modelConfiguration = await loadModelConfiguration(cwd, current.config.modelPriority, env);
  const catalog = await createModelCatalog(modelConfiguration, env);
  const all = new Map(
    (catalog.all?.() ?? catalog.available()).map((model) => [modelId(model), model]),
  );
  const available = new Set(catalog.available().map(modelId));
  const requiredReferences = new Set<string>();
  const currentRoles = current.config.rolePolicies ?? {};
  const currentAdaptive = normalizeAdaptivePolicy(current.config.adaptivePolicy);
  for (const role of new Set([
    ...Object.keys(currentRoles),
    ...Object.keys(execution.rolePolicies),
  ])) {
    const before = modelsForRole(currentRoles, role);
    const after = modelsForRole(execution.rolePolicies, role);
    if (!sameStrings(before, after))
      after.forEach((reference) => requiredReferences.add(reference));
  }
  if (!sameStrings(currentAdaptive.classifierModels, execution.adaptivePolicy.classifierModels)) {
    execution.adaptivePolicy.classifierModels.forEach((reference) =>
      requiredReferences.add(reference),
    );
  }
  const requireAdaptiveClassifier =
    sandboxMode === "adaptive" &&
    (sandboxMode !== (current.config.sandboxMode ?? "strict") ||
      !sameStrings(currentAdaptive.classifierModels, execution.adaptivePolicy.classifierModels));
  if (requireAdaptiveClassifier) {
    applyAdaptiveClassifierDefault(execution, sandboxMode, modelConfiguration.primary);
    execution.adaptivePolicy.classifierModels.forEach((reference) =>
      requiredReferences.add(reference),
    );
  }
  validateModelReferences(modelConfiguration, execution, all, available, requiredReferences);
  assertExecutionModels(
    execution,
    all,
    available,
    sandboxMode,
    requireAdaptiveClassifier,
    requiredReferences,
  );
  const state = await saveProjectSettings(cwd, profile, sandboxMode, execution, env);
  return state.config.profile!;
}

function normalizeSandboxMode(value: unknown, fallback: SandboxMode): SandboxMode {
  if (value === undefined) return fallback;
  if (
    value === "strict" ||
    value === "adaptive" ||
    value === "lenient" ||
    value === "autopilot" ||
    value === "full-access"
  ) {
    return value;
  }
  throw new Error("Sandbox mode must be strict, adaptive, lenient, autopilot, or full-access");
}

function normalizeDecisionMode(value: unknown, fallback: DecisionMode): DecisionMode {
  if (value === undefined) return fallback;
  if (value === "cost" || value === "balance" || value === "power") return value;
  throw new Error("Decision mode must be cost, balance, or power");
}

function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function normalizeHostAssistance(
  value: HostAssistancePolicy | undefined,
  fallback: HostAssistancePolicy,
): HostAssistancePolicy {
  if (value === undefined) return structuredClone(fallback);
  if (value.maxRequests === undefined || value.maxFanOut === undefined)
    throw new Error(
      "Host Assistance requests and fan-out are required when the section is submitted",
    );
  const reviewMode = value.reviewMode ?? fallback.reviewMode ?? "user-only";
  const autoApprovalScope = value.autoApprovalScope ?? fallback.autoApprovalScope ?? "context-only";
  const autoApproveDiscoveryGates =
    value.autoApproveDiscoveryGates ?? fallback.autoApproveDiscoveryGates ?? false;
  const outwardApprovalGranularity =
    value.outwardApprovalGranularity ?? fallback.outwardApprovalGranularity ?? "each-time";
  const autoGitWrites = value.autoGitWrites ?? fallback.autoGitWrites ?? false;
  const autoDelivery = value.autoDelivery ?? fallback.autoDelivery ?? false;
  const allowedContextClasses = ["workspace", "web", "docs", "paper", "connector", "skill"];
  if (
    !Array.isArray(value.contextClasses) ||
    value.contextClasses.some((item) => !allowedContextClasses.includes(item))
  )
    throw new Error("Host Assistance context classes contain an unsupported value");
  const contextClasses = [...new Set(value.contextClasses)];
  if (value.mode === "inherit")
    throw new Error(
      "Project configuration cannot inherit Host Assistance; choose On or Off. CLI job overrides may still use inherit.",
    );
  if (value.mode !== "on" && value.mode !== "off") throw new Error("Invalid Host Assistance mode");
  if (value.privateConnector !== "ask" && value.privateConnector !== "deny")
    throw new Error("Invalid private connector policy");
  if (reviewMode !== "user-only" && reviewMode !== "host-first")
    throw new Error("Invalid Host Assistance review mode");
  if (
    autoApprovalScope !== "context-only" &&
    autoApprovalScope !== "read-only" &&
    autoApprovalScope !== "reversible"
  )
    throw new Error("Invalid Host Assistance auto-approval scope");
  if (
    outwardApprovalGranularity !== "each-time" &&
    outwardApprovalGranularity !== "first-then-auto"
  )
    throw new Error("Invalid outward approval granularity");
  const maxRequests = normalizeBoundedInteger(
    value.maxRequests,
    fallback.maxRequests,
    WORKFLOW_BOUNDS.hostAssistance.requests.min,
    WORKFLOW_BOUNDS.hostAssistance.requests.max,
    "Host Assistance request limit",
  );
  const maxFanOut = normalizeBoundedInteger(
    value.maxFanOut,
    fallback.maxFanOut,
    WORKFLOW_BOUNDS.hostAssistance.fanOut.min,
    WORKFLOW_BOUNDS.hostAssistance.fanOut.max,
    "Host Assistance fan-out",
  );
  if (maxFanOut > maxRequests)
    throw new Error("Host Assistance fan-out cannot exceed its request limit");
  return {
    enabled: value.mode === "off" ? false : value.enabled !== false,
    mode: value.mode,
    contextClasses,
    privateConnector: value.privateConnector,
    maxRequests,
    maxFanOut,
    reviewMode,
    autoApprovalScope,
    autoApproveDiscoveryGates,
    outwardApprovalGranularity,
    autoGitWrites,
    autoDelivery,
  };
}

function normalizeAdvisor(
  value: AdvisorPolicy | undefined,
  fallback: AdvisorPolicy,
): AdvisorPolicy {
  if (value === undefined) return structuredClone(fallback);
  if (value.maxRequests === undefined || value.maxPerspectives === undefined)
    throw new Error(
      "Advisor consultations and perspectives are required when the section is submitted",
    );
  const allowedTargets = [
    "ask",
    "review",
    "plan",
    "implement",
    "orchestrate",
    "scaffold",
    "setup",
    "discover",
  ];
  if (!Array.isArray(value.targets) || value.targets.some((item) => !allowedTargets.includes(item)))
    throw new Error("Advisor targets contain an unsupported task kind");
  const targets = [...new Set(value.targets)];
  const maxRequests = normalizeBoundedInteger(
    value.maxRequests,
    fallback.maxRequests,
    WORKFLOW_BOUNDS.advisor.requests.min,
    WORKFLOW_BOUNDS.advisor.requests.max,
    "Advisor request limit",
  );
  const maxPerspectives = normalizeBoundedInteger(
    value.maxPerspectives,
    fallback.maxPerspectives,
    WORKFLOW_BOUNDS.advisor.perspectives.min,
    WORKFLOW_BOUNDS.advisor.perspectives.max,
    "Advisor perspective limit",
  );
  if (
    value.enabled === true &&
    (targets.length === 0 || maxRequests === 0 || maxPerspectives === 0)
  )
    throw new Error(
      "Enabled Advisor requires a target, at least one consultation, and one perspective",
    );
  return {
    enabled: value.enabled === true,
    targets,
    maxRequests,
    maxPerspectives,
  };
}

function normalizeHostActions(
  value: HostActionPolicy | undefined,
  fallback: HostActionPolicy,
): HostActionPolicy {
  if (value === undefined) return structuredClone(fallback);
  if (value.maxUses === undefined || value.maxCost === undefined || value.ttlMs === undefined)
    throw new Error("Host Action uses, cost metadata, and lease TTL are required when submitted");
  const actionClasses = [
    "local-mutation",
    "draft",
    "remote-write",
    "message",
    "deploy",
    "transaction",
  ];
  if (
    !Array.isArray(value.allowedActionClasses) ||
    value.allowedActionClasses.some((item) => !actionClasses.includes(item))
  )
    throw new Error("Host Action classes contain an unsupported value");
  const allowedActionClasses = [...new Set(value.allowedActionClasses)];
  if (
    value.remoteActionsEnabled === true &&
    !allowedActionClasses.some((item) =>
      ["remote-write", "message", "deploy", "transaction"].includes(item),
    )
  )
    throw new Error("Remote Host Actions require at least one remote action class");
  return {
    enabled: value.enabled === true,
    allowedActionClasses,
    remoteActionsEnabled: value.remoteActionsEnabled === true,
    maxUses: normalizeBoundedInteger(
      value.maxUses,
      fallback.maxUses,
      1,
      100,
      "Host Action use limit",
    ),
    maxCost:
      typeof value.maxCost === "number" && Number.isFinite(value.maxCost) && value.maxCost >= 0
        ? value.maxCost
        : (() => {
            throw new Error("Host Action recommendation cost metadata must be non-negative");
          })(),
    ttlMs: normalizeBoundedInteger(
      value.ttlMs,
      fallback.ttlMs,
      60_000,
      86_400_000,
      "Host Action TTL",
    ),
  };
}

function assertSandboxModeAvailable(mode: SandboxMode): void {
  // strict and full-access do not create the OS sandbox backend, so neither
  // requires Seatbelt/Bubblewrap to be available.
  if (mode === "strict" || mode === "full-access") return;
  const availability = detectSandboxAvailability();
  if (!availability.available)
    throw new Error(availability.reason ?? "Lenient sandboxing is unavailable");
}

function normalizeExecutionSettings(
  value: {
    rolePolicies?: RolePolicyOverrides | undefined;
    adaptivePolicy?: AdaptivePolicyConfig | undefined;
    backgroundRolePolicy?: BackgroundRolePolicy | undefined;
    decisionMode?: DecisionMode | undefined;
    hostAssistance?: HostAssistancePolicy | undefined;
    contextBudget?: number | undefined;
    advisor?: AdvisorPolicy | undefined;
    doctrine?: DoctrineId | null | undefined;
    hostActions?: HostActionPolicy | undefined;
  },
  fallback: Pick<
    ConfigurationView,
    | "rolePolicies"
    | "adaptivePolicy"
    | "backgroundRolePolicy"
    | "decisionMode"
    | "hostAssistance"
    | "contextBudget"
    | "advisor"
    | "doctrine"
    | "hostActions"
  >,
) {
  const rolePolicies: RolePolicyOverrides = {};
  const source = value.rolePolicies ?? fallback.rolePolicies ?? {};
  for (const [role, raw] of Object.entries(source)) {
    if (!isWorkerRole(role) || !raw || typeof raw !== "object") continue;
    const policy = raw as NonNullable<RolePolicyOverrides[typeof role]>;
    if (policy.thinkingLevel !== undefined && !isThinkingLevel(policy.thinkingLevel)) {
      throw new Error(`Invalid thinking level for ${role}`);
    }
    if (
      policy.maxAttempts !== undefined &&
      (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 2)
    ) {
      throw new Error(`Role ${role} max attempts must be 1 or 2`);
    }
    rolePolicies[role] = {
      ...(Array.isArray(policy.models) ? { models: [...new Set(policy.models)] } : {}),
      ...(policy.thinkingLevel ? { thinkingLevel: policy.thinkingLevel } : {}),
      ...(policy.maxAttempts ? { maxAttempts: policy.maxAttempts } : {}),
    };
  }
  const adaptivePolicy = normalizeAdaptivePolicyStrict(
    value.adaptivePolicy ?? fallback.adaptivePolicy ?? DEFAULT_ADAPTIVE_POLICY,
  );
  validateTrustedDomains(adaptivePolicy);
  return {
    rolePolicies,
    adaptivePolicy,
    backgroundRolePolicy: {
      mechanicalExecutor:
        (
          value.backgroundRolePolicy ??
          fallback.backgroundRolePolicy ??
          DEFAULT_BACKGROUND_ROLE_POLICY
        ).mechanicalExecutor === true,
    },
    decisionMode: normalizeDecisionMode(value.decisionMode, fallback.decisionMode),
    hostAssistance: normalizeHostAssistance(value.hostAssistance, fallback.hostAssistance),
    contextBudget: normalizeBoundedInteger(
      value.contextBudget,
      fallback.contextBudget,
      WORKFLOW_BOUNDS.contextBudget.min,
      WORKFLOW_BOUNDS.contextBudget.max,
      "Context budget",
    ),
    advisor: normalizeAdvisor(value.advisor, fallback.advisor),
    doctrine:
      value.doctrine === undefined
        ? fallback.doctrine
        : value.doctrine === null || value.doctrine === "first-principles-qds-v1"
          ? value.doctrine
          : (() => {
              throw new Error("Unknown decision doctrine");
            })(),
    hostActions: normalizeHostActions(value.hostActions, fallback.hostActions),
  };
}

function validateTrustedDomains(policy: AdaptivePolicyConfig): void {
  for (const domain of policy.trustedDomains) {
    if (
      !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
      domain === "localhost" ||
      /^\d+(?:\.\d+){3}$/.test(domain)
    ) {
      throw new Error(`Invalid trusted domain: ${domain}`);
    }
  }
}

function assertExecutionModels(
  execution: ReturnType<typeof normalizeExecutionSettings>,
  all: Map<string, PiModel>,
  available: Set<string>,
  sandboxMode: SandboxMode,
  requireAdaptiveClassifier = true,
  requiredReferences: ReadonlySet<string> = new Set(),
): void {
  const selected = [
    ...Object.values(execution.rolePolicies).flatMap((policy) => policy?.models ?? []),
    ...execution.adaptivePolicy.classifierModels,
  ];
  const unknown = selected.filter((model) => !all.has(model) && requiredReferences.has(model));
  if (unknown.length) {
    throw new ConfigurationSaveError(
      "configuration-reference-conflict",
      `Unknown role or classifier model: ${[...new Set(unknown)].join(", ")}`,
      { status: 400, path: "rolePolicies" },
    );
  }
  const unavailable = selected.filter(
    (model) => !available.has(model) && requiredReferences.has(model),
  );
  if (unavailable.length) {
    throw new ConfigurationSaveError(
      "model-health-check-failed",
      `Role or classifier models are not authenticated: ${[...new Set(unavailable)].join(", ")}`,
      { status: 400, path: "rolePolicies" },
    );
  }
  if (
    requireAdaptiveClassifier &&
    sandboxMode === "adaptive" &&
    execution.adaptivePolicy.classifierModels.length === 0
  ) {
    throw new Error("Adaptive mode requires at least one classifier model");
  }
}

function requiredModelReferences(
  current: ConfigurationView,
  candidate: ModelConfiguration,
  execution: ReturnType<typeof normalizeExecutionSettings>,
  credentialProviders: string[],
): Set<string> {
  const required = new Set<string>();
  const currentRoles = current.rolePolicies ?? {};
  const currentAdaptive = current.adaptivePolicy ?? DEFAULT_ADAPTIVE_POLICY;
  if (candidate.primary && candidate.primary !== current.configuration.primary)
    required.add(candidate.primary);
  if (!sameStrings(candidate.fallbacks, current.configuration.fallbacks)) {
    candidate.fallbacks.forEach((reference) => required.add(reference));
  }
  for (const role of new Set([
    ...Object.keys(currentRoles),
    ...Object.keys(execution.rolePolicies),
  ])) {
    const before = modelsForRole(currentRoles, role);
    const after = modelsForRole(execution.rolePolicies, role);
    if (!sameStrings(before, after)) after.forEach((reference) => required.add(reference));
  }
  if (!sameStrings(currentAdaptive.classifierModels, execution.adaptivePolicy.classifierModels)) {
    execution.adaptivePolicy.classifierModels.forEach((reference) => required.add(reference));
  }
  const currentProviders = new Map(
    current.configuration.customProviders.map((provider) => [
      provider.id,
      JSON.stringify(provider),
    ]),
  );
  const changedProviders = new Set(credentialProviders);
  for (const provider of candidate.customProviders) {
    if (currentProviders.get(provider.id) !== JSON.stringify(provider))
      changedProviders.add(provider.id);
  }
  for (const reference of modelReferences(
    candidate,
    execution.rolePolicies,
    execution.adaptivePolicy,
  )) {
    if (changedProviders.has(providerForModelReference(reference))) required.add(reference);
  }
  return required;
}

function validateModelReferences(
  candidate: ModelConfiguration,
  execution: ReturnType<typeof normalizeExecutionSettings>,
  all: Map<string, PiModel>,
  available: Set<string>,
  requiredReferences: ReadonlySet<string>,
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const reference of modelReferences(
    candidate,
    execution.rolePolicies,
    execution.adaptivePolicy,
  )) {
    const path = modelReferencePath(candidate, execution, reference);
    const providerId = providerForModelReference(reference);
    if (!all.has(reference)) {
      const issue: ConfigurationIssue = {
        code: "model-health-check-failed",
        severity: "warning",
        blocking: requiredReferences.has(reference),
        path,
        modelId: reference,
        providerId,
        message: `Saved model is no longer in the current catalog: ${reference}`,
      };
      if (issue.blocking) {
        throw new ConfigurationSaveError("configuration-reference-conflict", issue.message, {
          status: 400,
          path,
          issues: [issue],
        });
      }
      issues.push(issue);
      continue;
    }
    if (!available.has(reference)) {
      const issue: ConfigurationIssue = {
        code: "model-health-check-failed",
        severity: "warning",
        blocking: requiredReferences.has(reference),
        path,
        modelId: reference,
        providerId,
        message: `Saved model is currently unavailable: ${reference}`,
      };
      if (issue.blocking) {
        throw new ConfigurationSaveError("model-health-check-failed", issue.message, {
          status: 400,
          path,
          issues: [issue],
        });
      }
      issues.push(issue);
    }
  }
  return issues;
}

function modelReferencePath(
  candidate: Pick<ModelConfiguration, "primary" | "fallbacks">,
  execution: Pick<ReturnType<typeof normalizeExecutionSettings>, "rolePolicies" | "adaptivePolicy">,
  reference: string,
): string {
  if (candidate.primary === reference) return "primary";
  if (candidate.fallbacks.includes(reference)) return "fallbacks";
  for (const [role, policy] of Object.entries(execution.rolePolicies)) {
    if (policy?.models?.includes(reference)) return `rolePolicies.${role}.models`;
  }
  if (execution.adaptivePolicy.classifierModels.includes(reference)) {
    return "adaptivePolicy.classifierModels";
  }
  return "models";
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function modelsForRole(policies: RolePolicyOverrides, role: string): string[] {
  return policies[role as keyof RolePolicyOverrides]?.models ?? [];
}

function applyAdaptiveClassifierDefault(
  execution: ReturnType<typeof normalizeExecutionSettings>,
  sandboxMode: SandboxMode,
  primary: string | null | undefined,
): void {
  if (
    sandboxMode === "adaptive" &&
    execution.adaptivePolicy.classifierModels.length === 0 &&
    primary
  ) {
    execution.adaptivePolicy.classifierModels = [primary];
  }
}

function normalizeProviderFields(
  definition: ProviderDefinition,
  authMethod: ProviderAuthMethod,
  value: Record<string, string>,
): { settings: Record<string, string>; secret?: string | undefined } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider fields must be an object");
  }
  const known = new Set(definition.fields.map((field) => field.id));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new Error(`Unknown field for ${definition.name}: ${key}`);
  }
  const settings: Record<string, string> = {};
  let secret: string | undefined;
  for (const field of definition.fields) {
    const visible =
      (!field.visibleWhen ||
        field.visibleWhen.field !== "authMethod" ||
        field.visibleWhen.equals === authMethod) &&
      (!field.secret || authMethod === "api-key");
    const raw = value[field.id];
    if (raw !== undefined && typeof raw !== "string")
      throw new Error(`${field.label} must be text`);
    const normalized = raw?.trim() ?? "";
    if (
      field.type === "select" &&
      normalized &&
      !field.options?.some((option) => option.value === normalized)
    ) {
      throw new Error(`${field.label} has an invalid option`);
    }
    if (!visible) {
      if (field.type === "select" && normalized)
        throw new Error(`${field.label} is unavailable for ${authMethod}`);
      continue;
    }
    if (normalized.length > 16_384) throw new Error(`${field.label} is too long`);
    if (field.required && !field.secret && !normalized)
      throw new Error(`${field.label} is required`);
    if (!normalized) continue;
    if (field.secret) secret = normalized;
    else if (field.type === "url")
      settings[field.id] = normalizeProviderUrl(normalized, field.label, authMethod);
    else {
      settings[field.id] = normalized;
    }
  }
  if (definition.id === "azure-openai-responses" && !settings.baseUrl && !settings.resourceName) {
    throw new Error("Azure OpenAI requires an endpoint or resource name");
  }
  if (
    settings.deploymentNameMap &&
    !settings.deploymentNameMap
      .split(",")
      .every((entry) => /^[^=,\s]+=[^=,\s]+$/.test(entry.trim()))
  ) {
    throw new Error(
      "Azure deployment mapping must use model=deployment entries separated by commas",
    );
  }
  return { settings, ...(secret ? { secret } : {}) };
}

function normalizeProviderUrl(
  value: string,
  label: string,
  authMethod: ProviderAuthMethod,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password) throw new Error(`${label} may not contain credentials`);
  if (
    authMethod !== "none" &&
    url.protocol === "http:" &&
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    throw new Error(`${label} must use HTTPS when credentials are configured`);
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function providerProfile(
  definition: ProviderDefinition,
  authMethod: ProviderAuthMethod,
  settings: Record<string, string>,
  readiness: ProviderProfile["readiness"],
): ProviderProfile {
  const runtimeApi =
    definition.protocolMode === "managed-per-model"
      ? "managed-per-model"
      : definition.runtimeApis[0];
  if (!runtimeApi) throw new Error(`Provider has no runtime API: ${definition.id}`);
  return {
    id: definition.id,
    provider: definition.id,
    name: definition.name,
    connectionKind: "builtin",
    auth: {
      method: authMethod,
      ...(authMethod === "api-key" || authMethod === "oauth"
        ? { secretRef: providerSecretRef(definition.id) }
        : {}),
    },
    ...(definition.wireProtocol ? { protocol: definition.wireProtocol } : {}),
    runtimeApi,
    readiness,
    settings,
    headers: [],
  };
}

function upsertProviderProfile(
  profiles: ProviderProfile[],
  profile: ProviderProfile,
): ProviderProfile[] {
  return [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
}

function authMethodLabel(method: ProviderAuthMethod): string {
  switch (method) {
    case "api-key":
      return "Stored API key";
    case "oauth":
      return "Subscription OAuth";
    case "ambient":
      return "Ambient cloud identity";
    case "none":
      return "No credential";
    case "custom-header":
      return "API key plus custom secret header";
  }
}

function credentialSecret(
  credential: Credential | undefined,
  provider: string,
  authMethod: EndpointDiscoveryRequest["authMethod"],
  headerName: EndpointDiscoveryRequest["headerName"],
): string | undefined {
  if (!credential || credential.type !== "api_key") return undefined;
  if (authMethod !== "custom-header") return credential.key;
  if (!headerName) return undefined;
  return credential.env?.[customProviderHeaderVariable(provider, headerName)];
}

function requireSecretHeader(
  value: EndpointDiscoveryRequest["headerName"],
): "authorization" | "x-api-key" | "api-key" {
  if (value !== "authorization" && value !== "x-api-key" && value !== "api-key") {
    throw new Error("Choose a supported secret header");
  }
  return value;
}

async function projectDirectoryOptions(cwd: string, selected: string[]): Promise<string[]> {
  const root = await resolveWorkspaceRoot(cwd);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const discovered = entries
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
    )
    .map((entry) => entry.name);
  return [...new Set([...discovered, ...selected])].sort((left, right) =>
    left.localeCompare(right),
  );
}

async function normalizeProjectProfile(
  cwd: string,
  submission: ProjectProfileSubmission,
): Promise<SwarmProfile> {
  if (typeof submission !== "object" || submission === null || Array.isArray(submission)) {
    throw new Error("Project profile must be a JSON object");
  }
  if (typeof submission.goal !== "string" || !submission.goal.trim()) {
    throw new Error("Project goal is required");
  }
  if (submission.goal.length > 4_000) throw new Error("Project goal is too long");
  if (
    submission.dirs !== undefined &&
    (!Array.isArray(submission.dirs) ||
      !submission.dirs.every((entry) => typeof entry === "string"))
  ) {
    throw new Error("Project directories must be a string array");
  }
  if (
    !Array.isArray(submission.tasks) ||
    !submission.tasks.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Delegated task types must be a string array");
  }
  if ((submission.dirs?.length ?? 0) > 128)
    throw new Error("Too many project directories were selected");
  if (submission.tasks.length === 0) throw new Error("Choose at least one delegated task type");
  if (submission.tasks.length > 32) throw new Error("Too many delegated task types were selected");

  const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
  const dirs: string[] = [];
  for (const raw of new Set((submission.dirs ?? []).map((entry) => entry.trim()).filter(Boolean))) {
    if (path.isAbsolute(raw)) throw new Error(`Project directory must be relative: ${raw}`);
    const normalized = path.normalize(raw);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`Project directory is outside the workspace: ${raw}`);
    }
    let absolute: string;
    try {
      absolute = await fs.realpath(path.resolve(root, normalized));
    } catch {
      throw new Error(`Project directory does not exist: ${raw}`);
    }
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Project directory is outside the workspace: ${raw}`);
    }
    if (!(await fs.stat(absolute)).isDirectory())
      throw new Error(`Project scope is not a directory: ${raw}`);
    dirs.push(relative.split(path.sep).join("/"));
  }
  const tasks = normalizeDelegatedTaskSelections(
    submission.tasks.map((entry) => entry.trim()).filter(Boolean),
  );
  if (tasks.length === 0) throw new Error("Choose at least one delegated task type");
  if (tasks.some((entry) => entry.length > 80)) throw new Error("Delegated task type is too long");

  return {
    goal: submission.goal,
    ...(submission.dirs === undefined ? {} : { dirs }),
    tasks,
    configuredAt: new Date().toISOString(),
  };
}

function assertNoBuiltInProviderOverride(
  current: ConfigurationView,
  candidate: ModelConfiguration,
): void {
  const currentCustom = new Set(
    current.configuration.customProviders.map((provider) => provider.id),
  );
  const builtIn = new Set(current.providerCatalog.map((provider) => provider.id));
  for (const provider of candidate.customProviders) {
    if (builtIn.has(provider.id) && !currentCustom.has(provider.id)) {
      throw new Error(`Custom provider may not replace built-in provider: ${provider.id}`);
    }
  }
}

function assertProviderProfilePolicies(configuration: ModelConfiguration): void {
  for (const profile of configuration.providerProfiles) {
    if (profile.connectionKind === "builtin") {
      const definition = getProviderDefinition(profile.provider);
      if (!definition || definition.id === "custom")
        throw new Error(`Unknown built-in provider profile: ${profile.provider}`);
      profile.settings = normalizeProviderFields(
        definition,
        profile.auth.method,
        profile.settings,
      ).settings;
      continue;
    }
    const provider = configuration.customProviders.find(
      (candidate) => candidate.id === profile.provider,
    );
    if (!provider) throw new Error(`Missing custom provider for profile: ${profile.provider}`);
    if (profile.protocol !== provider.wireProtocol || profile.runtimeApi !== provider.api) {
      throw new Error(
        `Custom provider profile does not match runtime adapter: ${profile.provider}`,
      );
    }
    if (profile.auth.method !== provider.auth?.method) {
      throw new Error(
        `Custom provider profile does not match authentication policy: ${profile.provider}`,
      );
    }
  }
}

function normalizeCredentialDrafts(
  value: ConfigurationSubmission["credentialDrafts"],
  vault: CredentialDraftVault | undefined,
): Array<{ provider: string; draftId: string }> {
  if (value === undefined) return [];
  if (!vault) throw new Error("Credential drafts are unavailable for this configuration session");
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Credential drafts must be an array");
  const byProvider = new Map<string, { provider: string; draftId: string }>();
  for (const entry of value) {
    if (!entry || typeof entry.provider !== "string" || typeof entry.draftId !== "string") {
      throw new Error("Credential draft references require provider and draftId strings");
    }
    const provider = entry.provider.trim();
    const draftId = entry.draftId.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) || !/^[0-9a-f-]{36}$/.test(draftId)) {
      throw new Error("Credential draft reference is invalid");
    }
    vault.summary(provider, draftId);
    byProvider.set(provider, { provider, draftId });
  }
  return [...byProvider.values()];
}
