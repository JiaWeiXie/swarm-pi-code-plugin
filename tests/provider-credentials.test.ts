import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { FileCredentialStore, OverlayCredentialStore } from "../src/pi/credentials.js";
import { customProviderHeaderVariable } from "../src/pi/environment.js";
import { CredentialDraftVault, OAuthSessionManager } from "../src/providers/credentials.js";

test("credential drafts expose only opaque metadata", () => {
  const vault = new CredentialDraftVault();
  const secret = "secret-that-must-not-leak";
  const draft = vault.stageApiKey("openai", secret);

  assert.equal(draft.masked, true);
  assert.doesNotMatch(JSON.stringify(draft), new RegExp(secret));
  assert.deepEqual(vault.resolve("openai", draft.id), { type: "api_key", key: secret });
  assert.throws(() => vault.resolve("anthropic", draft.id), /missing or expired/);
});

test("custom-header drafts keep secret values in provider-scoped credential env", () => {
  const vault = new CredentialDraftVault();
  const draft = vault.stageCustomHeader("custom-test", "x-api-key", "header-secret");
  const credential = vault.resolve("custom-test", draft.id);

  assert.equal(credential.type, "api_key");
  if (credential.type === "api_key") {
    assert.equal(credential.key, "header-secret");
    assert.equal(
      credential.env?.[customProviderHeaderVariable("custom-test", "x-api-key")],
      "header-secret",
    );
  }
  assert.doesNotMatch(JSON.stringify(draft), /header-secret/);
});

test("ChatGPT subscription OAuth supports device-code login without exposing tokens", async () => {
  const vault = new CredentialDraftVault();
  const manager = new OAuthSessionManager(vault, new InMemoryCredentialStore(), {
    timeoutMs: 5_000,
    login: async (_runtime, provider, interaction) => {
      assert.equal(provider, "openai-codex");
      const method = await interaction.prompt({
        type: "select",
        message: "Choose login method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      });
      assert.equal(method, "device_code");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 900,
      });
      return {
        type: "oauth",
        access: "access-token-secret",
        refresh: "refresh-token-secret",
        expires: Date.now() + 3_600_000,
      };
    },
  });

  const started = await manager.start("openai-codex", "device_code");
  let status = await manager.waitForStatus(started.id, started.revision, 1_000);
  while (status.status !== "completed") {
    status = await manager.waitForStatus(started.id, status.revision, 1_000);
  }

  assert.equal(status.notice?.type, "device-code");
  assert.equal(status.credentialDraft?.provider, "openai-codex");
  assert.doesNotMatch(JSON.stringify(status), /access-token-secret|refresh-token-secret/);
  const credential = vault.resolve("openai-codex", status.credentialDraft!.id);
  assert.equal(credential.type, "oauth");
  manager.dispose();
});

test("OAuth prompts use revision-fenced responses and cancellation", async () => {
  const vault = new CredentialDraftVault();
  const manager = new OAuthSessionManager(vault, new InMemoryCredentialStore(), {
    timeoutMs: 5_000,
    login: async (_runtime, _provider, interaction) => {
      await interaction.prompt({ type: "text", message: "Enter code", placeholder: "code" });
      return {
        type: "oauth",
        access: "access-token-secret",
        refresh: "refresh-token-secret",
        expires: Date.now() + 3_600_000,
      };
    },
  });
  const started = await manager.start("anthropic");
  const waiting =
    started.status === "awaiting-input"
      ? started
      : await manager.waitForStatus(started.id, started.revision, 1_000);

  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.challenge?.type, "text");
  assert.throws(() => manager.respond(started.id, "stale-challenge", "value"), /stale/);
  const cancelled = manager.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  manager.dispose();
});

test("credential mutations abort while waiting for the store lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swarm-pi-credentials-"));
  try {
    const authPath = path.join(root, "auth.json");
    // A live lock directory holds every writer off, so `modify` parks in the
    // retry wait where cancellation has to be observed.
    await mkdir(`${authPath}.lock`);
    const store = new OverlayCredentialStore(new FileCredentialStore(authPath), new Map());

    const startedAt = Date.now();
    await assert.rejects(
      () =>
        store.modify("openai", async () => ({ type: "api_key", key: "must-not-be-written" }), {
          signal: AbortSignal.timeout(25),
        }),
      (error: unknown) => (error as Error).name === "AbortError",
    );

    // Without cancellation the ceiling is 100 retries x 100ms, so a fast
    // rejection proves the wait itself aborted rather than running to timeout.
    assert.ok(Date.now() - startedAt < 1_000);
    await assert.rejects(() => stat(authPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abort inside the mutation callback commits nothing and leaves no temp file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swarm-pi-credentials-"));
  try {
    const authPath = path.join(root, "auth.json");
    const store = new OverlayCredentialStore(new FileCredentialStore(authPath), new Map());
    const controller = new AbortController();

    await assert.rejects(
      () =>
        store.modify(
          "openai",
          async () => {
            // Aborting here lands before the atomic rename, so the write must
            // never reach auth.json.
            controller.abort();
            return { type: "api_key", key: "must-not-be-written" };
          },
          { signal: controller.signal },
        ),
      (error: unknown) => (error as Error).name === "AbortError",
    );

    await assert.rejects(() => stat(authPath), /ENOENT/);
    assert.deepEqual(
      (await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
      [],
      "a cancelled write left a temporary credential file behind",
    );
    // The lock is released even on the cancelled path, so the next write works.
    const written = await store.modify("openai", async () => ({
      type: "api_key",
      key: "written-after-cancellation",
    }));
    assert.equal(written?.type, "api_key");
    assert.equal((await store.read("openai"))?.type, "api_key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
