import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopControlSession, windowsAutomationRunner } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

function walk(value: any, predicate: (item: any) => boolean, depth = 0): any {
  if (depth > 100 || value == null) return undefined;
  if (typeof value === "string") { try { const marker = value.indexOf("Output:\n"); return walk(JSON.parse(marker >= 0 ? value.slice(marker + 8) : value), predicate, depth + 1); } catch { return undefined; } }
  if (typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const item of Object.values(value)) { const found = walk(item, predicate, depth + 1); if (found) return found; }
  return undefined;
}

test("installed Claude controls a disposable Windows app through restricted MCP", { skip: process.env.NOVA_CLAUDE_FULL_NATIVE_TEST !== "1", timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-claude-full-"));
  const config = path.join(root, "claude-config"); await mkdir(config);
  const removed: Record<string, string> = {};
  for (const key of Object.keys(process.env)) if (/^(?:ANTHROPIC_|CLAUDE|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)) { if (process.env[key] !== undefined) removed[key] = process.env[key]!; delete process.env[key]; }
  t.after(() => { Object.assign(process.env, removed); });
  const electron = spawn(path.resolve("node_modules/electron/dist/electron.exe"), [path.resolve("test/desktop-window-fixture.cjs")], { env: { ...process.env, NOVA_DESKTOP_FIXTURE_DATA: root }, stdio: "ignore", windowsHide: false });
  t.after(async () => { if (electron.exitCode === null) electron.kill(); await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); });
  const controller = new AbortController();
  const raw = windowsAutomationRunner(path.resolve("node_modules/@microsoft/winappcli/bin/win-x64/winapp.exe"), path.join(root, "cache"));
  const runner = (args: string[], signal: AbortSignal) => raw(args[0] === "list-windows" ? [...args, "-a", String(electron.pid)] : args, signal);
  let hwnd = 0;
  for (let attempt = 0; attempt < 20 && !hwnd; attempt++) {
    const windows = JSON.parse(await runner(["list-windows"], controller.signal)) as Array<{ hwnd: number; title: string; processId: number }>;
    hwnd = windows.find((item) => item.title === "Nova Desktop Synthetic Fixture" && item.processId === electron.pid)?.hwnd ?? 0;
    if (!hwnd) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(hwnd, "Synthetic window not found");
  let approvals = 0, count = 0, observation = "", selector = "", receivedImage = false, sawClicked = false;
  const session = new DesktopControlSession(runner, async () => { approvals++; return true; }, path.join(root, "captures"));
  const desktop = await startDesktopMcp(session, controller.signal); t.after(desktop.dispose);
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const tool = body.tools?.find((entry: any) => /nova_desktop.*desktop/i.test(entry.name ?? ""));
    const observed = walk(body.messages, (item) => typeof item.observation === "string" && !!item.result);
    if (observed) { observation = observed.observation; selector = walk(observed.result, (item) => item.name === "Test button" && typeof item.selector === "string")?.selector ?? selector; }
    receivedImage ||= !!walk(body.messages, (item) => item.type === "image" && item.source?.type === "base64");
    sawClicked ||= !!walk(body.messages, (item) => item.name === "Clicked");
    const actions: any[] = [{ action: "list" }, { action: "select", hwnd }, { action: "inspect" }, { action: "screenshot" }, { action: "invoke", observation, selector, operation: "invoke" }, { action: "inspect" }];
    const action = actions[count++];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: `msg_fixture_${count}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (action && tool) {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_fixture_${count}`, name: tool.name, input: {} } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(action) } });
    } else {
      emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } });
    }
    emit("content_block_stop", { type: "content_block_stop", index: 0 });
    emit("message_delta", { type: "message_delta", delta: { stop_reason: action && tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    emit("message_stop", { type: "message_stop" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const home = await ensureNovaCodexHome(root); const executable = await resolveExecutable("claude");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, CODEX_HOME: home, NOVA_DESKTOP_TOKEN: desktop.token, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic-test-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, args: providerArguments("claude", root, "plan", "claude-sonnet-4-5", { desktopMcpUrl: desktop.url, claudePartialMessages: true }) }, provider: "claude", cwd: root, prompt: "Use desktop control on the test window.", signal: controller.signal, timeoutMs: 75000, maxBytes: 64 * 1024, allowDesktopImages: true, onEvent: () => {} });
  assert.equal(result.error, undefined);
  assert.equal(result.completed, true);
  assert.ok(observation && selector, "The synthetic Claude model did not receive the inspected button");
  assert.equal(receivedImage, true, "The screenshot did not reach Claude's synthetic model");
  assert.equal(sawClicked, true, "The button action was not observed");
  assert.equal(approvals, 6);
});
