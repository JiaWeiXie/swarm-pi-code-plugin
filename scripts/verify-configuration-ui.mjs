#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { startConfigurationServer } from "../plugins/swarm-pi-code-plugin/runtime/web/configuration-server.js";
import {
  loadModelConfiguration,
  saveModelConfiguration,
} from "../plugins/swarm-pi-code-plugin/runtime/state/model-config.js";
import { updateState } from "../plugins/swarm-pi-code-plugin/runtime/state/state.js";

const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 1231, height: 900 },
  { width: 1024, height: 900 },
  { width: 768, height: 900 },
  { width: 375, height: 900 },
];
const TASKS = ["planning", "implementation", "code-review"];
const OUTPUT = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : null;
// Pi's ModelRuntime discovers built-in provider credentials from process.env.
// Keep host credentials from changing the intentionally empty E2E fixtures.
const PI_PROVIDER_ENV_VARS = [
  "AI_GATEWAY_API_KEY",
  "ANT_LING_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_GATEWAY_ID",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GCLOUD_PROJECT",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
];

function isolatePiProviderEnvironment() {
  const saved = new Map();
  for (const name of PI_PROVIDER_ENV_VARS) {
    if (!Object.hasOwn(process.env, name)) continue;
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) process.env[name] = value;
  };
}

async function makeFixture({ configured, projectOnly }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-config-e2e-"));
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-config-e2e-auth-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_DATA_DIR: ".configuration-e2e-state",
    SWARM_PI_CODE_PLUGIN_AUTH_FILE: path.join(privateDir, "auth.json"),
    SWARM_PI_CODE_PLUGIN_MODELS_FILE: path.join(privateDir, "models.json"),
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: path.join(privateDir, "state"),
    SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST: "1",
  };
  const fixtureProvider = {
    id: "fixture",
    name: "Fixture Service",
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    authHeader: false,
    requiresApiKey: false,
    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: true, input: ["text"] }],
  };
  // A custom connection saved through the UI always carries a provider profile;
  // the Edit dialog needs one to hydrate its profile draft.
  const fixtureProfile = {
    id: "fixture",
    provider: "fixture",
    name: "Fixture Service",
    connectionKind: "custom",
    auth: { method: "none" },
    protocol: "openai-chat-completions",
    runtimeApi: "openai-completions",
    readiness: "configured",
    settings: {},
    headers: [],
  };
  if (configured) {
    await saveModelConfiguration(
      workspace,
      {
        version: 1,
        primary: "fixture/fixture-model",
        fallbacks: [],
        customProviders: [fixtureProvider],
        providerProfiles: [fixtureProfile],
      },
      env,
    );
    await updateState(
      workspace,
      (state) => {
        state.config.profile = {
          goal: "Maintain a dependable project setup experience",
          tasks: TASKS,
          ...(projectOnly ? {} : { dirs: ["."] }),
          configuredAt: "2026-01-01T00:00:00.000Z",
        };
        state.config.sandboxMode = "strict";
        state.config.adaptivePolicy = {
          classifierModels: ["fixture/fixture-model"],
          classifierThinkingLevel: "medium",
          approvalPolicy: "wait",
          trustedDomains: ["registry.npmjs.org"],
          rules: [],
          diagnostics: true,
        };
        state.config.rolePolicies = {
          planner: { models: ["fixture/fixture-model"], thinkingLevel: "xhigh", maxAttempts: 2 },
          reviewer: { models: ["fixture/fixture-model"], thinkingLevel: "high", maxAttempts: 2 },
        };
        state.config.decisionMode = "balance";
        state.config.hostAssistance = {
          ...state.config.hostAssistance,
          enabled: true,
          mode: "on",
          reviewMode: "host-first",
          autoApprovalScope: "reversible",
          autoApproveDiscoveryGates: true,
        };
      },
      env,
    );
  }
  return { workspace, privateDir, env, fixtureProvider };
}

async function openSession(browser, fixture, mode, viewport) {
  const server = await startConfigurationServer(fixture.workspace, {
    env: fixture.env,
    mode,
    openBrowser: false,
    timeoutMs: 120_000,
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];
  const responseChecks = [];
  const badRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/providers/custom/credential")) {
      badRequests.push(request.postData() || "");
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      responseChecks.push(
        response
          .text()
          .catch(() => "")
          .then((body) => badResponses.push(`${response.status()} ${response.url()} ${body}`)),
      );
    }
  });
  await page.goto(server.url, { waitUntil: "networkidle" });
  return {
    server,
    context,
    page,
    consoleErrors,
    pageErrors,
    badResponses,
    responseChecks,
    badRequests,
  };
}

async function closeSession(session) {
  await Promise.all(session.responseChecks);
  await session.context.close();
  await session.server.close().catch(() => {});
  assert.deepEqual(
    session.badResponses,
    [],
    `Configuration UI emitted HTTP errors (requests=${JSON.stringify(session.badRequests)})`,
  );
  assert.deepEqual(session.consoleErrors, [], "Configuration UI emitted console errors");
  assert.deepEqual(session.pageErrors, [], "Configuration UI emitted page errors");
}

async function cleanupFixture(fixture) {
  await fs.rm(fixture.workspace, { recursive: true, force: true });
  await fs.rm(fixture.privateDir, { recursive: true, force: true });
}

async function assertPageHealth(page, label) {
  const headings = page.locator("section:not([hidden]) h1");
  const headingCount = await headings.count();
  assert.equal(
    headingCount,
    1,
    `${label}: expected one visible setup heading, got ${headingCount}`,
  );
  const heading = await headings.textContent();
  assert.ok(heading?.trim(), `${label}: visible setup page has no heading`);
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal document overflow (${metrics.scrollWidth} > ${metrics.clientWidth})`,
  );
  assert.ok(
    metrics.bodyScrollWidth <= metrics.clientWidth + 1,
    `${label}: horizontal body overflow (${metrics.bodyScrollWidth} > ${metrics.clientWidth})`,
  );
  assert.equal(
    await page.locator("dialog[open]").count(),
    0,
    `${label}: modal overlay remained open`,
  );
}

async function maybeScreenshot(page, name) {
  if (!OUTPUT) return;
  await fs.mkdir(OUTPUT, { recursive: true });
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: false });
}

async function assertBlankFull(browser, viewport) {
  const fixture = await makeFixture({ configured: false, projectOnly: false });
  const modelFile = path.join(
    fixture.workspace,
    fixture.env.SWARM_PI_CODE_PLUGIN_DATA_DIR,
    "model.json",
  );
  const session = await openSession(browser, fixture, "full", viewport);
  try {
    await assertPageHealth(session.page, `full blank ${viewport.width}`);
    assert.equal(
      await session.page.locator("#connection-empty").isVisible(),
      true,
      `full blank ${viewport.width}: empty connection state is not visible`,
    );
    assert.equal(
      await session.page.locator("#next-button").isDisabled(),
      true,
      `full blank ${viewport.width}: next button is not fail-closed`,
    );
    assert.equal(
      await fs
        .access(modelFile)
        .then(() => true)
        .catch(() => false),
      false,
      `full blank ${viewport.width}: model file was written during initialization`,
    );
    await maybeScreenshot(session.page, `full-blank-${viewport.width}`);
  } finally {
    await closeSession(session);
    await cleanupFixture(fixture);
  }
}

async function assertBlankProject(browser, viewport) {
  const fixture = await makeFixture({ configured: false, projectOnly: true });
  const session = await openSession(browser, fixture, "project", viewport);
  try {
    await assertPageHealth(session.page, `project blank ${viewport.width}`);
    assert.equal(
      await session.page.locator("#roles-screen").isVisible(),
      true,
      `project blank ${viewport.width}: roles page is not visible`,
    );
    assert.equal(
      await session.page.locator("#project-only-model-warning").isVisible(),
      true,
      `project blank ${viewport.width}: missing-model warning is not visible`,
    );
    assert.equal(
      await session.page.locator("#next-button").isDisabled(),
      true,
      `project blank ${viewport.width}: next button is not fail-closed`,
    );
    await maybeScreenshot(session.page, `project-blank-${viewport.width}`);
  } finally {
    await closeSession(session);
    await cleanupFixture(fixture);
  }
}

async function completeBlankFullInitialization(browser, viewport) {
  const fixture = await makeFixture({ configured: false, projectOnly: false });
  const modelFile = fixture.env.SWARM_PI_CODE_PLUGIN_MODELS_FILE;
  const session = await openSession(browser, fixture, "full", viewport);
  try {
    await assertPageHealth(session.page, `full initialization blank ${viewport.width}`);
    assert.equal(
      await fs
        .access(modelFile)
        .then(() => true)
        .catch(() => false),
      false,
      "blank initialization wrote model configuration before Connect",
    );
    const emptyConnect = session.page.locator("#empty-connect");
    assert.equal(await emptyConnect.count(), 1);
    await emptyConnect.click();
    const customTab = session.page.locator("#custom-tab");
    assert.equal(await customTab.count(), 1);
    await customTab.click();
    await session.page.locator("#endpoint-auth-method").selectOption("none");
    assert.equal(
      await session.page.locator("#endpoint-auth-method").inputValue(),
      "none",
      "manual initialization did not select no-authentication mode",
    );
    await session.page.locator("#endpoint-url").fill("http://127.0.0.1:11434/v1");
    await session.page.locator("#manual-models summary").click();
    await session.page.locator("#manual-model-ids").fill("fixture-model");
    await session.page.locator("#use-manual-models").click();
    await session.page.locator("#accept-endpoint").waitFor({ state: "visible" });
    await session.page.locator("#accept-endpoint").click();
    await assertPageHealth(session.page, `full initialization connected ${viewport.width}`);
    assert.equal(await session.page.locator("#connection-list .connection-row").count(), 1);
    assert.equal(await session.page.locator("#next-button").isDisabled(), false);
    await walkFullConfiguration(session.page, viewport, { save: true, expectCustomPrimary: true });
    const savedConfiguration = await loadModelConfiguration(fixture.workspace, [], fixture.env);
    assert.match(
      savedConfiguration.primary || "",
      /\/fixture-model$/,
      `blank initialization did not persist model configuration after Save (file=${modelFile})`,
    );
  } finally {
    await closeSession(session);
  }
  await cleanupFixture(fixture);
}

async function walkFullConfiguration(page, viewport, { save, expectCustomPrimary = false }) {
  await assertPageHealth(page, `full connections ${viewport.width}`);
  assert.equal(await page.locator("#connection-list .connection-row").count(), 1);
  await page.locator("#next-button").click();
  await assertPageHealth(page, `full models ${viewport.width}`);
  const primaryModel = await page.locator("#primary-model").inputValue();
  if (expectCustomPrimary)
    assert.match(primaryModel, /^custom-[a-z0-9.-]+-[a-f0-9]{10}\/fixture-model$/);
  else assert.equal(primaryModel, "fixture/fixture-model");
  await page.locator("#next-button").click();
  await assertPageHealth(page, `full roles ${viewport.width}`);
  assert.ok((await page.locator("#role-policy-list select").count()) >= 3);
  const roleThinking = page.locator("#role-policy-list select").nth(1);
  await roleThinking.selectOption("high");
  await page.locator("#next-button").click();
  await assertPageHealth(page, `full safety ${viewport.width}`);
  assert.equal(
    await page.locator("#sandbox-strict").getAttribute("aria-checked"),
    expectCustomPrimary ? "false" : "true",
  );
  if (expectCustomPrimary) {
    await page.locator("#sandbox-strict").click();
    assert.equal(await page.locator("#sandbox-strict").getAttribute("aria-checked"), "true");
  }
  await page.locator("#decision-mode").selectOption("cost");
  await page.locator("#host-assistance-mode").selectOption("on");
  await page.locator("#next-button").click();
  await assertPageHealth(page, `full workspace ${viewport.width}`);
  await page.locator("#project-goal").fill("Updated through the reconfiguration QA gate");
  await page.locator("#scope-all").click();
  assert.equal(await page.locator("#scope-all").getAttribute("aria-checked"), "true");
  await page.locator("#next-button").click();
  await assertPageHealth(page, `full review ${viewport.width}`);
  assert.match(await page.locator("#review-goal").textContent(), /Updated through/);
  assert.match(await page.locator("#review-sandbox").textContent(), /Strict/);
  await maybeScreenshot(page, `full-review-${viewport.width}`);
  if (save) {
    await page.locator("#save-button").click();
    await page.locator("#closed-screen").waitFor({ state: "visible" });
    assert.match(await page.locator("#completion-title").textContent(), /Configuration saved/);
  }
}

async function assertFullReconfiguration(browser, viewport, save) {
  const fixture = await makeFixture({ configured: true, projectOnly: false });
  const session = await openSession(browser, fixture, "full", viewport);
  try {
    await walkFullConfiguration(session.page, viewport, { save });
  } finally {
    await closeSession(session);
  }
  if (save) {
    const reload = await openSession(browser, fixture, "full", viewport);
    try {
      await reload.page.locator("#next-button").click();
      assert.equal(
        await reload.page.locator("#primary-model").inputValue(),
        "fixture/fixture-model",
      );
      await reload.page.locator("#next-button").click();
      await reload.page.locator("#next-button").click();
      assert.equal(await reload.page.locator("#decision-mode").inputValue(), "cost");
      await reload.page.locator("#next-button").click();
      assert.equal(
        await reload.page.locator("#project-goal").inputValue(),
        "Updated through the reconfiguration QA gate",
      );
      await assertPageHealth(reload.page, `full reload workspace ${viewport.width}`);
    } finally {
      await closeSession(reload);
    }
  }
  await cleanupFixture(fixture);
}

async function assertProjectReconfiguration(browser, viewport) {
  const fixture = await makeFixture({ configured: true, projectOnly: true });
  const before = JSON.stringify(await loadModelConfiguration(fixture.workspace, [], fixture.env));
  const session = await openSession(browser, fixture, "project", viewport);
  try {
    await assertPageHealth(session.page, `project roles ${viewport.width}`);
    const roleValues = await session.page
      .locator("#role-policy-list select")
      .evaluateAll((elements) => elements.map((element) => element.value));
    assert.ok(
      roleValues.includes("fixture/fixture-model"),
      "project roles did not read the saved role override",
    );
    await session.page.locator("#next-button").click();
    await assertPageHealth(session.page, `project safety ${viewport.width}`);
    await session.page.locator("#next-button").click();
    await assertPageHealth(session.page, `project workspace ${viewport.width}`);
    await session.page.locator("#project-goal").fill("Updated project-only setup QA");
    await session.page.locator("#next-button").click();
    await assertPageHealth(session.page, `project review ${viewport.width}`);
    assert.match(await session.page.locator("#review-goal").textContent(), /project-only/);
    await maybeScreenshot(session.page, `project-review-${viewport.width}`);
    await session.page.locator("#save-button").click();
    await session.page.locator("#closed-screen").waitFor({ state: "visible" });
  } finally {
    await closeSession(session);
  }
  const after = JSON.stringify(await loadModelConfiguration(fixture.workspace, [], fixture.env));
  assert.equal(after, before, "project-only save changed global model configuration");
  const reload = await openSession(browser, fixture, "project", viewport);
  try {
    await reload.page.locator("#next-button").click();
    await reload.page.locator("#next-button").click();
    assert.equal(
      await reload.page.locator("#project-goal").inputValue(),
      "Updated project-only setup QA",
    );
    await assertPageHealth(reload.page, `project reload workspace ${viewport.width}`);
  } finally {
    await closeSession(reload);
  }
  await cleanupFixture(fixture);
}
async function assertPi084ProviderCatalog(browser, viewport) {
  const fixture = await makeFixture({ configured: false, projectOnly: false });
  const session = await openSession(browser, fixture, "full", viewport);
  try {
    await session.page.locator("#empty-connect").click();
    const grouped = await session.page.locator("#cloud-provider optgroup").evaluateAll((groups) =>
      groups.map((group) => ({
        label: group.label,
        options: [...group.querySelectorAll("option")].map((option) => ({
          value: option.value,
          text: option.textContent,
        })),
      })),
    );
    const common = grouped.find((group) => group.label === "Common");
    const subscription = grouped.find((group) => group.label === "Subscription");
    assert.ok(common, "Connect selector is missing the Common provider group");
    assert.ok(subscription, "Connect selector is missing the Subscription provider group");
    assert.ok(
      common.options.some((option) => option.value === "baseten" && option.text === "Baseten"),
      "Common providers are missing Baseten",
    );
    assert.ok(
      subscription.options.some(
        (option) =>
          option.value === "qwen-token-plan-individual" &&
          option.text === "Qwen Token Plan Individual",
      ),
      "Subscription providers are missing Qwen Token Plan Individual",
    );

    await session.page.locator("#cloud-provider").selectOption("baseten");
    assert.equal(await session.page.locator("#provider-auth-method").inputValue(), "api-key");
    assert.equal(
      await session.page.locator("#provider-protocol").textContent(),
      "Protocol: OpenAI Chat Completions",
    );
    assert.equal(await session.page.locator("#provider-field-apiKey").isVisible(), true);
    await session.page.locator("#close-dialog").click();
    await session.page.locator("#connection-dialog").waitFor({ state: "hidden" });
    await assertPageHealth(session.page, `pi 0.84 provider catalog ${viewport.width}`);
  } finally {
    await closeSession(session);
    await cleanupFixture(fixture);
  }
}

async function assertCustomModelSamplingEditor(browser, viewport) {
  const fixture = await makeFixture({ configured: true, projectOnly: false });
  const session = await openSession(browser, fixture, "full", viewport);
  try {
    await session.page
      .locator("#connection-list .connection-row button", { hasText: "Edit" })
      .first()
      .click();
    await session.page.locator("#advanced-connection > summary").click();
    await session.page.locator("#advanced-models .model-editor summary").first().click();

    const textarea = session.page.locator("#draft-sampling-params-0");
    const budget = session.page.locator("#draft-thinking-token-budget-0");
    const status = session.page.locator("#dialog-status");
    assert.equal(await textarea.isVisible(), true, "sampling textarea is not visible");
    assert.equal(await budget.isVisible(), true, "vLLM budget checkbox is not visible");

    await textarea.fill('{"temperature":0.2,');
    await session.page.locator("#accept-endpoint").click();
    assert.equal(
      await session.page.locator("#connection-dialog").getAttribute("open"),
      "",
      "malformed sampling JSON closed the dialog",
    );
    assert.equal(
      await status.textContent(),
      "Sampling parameters for fixture-model must contain valid JSON.",
    );

    await textarea.fill("[1, 2]");
    await session.page.locator("#accept-endpoint").click();
    assert.equal(
      await status.textContent(),
      "Sampling parameters for fixture-model must be a JSON object.",
    );

    await textarea.fill('{"temperature":0.2,"top_p":0.9}');
    await budget.check();
    await session.page.locator("#accept-endpoint").click();
    assert.equal(await status.textContent(), "", "save reported a validation error");
    await session.page.locator("#connection-dialog").waitFor({ state: "hidden" });
    await walkFullConfiguration(session.page, viewport, { save: true });
  } finally {
    await closeSession(session);
  }

  const saved = await loadModelConfiguration(fixture.workspace, [], fixture.env);
  const model = saved.customProviders[0]?.models[0];
  assert.deepEqual(
    model?.samplingParams,
    { temperature: 0.2, top_p: 0.9 },
    "sampling parameters did not persist",
  );
  assert.equal(
    model?.compat?.supportsThinkingTokenBudget,
    true,
    "vLLM thinking budget flag did not persist",
  );
  await cleanupFixture(fixture);
}

async function main() {
  const restorePiProviderEnvironment = isolatePiProviderEnvironment();
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of VIEWPORTS) {
        await assertBlankFull(browser, viewport);
        await assertBlankProject(browser, viewport);
      }
      await completeBlankFullInitialization(browser, VIEWPORTS[0]);
      await assertPi084ProviderCatalog(browser, VIEWPORTS[0]);
      await assertCustomModelSamplingEditor(browser, VIEWPORTS[0]);
      for (const viewport of VIEWPORTS) {
        await assertFullReconfiguration(browser, viewport, true);
        await assertProjectReconfiguration(browser, viewport);
      }
    } finally {
      await browser.close();
    }
  } finally {
    restorePiProviderEnvironment();
  }
  console.log(
    `Configuration UI E2E passed for ${VIEWPORTS.map((viewport) => viewport.width).join(", ")}px.`,
  );
}

main().catch((error) => {
  console.error(`Configuration UI E2E failed: ${error.message}`);
  if (error.stack) console.error(error.stack);
  console.error(
    "Install the pinned Chromium headless shell with: mise run docs-screenshots-install",
  );
  process.exitCode = 1;
});
