import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const userData = await mkdtemp(path.join(os.tmpdir(), "nova-local-auth-smoke-"));
const server = createServer((request, response) => {
  if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer synthetic-smoke-key") {
    response.writeHead(401); response.end(); return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const connection = { kind: "custom", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "chat-completions" };
let application;
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => typeof value === "string" && key !== "NOVA_DEV_SERVER_URL" && key !== "ELECTRON_RUN_AS_NODE"));
  application = await electron.launch({ args: [".", "--nova-smoke-test"], cwd: process.cwd(), env: { ...env, NOVA_TEST_USER_DATA: userData }, chromiumSandbox: true, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => typeof window.workbench?.ensureChatWorkspace === "function");
  return page;
}
try {
  const page = await launch();
  const chat = await page.evaluate(() => window.workbench.ensureChatWorkspace());
  assert.equal(chat.name, "Chats");
  await page.evaluate((value) => window.workbench.setLocalServerKey(value, "synthetic-smoke-key"), connection);
  assert.equal((await readFile(path.join(userData, "workspace", "local-server-keys.bin"))).includes(Buffer.from("synthetic-smoke-key")), false);
  assert.equal((await page.evaluate((value) => window.workbench.listLocalModels(value), connection)).models[0].id, "smoke-model");
  await application.close(); application = undefined;
  const reopened = await launch();
  assert.equal((await reopened.evaluate((value) => window.workbench.listLocalModels(value), connection)).models[0].id, "smoke-model");
  await reopened.evaluate((value) => window.workbench.setLocalServerKey(value, ""), connection);
  assert.equal(await reopened.evaluate(async (value) => { try { await window.workbench.listLocalModels(value); return false; } catch { return true; } }, connection), true);
  console.log("Native Electron: encrypted key saved, reloaded and removed; authenticated discovery and chat workspace passed.");
} finally {
  if (application) await application.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
