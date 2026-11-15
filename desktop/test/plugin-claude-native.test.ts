import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";
import { DesktopControlSession } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

test("installed Claude exposes desktop and approved plugin tools together", { skip: process.env.NOVA_PLUGIN_CLAUDE_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-claude-"));
  const removed: Record<string, string> = {};
  for (const key of Object.keys(process.env)) if (/^(?:ANTHROPIC_|CLAUDE|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)) { if (process.env[key] !== undefined) removed[key] = process.env[key]!; delete process.env[key]; }
  t.after(() => { Object.assign(process.env, removed); });
  const source = path.join(root, "source"); await mkdir(source);
  const config = path.join(root, "claude-config"); await mkdir(config);
  await copyFile(path.resolve("test/fixtures/mcp-server.mjs"), path.join(source, "server.mjs"));
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], enabled_tools: ["echo"] } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const controller = new AbortController(); const approvals: string[] = [];
  const plugin = await startPluginMcp(copies.packages, async (request) => { approvals.push(request.action); return true; }, controller.signal);
  const desktop = await startDesktopMcp(new DesktopControlSession(async () => "[]", async () => true, root), controller.signal);
  t.after(async () => { await desktop.dispose(); await plugin.dispose(); await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  let calls = 0, pluginExposed = false, desktopExposed = false, resultReceived = false;
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); const tool = body.tools?.find((entry: any) => /nova_plugins.*p_/i.test(entry.name ?? ""));
    pluginExposed ||= !!tool; desktopExposed ||= (body.tools ?? []).some((entry: any) => /nova_desktop.*desktop/i.test(entry.name ?? ""));
    resultReceived ||= JSON.stringify(body.messages).includes("server request denied");
    const useTool = ++calls === 1 && tool;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (useTool) {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: tool.name, input: {} } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ message: "synthetic" }) } });
    } else {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } });
    }
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    emit("message_stop", { type: "message_stop" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const home = await ensureNovaCodexHome(path.join(root, "data")); const executable = await resolveExecutable("claude");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, CODEX_HOME: home, NOVA_PLUGIN_TOKEN: plugin.token, NOVA_DESKTOP_TOKEN: desktop.token, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic-test-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, args: providerArguments("claude", root, "plan", "claude-sonnet-4-5", { desktopMcpUrl: desktop.url, pluginMcpUrl: plugin.url, pluginDirectory: copies.providerDirectory, claudePartialMessages: true }) }, provider: "claude", cwd: root, prompt: "Use the synthetic plugin.", signal: controller.signal, timeoutMs: 45000, maxBytes: 1024 * 1024, allowPluginImages: true, allowDesktopImages: true, onEvent: () => {} });
  assert.equal(result.error, undefined);
  assert.equal(result.completed, true);
  assert.equal(pluginExposed, true);
  assert.equal(desktopExposed, true);
  assert.equal(resultReceived, true);
  assert.deepEqual(approvals, ["start", "discover", "call"]);
});
