import { randomUUID } from "node:crypto";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
} from "@earendil-works/pi-ai";

import { getProviderDefinition } from "./capabilities.js";
import { customProviderHeaderVariable } from "../pi/environment.js";
import {
  CONTROLLED_SECRET_HEADER_NAMES,
  type ControlledSecretHeaderName,
} from "../state/model-config.js";

const DEFAULT_DRAFT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_OAUTH_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SECRET_LENGTH = 16_384;

export interface CredentialDraftSummary {
  id: string;
  provider: string;
  authMethod: "api-key" | "oauth" | "custom-header";
  masked: true;
  expiresAt: string;
}

interface CredentialDraft extends CredentialDraftSummary {
  credential: Credential;
  createdAt: number;
  expiresAtMs: number;
}

export class CredentialDraftVault {
  private readonly drafts = new Map<string, CredentialDraft>();

  constructor(private readonly ttlMs = DEFAULT_DRAFT_TTL_MS) {}

  stageApiKey(provider: string, apiKey: string): CredentialDraftSummary {
    return this.stage(provider, "api-key", {
      type: "api_key",
      key: normalizeSecret(apiKey, "API key"),
    });
  }

  stageCustomHeader(
    provider: string,
    headerName: ControlledSecretHeaderName,
    value: string,
  ): CredentialDraftSummary {
    if (!CONTROLLED_SECRET_HEADER_NAMES.includes(headerName)) {
      throw new Error(`Unsupported secret header: ${headerName}`);
    }
    const secret = normalizeSecret(value, "Header value");
    return this.stage(provider, "custom-header", {
      type: "api_key",
      key: secret,
      env: {
        [customProviderHeaderVariable(provider, headerName)]: secret,
      },
    });
  }

  stageOAuth(provider: string, credential: Credential): CredentialDraftSummary {
    if (credential.type !== "oauth") throw new Error("OAuth draft requires OAuth credentials");
    return this.stage(provider, "oauth", credential);
  }

  resolve(provider: string, draftId: string): Credential {
    this.prune();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.provider !== provider)
      throw new Error("Credential draft is missing or expired");
    return structuredClone(draft.credential);
  }

  summary(provider: string, draftId: string): CredentialDraftSummary {
    this.resolve(provider, draftId);
    const draft = this.drafts.get(draftId)!;
    return publicSummary(draft);
  }

  remove(draftId: string): void {
    this.drafts.delete(draftId);
  }

  clear(): void {
    this.drafts.clear();
  }

  private stage(
    provider: string,
    authMethod: CredentialDraftSummary["authMethod"],
    credential: Credential,
  ): CredentialDraftSummary {
    const normalizedProvider = providerIdentifier(provider);
    const now = Date.now();
    const draft: CredentialDraft = {
      id: randomUUID(),
      provider: normalizedProvider,
      authMethod,
      masked: true,
      createdAt: now,
      expiresAtMs: now + this.ttlMs,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      credential: structuredClone(credential),
    };
    this.drafts.set(draft.id, draft);
    this.prune(now);
    return publicSummary(draft);
  }

  private prune(now = Date.now()): void {
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAtMs <= now) this.drafts.delete(id);
    }
  }
}

export type OAuthChallenge =
  | {
      id: string;
      type: "select";
      message: string;
      options: Array<{ id: string; label: string }>;
    }
  | {
      id: string;
      type: "text" | "manual-code";
      message: string;
      placeholder?: string | undefined;
      allowEmpty?: boolean | undefined;
    };

export type OAuthNotice =
  | { type: "auth-url"; url: string; instructions?: string | undefined }
  | {
      type: "device-code";
      userCode: string;
      verificationUri: string;
      expiresInSeconds?: number | undefined;
    }
  | { type: "progress"; message: string };

export interface OAuthSessionView {
  id: string;
  provider: string;
  providerName: string;
  status: "running" | "awaiting-input" | "completed" | "failed" | "cancelled" | "timed-out";
  revision: number;
  challenge: OAuthChallenge | null;
  notice: OAuthNotice | null;
  credentialDraft?: CredentialDraftSummary | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface PendingChallenge {
  challenge: OAuthChallenge;
  resolve(value: string | undefined): void;
  reject(error: Error): void;
}

interface OAuthSessionRecord extends OAuthSessionView {
  controller: AbortController;
  timer: NodeJS.Timeout;
  pending?: PendingChallenge | undefined;
  waiters: Set<() => void>;
}

export class OAuthSessionManager {
  private readonly sessions = new Map<string, OAuthSessionRecord>();
  private readonly timeoutMs: number;
  private readonly login: (
    runtime: ModelRuntime,
    provider: string,
    interaction: AuthInteraction,
  ) => Promise<Credential>;

  constructor(
    private readonly vault: CredentialDraftVault,
    private readonly persistentCredentials: CredentialStore,
    options: {
      timeoutMs?: number | undefined;
      login?:
        | ((
            runtime: ModelRuntime,
            provider: string,
            interaction: AuthInteraction,
          ) => Promise<Credential>)
        | undefined;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
    this.login =
      options.login ??
      ((runtime, provider, interaction) => runtime.login(provider, "oauth", interaction));
  }

  async start(provider: string, preferredMethod?: string): Promise<OAuthSessionView> {
    const definition = getProviderDefinition(provider);
    if (!definition?.oauthProvider || !definition.authMethods.includes("oauth")) {
      throw new Error(`Provider does not support OAuth: ${provider}`);
    }
    const loginProvider = definition.oauthProvider;
    const existing =
      (await this.persistentCredentials.read(provider)) ??
      (await this.persistentCredentials.read(loginProvider));
    const staging = new InMemoryCredentialStore();
    if (existing) {
      await staging.modify(loginProvider, async () => structuredClone(existing));
    }
    const stagingRuntime = await ModelRuntime.create({
      credentials: staging,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const now = Date.now();
    const controller = new AbortController();
    const record: OAuthSessionRecord = {
      id: randomUUID(),
      provider,
      providerName: definition.name,
      status: "running",
      revision: 1,
      challenge: null,
      notice: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
      controller,
      timer: setTimeout(() => this.abort(record, "timed-out"), this.timeoutMs),
      waiters: new Set(),
    };
    record.timer.unref();
    this.sessions.set(record.id, record);

    let selectedMethod = preferredMethod;
    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) => {
        const value = this.handlePrompt(record, prompt, selectedMethod);
        if (
          prompt.type === "select" &&
          selectedMethod &&
          prompt.options.some((option) => option.id === selectedMethod)
        ) {
          selectedMethod = undefined;
        }
        return value;
      },
      notify: (event) => this.handleAuthEvent(record, event),
    };

    void this.login(stagingRuntime, loginProvider, interaction)
      .then(async (result) => {
        if (isOAuthTerminal(record.status)) return;
        const credential = (await staging.read(loginProvider)) ?? result;
        if (!credential || credential.type !== "oauth")
          throw new Error("OAuth completed without credentials");
        const credentialDraft = this.vault.stageOAuth(provider, credential);
        this.releasePending(record, new Error("OAuth flow completed"));
        clearTimeout(record.timer);
        this.update(record, { status: "completed", challenge: null, credentialDraft });
      })
      .catch((error: unknown) => {
        if (isOAuthTerminal(record.status)) return;
        this.releasePending(record, new Error("OAuth flow stopped"));
        clearTimeout(record.timer);
        this.update(record, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          challenge: null,
          error: safeOAuthError(error),
        });
      });
    return publicOAuthSession(record);
  }

  private handlePrompt(
    record: OAuthSessionRecord,
    prompt: AuthPrompt,
    preferredMethod: string | undefined,
  ): Promise<string> {
    if (prompt.type === "select") {
      if (preferredMethod && prompt.options.some((option) => option.id === preferredMethod)) {
        return Promise.resolve(preferredMethod);
      }
      return this.awaitInput(record, {
        id: randomUUID(),
        type: "select",
        message: safeOAuthMessage(prompt.message),
        options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
      }).then((value) => value ?? "");
    }
    return this.awaitInput(record, {
      id: randomUUID(),
      type: prompt.type === "manual_code" ? "manual-code" : "text",
      message: safeOAuthMessage(prompt.message),
      ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    }).then((value) => value ?? "");
  }

  private handleAuthEvent(record: OAuthSessionRecord, event: AuthEvent): void {
    if (event.type === "auth_url") {
      this.update(record, {
        notice: {
          type: "auth-url",
          url: safeOAuthUrl(event.url),
          ...(event.instructions ? { instructions: event.instructions } : {}),
        },
      });
      return;
    }
    if (event.type === "device_code") {
      this.update(record, {
        notice: {
          type: "device-code",
          userCode: event.userCode,
          verificationUri: safeOAuthUrl(event.verificationUri),
          ...(event.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: event.expiresInSeconds }),
        },
      });
      return;
    }
    this.update(record, {
      notice: { type: "progress", message: safeOAuthMessage(event.message) },
    });
  }

  status(sessionId: string): OAuthSessionView {
    return publicOAuthSession(this.requireSession(sessionId));
  }

  async waitForStatus(
    sessionId: string,
    afterRevision: number,
    waitTimeoutMs: number,
  ): Promise<OAuthSessionView> {
    const record = this.requireSession(sessionId);
    if (record.revision > afterRevision || isOAuthTerminal(record.status))
      return publicOAuthSession(record);
    const bounded = Math.max(0, Math.min(waitTimeoutMs, 25_000));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        record.waiters.delete(done);
        resolve();
      }, bounded);
      const done = () => {
        clearTimeout(timer);
        record.waiters.delete(done);
        resolve();
      };
      record.waiters.add(done);
    });
    return publicOAuthSession(record);
  }

  respond(sessionId: string, challengeId: string, value?: string): OAuthSessionView {
    const record = this.requireSession(sessionId);
    const pending = record.pending;
    if (!pending || pending.challenge.id !== challengeId)
      throw new Error("OAuth prompt is stale or no longer active");
    if (
      pending.challenge.type === "select" &&
      !pending.challenge.options.some((option) => option.id === value)
    ) {
      throw new Error("Choose one of the offered OAuth options");
    }
    record.pending = undefined;
    this.update(record, { status: "running", challenge: null });
    pending.resolve(value);
    return publicOAuthSession(record);
  }

  cancel(sessionId: string): OAuthSessionView {
    const record = this.requireSession(sessionId);
    this.abort(record, "cancelled");
    return publicOAuthSession(record);
  }

  dispose(): void {
    for (const record of this.sessions.values()) this.abort(record, "cancelled");
    this.sessions.clear();
  }

  private awaitInput(
    record: OAuthSessionRecord,
    challenge: OAuthChallenge,
  ): Promise<string | undefined> {
    if (record.controller.signal.aborted)
      return Promise.reject(new Error("OAuth flow was cancelled"));
    this.releasePending(record, new Error("OAuth prompt was replaced"));
    return new Promise<string | undefined>((resolve, reject) => {
      record.pending = { challenge, resolve, reject };
      this.update(record, { status: "awaiting-input", challenge });
    });
  }

  private abort(record: OAuthSessionRecord, status: "cancelled" | "timed-out"): void {
    if (isOAuthTerminal(record.status)) return;
    clearTimeout(record.timer);
    record.controller.abort();
    this.releasePending(
      record,
      new Error(status === "timed-out" ? "OAuth flow timed out" : "OAuth flow was cancelled"),
    );
    this.update(record, {
      status,
      challenge: null,
      error: status === "timed-out" ? "OAuth sign-in timed out. Start a new sign-in." : undefined,
    });
  }

  private releasePending(record: OAuthSessionRecord, error: Error): void {
    const pending = record.pending;
    if (!pending) return;
    record.pending = undefined;
    pending.reject(error);
  }

  private update(
    record: OAuthSessionRecord,
    patch: Partial<
      Pick<OAuthSessionView, "status" | "challenge" | "notice" | "credentialDraft" | "error">
    >,
  ): void {
    Object.assign(record, patch);
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    // oxlint-disable-next-line no-useless-spread -- defensive copy: callbacks may mutate record.waiters mid-iteration
    for (const waiter of [...record.waiters]) waiter();
  }

  private requireSession(sessionId: string): OAuthSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error("Unknown OAuth session");
    return record;
  }
}

function publicSummary(draft: CredentialDraft): CredentialDraftSummary {
  return {
    id: draft.id,
    provider: draft.provider,
    authMethod: draft.authMethod,
    masked: true,
    expiresAt: draft.expiresAt,
  };
}

function publicOAuthSession(record: OAuthSessionRecord): OAuthSessionView {
  return {
    id: record.id,
    provider: record.provider,
    providerName: record.providerName,
    status: record.status,
    revision: record.revision,
    challenge: record.challenge ? structuredClone(record.challenge) : null,
    notice: record.notice ? structuredClone(record.notice) : null,
    ...(record.credentialDraft ? { credentialDraft: structuredClone(record.credentialDraft) } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}

function normalizeSecret(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > MAX_SECRET_LENGTH) throw new Error(`${label} is too long`);
  return value.trim();
}

function providerIdentifier(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("Invalid provider identifier");
  }
  return value;
}

function safeOAuthUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  ) {
    throw new Error("OAuth provider returned an unsafe URL");
  }
  return url.toString();
}

function safeOAuthMessage(value: string): string {
  return value
    .replace(/(?:access|refresh|id)_?token\s*[:=]\s*\S+/gi, "token=[redacted]")
    .slice(0, 2_000);
}

function safeOAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("cancel")) return "OAuth sign-in was cancelled.";
  if (message.includes("timed out") || message.includes("timeout"))
    return "OAuth sign-in timed out. Start a new sign-in.";
  if (message.includes("not enabled") || message.includes("unavailable"))
    return "This OAuth sign-in method is unavailable for the provider.";
  if (message.includes("unsafe url") || message.includes("untrusted"))
    return "The provider returned an unsafe OAuth address.";
  if (message.includes("network") || message.includes("fetch") || message.includes("connect"))
    return "The OAuth provider could not be reached. Retry the sign-in.";
  return "OAuth sign-in failed. Retry or choose another sign-in method.";
}

function isOAuthTerminal(status: OAuthSessionView["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed-out"
  );
}
