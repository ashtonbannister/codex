import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

// Native Electron validation, not the browser's synthetic bridge. No inference,
// project selection, external command profile, or account sign-in is performed.
const userData = await mkdtemp(path.join(os.tmpdir(), "nova-native-smoke-"));
const codexFixture = path.join(userData, "synthetic Codex home");
await mkdir(codexFixture);
await writeFile(
  path.join(codexFixture, "AGENTS.md"),
  "Synthetic native-bridge reference.\n",
);
const codexHome = await realpath(codexFixture);
const errors = [];
let application;
const launch = async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        typeof value === "string" &&
        key !== "NOVA_DEV_SERVER_URL" &&
        key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  application = await electron.launch({
    args: [".", "--nova-smoke-test"],
    cwd: process.cwd(),
    env: { ...env, NOVA_TEST_USER_DATA: userData },
    chromiumSandbox: true,
    timeout: 30_000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => typeof window.workbench?.getSnapshot === "function",
  );
  assert.equal(page.url(), "nova://app/index.html");
  const boundaries = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    rawIpc: typeof window.workbench.invoke,
  }));
  assert.deepEqual(boundaries, {
    node: "undefined",
    process: "undefined",
    rawIpc: "undefined",
  });
  return page;
};

try {
  const page = await launch();
  const snapshot = await page.evaluate(() => window.workbench.getSnapshot());
  assert.equal(snapshot.state.projects.length, 0);
  assert.equal(snapshot.state.runs.length, 0);
  assert.equal(snapshot.state.verifications.length, 0);
  await page.evaluate(async (home) => {
    const value = await window.workbench.getSnapshot();
    await window.workbench.updateSettings({
      ...value.state.settings,
      theme: "light",
      codexHome: home,
      localProvider: "custom",
      localBaseUrl: "http://127.0.0.1:8080/v1",
      localProtocol: "chat-completions",
    });
  }, codexHome);
  const installation = await page.evaluate(() =>
    window.workbench.inspectCodexInstallation(),
  );
  assert.equal(installation.home, codexHome);
  assert.equal(installation.exists, true);
  const references = await page.evaluate(() =>
    window.workbench.listCodexResources({ section: "instructions" }),
  );
  assert.deepEqual(
    references.resources.map((entry) => entry.path),
    ["AGENTS.md"],
  );
  const reference = await page.evaluate(() =>
    window.workbench.previewCodexResource({
      section: "instructions",
      path: "AGENTS.md",
    }),
  );
  assert.equal(reference.content, "Synthetic native-bridge reference.\n");
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  const deniedReference = await page.evaluate(async () => {
    try {
      await window.workbench.previewCodexResource({
        section: "instructions",
        path: "../auth.json",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(
    deniedReference,
    true,
    "native reference bridge must reject private/traversal paths",
  );
  assert.deepEqual(await page.evaluate(() => window.workbench.listRecoveryItems()), []);
  const rejectedLocalEndpoint = await page.evaluate(async () => {
    try {
      await window.workbench.listLocalModels({
        kind: "custom", baseUrl: "https://example.invalid/v1", protocol: "chat-completions",
      });
      return false;
    } catch { return true; }
  });
  assert.equal(rejectedLocalEndpoint, true, "local discovery must reject remote destinations before any request");
  const rejectedUnknownActions = await page.evaluate(async () => {
    const actions = [
      () => window.workbench.chooseExecutable("unknown"),
      () => window.workbench.openProviderHelp("https://example.invalid"),
      () => window.workbench.reviewWorktree("missing-run"),
      () => window.workbench.exportConversation("missing-thread"),
    ];
    return Promise.all(actions.map(async (action) => {
      try { await action(); return false; } catch { return true; }
    }));
  });
  assert.deepEqual(rejectedUnknownActions, [true, true, true, true]);
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/native-windows-light.png",
    fullPage: true,
  });
  await application.close();
  application = undefined;
  const saved = JSON.parse(
    await readFile(path.join(userData, "workspace", "workspace.json"), "utf8"),
  );
  assert.equal(saved.settings.theme, "light");
  assert.equal(saved.settings.codexHome, codexHome);

  const reopened = await launch();
  const restored = await reopened.evaluate(() =>
    window.workbench.getSnapshot(),
  );
  assert.equal(restored.state.settings.theme, "light");
  assert.equal(restored.state.settings.codexHome, codexHome);
  assert.equal(restored.state.settings.localProvider, "custom");
  assert.equal(restored.state.settings.localBaseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(restored.state.settings.localProtocol, "chat-completions");
  const rejected = await reopened.evaluate(async () => {
    try {
      await window.workbench.updateThread({
        id: "../outside",
        title: "invalid",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true, "native bridge must reject invalid identifiers");
  assert.deepEqual(errors, [], "renderer must start without uncaught errors");
  console.log(
    "Native Electron smoke passed: custom protocol, isolated preload, validated action IPC, local endpoint rejection, synthetic Codex inventory/reference preview, settings, recovery listing, and restart persistence. No native history server or model was started.",
  );
} finally {
  if (application) await application.close();
  await rm(userData, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
