import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import {
  InMemoryCredentialStore,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type CredentialData = Record<string, Credential>;

const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 100;

/**
 * A small CredentialStore compatible with Pi's auth.json format.
 *
 * Pi 0.80.8 deliberately stopped exporting its AuthStorage implementation.
 * Keeping this adapter in the plugin preserves the existing file boundary and
 * lets configuration flows use the same storage contract as ModelRuntime.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const data = await this.readData();
    const credential = data[providerId];
    return credential ? resolveCredential(credential) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const data = await this.readData();
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.withLock(async (data) => {
      const current = cloneCredential(data[providerId]);
      const next = await fn(current);
      if (next === undefined) return { result: current };
      data[providerId] = structuredClone(next);
      return { result: cloneCredential(next), write: true };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async (data) => {
      delete data[providerId];
      return { result: undefined, write: true };
    });
  }

  private async readData(): Promise<CredentialData> {
    try {
      const content = await readFile(this.authPath, "utf8");
      return parseCredentialData(content);
    } catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
  }

  private async withLock<T>(
    fn: (data: CredentialData) => Promise<{ result: T; write?: boolean }>,
  ): Promise<T> {
    await mkdir(path.dirname(this.authPath), { recursive: true, mode: AUTH_DIRECTORY_MODE });
    const lockPath = `${this.authPath}.lock`;
    await acquireLock(lockPath);
    try {
      let data: CredentialData = {};
      try {
        data = parseCredentialData(await readFile(this.authPath, "utf8"));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const outcome = await fn(data);
      if (outcome.write) await writeCredentialData(this.authPath, data);
      return outcome.result;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

/** Apply provider-profile environment values without persisting them. */
export class OverlayCredentialStore implements CredentialStore {
  constructor(
    private readonly delegate: CredentialStore,
    private readonly overlays: ReadonlyMap<string, Readonly<Record<string, string>>>,
  ) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = await this.delegate.read(providerId);
    const overlay = this.overlays.get(providerId);
    if (!credential && overlay) return { type: "api_key", env: { ...overlay } };
    if (!credential || !overlay) return credential;
    if (credential.type !== "api_key") return credential;
    return { ...credential, env: { ...credential.env, ...overlay } };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const entries = [...(await this.delegate.list())];
    const known = new Set(entries.map((entry) => entry.providerId));
    for (const providerId of this.overlays.keys()) {
      if (!known.has(providerId)) entries.push({ providerId, type: "api_key" });
    }
    return entries;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.delegate.modify(providerId, fn);
  }

  delete(providerId: string): Promise<void> {
    return this.delegate.delete(providerId);
  }
}

export function createFileCredentialStore(authPath: string | undefined): FileCredentialStore {
  return new FileCredentialStore(authPath ?? path.join(getAgentDir(), "auth.json"));
}

export async function cloneCredentialStore(
  source: CredentialStore,
): Promise<InMemoryCredentialStore> {
  const target = new InMemoryCredentialStore();
  for (const entry of await source.list()) {
    const credential = await source.read(entry.providerId);
    if (credential) await target.modify(entry.providerId, async () => structuredClone(credential));
  }
  return target;
}

function parseCredentialData(content: string): CredentialData {
  if (!content.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pi credential store must contain a JSON object");
  }
  return parsed as CredentialData;
}

async function writeCredentialData(authPath: string, data: CredentialData): Promise<void> {
  const temporaryPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: AUTH_FILE_MODE,
  });
  await rename(temporaryPath, authPath);
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > LOCK_STALE_MS) await rm(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (!isMissing(statError)) throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for the Pi credential store lock");
}

function resolveCredential(credential: Credential): Credential {
  if (credential.type !== "api_key" || !credential.key) return structuredClone(credential);
  const key = resolveEnvironmentTemplate(credential.key, credential.env);
  const resolved = structuredClone(credential);
  if (key === undefined) delete resolved.key;
  else resolved.key = key;
  return resolved;
}

function resolveEnvironmentTemplate(
  value: string,
  env: Record<string, string> | undefined,
): string | undefined {
  let unresolved = false;
  const resolved = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced, bare) => {
      const name = braced ?? bare;
      const replacement = env?.[name] ?? process.env[name];
      if (replacement === undefined) {
        unresolved = true;
        return "";
      }
      return replacement;
    },
  );
  return unresolved ? undefined : resolved;
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential ? structuredClone(credential) : undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
