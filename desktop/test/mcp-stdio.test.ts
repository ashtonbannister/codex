import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { McpStdioClient } from "../src/main/services/mcp-stdio";

function start(t: { after(fn: () => Promise<void>): void }, mode = "normal") {
  const controller = new AbortController();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
  const client = new McpStdioClient({ command: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs"), mode], cwd: process.cwd(), env, signal: controller.signal });
  t.after(async () => { assert.equal(await client.close(), true); });
  return client;
}

test("stdio MCP client discovers paginated tools and refuses unsolicited server requests", async (t) => {
  const client = start(t);
  await client.initialize();
  assert.deepEqual((await client.listTools()).map((item) => item.name), ["echo", "slow", "invalidate"]);
  await assert.rejects(client.call("unknown", {}, new AbortController().signal), /not in the current/);
  const result = await client.call("echo", {}, new AbortController().signal);
  assert.equal((result.content as Array<{ text: string }>)[0]?.text, "server request denied");
  await client.call("invalidate", {}, new AbortController().signal);
  await assert.rejects(client.call("echo", {}, new AbortController().signal), /not in the current/);
});

test("stdio MCP client stops the server when a request is cancelled", async (t) => {
  const client = start(t);
  await client.initialize(); await client.listTools();
  const controller = new AbortController();
  const slow = client.call("slow", {}, controller.signal);
  controller.abort();
  await assert.rejects(slow, /cancelled/);
  await assert.rejects(client.call("echo", {}, new AbortController().signal), /stopped|closed/);
  assert.equal(await client.close(), true);
});

test("stdio MCP client rejects unsafe tool names", async (t) => {
  const client = start(t, "invalid");
  await client.initialize();
  await assert.rejects(client.listTools(), /invalid or duplicate/);
});


test("stdio MCP client refuses a tool list changed during discovery", async (t) => {
  const client = start(t, "change-during-list");
  await client.initialize();
  await assert.rejects(client.listTools(), /changed during discovery/);
});


test("stdio MCP client accepts longer plugin tool names", async (t) => {
  const client = start(t, "long");
  await client.initialize();
  assert.equal((await client.listTools())[0]!.name.length, 100);
});


test("stdio MCP client discovers a large paginated catalog", async (t) => {
  const client = start(t, "many");
  await client.initialize();
  assert.equal((await client.listTools()).length, 474);
});
