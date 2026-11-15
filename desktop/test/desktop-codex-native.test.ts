import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { DesktopControlSession } from "../src/main/services/desktop-control";
import { startDesktopMcp } from "../src/main/services/desktop-mcp";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { prepareLocalProvider, providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

// Explicit local integration check: the installed CLI sees a synthetic model and a fake desktop.
test("installed Codex exposes desktop MCP to a local model without external inference", { skip: process.env.NOVA_CODEX_DESKTOP_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-codex-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  let count = 0;
  let exposed = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    const tool = input.tools?.find((entry: any) => /desktop/i.test(entry.function?.name ?? ""));
    exposed ||= !!tool;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (++count === 1 && tool) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ action: "list" }) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    else res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fixture complete." }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const settings = { ...DEFAULT_SETTINGS, localProvider: "custom" as const, localProtocol: "chat-completions" as const, localBaseUrl: `http://127.0.0.1:${address.port}/v1`, localModel: "fixture-model" };
  const controller = new AbortController();
  let approvals = 0;
  const session = new DesktopControlSession(async (args) => args[0] === "list-windows" ? "[]" : "{}", async () => { approvals++; return true; }, root);
  const desktop = await startDesktopMcp(session, controller.signal); t.after(desktop.dispose);
  const local = await prepareLocalProvider(settings, "fixture-model", controller.signal); t.after(local.dispose);
  const home = await ensureNovaCodexHome(root);
  const executable = await resolveExecutable("codex");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, ...local.env, CODEX_HOME: home, NOVA_DESKTOP_TOKEN: desktop.token }, args: providerArguments("ollama", root, "plan", "fixture-model", { allowNonGit: true, localConfigArgs: local.configArgs, desktopMcpUrl: desktop.url }) }, provider: "ollama", cwd: root, prompt: "Use the desktop tool to list windows, then stop.", signal: controller.signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined);
  assert.equal(result.completed, true);
  assert.equal(exposed, true);
  assert.equal(approvals, 1);
});
