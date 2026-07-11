import assert from "node:assert/strict";
import test from "node:test";

import { AuthStorage } from "@earendil-works/pi-coding-agent";

import {
  CredentialDraftVault,
  OAuthSessionManager,
} from "../src/providers/credentials.js";
import { customProviderHeaderVariable } from "../src/pi/environment.js";

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
  const manager = new OAuthSessionManager(vault, AuthStorage.inMemory(), {
    timeoutMs: 5_000,
    login: async (storage, provider, callbacks) => {
      assert.equal(provider, "openai-codex");
      const method = await callbacks.onSelect({
        message: "Choose login method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      });
      assert.equal(method, "device_code");
      callbacks.onDeviceCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 900,
      });
      storage.set(provider, {
        type: "oauth",
        access: "access-token-secret",
        refresh: "refresh-token-secret",
        expires: Date.now() + 3_600_000,
      });
    },
  });

  const started = manager.start("openai-codex", "device_code");
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
  const manager = new OAuthSessionManager(vault, AuthStorage.inMemory(), {
    timeoutMs: 5_000,
    login: async (_storage, _provider, callbacks) => {
      await callbacks.onPrompt({ message: "Enter code", placeholder: "code" });
    },
  });
  const started = manager.start("anthropic");
  const waiting = started.status === "awaiting-input"
    ? started
    : await manager.waitForStatus(started.id, started.revision, 1_000);

  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.challenge?.type, "text");
  assert.throws(
    () => manager.respond(started.id, "stale-challenge", "value"),
    /stale/,
  );
  const cancelled = manager.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  manager.dispose();
});
