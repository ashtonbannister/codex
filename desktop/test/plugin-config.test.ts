import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePluginMcp, pluginServerSummary, preparePluginLaunch } from "../src/main/services/plugin-config";

test("parses Codex and Claude stdio servers without exposing env values", () => {
  const [server] = parsePluginMcp({ mcpServers: { sample: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js", ""], env: { SAMPLE_TOKEN: "synthetic-secret" }, env_vars: ["USER_TOKEN", { name: "OTHER_TOKEN", source: "local" }], enabled_tools: ["read"], disabled_tools: ["write"], startup_timeout_sec: 10, tool_timeout_sec: 20 } } });
  assert.equal(server!.transport, "stdio");
  assert.deepEqual(server!.args, ["${CLAUDE_PLUGIN_ROOT}/server.js", ""]);
  assert.deepEqual(server!.enabledTools, ["read"]);
  assert.deepEqual(server!.disabledTools, ["write"]);
  assert.equal(server!.startupTimeoutMs, 10000);
  assert.equal(server!.toolTimeoutMs, 20000);
  assert.deepEqual(server!.unsupported, []);
  const summary = pluginServerSummary(server!);
  assert.deepEqual(summary.environmentNames, ["OTHER_TOKEN", "SAMPLE_TOKEN", "USER_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-secret/);
});

test("retains disabled servers and reports unsupported restrictions", () => {
  const parsed = parsePluginMcp({ mcpServers: { remote: { type: "http", url: "https://example.invalid/mcp", enabled: false, oauth: { scopes: ["x"] } }, restricted: { command: "node", omit_tools_from: ["direct"], tools: { read: { output_token_limit: 4 } }, env_vars: [{ name: "TOKEN", source: "remote" }] } } });
  assert.equal(parsed[0]!.enabled, false);
  assert.match(parsed[0]!.unsupported.join(" "), /authentication/);
  assert.match(parsed[1]!.unsupported.join(" "), /direct tool exposure/);
  assert.match(parsed[1]!.unsupported.join(" "), /Per-tool/);
  assert.match(parsed[1]!.unsupported.join(" "), /Remote environment/);
});

test("rejects ambiguous transports, invalid fields and oversized timeouts", () => {
  assert.throws(() => parsePluginMcp({ mcpServers: { bad: { command: "node", url: "https://example.invalid" } } }), /exactly one/);
  assert.throws(() => parsePluginMcp({ mcpServers: { bad: { command: "node", env: { "BAD-NAME": "x" } } } }), /environment/);
  assert.throws(() => parsePluginMcp({ mcpServers: { bad: { command: "node", startup_timeout_sec: 999 } } }), /timeout/);
  assert.throws(() => parsePluginMcp({ mcpServers: { "bad/name": { command: "node" } } }), /name/);
});


test("resolves reviewed plugin roots and only explicitly requested environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [server] = parsePluginMcp({ mcpServers: { demo: { command: process.execPath, args: ["${CODEX_PLUGIN_ROOT}/server.mjs", "${PLUGIN_TOKEN}"], env: { MODE: "production" }, env_vars: ["PLUGIN_TOKEN"] } } });
  const summary = pluginServerSummary(server!);
  assert.deepEqual(summary.environmentNames, ["MODE", "PLUGIN_TOKEN"]);
  const prepared = await preparePluginLaunch(server!, root, { PATH: process.env.PATH, PLUGIN_TOKEN: "synthetic-token", UNRELATED_SECRET: "never-forward" });
  assert.equal(path.normalize(prepared.args[0]!).toLowerCase(), path.join(root, "server.mjs").toLowerCase());
  assert.equal(prepared.args[1], "synthetic-token");
  assert.equal(prepared.env.MODE, "production");
  assert.equal(prepared.env.PLUGIN_TOKEN, "synthetic-token");
  assert.equal(prepared.env.UNRELATED_SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-token/);
  await assert.rejects(preparePluginLaunch(server!, root, { PATH: process.env.PATH }), /PLUGIN_TOKEN/);
});

test("rejects relative plugin commands escaping the copied package", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [server] = parsePluginMcp({ mcpServers: { bad: { command: "../escape.exe" } } });
  await assert.rejects(preparePluginLaunch(server!, root, { PATH: process.env.PATH }), /escapes/);
});


test("plugin interpolation uses configured values and rejects cycles", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-vars-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [server] = parsePluginMcp({ mcpServers: { demo: { command: process.execPath, args: ["${MODE}", "${COMBINED}"], env: { MODE: "configured", COMBINED: "${MODE}:${TOKEN}" }, env_vars: ["TOKEN"] } } });
  const prepared = await preparePluginLaunch(server!, root, { PATH: process.env.PATH, MODE: "host", TOKEN: "synthetic" });
  assert.deepEqual(prepared.args, ["configured", "configured:synthetic"]);
  const [cyclic] = parsePluginMcp({ mcpServers: { bad: { command: process.execPath, env: { A: "${B}", B: "${A}" } } } });
  await assert.rejects(preparePluginLaunch(cyclic!, root, { PATH: process.env.PATH }), /cycle/);
});


test("maps plugin root, persistent data, and selected project placeholders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-locations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [server] = parsePluginMcp({ mcpServers: { demo: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_DATA}", "${CLAUDE_PROJECT_DIR}"] } } });
  const prepared = await preparePluginLaunch(server!, root, { PATH: process.env.PATH }, { dataDir: root, projectDir: root });
  assert.equal(prepared.args.length, 3);
  assert.ok(prepared.args.every((arg) => path.resolve(arg).toLowerCase() === path.resolve(root).toLowerCase()));
  assert.equal(prepared.env.CLAUDE_PLUGIN_DATA, root);
  assert.equal(prepared.env.CLAUDE_PROJECT_DIR, root);
});


test("Windows npx plugins resolve to Node and npm's script without a shell", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-npx-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [server] = parsePluginMcp({ mcpServers: { npm: { command: "npx", args: ["--no-install", "synthetic-tool"] } } });
  const prepared = await preparePluginLaunch(server!, root, { PATH: process.env.PATH });
  assert.equal(path.basename(prepared.executable.command).toLowerCase(), "node.exe");
  assert.equal(path.basename(prepared.executable.prefix[0]!).toLowerCase(), "npx-cli.js");
  assert.deepEqual(prepared.args.slice(1), ["--no-install", "synthetic-tool"]);
});


test("remote MCP configuration accepts reviewed HTTPS or loopback and rejects unsafe endpoints", () => {
  const [remote] = parsePluginMcp({ mcpServers: { remote: { type: "sse", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${NOVA_TEST_TOKEN}" } } } });
  assert.deepEqual(remote!.unsupported, []);
  assert.deepEqual(pluginServerSummary(remote!).environmentNames, ["NOVA_TEST_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(pluginServerSummary(remote!)), /Bearer/);
  for (const url of ["http://example.invalid/mcp", "http://localhost/mcp", "https://user:password@example.invalid/mcp", "file:///tmp/mcp"]) assert.throws(() => parsePluginMcp({ mcpServers: { bad: { url } } }), /HTTPS/);
  assert.throws(() => parsePluginMcp({ mcpServers: { bad: { url: "https://example.invalid/mcp", headers: { Host: "other" } } } }), /header/);
});
