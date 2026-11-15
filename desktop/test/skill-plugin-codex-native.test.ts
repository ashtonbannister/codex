import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared/types";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { ensureNovaCodexHome } from "../src/main/services/nova-runtime";
import { prepareLocalProvider, providerArguments, resolveExecutable, runProvider } from "../src/main/services/providers";

test("installed Codex reads a skill-only plugin through an isolated synthetic local model", { skip: process.env.NOVA_SKILL_CODEX_NATIVE_TEST !== "1", timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-skill-codex-"));
  const source = path.join(root, "source"); await mkdir(path.join(source, "skills", "demo"), { recursive: true });
  await writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "fixture-skill-plugin" }));
  await writeFile(path.join(source, "skills", "demo", "SKILL.md"), "---\nname: fixture-only-skill\ndescription: Synthetic instructions\n---\nSYNTHETIC_SKILL_CONTENT\n");
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const skillFile = path.join(copies.packages[0]!.root, "skills", "demo", "SKILL.md");
  t.after(async () => { await copies.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  let calls = 0, catalogSeen = false, contentSeen = false, toolSeen = false, pluginMcpSeen = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
    let data = ""; for await (const chunk of req) data += chunk; const body = JSON.parse(data);
    const messages = JSON.stringify(body.messages); catalogSeen ||= messages.includes("fixture-only-skill"); contentSeen ||= messages.includes("SYNTHETIC_SKILL_CONTENT");
    const tools = body.tools ?? []; pluginMcpSeen ||= tools.some((tool: any) => /nova_plugins/i.test(tool.function?.name ?? ""));
    const tool = tools.find((entry: any) => /(?:shell_command|exec_command|shell)$/i.test(entry.function?.name ?? "")); toolSeen ||= !!tool;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (++calls === 1 && tool) {
      const properties = tool.function.parameters?.properties ?? {}; const escaped = skillFile.replace(/'/g, "''");
      const command = process.platform === "win32" ? `powershell.exe -NoProfile -NonInteractive -Command "Get-Content -LiteralPath '${escaped}' -Raw"` : `cat '${escaped}'`;
      const args: Record<string, unknown> = { [Object.hasOwn(properties, "cmd") ? "cmd" : "command"]: command };
      if (Object.hasOwn(properties, "workdir")) args.workdir = root;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    } else res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fixture complete." }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { const done = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await done; });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const settings = { ...DEFAULT_SETTINGS, localProvider: "custom" as const, localProtocol: "chat-completions" as const, localBaseUrl: `http://127.0.0.1:${address.port}/v1`, localModel: "fixture-model" };
  const controller = new AbortController(); const local = await prepareLocalProvider(settings, "fixture-model", controller.signal); t.after(local.dispose);
  const home = await ensureNovaCodexHome(path.join(root, "data")); const executable = await resolveExecutable("codex");
  const result = await runProvider({ command: { ...executable, env: { ...executable.env, ...local.env, CODEX_HOME: home }, args: providerArguments("ollama", root, "plan", "fixture-model", { allowNonGit: true, localConfigArgs: local.configArgs, pluginDirectory: copies.directory }) }, provider: "ollama", cwd: root, prompt: `Read the fixture skill.${copies.prompt}`, signal: controller.signal, timeoutMs: 45000, maxBytes: 1024 * 1024, onEvent: () => {} });
  assert.equal(result.error, undefined); assert.equal(result.completed, true); assert.equal(catalogSeen, true); assert.equal(toolSeen, true); assert.equal(contentSeen, true); assert.equal(pluginMcpSeen, false);
});
