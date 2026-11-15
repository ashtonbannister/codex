import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginPackageStore } from "../src/main/services/plugin-packages";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture-plugin", mcpServers: "./.mcp.json" }));
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "node", args: ["${CODEX_PLUGIN_ROOT}/server.mjs"], env: { TOKEN: "synthetic-secret" } } } }));
  await writeFile(path.join(source, "server.mjs"), "// synthetic fixture\n");
  return { root, source, store: new PluginPackageStore(path.join(root, "data")) };
}

test("imports a reviewed tool-only plugin as a disabled package", async (t) => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.source);
  assert.equal(preview.name, "fixture-plugin");
  assert.equal(preview.skills.length, 0);
  assert.deepEqual(preview.servers[0]!.environmentNames, ["TOKEN"]);
  assert.doesNotMatch(JSON.stringify(preview), /synthetic-secret/);
  const pkg = await f.store.install(f.source, preview.fingerprint);
  assert.equal(pkg.enabled, false);
  assert.equal(await readFile(path.join(f.root, "data", "plugin-packages", pkg.id, "files", "server.mjs"), "utf8"), "// synthetic fixture\n");
  await f.store.setEnabled(pkg.id, true);
  assert.equal((await f.store.list())[0]!.enabled, true);
  const run = await f.store.prepareRun();
  assert.equal(run.packages[0]!.servers[0]!.name, "fixture");
  await writeFile(path.join(run.packages[0]!.root, "server.mjs"), "// disposable edit\n");
  assert.equal(await readFile(path.join(f.root, "data", "plugin-packages", pkg.id, "files", "server.mjs"), "utf8"), "// synthetic fixture\n");
  await writeFile(path.join(run.packages[0]!.dataDir, "state.json"), "persistent fixture");
  const dataDir = run.packages[0]!.dataDir;
  await run.dispose();
  const nextRun = await f.store.prepareRun();
  assert.equal(nextRun.packages[0]!.dataDir, dataDir);
  assert.equal(await readFile(path.join(dataDir, "state.json"), "utf8"), "persistent fixture");
  await nextRun.dispose();
  await f.store.setEnabled(pkg.id, false);
  assert.equal((await f.store.list())[0]!.enabled, false);
});

test("plugin import rejects changed sources and changed installed files", async (t) => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.source);
  await writeFile(path.join(f.source, "server.mjs"), "// changed\n");
  await assert.rejects(f.store.install(f.source, preview.fingerprint), /changed/);
  const current = await f.store.preview(f.source);
  const pkg = await f.store.install(f.source, current.fingerprint);
  await writeFile(path.join(f.root, "data", "plugin-packages", pkg.id, "files", "server.mjs"), "// modified\n");
  await assert.rejects(f.store.setEnabled(pkg.id, true), /changed/);
});

test("plugin manifests cannot reference files outside the selected folder", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture", mcpServers: "../outside.json" }));
  await assert.rejects(f.store.preview(f.source), /inside the selected folder/);
});


test("plugin manifests merge default and declared MCP servers in order", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "old" }, base: { command: "node" } } }));
  await writeFile(path.join(f.source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture", hooks: "./hooks/hooks.json", mcpServers: [{ shared: { command: "new" } }, { extra: { command: "node" } }] }));
  const preview = await f.store.preview(f.source);
  assert.deepEqual(preview.servers.map((server) => server.name), ["shared", "base", "extra"]);
  assert.match(preview.warnings.join(" "), /hooks are not loaded/);
});

test("plugin bundle references are reported unsupported instead of silently ignored", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture", mcpServers: ["https://example.invalid/plugin.mcpb"] }));
  const preview = await f.store.preview(f.source);
  assert.ok(preview.servers.some((server) => server.unsupported.some((reason) => reason.includes("bundles"))));
  const pkg = await f.store.install(f.source, preview.fingerprint);
  assert.ok(pkg.disabledServers.some((name) => name.startsWith("unsupported_bundle_")));
  await f.store.setEnabled(pkg.id, true);
  const run = await f.store.prepareRun();
  assert.deepEqual(run.packages[0]!.servers.map((server) => server.name), ["fixture"]);
  await run.dispose();
});


test("an empty default MCP file can be supplemented by the plugin manifest", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  await writeFile(path.join(f.source, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture", mcpServers: { declared: { command: "node" } } }));
  const preview = await f.store.preview(f.source);
  assert.deepEqual(preview.servers.map((server) => server.name), ["declared"]);
});


test("only declared and standard plugin skills enter the catalog", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, "skills", "usable"), { recursive: true });
  await mkdir(path.join(f.source, "examples", "hidden"), { recursive: true });
  await writeFile(path.join(f.source, "skills", "usable", "SKILL.md"), "---\nname: usable\ndescription: Useful\n---\nInstructions");
  await writeFile(path.join(f.source, "examples", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: Example only\n---\nInstructions");
  const preview = await f.store.preview(f.source);
  assert.deepEqual(preview.skills.map((skill) => skill.name), ["usable"]);
  assert.match(preview.warnings.join(" "), /outside declared plugin skill paths/);
});


test("individual servers can be excluded without overriding source restrictions", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".mcp.json"), JSON.stringify({ mcpServers: { first: { command: "node" }, second: { command: "node" }, off: { command: "node", enabled: false } } }));
  const preview = await f.store.preview(f.source); const pkg = await f.store.install(f.source, preview.fingerprint);
  await f.store.setServerEnabled(pkg.id, "second", false);
  await assert.rejects(f.store.setServerEnabled(pkg.id, "off", true), /disabled in its source/);
  await f.store.setEnabled(pkg.id, true);
  const run = await f.store.prepareRun();
  assert.deepEqual(run.packages[0]!.servers.map((server) => server.name), ["first"]);
  await run.dispose();
  await assert.rejects(f.store.setServerEnabled(pkg.id, "first", false), /last supported server/);
});


test("previously imported remote servers refresh their supported status without being enabled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-plugin-migration-"));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.invalid/mcp" } } }));
  const data = path.join(root, "data"); const store = new PluginPackageStore(data);
  const preview = await store.preview(source); const pkg = await store.install(source, preview.fingerprint);
  const metadata = path.join(data, "plugin-packages", pkg.id, "package.json");
  const old = JSON.parse(await readFile(metadata, "utf8")); old.servers[0].unsupported = ["Remote MCP connections are not yet supported."]; old.disabledServers = ["remote"];
  await writeFile(metadata, JSON.stringify(old));
  const refreshed = (await store.list())[0]!;
  assert.equal(refreshed.servers[0]!.supportsCredential, true); assert.deepEqual(refreshed.servers[0]!.unsupported, []);
  assert.deepEqual(refreshed.disabledServers, ["remote"]); assert.equal(refreshed.enabled, false);
  const identity = { id: pkg.id, fingerprint: pkg.fingerprint, server: "remote" };
  assert.deepEqual(await store.credentialIdentity(pkg.id, "remote"), identity);
  await writeFile(path.join(data, "plugin-packages", pkg.id, "files", ".mcp.json"), "changed");
  const invalid = (await store.list())[0]!;
  assert.match(invalid.servers[0]!.unsupported.join(" "), /verification failed/);
  await assert.rejects(store.credentialIdentity(pkg.id, "remote"), /changed/);
  assert.deepEqual(await store.credentialIdentity(pkg.id, "remote", true), identity);
});
