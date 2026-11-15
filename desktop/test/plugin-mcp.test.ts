import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";
import { McpRemoteClient } from "../src/main/services/mcp-remote";

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


test("remote MCP plugin requires connection, catalog and call approvals and keeps headers private", async (t) => {
  let requests = 0; let calls = 0; const observed: string[] = [];
  const server = createServer(async (request, response) => {
    requests++; observed.push(request.headers.authorization ?? "");
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let data = ""; for await (const part of request) data += part;
    const message = JSON.parse(data);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    else if (message.method === "tools/call") { calls++; result = { content: [{ type: "text", text: message.params.arguments.message }] }; }
    else { response.writeHead(400).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-remote-plugin-"));
  const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "http", startup_timeout_sec: 5, url: `http://127.0.0.1:${address.port}/mcp?private=synthetic-query` } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun();
  t.after(async () => { await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await assert.rejects(startPluginMcp(copies.packages, async () => false, new AbortController().signal), /declined/);
  assert.equal(requests, 0);
  const approvals: Array<{ action: string; detail: string }> = []; let allow = false;
  const gateway = await startPluginMcp(copies.packages, async (request) => { approvals.push(request); return request.action !== "call" || allow; }, new AbortController().signal, process.cwd(), (identity) => {
    assert.deepEqual(identity, { id: pkg.id, fingerprint: pkg.fingerprint, server: "remote" }); return "synthetic-test-secret";
  });
  t.after(async () => { await gateway.dispose(); });
  assert.doesNotMatch(approvals[0]!.detail, /synthetic-test-secret|synthetic-query/);
  assert.match(approvals[0]!.detail, /Authorization/);
  const send = async (id: number, method: string, params: unknown = {}) => (await (await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json()) as any;
  const list = await send(1, "tools/list"); const name = list.result.tools[0].name;
  assert.equal((await send(2, "tools/call", { name, arguments: { message: "hello" } })).result.isError, true); assert.equal(calls, 0);
  allow = true; assert.equal((await send(3, "tools/call", { name, arguments: { message: "hello" } })).result.content[0].text, "hello");
  assert.equal(calls, 1); assert.ok(observed.every((value) => value === "Bearer synthetic-test-secret"));
  assert.deepEqual(approvals.map((item) => item.action), ["start", "discover", "call", "call"]);
});


test("remote transport refuses redirects before forwarding headers", async (t) => {
  let redirected = 0;
  const target = createServer((_request, response) => { redirected++; response.writeHead(200).end(); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address(); if (!targetAddress || typeof targetAddress === "string") throw new Error("No test port");
  const server = createServer((_request, response) => response.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/other` }).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  t.after(() => { server.closeAllConnections(); target.closeAllConnections(); server.close(); target.close(); });
  const client = new McpRemoteClient(new URL(`http://127.0.0.1:${address.port}/mcp`), "http", { Authorization: "Bearer synthetic-secret" }, new AbortController().signal);
  await assert.rejects(client.initialize(2000), /connection failed/);
  assert.equal(redirected, 0);
});

test("legacy SSE remote transport connects and calls a synthetic tool", async (t) => {
  let stream: import("node:http").ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      stream = response; response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write("event: endpoint\ndata: /messages\n\n"); return;
    }
    let data = ""; for await (const part of request) data += part;
    const message = JSON.parse(data); response.writeHead(202).end();
    if (message.id === undefined) return;
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    else result = { content: [{ type: "text", text: "sse works" }] };
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new McpRemoteClient(new URL(`http://127.0.0.1:${address.port}/sse`), "sse", {}, new AbortController().signal);
  t.after(async () => { await client.close(); });
  await client.initialize(3000); const tools = await client.listTools(3000);
  assert.equal(tools[0]!.name, "echo");
  const result = await client.call("echo", {}, new AbortController().signal, 3000);
  assert.equal((result.content as any[])[0].text, "sse works");
});
