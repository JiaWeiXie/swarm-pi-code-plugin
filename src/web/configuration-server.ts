import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import type { Host } from "../core/contracts.js";
import { resolveModelConfigurationFile } from "../state/model-config.js";
import {
  loadConfigurationView,
  saveConfigurationSubmission,
  type ConfigurationSubmission,
} from "./configuration-service.js";
import { renderConfigurationPage } from "./ui.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type ConfigurationCompletion = {
  status: "saved" | "cancelled" | "timed-out";
  saved: boolean;
  modelConfigurationFile: string;
};

export interface ConfigurationServerOptions {
  host?: Host | undefined;
  port?: number | undefined;
  openBrowser?: boolean | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  openUrl?: ((url: string) => Promise<void> | void) | undefined;
}

export interface ConfigurationServerSession {
  url: string;
  completion: Promise<ConfigurationCompletion>;
  close(): Promise<void>;
}

export async function startConfigurationServer(
  cwd: string,
  options: ConfigurationServerOptions = {},
): Promise<ConfigurationServerSession> {
  const token = randomBytes(32).toString("base64url");
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let origin = "";
  let settled = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (value: ConfigurationCompletion) => void;
  const completion = new Promise<ConfigurationCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    if (!isLoopbackRequest(request, origin)) return json(response, 403, { error: "Local request required" });
    const url = new URL(request.url ?? "/", origin);
    if (!validToken(request, url, token)) return json(response, 403, { error: "Invalid setup session" });
    resetTimer();
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const view = await loadConfigurationView(cwd, env);
        const nonce = randomBytes(18).toString("base64");
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        );
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderConfigurationPage(view, nonce));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/save") {
        assertJsonRequest(request, origin);
        const submission = (await readJsonBody(request)) as ConfigurationSubmission;
        const view = await saveConfigurationSubmission(cwd, submission, env);
        response.setHeader("Connection", "close");
        response.once("finish", () => void finish("saved"));
        json(response, 200, { saved: true, configuration: view.configuration });
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
    } catch (error) {
      json(response, statusForError(error), {
        error: error instanceof Error ? error.message : "Configuration failed",
      });
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.listen(options.port ?? 0, LOOPBACK_HOST);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve configuration server address");
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  const url = `${origin}/?token=${encodeURIComponent(token)}`;
  resetTimer();

  if (options.openBrowser !== false) {
    try {
      await (options.openUrl ?? openSystemBrowser)(url);
    } catch {
      // Printing the URL is the supported fallback when browser launch is unavailable.
    }
  }

  async function finish(status: ConfigurationCompletion["status"]): Promise<void> {
    if (settled) return;
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
    await closeServer(server);
    resolveCompletion({
      status,
      saved: status === "saved",
      modelConfigurationFile: await resolveModelConfigurationFile(cwd),
    });
  }

  function resetTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void finish("timed-out"), timeoutMs);
    idleTimer.unref();
  }

  return {
    url,
    completion,
    close: () => finish("cancelled"),
  };
}

function isLoopbackRequest(request: IncomingMessage, origin: string): boolean {
  const remote = request.socket.remoteAddress;
  if (remote !== LOOPBACK_HOST && remote !== `::ffff:${LOOPBACK_HOST}` && remote !== "::1") return false;
  if (!origin) return true;
  const expected = new URL(origin).host;
  return request.headers.host === expected;
}

function validToken(request: IncomingMessage, url: URL, expected: string): boolean {
  const supplied = request.headers["x-swarm-token"] ?? url.searchParams.get("token") ?? "";
  if (Array.isArray(supplied)) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertJsonRequest(request: IncomingMessage, origin: string): void {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON request required");
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin && requestOrigin !== origin) throw new HttpError(403, "Cross-origin request rejected");
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin") throw new HttpError(403, "Cross-site request rejected");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON");
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function statusForError(error: unknown): number {
  return error instanceof HttpError ? error.status : 400;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function openSystemBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
