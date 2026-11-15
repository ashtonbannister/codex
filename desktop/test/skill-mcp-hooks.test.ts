import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizeThreadPermission, ThreadPermissionStore, type PermissionContext } from "../src/main/services/thread-permissions";
import { SkillPackageStore } from "../src/main/services/skill-packages";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";
import { prepareSkillMcpHooks, skillMcpHookRunner } from "../src/main/services/skill-mcp-hooks";
import { parseSkillMcpHooks } from "../src/main/services/skill-hook-config";

const config = (matcher: string, command: string) => ({ PreToolUse: [{ matcher, hooks: [{ type: "command", command }] }] });
test("only interceptable MCP pre-tool hook configurations are accepted", () => {
  assert.equal(parseSkillMcpHooks(config("mcp__fixture__.*", "echo ok"))!.length, 1);
  for (const value of [config("Bash", "echo ok"), config("mcp__.*", "echo ok"), config("mcp__nova_desktop__desktop", "echo ok"), { PostToolUse: [] }, { PreToolUse: [{ matcher: "mcp__fixture__.*", hooks: [{ type: "command", command: "echo x", once: true }] }] }, config("mcp__fixture__.*", "${user_config.token}")]) assert.throws(() => parseSkillMcpHooks(value));
});

test("reviewed MCP hooks block, allow, and fail closed before plugin calls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-mcp-hook-"));
  const skillDir = path.join(root, "skill"); await mkdir(skillDir); const script = path.join(skillDir, "hook.cjs");
  await writeFile(script, `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const v=JSON.parse(data);if(v.hook_event_name!=='PreToolUse'||v.tool_name!=='mcp__fixture__echo'||v.tool_input.secret!=='synthetic-value')process.exit(3);const m=v.tool_input.message;if(m==='block')process.exit(2);if(m==='array-deny')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:['deny']}}));if(m==='ask')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'synthetic reason'}}));if(m==='json-deny')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'}}));if(m==='error')process.exit(7);if(m==='invalid')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{}}}));if(m==='allow')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));});`);
  const shell = process.platform === "win32" ? "powershell" : "bash"; const command = shell === "powershell" ? `& '${process.execPath}' '\${CLAUDE_SKILL_DIR}/hook.cjs'` : `'${process.execPath}' '\${CLAUDE_SKILL_DIR}/hook.cjs'`;
  const yaml = `---\nname: guard\ndescription: Guard\nshell: ${shell}\nhooks:\n  PreToolUse:\n    - matcher: mcp__fixture__echo\n      hooks:\n        - type: command\n          command: ${JSON.stringify(command)}\n---\nReview before using the tool.\n`;
  await writeFile(path.join(skillDir, "SKILL.md"), yaml); const skillStore = new SkillPackageStore(path.join(root, "data")); const preview = await skillStore.preview(skillDir); assert.equal(preview.skills[0]!.mcpHooks!.length, 1); assert.equal(preview.skills[0]!.disableModelInvocation, true); await skillStore.install(skillDir, preview.fingerprint);
  const skills = await skillStore.prepareRun("/guard", "codex"); const plans = prepareSkillMcpHooks(skills.invoked, root);
  const pluginDir = path.join(root, "plugin"); await mkdir(pluginDir); await copyFile(path.resolve("test/fixtures/mcp-server.mjs"), path.join(pluginDir, "server.mjs"));
  await writeFile(path.join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ["${CODEX_PLUGIN_ROOT}/server.mjs"], enabled_tools: ["echo", "slow"] } } }));
  const plugins = new PluginPackageStore(path.join(root, "data")); const pluginPreview = await plugins.preview(pluginDir); const pkg = await plugins.install(pluginDir, pluginPreview.fingerprint); await plugins.setEnabled(pkg.id, true); const copies = await plugins.prepareRun();
  let allowCall = false, allowHook = false, allowHookAsk = false, tamper = false; const approvals: Array<{ action: string; detail: string }> = [];
  const approve = async (request: { action: string; detail: string; title: string }) => { approvals.push(request); if (request.action === "skill-hook" && tamper) await writeFile(skills.invoked[0]!.path, "changed"); return request.title === "Confirm tool call requested by hook?" ? allowHookAsk : request.action === "call" ? allowCall : request.action === "skill-hook" ? allowHook : true; };
  const controller = new AbortController(); const verify = async () => { await skills.verify(); await copies.verifyProviders(); };
  const runner = skillMcpHookRunner(plans, root, "synthetic-run", approve, verify, () => controller.abort());
  const gateway = await startPluginMcp(copies.packages, approve, controller.signal, root, undefined, undefined, undefined, runner);
  t.after(async () => { await gateway.dispose(); await copies.dispose(); await skills.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const send = async (id: number, method: string, params: unknown = {}) => (await (await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json()) as any;
  const tools = (await send(1, "tools/list")).result.tools as Array<{ name: string }>; const name = tools.find((item) => item.name.endsWith("_echo"))!.name; const slow = tools.find((item) => item.name.endsWith("_slow"))!.name;
  const call = (id: number, message: string) => send(id, "tools/call", { name, arguments: { message, secret: "synthetic-value" } });
  assert.equal((await call(2, "allow")).result.isError, true); assert.equal(approvals.filter((item) => item.action === "skill-hook").length, 0);
  allowCall = true; assert.match((await call(3, "allow")).result.content[0].text, /hook execution was declined/); assert.match(approvals.at(-1)!.detail, /synthetic-value/);
  allowHook = true; assert.equal((await call(4, "allow")).result.content[0].text, "server request denied");
  assert.match((await call(5, "block")).result.content[0].text, /hook blocked/);
  assert.match((await call(6, "invalid")).result.content[0].text, /Unsupported skill hook decision/);
  assert.match((await call(7, "json-deny")).result.content[0].text, /hook blocked/); assert.match((await call(8, "error")).result.content[0].text, /hook failed/);
  assert.match((await call(13, "array-deny")).result.content[0].text, /Unsupported skill hook decision/);
  assert.match((await call(9, "ask")).result.content[0].text, /confirmation was declined/); assert.match(approvals.at(-1)!.detail, /synthetic reason/);
  allowHookAsk = true; assert.equal((await call(10, "ask")).result.content[0].text, "server request denied");
  const hookCount = approvals.filter((item) => item.action === "skill-hook").length; assert.equal((await send(11, "tools/call", { name: slow, arguments: {} })).result.content[0].text, "late"); assert.equal(approvals.filter((item) => item.action === "skill-hook").length, hookCount);
  tamper = true; assert.match((await call(12, "allow")).result.content[0].text, /changed after/);
});


test("hook shell denial and timeout fail closed and settle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-hook-timeout-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const shell = process.platform === "win32" ? "powershell" : "bash";
  const make = (command: string, timeoutMs: number) => prepareSkillMcpHooks([{ source: "imported skill", package: "fixture", name: "guard", description: "", path: path.join(root, "SKILL.md"), root, data: root, descriptor: { path: "SKILL.md", name: "guard", description: "", shell, mcpHooks: [{ server: "fixture", tool: "echo", command, timeoutMs }] }, reference: { name: "guard", args: "", token: "/guard" }, verifiedContent: "fixture" }], root);
  const call = { server: "fixture", tool: "echo", alias: "p_1_echo", args: {} }; let aborted = false;
  const denied = skillMcpHookRunner(make("exit 2", 3000), root, "run", async () => true, async () => {}, () => { aborted = true; });
  await assert.rejects(denied.beforeCall(call, new AbortController().signal), /hook blocked/); await denied.settle(); assert.equal(aborted, false);
  const failingCommand = shell === "powershell" ? "Write-Error 'synthetic failure'" : "false"; const failed = skillMcpHookRunner(make(failingCommand, 3000), root, "run", async () => true, async () => {}, () => { aborted = true; });
  await assert.rejects(failed.beforeCall(call, new AbortController().signal), /hook failed/); await failed.settle();
  const command = shell === "powershell" ? "Start-Sleep -Seconds 10" : "sleep 10";
  const timed = skillMcpHookRunner(make(command, 300), root, "run", async () => true, async () => {}, () => { aborted = true; });
  await assert.rejects(timed.beforeCall(call, new AbortController().signal), /hook failed|termination could not be confirmed/); await timed.settle();
});


test("remembered hook permissions match the same chat, package, command, and tool input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-hook-permission-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const source = path.join(root, "source"); await mkdir(source); const shell = process.platform === "win32" ? "powershell" : "bash"; const command = shell === "powershell" ? "exit 0" : "true";
  await writeFile(path.join(source, "SKILL.md"), `---\nname: guard\ndescription: Fixture\nshell: ${shell}\nhooks:\n  PreToolUse:\n    - matcher: mcp__fixture__echo\n      hooks:\n        - type: command\n          command: ${JSON.stringify(command)}\n---\nGuard.\n`);
  const skills = new SkillPackageStore(path.join(root, "data")); const preview = await skills.preview(source); await skills.install(source, preview.fingerprint);
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text, "utf8"), decryptString: (data: Buffer) => data.toString("utf8") }; const grants = new ThreadPermissionStore(root, encryption); await grants.load();
  const context: PermissionContext = { threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", provider: "codex", model: "fixture", mode: "plan", worker: "parent" }; let prompts = 0;
  const approve = (request: { scope?: unknown }) => authorizeThreadPermission(grants, context, request.scope, async () => { prompts++; return 2; });
  for (let i = 0; i < 2; i++) { const run = await skills.prepareRun("/guard", "codex"); const runner = skillMcpHookRunner(prepareSkillMcpHooks(run.invoked, root), root, `run-${i}`, approve, run.verify, () => {}); await runner.beforeCall({ server: "fixture", tool: "echo", alias: "p_echo", args: { message: "same" } }, new AbortController().signal); await runner.settle(); await run.dispose(); }
  assert.equal(prompts, 1);
  const run = await skills.prepareRun("/guard", "codex"); const runner = skillMcpHookRunner(prepareSkillMcpHooks(run.invoked, root), root, "run-3", approve, run.verify, () => {}); await runner.beforeCall({ server: "fixture", tool: "echo", alias: "p_echo", args: { message: "different" } }, new AbortController().signal); await runner.settle(); await run.dispose(); assert.equal(prompts, 2);
});
