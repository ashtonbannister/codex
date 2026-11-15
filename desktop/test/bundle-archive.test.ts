import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { PluginPackageStore } from "../src/main/services/plugin-packages";
import { startPluginMcp } from "../src/main/services/plugin-mcp";
import { preparePluginLaunch } from "../src/main/services/plugin-config";
import { BundleConfigStore } from "../src/main/services/bundle-config-store";
import { expandBundleDefault } from "../src/main/services/bundle-config";

function zip(entries: Array<{ name: string; data: Buffer; mode?: number; corrupt?: boolean }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name); const compressed = deflateRawSync(item.data); const checksum = crc32(item.data) ^ (item.corrupt ? 1 : 0);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(8, 8); head.writeUInt32LE(checksum >>> 0, 14); head.writeUInt32LE(compressed.length, 18); head.writeUInt32LE(item.data.length, 22); head.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(checksum >>> 0, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(item.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    local.push(head, name, compressed); central.push(cd, name); offset += head.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const manifest = (extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ manifest_version: "0.3", name: "synthetic-bundle", version: "1.0.0", description: "fixture", author: { name: "fixture" }, server: { type: "node", entry_point: "server/index.mjs", mcp_config: { command: process.execPath, args: ["${__dirname}/server/index.mjs"] } }, ...extra }));

test("imports, reviews and runs a local MCP bundle through the plugin gateway", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-bundle-"));
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const archive = path.join(root, "fixture.mcpb"); const script = await readFile(path.resolve("test/fixtures/mcp-server.mjs"));
  await writeFile(archive, zip([{ name: "manifest.json", data: manifest({ compatibility: { platforms: [process.platform], runtimes: { node: ">=1.0.0" } } }) }, { name: "server/index.mjs", data: script }]));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(archive);
  assert.equal(preview.name, "synthetic-bundle"); assert.deepEqual(preview.servers[0]!.unsupported, []);
  const pkg = await store.install(archive, preview.fingerprint); assert.equal(pkg.enabled, false); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const actions: string[] = [];
  const gateway = await startPluginMcp(copies.packages, async (request) => { actions.push(request.action); return true; }, new AbortController().signal);
  const response = await fetch(gateway.url, { method: "POST", headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const result = await response.json() as any; assert.ok(result.result.tools.length > 0); assert.deepEqual(actions, ["start", "discover"]);
  await gateway.dispose(); await copies.dispose();
});

test("refuses unsafe paths, links, case collisions and corruption", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-bundle-invalid-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const store = new PluginPackageStore(path.join(root, "data")); const archive = path.join(root, "fixture.mcpb");
  for (const entries of [
    [{ name: "../escape", data: Buffer.from("x") }],
    [{ name: "server/link", data: Buffer.from("target"), mode: 0o120777 }],
    [{ name: "A.txt", data: Buffer.from("a") }, { name: "a.txt", data: Buffer.from("b") }],
    [{ name: "broken", data: Buffer.from("x"), corrupt: true }],
    [{ name: "CON.txt", data: Buffer.from("x") }],
  ]) { await writeFile(archive, zip(entries)); await assert.rejects(store.preview(archive)); }

});


test("bundle settings are encrypted, validated and substituted without exposing sensitive values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-bundle-settings-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const archive = path.join(root, "settings.mcpb"); const script = await readFile(path.resolve("test/fixtures/mcp-server.mjs"));
  const config = manifest({ server: { type: "node", entry_point: "server/index.mjs", mcp_config: { command: process.execPath, args: ["${__dirname}/server/index.mjs", "${user_config.paths}"], env: { SYNTHETIC_AUTH: "${user_config.token}" } } }, user_config: {
    token: { type: "string", title: "API Token", description: "Secret", required: true, sensitive: true },
    paths: { type: "directory", title: "Folders", description: "Directories", multiple: true, required: true },
  } });
  await writeFile(archive, zip([{ name: "manifest.json", data: config }, { name: "server/index.mjs", data: script }]));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(archive); assert.equal(preview.bundleFields!.length, 2);
  const pkg = await store.install(archive, preview.fingerprint); await store.setEnabled(pkg.id, true); const copies = await store.prepareRun();
  const target = copies.packages[0]!; const identity = { id: pkg.id, fingerprint: pkg.fingerprint };
  const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa5)), decryptString: (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0xa5)).toString("utf8") };
  const settings = new BundleConfigStore(root, encryption); const tokenField = await store.bundleField(pkg.id, "token"), pathField = await store.bundleField(pkg.id, "paths");
  await assert.rejects(startPluginMcp(copies.packages, async () => true, new AbortController().signal), /Configure API Token/);
  await settings.set(identity, tokenField.definition, "synthetic-sensitive-value"); await settings.set(identity, pathField.definition, [root, path.dirname(root)]);
  const reloaded = new BundleConfigStore(root, encryption); await reloaded.load(); assert.equal(reloaded.get(identity).token, "synthetic-sensitive-value");
  assert.equal(Object.keys(reloaded.get({ ...identity, fingerprint: "c".repeat(64) })).length, 0);
  assert.doesNotMatch((await readFile(path.join(root, "bundle-settings.bin"))).toString(), /synthetic-sensitive-value/);
  const launch = await preparePluginLaunch(target.servers[0]!, target.root, process.env, { dataDir: target.dataDir, projectDir: root, bundleValues: settings.get(identity), bundlePaths: { HOME: root, DESKTOP: root, DOCUMENTS: root, DOWNLOADS: root } });
  assert.deepEqual(expandBundleDefault(["${HOME}/docs", "${DOCUMENTS}"], { HOME: root, DOCUMENTS: root }), [`${root}/docs`, root]);
  assert.equal(launch.env.SYNTHETIC_AUTH, "synthetic-sensitive-value"); assert.deepEqual(launch.args.slice(-2), [root, path.dirname(root)]);
  const indirect = { ...target.servers[0]!, command: "${WRAPPED}", env: { WRAPPED: "${user_config.token}" } };
  await assert.rejects(preparePluginLaunch(indirect, target.root, process.env, { dataDir: target.dataDir, projectDir: root, bundleValues: settings.get(identity) }), /sensitive bundle setting/);
  const details: string[] = [];
  const gateway = await startPluginMcp(copies.packages, async (request) => { details.push(request.detail); return true; }, new AbortController().signal, root, undefined, undefined, { values: () => settings.get(identity), paths: { HOME: root, DESKTOP: root, DOCUMENTS: root, DOWNLOADS: root } });
  assert.doesNotMatch(details.join(" "), /synthetic-sensitive-value/); assert.ok(details[0]!.includes(JSON.stringify(root).slice(1, -1))); assert.match(details[0]!, /\[redacted\]/); await gateway.dispose(); await copies.dispose();
});


test("bundle runtime compatibility is checked after approval before server startup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-bundle-runtime-")); t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const archive = path.join(root, "runtime.mcpb"); const script = await readFile(path.resolve("test/fixtures/mcp-server.mjs"));
  await writeFile(archive, zip([{ name: "manifest.json", data: manifest({ compatibility: { runtimes: { node: ">=999.0.0" } } }) }, { name: "server/index.mjs", data: script }]));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(archive); const pkg = await store.install(archive, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const actions: string[] = [];
  await assert.rejects(startPluginMcp(copies.packages, async (request) => { actions.push(request.action); return true; }, new AbortController().signal), /runtime does not match/);
  assert.deepEqual(actions, ["start"]); await copies.dispose();
});


test("Node bundles fall back to Nova's executable when Node is absent from PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nova-bundle-node-")); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const archive = path.join(root, "node.mcpb");
  const config = manifest({ server: { type: "node", entry_point: "server/index.mjs", mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"] } } });
  await writeFile(archive, zip([{ name: "manifest.json", data: config }, { name: "server/index.mjs", data: Buffer.from("") }]));
  const store = new PluginPackageStore(path.join(root, "data")); const preview = await store.preview(archive); const pkg = await store.install(archive, preview.fingerprint); await store.setEnabled(pkg.id, true);
  const copies = await store.prepareRun(); const entry = copies.packages[0]!;
  const prepared = await preparePluginLaunch(entry.servers[0]!, entry.root, { PATH: "" }, { dataDir: entry.dataDir, projectDir: root });
  assert.equal(prepared.executable.command.toLowerCase(), process.execPath.toLowerCase()); await copies.dispose();
});
