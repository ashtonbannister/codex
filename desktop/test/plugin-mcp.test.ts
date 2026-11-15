import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-mcp-"));
  const source = path.join(root, "source"); await mkdir(source);
  await copyFile(path.resolve("test/fixtures/mcp-server.mjs"), path.join(source, "server.mjs"));
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["${CODEX_PLUGIN_ROOT}/server.mjs"], env: { API_TOKEN: "synthetic-start-secret", MODE: "fixture-mode" }, enabled_tools: ["echo", "slow"], disabled_tools: ["slow"] } } }));
  const store = new PluginPackageStore(path.join(root, "data"));
  const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint);
  await store.setEnabled(pkg.id, true); const prepared = await store.prepareRun();
  return { root, prepared };
}

test("plugin gateway requires startup and per-call approval, and honors tool filters", async (t) => {
  const f = await fixture(t);
  const approvals: Array<{ action: string; detail: string }> = [];
  let allowCall = false;
  const gateway = await startPluginMcp(f.prepared.packages, async (request) => { approvals.push(request); return request.action !== "call" || allowCall; }, new AbortController().signal);
  t.after(async () => { await gateway.dispose(); await f.prepared.dispose(); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const send = async (id: number, method: string, params: unknown = {}) => {
    const response = await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return await response.json() as any;
  };
  assert.doesNotMatch(approvals[0]!.detail, /synthetic-start-secret/);
  assert.match(approvals[0]!.detail, /fixture-mode/);
  const list = await send(1, "tools/list");
  assert.equal(list.result.tools.length, 1);
  const name = list.result.tools[0].name;
  const denied = await send(2, "tools/call", { name, arguments: { token: "synthetic-secret", message: "hello" } });
  assert.equal(denied.result.isError, true);
  assert.doesNotMatch(approvals[2]!.detail, /synthetic-secret/);
  allowCall = true;
  const allowed = await send(3, "tools/call", { name, arguments: { message: "hello" } });
  assert.equal(allowed.result.content[0].text, "server request denied");
  let nested: unknown = "leaf"; for (let i = 0; i < 16; i++) nested = { next: nested };
  const unreviewable = await send(4, "tools/call", { name, arguments: { nested } });
  assert.equal(unreviewable.result.isError, true);
  assert.match(unreviewable.result.content[0].text, /deeply nested/);
  assert.deepEqual(approvals.map((entry) => entry.action), ["start", "discover", "call", "call"]);
});

test("declining plugin startup prevents running its server", async (t) => {
  const f = await fixture(t);
  t.after(async () => { await f.prepared.dispose(); await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await assert.rejects(startPluginMcp(f.prepared.packages, async () => false, new AbortController().signal), /declined/);
});


test("plugin startup refuses an external script changed after review", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-review-"));
  const source = path.join(root, "source"); await mkdir(source);
  const script = path.join(root, "external.mjs");
  await copyFile(path.resolve("test/fixtures/mcp-server.mjs"), script);
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: script } } }));
  const store = new PluginPackageStore(path.join(root, "data"));
  const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint);
  await store.setEnabled(pkg.id, true); const prepared = await store.prepareRun();
  t.after(async () => { await prepared.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await assert.rejects(startPluginMcp(prepared.packages, async (request) => {
    if (request.action === "start") await writeFile(script, "// replaced synthetic script\n");
    return true;
  }, new AbortController().signal), /changed before startup/);
});


test("plugin gateway reviews and exposes a large paginated catalog", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-many-"));
  const source = path.join(root, "source"); await mkdir(source);
  await copyFile(path.resolve("test/fixtures/mcp-server.mjs"), path.join(source, "server.mjs"));
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["${CODEX_PLUGIN_ROOT}/server.mjs", "many"] } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const approvals: string[] = [];
  const gateway = await startPluginMcp(copies.packages, async (request) => { approvals.push(request.action); return true; }, new AbortController().signal);
  t.after(async () => { await gateway.dispose(); await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const response = await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const list = await response.json() as any;
  assert.equal(list.result.tools.length, 474);
  assert.deepEqual(approvals, ["start", "discover"]);
});
