import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { renderExplicitSkill } from "../src/main/services/skill-selection";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

test("installed Claude reads a skill-only plugin through an isolated synthetic provider", { skip: process.env.NOVA_SKILL_CLAUDE_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-claude-"));
  const removed: Record<string, string> = {};
  for (const key of Object.keys(process.env)) if (/^(?:ANTHROPIC_|CLAUDE|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)) { if (process.env[key] !== undefined) removed[key] = process.env[key]!; delete process.env[key]; }
  t.after(() => { Object.assign(process.env, removed); });
  const source = path.join(root, "source"); await mkdir(path.join(source, "skills", "demo"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture-skill-plugin" }));
  await writeFile(path.join(source, "skills", "demo", "SKILL.md"), "---\nname: fixture-only-skill\ndescription: Synthetic instructions\ndisable-model-invocation: true\n---\nSYNTHETIC_SKILL_CONTENT\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun('/fixture-skill-plugin:fixture-only-skill "test arg"', "claude"); const rendered = await renderExplicitSkill(copies.invoked[0]!, root, "claude"); const skillFile = path.join(copies.packages[0]!.providerRoot!, "skills", "demo", "SKILL.md");
  const config = path.join(root, "claude-config"); await mkdir(config);
  t.after(async () => { await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  let calls = 0, catalogSeen = false, contentSeen = false, mcpSeen = false;
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
    let data = ""; for await (const chunk of req) data += chunk; const body = JSON.parse(data);
    const text = JSON.stringify(body.messages); catalogSeen ||= text.includes("fixture-only-skill"); contentSeen ||= text.includes("tool_result") && text.includes("SYNTHETIC_SKILL_CONTENT"); mcpSeen ||= (body.tools ?? []).some((tool: any) => /nova_plugins/i.test(tool.name ?? ""));
    const read = ++calls === 1; res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (read) { emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: "Read", input: {} } }); emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: skillFile }) } }); }
    else { emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } }); }
    emit("content_block_stop", { type: "content_block_stop", index: 0 }); emit("message_delta", { type: "message_delta", delta: { stop_reason: read ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }); emit("message_stop", { type: "message_stop" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const home = await ensureNovaCodexHome(path.join(root, "data")); const executable = await resolveExecutable("claude");
  const args = providerArguments("claude", root, "plan", "claude-sonnet-4-5", { pluginDirectory: copies.providerDirectory, claudePartialMessages: true });
  assert.ok(args.includes("--safe-mode")); assert.ok(!args.join(" ").includes("nova_plugins"));
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDECODE: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "synthetic-test-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, args }, provider: "claude", cwd: root, prompt: `Read the fixture skill.${copies.prompt}\n${rendered.content}`, signal: new AbortController().signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined); assert.equal(result.completed, true); assert.equal(catalogSeen, true); assert.equal(contentSeen, true); assert.equal(mcpSeen, false);
});
