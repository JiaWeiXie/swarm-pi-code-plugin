#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { startConfigurationServer } from "../plugins/swarm-pi-code-plugin/runtime/web/configuration-server.js";
import { saveModelConfiguration } from "../plugins/swarm-pi-code-plugin/runtime/state/model-config.js";
import { updateState } from "../plugins/swarm-pi-code-plugin/runtime/state/state.js";

const OUTPUT = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : "docs/assets/setup";
const VIEWPORT = { width: 1440, height: 1000 };
const TASKS = ["planning", "implementation", "code-review"];

async function makeFixture(configured, projectOnly = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-doc-screenshot-"));
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-doc-screenshot-auth-"));
  const env = {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_DATA_DIR: ".screenshot-state",
    SWARM_PI_CODE_PLUGIN_AUTH_FILE: path.join(privateDir, "auth.json"),
    SWARM_PI_CODE_PLUGIN_MODELS_FILE: path.join(privateDir, "models.json"),
    SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST: "1",
  };
  if (configured) {
    await saveModelConfiguration(workspace, {
      version: 1,
      primary: "fixture/fixture-model",
      fallbacks: [],
      customProviders: [
        {
          id: "fixture",
          name: "Fixture Service",
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          authHeader: false,
          requiresApiKey: false,
          models: [
            { id: "fixture-model", name: "Fixture Model", reasoning: true, input: ["text"] },
          ],
        },
      ],
      providerProfiles: [],
    });
  }
  await updateState(workspace, (state) => {
    state.config.profile = {
      goal: "Maintain a dependable project setup experience",
      tasks: TASKS,
      ...(projectOnly ? {} : { dirs: ["."] }),
      configuredAt: "2026-01-01T00:00:00.000Z",
    };
    state.config.sandboxMode = "adaptive";
    state.config.adaptivePolicy = {
      classifierModels: configured ? ["fixture/fixture-model"] : [],
      classifierThinkingLevel: "medium",
      approvalPolicy: "wait",
      trustedDomains: [],
      rules: [],
      diagnostics: true,
    };
    state.config.rolePolicies = {
      planner: { models: ["fixture/fixture-model"], thinkingLevel: "xhigh", maxAttempts: 2 },
      reviewer: { models: ["fixture/fixture-model"], thinkingLevel: "high", maxAttempts: 2 },
    };
  });
  return { workspace, privateDir, env };
}

async function capture(page, file, action) {
  await action(page);
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    document.documentElement.classList.add("screenshot-capture");
  });
  await page.screenshot({ path: file, fullPage: false });
}

async function withPage(browser, fixture, mode, action, file) {
  const server = await startConfigurationServer(fixture.workspace, {
    env: fixture.env,
    mode,
    openBrowser: false,
    timeoutMs: 120_000,
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await page.goto(server.url, { waitUntil: "networkidle" });
    await capture(page, file, action);
  } finally {
    await context.close();
    await server.close();
    await fs.rm(fixture.workspace, { recursive: true, force: true });
    await fs.rm(fixture.privateDir, { recursive: true, force: true });
  }
}

async function main() {
  if (!OUTPUT) throw new Error("Screenshot output directory is required");
  await fs.mkdir(OUTPUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await withPage(
      browser,
      await makeFixture(false),
      "full",
      async () => {},
      path.join(OUTPUT, "01-empty-connections.png"),
    );
    await withPage(
      browser,
      await makeFixture(false),
      "full",
      async (page) => {
        await page.locator("#empty-connect").click();
        await page.locator("#custom-tab").click();
      },
      path.join(OUTPUT, "02-endpoint-discovery.png"),
    );
    await withPage(
      browser,
      await makeFixture(false, true),
      "project",
      async () => {},
      path.join(OUTPUT, "03-project-setup.png"),
    );
    await withPage(
      browser,
      await makeFixture(true),
      "full",
      async (page) => {
        await page.locator("#next-button").click();
        await page.locator("#next-button").click();
      },
      path.join(OUTPUT, "04-role-routing.png"),
    );
    await withPage(
      browser,
      await makeFixture(true),
      "full",
      async (page) => {
        await page.locator("#next-button").click();
        await page.locator("#next-button").click();
        await page.locator("#next-button").click();
      },
      path.join(OUTPUT, "05-execution-safety.png"),
    );
    await withPage(
      browser,
      await makeFixture(true),
      "full",
      async (page) => {
        for (let index = 0; index < 5; index += 1) await page.locator("#next-button").click();
      },
      path.join(OUTPUT, "06-review.png"),
    );
  } finally {
    await browser.close();
  }
  console.log(`Generated six documentation screenshots in ${OUTPUT}`);
}

main().catch((error) => {
  console.error(`Screenshot generation failed: ${error.message}`);
  console.error(
    "Install the pinned Chromium headless shell with: mise run docs-screenshots-install",
  );
  process.exitCode = 1;
});
