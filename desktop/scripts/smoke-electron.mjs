import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
const sourceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const rolloutName = `rollout-2026-11-13-synthetic-${sourceId}.jsonl`;
const recordedSourceFolder = path.join(userData, "source-project-not-opened");
const rollout = [
  { type: "session_meta", payload: { id: sourceId, cwd: recordedSourceFolder, timestamp: "2026-11-13T00:00:00Z", source: "cli" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic copied question." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic copied answer." }] } },
].map((item) => JSON.stringify(item)).join("\n") + "\n";
await mkdir(path.join(codexFixture, "sessions"));
await writeFile(path.join(codexFixture, "sessions", rolloutName), rollout);
// This invalid source config must never be loaded by an engine during import.
await writeFile(path.join(codexFixture, "config.toml"), "not valid TOML [ source only\n");
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
  await application.evaluate(({ dialog }, home) => {
    const confirmations = [];
    globalThis.__novaSmokeImportConfirmations = confirmations;
    // Accept only this synthetic read-only confirmation. No login, execution,
    // recovery cleanup, or broader native permission is approved by the test.
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title !== "Read this Codex import source?" ||
        !options.detail?.includes(home) || options.buttons?.[1] !== "Read import source")
        throw new Error("Unexpected native confirmation in isolated import smoke test.");
      confirmations.push(options.title);
      return { response: 1, checkboxChecked: false };
    };
  }, codexHome);
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
  await page.getByRole("button", { name: "Codex library", exact: true }).click();
  await page.getByRole("button", { name: "Read Codex import source", exact: true }).waitFor();
  assert.equal(await application.evaluate(() => globalThis.__novaSmokeImportConfirmations.length), 0,
    "opening the library must not request or start source access");
  await page.getByRole("button", { name: "Read Codex import source", exact: true }).click();
  await page.locator(".library-thread").first().waitFor();
  assert.equal(await application.evaluate(() => globalThis.__novaSmokeImportConfirmations.length), 1,
    "concurrent explicit library reads share one source-only confirmation");
  const installation = await page.evaluate(() =>
    window.workbench.inspectCodexInstallation(),
  );
  assert.equal(installation.home, codexHome);
  assert.equal(installation.exists, true);
  const history = await page.evaluate((threadId) => window.workbench.readCodexHistory({ threadId }), sourceId);
  assert.deepEqual(history.messages.map((item) => item.text), ["Synthetic copied question.", "Synthetic copied answer."]);
  const refusedPublish = await page.evaluate(async () => {
    try { await window.workbench.publishCodexHandoff("missing-thread"); return false; }
    catch (error) { return /import-only/.test(String(error)); }
  });
  assert.equal(refusedPublish, true, "native handoff IPC must fail closed without another confirmation or engine");
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
  assert.deepEqual((await readdir(codexHome)).sort(), ["AGENTS.md", "config.toml", "sessions"]);
  assert.deepEqual(await readdir(path.join(codexHome, "sessions")), [rolloutName]);
  assert.equal(await readFile(path.join(codexHome, "sessions", rolloutName), "utf8"), rollout);
  assert.equal(await readFile(path.join(codexHome, "config.toml"), "utf8"), "not valid TOML [ source only\n");

  const reopened = await launch();
  const restored = await reopened.evaluate(() =>
    window.workbench.getSnapshot(),
  );
  assert.equal(restored.state.settings.theme, "light");
  assert.equal(restored.state.settings.codexHome, codexHome);
  assert.equal(restored.state.settings.localProvider, "custom");
  assert.equal(restored.state.settings.localBaseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(restored.state.settings.localProtocol, "chat-completions");
  assert.equal(await application.evaluate(() => globalThis.__novaSmokeImportConfirmations.length), 0,
    "restart must not reconnect to the saved import source");
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
    "Native Electron smoke passed: custom protocol, isolated preload, explicit read-only source confirmation, synthetic conversation/reference copies, native publish rejection, unchanged source files, validated action IPC, local endpoint rejection, settings, recovery listing, and restart persistence. No account, native history server, or model was started.",
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
