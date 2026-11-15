import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { findPluginCommand, pluginCommandPrompt } from "../src/main/services/plugin-commands";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { prepareLocalProvider, providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

async function packageFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-command-native-")); const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture", commands: { review: { content: "Review $0. All arguments: $ARGUMENTS" } } }));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const command = findPluginCommand('/fixture:review "my file"', copies.packages, root)!;
  t.after(async () => { await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  return { root, copies, prompt: pluginCommandPrompt(command) };
}

test("installed Claude receives explicitly rendered command instructions through a synthetic provider", { skip: process.env.NOVA_COMMAND_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const removed: Record<string, string> = {}; for (const key of Object.keys(process.env)) if (/^(?:ANTHROPIC_|CLAUDE|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)) { if (process.env[key] !== undefined) removed[key] = process.env[key]!; delete process.env[key]; }
  t.after(() => { Object.assign(process.env, removed); });
  const fixture = await packageFixture(t); const config = path.join(fixture.root, "claude-config"); await mkdir(config);
  let contentSeen = false, mcpSeen = false;
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    let data = ""; for await (const chunk of req) data += chunk; const body = JSON.parse(data); contentSeen ||= JSON.stringify(body.messages).includes("Review my file"); mcpSeen ||= (body.tools ?? []).some((tool: any) => /nova_plugins/i.test(tool.name ?? ""));
    res.writeHead(200, { "Content-Type": "text/event-stream" }); const emit = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } });
    emit("content_block_stop", { type: "content_block_stop", index: 0 }); emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }); emit("message_stop", { type: "message_stop" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const home = await ensureNovaCodexHome(path.join(fixture.root, "data")); const executable = await resolveExecutable("claude");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic-test-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, args: providerArguments("claude", fixture.root, "plan", "claude-sonnet-4-5", { pluginDirectory: fixture.copies.directory, claudePartialMessages: true }) }, provider: "claude", cwd: fixture.root, prompt: fixture.prompt, signal: new AbortController().signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined); assert.equal(result.completed, true); assert.equal(contentSeen, true); assert.equal(mcpSeen, false);
});

test("installed Codex receives command instructions through a synthetic local model", { skip: process.env.NOVA_COMMAND_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const fixture = await packageFixture(t); let contentSeen = false, mcpSeen = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let data = ""; for await (const chunk of req) data += chunk; const body = JSON.parse(data); contentSeen ||= JSON.stringify(body.messages).includes("Review my file"); mcpSeen ||= (body.tools ?? []).some((tool: any) => /nova_plugins/i.test(tool.function?.name ?? ""));
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fixture complete." }, finish_reason: "stop" }] })}\n\n`); res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const settings = { ...DEFAULT_SETTINGS, localProvider: "custom" as const, localProtocol: "chat-completions" as const, localBaseUrl: `http://127.0.0.1:${address.port}/v1`, localModel: "fixture-model" };
  const controller = new AbortController(); const local = await prepareLocalProvider(settings, "fixture-model", controller.signal); t.after(local.dispose);
  const home = await ensureNovaCodexHome(path.join(fixture.root, "data")); const executable = await resolveExecutable("codex");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, ...local.env, CODEX_HOME: home }, args: providerArguments("ollama", fixture.root, "plan", "fixture-model", { allowNonGit: true, localConfigArgs: local.configArgs, pluginDirectory: fixture.copies.directory }) }, provider: "ollama", cwd: fixture.root, prompt: fixture.prompt, signal: controller.signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined); assert.equal(result.completed, true); assert.equal(contentSeen, true); assert.equal(mcpSeen, false);
});
