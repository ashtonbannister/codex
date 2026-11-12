import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

// Native Electron validation, not the browser's synthetic bridge. No inference,
// project selection, external command profile, or account sign-in is performed.
const userData = await mkdtemp(path.join(os.tmpdir(), "nova-native-smoke-"));
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
  await page.evaluate(async () => {
    const value = await window.workbench.getSnapshot();
    await window.workbench.updateSettings({
      ...value.state.settings,
      theme: "light",
    });
  });
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

  const reopened = await launch();
  const restored = await reopened.evaluate(() =>
    window.workbench.getSnapshot(),
  );
  assert.equal(restored.state.settings.theme, "light");
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
    "Native Electron smoke passed: custom protocol, isolated preload, validated IPC, settings, and restart persistence.",
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
