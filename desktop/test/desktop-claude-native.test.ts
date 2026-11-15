import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopControlSession } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

// No provider credential or hosted inference: every synthetic model request stays on loopback.
test("installed Claude safe mode does not expose a configured desktop MCP server", { skip: process.env.NOVA_CLAUDE_DESKTOP_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-claude-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const config = path.join(root, "claude-config"); await mkdir(config);
  const removed: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (/^(?:ANTHROPIC_|CLAUDE|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)) {
      if (process.env[key] !== undefined) removed[key] = process.env[key]!;
      delete process.env[key];
    }
  }
  t.after(() => { Object.assign(process.env, removed); });
  let exposed = false, calls = 0, approvals = 0;
  let lastToolResult = "";
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const lastMessage = body.messages?.at(-1);
    lastToolResult = JSON.stringify(lastMessage?.content ?? "").slice(0, 1500);
    const desktopTool = body.tools?.find((entry: any) => /nova_desktop.*desktop/i.test(entry.name ?? ""));
    exposed ||= !!desktopTool;
    const useTool = ++calls === 1 && desktopTool;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (useTool) {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: desktopTool.name, input: {} } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "list" }) } });
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
  const controller = new AbortController();
  const session = new DesktopControlSession(async (args) => args[0] === "list-windows" ? "[]" : "{}", async () => { approvals++; return true; }, root);
  const desktop = await startDesktopMcp(session, controller.signal); t.after(desktop.dispose);
  const home = await ensureNovaCodexHome(root);
  const executable = await resolveExecutable("claude");
  const args = providerArguments("claude", root, "plan", "claude-sonnet-4-5");
  args[args.indexOf("--mcp-config") + 1] = JSON.stringify({ mcpServers: { nova_desktop: { type: "http", url: desktop.url, alwaysLoad: true, headers: { Authorization: "Bearer ${NOVA_DESKTOP_TOKEN}" } } } });
  const disallowed = args.indexOf("--disallowedTools"); args.splice(disallowed, 2, "--allowedTools", "mcp__nova_desktop__desktop");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, CODEX_HOME: home, NOVA_DESKTOP_TOKEN: desktop.token, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic-test-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, args }, provider: "claude", cwd: root, prompt: "Use the desktop tool to list windows, then stop.", signal: controller.signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined);
  assert.equal(result.completed, true);
  assert.equal(exposed, false);
  assert.equal(approvals, 0);
});
