import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { DesktopControlSession, windowsAutomationRunner } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { prepareLocalProvider, providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

function walk(value: any, predicate: (item: any) => boolean, depth = 0): any {
  if (depth > 100 || value == null) return undefined;
  if (typeof value === "string") { try { const marker = value.indexOf("Output:\n"); return walk(JSON.parse(marker >= 0 ? value.slice(marker + 8) : value), predicate, depth + 1); } catch { return undefined; } }
  if (typeof value !== "object") return undefined;
  if (predicate(value)) return value;
  for (const item of Object.values(value)) { const found = walk(item, predicate, depth + 1); if (found) return found; }
  return undefined;
}

test("installed Codex controls a disposable Windows app through local-model MCP", { skip: process.env.NOVA_DESKTOP_FULL_NATIVE_TEST !== "1", timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-desktop-full-"));
  const electron = spawn(path.resolve("node_modules/electron/dist/electron.exe"), [path.resolve("test/desktop-window-fixture.cjs")], { env: { ...process.env, NOVA_DESKTOP_FIXTURE_DATA: root }, stdio: "ignore", windowsHide: false });
  t.after(async () => { if (electron.exitCode === null) electron.kill(); await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); });
  const controller = new AbortController();
  const raw = windowsAutomationRunner(path.resolve("node_modules/@microsoft/winappcli/bin/win-x64/winapp.exe"), path.join(root, "cache"));
  const runner = (args: string[], signal: AbortSignal) => raw(args[0] === "list-windows" ? [...args, "-a", String(electron.pid)] : args, signal);
  let hwnd = 0;
  for (let attempt = 0; attempt < 20 && !hwnd; attempt++) {
    const windows = JSON.parse(await runner(["list-windows"], controller.signal)) as Array<{ hwnd: number; title: string; processId: number }>;
    hwnd = windows.find((entry) => entry.title === "Nova Desktop Synthetic Fixture" && entry.processId === electron.pid)?.hwnd ?? 0;
    if (!hwnd) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.ok(hwnd, "Synthetic window not found");
  let approvals = 0, count = 0, observation = "", selector = "", receivedImage = false, sawClicked = false;
  const results: string[] = [];
  const session = new DesktopControlSession(runner, async () => { approvals++; return true; }, path.join(root, "captures"));
  const desktop = await startDesktopMcp(session, controller.signal); t.after(desktop.dispose);
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    results.push(JSON.stringify(body.messages?.filter((m: any) => m.role === "tool").at(-1)?.content ?? "").slice(0, 1800));
    const tool = body.tools?.find((entry: any) => /desktop/i.test(entry.function?.name ?? ""));
    const observed = walk(body.messages, (item) => typeof item.observation === "string" && !!item.result);
    if (observed) { observation = observed.observation; selector = walk(observed.result, (item) => item.name === "Test button" && typeof item.selector === "string")?.selector ?? selector; }
    receivedImage ||= !!walk(body.messages, (item) => item.type === "image_url" && typeof item.image_url?.url === "string");
    sawClicked ||= !!walk(body.messages, (item) => item.name === "Clicked");
    const actions: any[] = [{ action: "list" }, { action: "select", hwnd }, { action: "inspect" }, { action: "screenshot" }, { action: "invoke", observation, selector, operation: "invoke" }, { action: "inspect" }];
    const action = actions[count++];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (action && tool) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `fixture-${count}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(action) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    else res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fixture complete." }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const settings = { ...DEFAULT_SETTINGS, localProvider: "custom" as const, localProtocol: "chat-completions" as const, localBaseUrl: `http://127.0.0.1:${address.port}/v1`, localModel: "fixture-model" };
  const local = await prepareLocalProvider(settings, "fixture-model", controller.signal); t.after(local.dispose);
  const home = await ensureNovaCodexHome(root); const executable = await resolveExecutable("codex");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, ...local.env, CODEX_HOME: home, NOVA_DESKTOP_TOKEN: desktop.token }, args: providerArguments("ollama", root, "plan", "fixture-model", { allowNonGit: true, localConfigArgs: local.configArgs, desktopMcpUrl: desktop.url }) }, provider: "ollama", cwd: root, prompt: "Use desktop control on the test window.", signal: controller.signal, timeoutMs: 75000, maxBytes: 64 * 1024, allowDesktopImages: true, onEvent: () => {} });
  assert.equal(result.error, undefined);
  assert.equal(result.completed, true);
  assert.ok(observation && selector, `No inspected button; calls=${count}, approvals=${approvals}, results=${JSON.stringify(results)}`);
  assert.equal(receivedImage, true, "The screenshot did not reach the local model");
  assert.equal(sawClicked, true, `Button not observed; approvals=${approvals}, last results=${JSON.stringify(results.slice(-2))}`);
  assert.equal(approvals, 6);
});
