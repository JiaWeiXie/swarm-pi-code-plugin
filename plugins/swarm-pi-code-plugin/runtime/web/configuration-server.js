import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http, {} from "node:http";
import { once } from "node:events";
import { createFileCredentialStore } from "../pi/credentials.js";
import { CredentialDraftVault, OAuthSessionManager } from "../providers/credentials.js";
import {} from "../state/model-config.js";
import { loadState, prepareConfigurationStorage, } from "../state/state.js";
import { configureBuiltInProvider, createManualCustomProvider, discoverConfigurationEndpoint, discoverLocalConfigurationEndpoints, loadConfigurationView, saveConfigurationSubmission, saveProjectProfileSubmission, signOutProvider, stageCustomProviderCredential, verifyProviderConnection, } from "./configuration-service.js";
import { EndpointDiscoveryError } from "./model-discovery.js";
import { renderConfigurationPage } from "./ui.js";
const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export async function startConfigurationServer(cwd, options = {}) {
    const env = options.env ?? process.env;
    const storage = await prepareConfigurationStorage(cwd, env, { migrate: true });
    const token = randomBytes(32).toString("base64url");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const credentialVault = new CredentialDraftVault();
    const oauthSessions = new OAuthSessionManager(credentialVault, createFileCredentialStore(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE), { timeoutMs: Math.min(timeoutMs, 10 * 60 * 1000) });
    let origin = "";
    let settled = false;
    let idleTimer;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });
    const server = http.createServer(async (request, response) => {
        applySecurityHeaders(response);
        if (!isLoopbackRequest(request, origin))
            return json(response, 403, { error: "Local request required" });
        const url = new URL(request.url ?? "/", origin);
        if (!validToken(request, url, token))
            return json(response, 403, { error: "Invalid setup session" });
        resetTimer();
        try {
            if (request.method === "GET" && url.pathname === "/") {
                const view = await loadConfigurationView(cwd, env);
                const nonce = randomBytes(18).toString("base64");
                response.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                response.end(renderConfigurationPage(view, nonce, options.mode ?? "full"));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/save") {
                assertJsonRequest(request, origin);
                const body = await readJsonBody(request);
                assertNoRawCredentials(body);
                const submission = body;
                const view = await saveConfigurationSubmission(cwd, submission, env, { credentialVault });
                response.setHeader("Connection", "close");
                response.once("finish", () => void finish("saved"));
                json(response, 200, { saved: true, configuration: view.configuration });
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/save-profile") {
                assertJsonRequest(request, origin);
                const body = await readJsonBody(request);
                const settings = normalizeProjectSubmission(body);
                const profile = await saveProjectProfileSubmission(cwd, settings, env);
                const sandboxMode = (await loadState(cwd, { env })).config.sandboxMode ?? "strict";
                response.setHeader("Connection", "close");
                response.once("finish", () => void finish("saved"));
                json(response, 200, { saved: true, profile, sandboxMode });
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/connect") {
                assertJsonRequest(request, origin);
                const connection = normalizeBuiltInConnectionRequest(await readJsonBody(request));
                json(response, 200, await configureBuiltInProvider(cwd, connection, credentialVault, env));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/custom/credential") {
                assertJsonRequest(request, origin);
                const credential = normalizeCustomCredentialRequest(await readJsonBody(request));
                json(response, 200, await stageCustomProviderCredential(cwd, credentialVault, credential, env));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/discover") {
                assertJsonRequest(request, origin);
                const discovery = normalizeDiscoveryRequest(await readJsonBody(request));
                json(response, 200, await discoverConfigurationEndpoint(cwd, discovery, credentialVault, env));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/local") {
                assertJsonRequest(request, origin);
                await readJsonBody(request);
                json(response, 200, {
                    connections: await discoverLocalConfigurationEndpoints(cwd, env),
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/custom/manual") {
                assertJsonRequest(request, origin);
                json(response, 200, await createManualCustomProvider(cwd, normalizeManualProviderRequest(await readJsonBody(request)), env));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/verify") {
                assertJsonRequest(request, origin);
                const verification = normalizeVerificationRequest(await readJsonBody(request));
                json(response, 200, await verifyProviderConnection(cwd, verification, credentialVault, env));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/providers/sign-out") {
                assertJsonRequest(request, origin);
                const provider = normalizeProviderId(await readJsonBody(request));
                await signOutProvider(cwd, provider, env);
                json(response, 200, { signedOut: true, provider });
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/oauth/start") {
                assertJsonRequest(request, origin);
                const oauth = normalizeOAuthStart(await readJsonBody(request));
                json(response, 202, await oauthSessions.start(oauth.provider, oauth.preferredMethod));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/oauth/status") {
                assertJsonRequest(request, origin);
                const poll = normalizeOAuthPoll(await readJsonBody(request));
                json(response, 200, await oauthSessions.waitForStatus(poll.sessionId, poll.afterRevision, poll.waitTimeoutMs));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/oauth/respond") {
                assertJsonRequest(request, origin);
                const answer = normalizeOAuthResponse(await readJsonBody(request));
                json(response, 200, oauthSessions.respond(answer.sessionId, answer.challengeId, answer.value));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/oauth/cancel") {
                assertJsonRequest(request, origin);
                const sessionId = normalizeSessionId(await readJsonBody(request));
                json(response, 200, oauthSessions.cancel(sessionId));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/cancel") {
                assertJsonRequest(request, origin);
                await readJsonBody(request);
                response.setHeader("Connection", "close");
                response.once("finish", () => void finish("cancelled"));
                json(response, 200, { saved: false });
                return;
            }
            json(response, 404, { error: "Not found" });
        }
        catch (error) {
            const problem = setupProblem(error);
            json(response, statusForError(error), {
                error: problem.message,
                code: problem.code,
                stage: problem.stage,
                recoverable: problem.recoverable,
                preserved: problem.preserved,
                nextActions: problem.nextActions,
            });
        }
    });
    server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    server.listen(options.port ?? 0, LOOPBACK_HOST);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Unable to resolve configuration server address");
    origin = `http://${LOOPBACK_HOST}:${address.port}`;
    const url = `${origin}/?token=${encodeURIComponent(token)}`;
    resetTimer();
    if (options.openBrowser !== false) {
        try {
            await (options.openUrl ?? openSystemBrowser)(url);
        }
        catch {
            // Printing the URL is the supported fallback when browser launch is unavailable.
        }
    }
    async function finish(status) {
        if (settled)
            return;
        settled = true;
        if (idleTimer)
            clearTimeout(idleTimer);
        oauthSessions.dispose();
        credentialVault.clear();
        await closeServer(server);
        resolveCompletion({
            status,
            saved: status === "saved",
            modelConfigurationFile: storage.modelConfigurationFile,
            configurationStorage: storage,
            ...(options.continuationId ? { continuationId: options.continuationId } : {}),
        });
    }
    function resetTimer() {
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => void finish("timed-out"), timeoutMs);
        idleTimer.unref();
    }
    return {
        url,
        completion,
        close: () => finish("cancelled"),
    };
}
function setupProblem(error) {
    const message = redactSetupMessage(error instanceof Error ? error.message : "Configuration failed");
    const code = error instanceof EndpointDiscoveryError
        ? error.code
        : message.includes("smoke test")
            ? "model-smoke-test-failed"
            : message.includes("recovery-required")
                ? "configuration-recovery-required"
                : /sandbox/i.test(message)
                    ? "sandbox-backend-unavailable"
                    : /model|authenticated/i.test(message)
                        ? "model-configuration-invalid"
                        : "configuration-save-failed";
    const stage = code.includes("sandbox")
        ? "execution-safety"
        : code.includes("model")
            ? "models"
            : code.includes("recovery")
                ? "recovery"
                : "workspace";
    return {
        code,
        stage,
        recoverable: true,
        message,
        preserved: ["form input", "previous saved configuration"],
        nextActions: code === "sandbox-backend-unavailable"
            ? ["use-strict", "doctor"]
            : ["review-current-step", "doctor"],
    };
}
function redactSetupMessage(value) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]+/gi, "[redacted]")
        .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
        .slice(0, 2_000);
}
function normalizeProjectSubmission(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "Project profile request must be a JSON object");
    }
    const record = value;
    const profile = record.profile;
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
        throw new HttpError(400, "Project profile is required");
    }
    return {
        profile: profile,
        ...(record.sandboxMode !== undefined
            ? { sandboxMode: record.sandboxMode }
            : {}),
        ...(record.rolePolicies !== undefined
            ? { rolePolicies: record.rolePolicies }
            : {}),
        ...(record.adaptivePolicy !== undefined
            ? { adaptivePolicy: record.adaptivePolicy }
            : {}),
        ...(record.backgroundRolePolicy !== undefined
            ? {
                backgroundRolePolicy: record.backgroundRolePolicy,
            }
            : {}),
        ...(record.decisionMode !== undefined
            ? { decisionMode: record.decisionMode }
            : {}),
        ...(record.hostAssistance !== undefined
            ? { hostAssistance: record.hostAssistance }
            : {}),
        ...(record.contextBudget !== undefined
            ? { contextBudget: record.contextBudget }
            : {}),
        ...(record.advisor !== undefined
            ? { advisor: record.advisor }
            : {}),
        ...(record.doctrine !== undefined
            ? { doctrine: record.doctrine }
            : {}),
        ...(record.hostActions !== undefined
            ? { hostActions: record.hostActions }
            : {}),
    };
}
function normalizeDiscoveryRequest(value) {
    const record = objectRequest(value, "Discovery request");
    if (typeof record.baseUrl !== "string")
        throw new HttpError(400, "Server URL is required");
    if (record.protocol !== "openai-chat-completions" &&
        record.protocol !== "openai-responses" &&
        record.protocol !== "anthropic-messages") {
        throw new HttpError(400, "A supported API protocol is required");
    }
    if ("apiKey" in record || "secret" in record)
        throw new HttpError(400, "Use a credential draft for discovery");
    const provider = providerId(record.provider);
    const reservedProviderIds = record.reservedProviderIds === undefined
        ? []
        : normalizeReservedProviderIds(record.reservedProviderIds);
    return {
        baseUrl: record.baseUrl,
        provider,
        protocol: record.protocol,
        ...(typeof record.modelsEndpoint === "string" && record.modelsEndpoint
            ? { modelsEndpoint: record.modelsEndpoint }
            : {}),
        ...(record.authMethod === "api-key" ||
            record.authMethod === "none" ||
            record.authMethod === "custom-header"
            ? { authMethod: record.authMethod }
            : {}),
        ...(record.headerName === "authorization" ||
            record.headerName === "x-api-key" ||
            record.headerName === "api-key"
            ? { headerName: record.headerName }
            : {}),
        ...(typeof record.credentialDraftId === "string"
            ? { credentialDraftId: uuid(record.credentialDraftId, "credential draft") }
            : {}),
        ...(reservedProviderIds.length > 0 ? { reservedProviderIds } : {}),
    };
}
function normalizeReservedProviderIds(value) {
    if (!Array.isArray(value) || value.length > 512) {
        throw new HttpError(400, "Reserved provider identifiers must be an array of at most 512 values");
    }
    const identifiers = value.map((entry) => {
        if (typeof entry !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry)) {
            throw new HttpError(400, "Reserved provider identifiers are invalid");
        }
        return entry;
    });
    return [...new Set(identifiers)];
}
function normalizeBuiltInConnectionRequest(value) {
    const record = objectRequest(value, "Connection request");
    const provider = providerId(record.provider);
    const authMethod = record.authMethod;
    if (authMethod !== "api-key" &&
        authMethod !== "oauth" &&
        authMethod !== "ambient" &&
        authMethod !== "none" &&
        authMethod !== "custom-header") {
        throw new HttpError(400, "A supported authentication method is required");
    }
    const fields = stringFields(record.fields, "Provider fields");
    return {
        provider,
        authMethod,
        fields,
        ...(typeof record.credentialDraftId === "string"
            ? { credentialDraftId: uuid(record.credentialDraftId, "credential draft") }
            : {}),
    };
}
function normalizeCustomCredentialRequest(value) {
    const record = objectRequest(value, "Custom credential request");
    const protocol = wireProtocol(record.protocol);
    const authMethod = record.authMethod;
    if (authMethod !== "api-key" && authMethod !== "none" && authMethod !== "custom-header") {
        throw new HttpError(400, "A supported custom authentication method is required");
    }
    return {
        baseUrl: requiredText(record.baseUrl, "Server URL"),
        protocol,
        authMethod,
        ...(typeof record.secret === "string"
            ? { secret: boundedTextField(record.secret, "Credential", 16_384) }
            : {}),
        ...(record.headerName === "authorization" ||
            record.headerName === "x-api-key" ||
            record.headerName === "api-key"
            ? { headerName: record.headerName }
            : {}),
        ...(typeof record.existingProvider === "string"
            ? { existingProvider: providerId(record.existingProvider) }
            : {}),
    };
}
function normalizeManualProviderRequest(value) {
    const record = objectRequest(value, "Manual provider request");
    const authMethod = record.authMethod;
    if (authMethod !== "api-key" && authMethod !== "none" && authMethod !== "custom-header") {
        throw new HttpError(400, "A supported custom authentication method is required");
    }
    if (!Array.isArray(record.modelIds) ||
        !record.modelIds.every((entry) => typeof entry === "string")) {
        throw new HttpError(400, "Manual model identifiers must be a string array");
    }
    return {
        baseUrl: requiredText(record.baseUrl, "Server URL"),
        protocol: wireProtocol(record.protocol),
        authMethod,
        modelIds: record.modelIds,
        ...(typeof record.modelsEndpoint === "string" && record.modelsEndpoint
            ? { modelsEndpoint: record.modelsEndpoint }
            : {}),
        ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
        ...(record.headerName === "authorization" ||
            record.headerName === "x-api-key" ||
            record.headerName === "api-key"
            ? { headerName: record.headerName }
            : {}),
        ...(typeof record.existingProvider === "string"
            ? { existingProvider: providerId(record.existingProvider) }
            : {}),
    };
}
function normalizeVerificationRequest(value) {
    const record = objectRequest(value, "Verification request");
    assertNoRawCredentials(record);
    if (!Array.isArray(record.customProviders) || !Array.isArray(record.providerProfiles)) {
        throw new HttpError(400, "Verification requires provider configuration and profiles");
    }
    const drafts = record.credentialDrafts;
    if (drafts !== undefined && !Array.isArray(drafts))
        throw new HttpError(400, "Credential drafts must be an array");
    return {
        model: requiredText(record.model, "Model"),
        customProviders: record.customProviders,
        providerProfiles: record.providerProfiles,
        ...(drafts ? { credentialDrafts: drafts } : {}),
    };
}
function normalizeOAuthStart(value) {
    const record = objectRequest(value, "OAuth start request");
    return {
        provider: providerId(record.provider),
        ...(typeof record.preferredMethod === "string" && record.preferredMethod
            ? { preferredMethod: boundedTextField(record.preferredMethod, "OAuth method", 128) }
            : {}),
    };
}
function normalizeOAuthPoll(value) {
    const record = objectRequest(value, "OAuth status request");
    return {
        sessionId: uuid(record.sessionId, "OAuth session"),
        afterRevision: boundedInteger(record.afterRevision, "OAuth revision", 0, Number.MAX_SAFE_INTEGER),
        waitTimeoutMs: boundedInteger(record.waitTimeoutMs ?? 20_000, "OAuth wait timeout", 0, 25_000),
    };
}
function normalizeOAuthResponse(value) {
    const record = objectRequest(value, "OAuth response");
    return {
        sessionId: uuid(record.sessionId, "OAuth session"),
        challengeId: uuid(record.challengeId, "OAuth challenge"),
        ...(typeof record.value === "string"
            ? { value: boundedTextField(record.value, "OAuth response", 16_384, true) }
            : {}),
    };
}
function normalizeSessionId(value) {
    return uuid(objectRequest(value, "OAuth cancel request").sessionId, "OAuth session");
}
function normalizeProviderId(value) {
    return providerId(objectRequest(value, "Provider request").provider);
}
function objectRequest(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, `${label} must be a JSON object`);
    }
    return value;
}
function stringFields(value, label) {
    const record = objectRequest(value, label);
    if (Object.keys(record).length > 64)
        throw new HttpError(400, `${label} contains too many entries`);
    const fields = {};
    for (const [key, raw] of Object.entries(record)) {
        if (typeof raw !== "string")
            throw new HttpError(400, `${label}.${key} must be text`);
        fields[key] = boundedTextField(raw, `${label}.${key}`, 16_384, true);
    }
    return fields;
}
function providerId(value) {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
        throw new HttpError(400, "Provider identifier is invalid");
    }
    return value;
}
function uuid(value, label) {
    if (typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new HttpError(400, `${label} identifier is invalid`);
    }
    return value;
}
function wireProtocol(value) {
    if (value !== "openai-chat-completions" &&
        value !== "openai-responses" &&
        value !== "anthropic-messages") {
        throw new HttpError(400, "A supported API protocol is required");
    }
    return value;
}
function requiredText(value, label) {
    if (typeof value !== "string")
        throw new HttpError(400, `${label} is required`);
    return boundedTextField(value, label, 16_384);
}
function boundedTextField(value, label, maximum, allowEmpty = false) {
    const normalized = value.trim();
    if (!allowEmpty && !normalized)
        throw new HttpError(400, `${label} is required`);
    if (value.length > maximum)
        throw new HttpError(400, `${label} is too long`);
    return normalized;
}
function boundedInteger(value, label, minimum, maximum) {
    if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new HttpError(400, `${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return Number(value);
}
function assertNoRawCredentials(value) {
    const forbidden = new Set(["apikey", "credential", "credentials", "secret", "token"]);
    const visit = (current) => {
        if (Array.isArray(current)) {
            current.forEach(visit);
            return;
        }
        if (typeof current !== "object" || current === null)
            return;
        for (const [key, nested] of Object.entries(current)) {
            if (forbidden.has(key.toLowerCase()))
                throw new HttpError(400, "Raw credentials are only accepted by the credential draft endpoint");
            visit(nested);
        }
    };
    visit(value);
}
function isLoopbackRequest(request, origin) {
    const remote = request.socket.remoteAddress;
    if (remote !== LOOPBACK_HOST && remote !== `::ffff:${LOOPBACK_HOST}` && remote !== "::1")
        return false;
    if (!origin)
        return true;
    const expected = new URL(origin).host;
    return request.headers.host === expected;
}
function validToken(request, url, expected) {
    const supplied = request.headers["x-swarm-token"] ?? url.searchParams.get("token") ?? "";
    if (Array.isArray(supplied))
        return false;
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}
function assertJsonRequest(request, origin) {
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "JSON request required");
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== origin)
        throw new HttpError(403, "Cross-origin request rejected");
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin")
        throw new HttpError(403, "Cross-site request rejected");
}
async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new HttpError(413, "Request body is too large");
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    }
    catch {
        throw new HttpError(400, "Request body must contain valid JSON");
    }
}
function applySecurityHeaders(response) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
}
function json(response, status, value) {
    if (response.headersSent)
        return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(value)}\n`);
}
function statusForError(error) {
    return error instanceof HttpError ? error.status : 400;
}
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
async function closeServer(server) {
    if (!server.listening)
        return;
    server.close();
    await once(server, "close");
}
function openSystemBrowser(url) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { });
    child.unref();
}
